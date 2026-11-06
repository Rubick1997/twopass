import type { BatchProvider, BatchRequest } from './batch/provider.ts';
import { Budget, BudgetExceededError } from './budget.ts';
import { asChoice, type DecisionModel, type DecisionState, type Questions } from './decide/model.ts';
import { createLimiter } from './http.ts';
import {
  customId,
  replay,
  verifyKey,
  type BatchInfo,
  type Ledger,
  type Round,
  type RunState,
} from './ledger.ts';
import { parseWriterOutput, render, verifyQuestion, verifyState, type Row, type TaskDefinition, type Thresholds } from './task.ts';
import { triageOutcome, verifyOutcome, type Verdict } from './verdict.ts';

// round 0: triage (decision model picks the answer itself, closed-choice tasks only)
// round 1: batch write (cheap writer) -> verify
// round 2: batch re-run of the rejected rows (stronger model) -> verify -> accepted | flagged
//
// Every stage reads the ledger first and only does work that is not already recorded,
// so `run` and `resume` are the same code path.

export interface RowRecord {
  id: string;
  data: Row;
}

export type Prices = Record<string, { inputPerToken: number; outputPerToken: number }>;

export interface PipelineContext {
  task: TaskDefinition;
  rows: RowRecord[];
  ledger: Ledger;
  /** Round 0: picks the answer itself. */
  triageDecider: DecisionModel;
  /** Rounds 1 and 2: judges the writer's answer. Can be a different model (dev runs: Clef verifies best). */
  verifyDecider: DecisionModel;
  batch: BatchProvider;
  writerModel: string;
  escalationModel: string;
  thresholds: Thresholds;
  budget: Budget;
  prices: Prices;
  /** Times a failed writer request is submitted in total, per round. Default 2. */
  maxAttempts?: number;
  decisionConcurrency?: number;
  pollIntervalMs?: number;
  /** Submit at most this many rows per batch, one batch at a time. Default: all at once. */
  maxRowsPerBatch?: number;
  /** Share of a batch that may hit max_tokens before the run stops. Default 0.05. */
  truncationTolerance?: number;
  /**
   * normal:   the TwoPass pipeline.
   * collect:  every row goes through every stage regardless of thresholds, to gather calibration data.
   * baseline: the writer model answers every row and every answer is accepted (no decision model).
   */
  mode?: 'normal' | 'collect' | 'baseline';
  log?: (message: string) => void;
}

export type RowStatus = 'accepted' | 'flagged' | 'pending';

export interface RowOutcome {
  rowId: string;
  data: Row;
  status: RowStatus;
  answer: string;
  confidence: number | null;
  verdict: Verdict | 'triage' | 'baseline' | '';
  model: string;
  round: Round;
  costUsd: number;
}

export async function executePipeline(ctx: PipelineContext): Promise<RowOutcome[]> {
  const { task, thresholds } = ctx;
  const mode = ctx.mode ?? 'normal';
  const state = () => replay(ctx.ledger.read());

  if (mode === 'baseline') {
    await writerRound(ctx, 1, ctx.rows, ctx.writerModel);
    return computeOutcomes(state(), ctx);
  }

  if (task.triage) {
    const st = state();
    const todo = ctx.rows.filter((r) => !st.triage.has(r.id));
    if (todo.length) {
      log(ctx, `round 0: triage ${todo.length} rows with ${ctx.triageDecider.id}`);
      await runDecisions(
        ctx,
        ctx.triageDecider,
        todo.map((r) => ({
          rowId: r.id,
          round: 0 as const,
          stage: 'triage' as const,
          state: task.state(r.data),
          questions: { answer: task.triage!.question },
        })),
      );
    }
  }

  const collect = mode === 'collect';
  let st = state();
  const round1 = ctx.rows.filter(
    (r) => collect || !triageOutcome(asChoice(st.triage.get(r.id)?.answers.answer), thresholds.t0).accepted,
  );
  await writerRound(ctx, 1, round1, ctx.writerModel);
  await verifyRound(ctx, 1, round1);

  st = state();
  const round2 = round1.filter(
    (r) => collect || !verifyOutcome(asChoice(st.verify.get(verifyKey(r.id, 1))?.answers.verdict), thresholds.t1).accepted,
  );
  await writerRound(ctx, 2, round2, ctx.escalationModel);
  await verifyRound(ctx, 2, round2);

  return computeOutcomes(state(), ctx);
}

function log(ctx: PipelineContext, message: string) {
  ctx.log?.(message);
}

interface DecisionItem {
  rowId: string;
  round: Round;
  stage: 'triage' | 'verify';
  state: DecisionState;
  questions: Questions;
}

async function runDecisions(ctx: PipelineContext, decider: DecisionModel, items: DecisionItem[]): Promise<void> {
  const limit = createLimiter(ctx.decisionConcurrency ?? 16);
  const settled = await Promise.allSettled(
    items.map((item) =>
      limit(async () => {
        ctx.budget.assertCanSpend();
        const res = await decider.decide(item.state, item.questions);
        ctx.ledger.append({
          t: 'decision',
          rowId: item.rowId,
          round: item.round,
          stage: item.stage,
          model: res.model,
          answers: res.answers,
          costUsd: res.costUsd,
          latencyMs: res.latencyMs,
        });
        ctx.budget.charge(res.costUsd);
      }),
    ),
  );
  const failures = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (!failures.length) return;
  const overBudget = failures.find((f) => f.reason instanceof BudgetExceededError);
  if (overBudget) throw overBudget.reason;
  throw new Error(
    `${failures.length} of ${items.length} decision calls failed (first: ${String(failures[0]!.reason)}). ` +
      `The others are saved; resume the run to retry.`,
  );
}

async function writerRound(ctx: PipelineContext, round: 1 | 2, rows: RowRecord[], model: string): Promise<void> {
  if (!rows.length) return;
  const maxAttempts = ctx.maxAttempts ?? 2;
  const ids = new Set(rows.map((r) => customId(r.id, round)));

  for (;;) {
    let st = replay(ctx.ledger.read());
    const pending = [...st.batches.values()].filter((b) => b.round === round && !b.finished);
    if (pending.length) {
      await Promise.all(pending.map((b) => collectBatch(ctx, b)));
      continue;
    }
    const allNeeded = rows.filter((r) => {
      const cid = customId(r.id, round);
      return !st.results.get(cid)?.ok && (st.attempts.get(cid) ?? 0) < maxAttempts;
    });
    if (!allNeeded.length) return;
    // With a row limit, batches go one at a time: OpenRouter reserves each batch's worst-case cost
    // (every row using all of max_tokens) from the balance at submit time.
    const need = ctx.maxRowsPerBatch ? allNeeded.slice(0, ctx.maxRowsPerBatch) : allNeeded;

    const requests: BatchRequest[] = need.map((r) => ({
      custom_id: customId(r.id, round),
      body: writerBody(ctx.task, r.data, round, st, r.id, ctx.mode),
    }));
    const price = ctx.prices[model];
    if (!price) throw new Error(`No price known for ${model}`);
    ctx.budget.assertCanSpend(estimateCost(requests, price, writerSettings(ctx.task, round, ctx.mode).maxTokens, st, model));

    const retry = need.some((r) => (st.attempts.get(customId(r.id, round)) ?? 0) > 0);
    const left = allNeeded.length > need.length ? ` (${allNeeded.length - need.length} more after this batch)` : '';
    log(ctx, `round ${round}: ${retry ? 'retrying' : 'submitting'} ${need.length} of ${ids.size} rows to ${model}${left}`);
    await ctx.batch.submit(model, requests, (h) =>
      ctx.ledger.append({ t: 'batch_submitted', round, batchId: h.id, model, customIds: h.customIds }),
    );
    st = replay(ctx.ledger.read());
  }
}

/**
 * Round 1 uses the writer settings, round 2 the escalation overrides. The baseline (a frontier model
 * on every row) asks the round-1 question with the escalation model's settings: like Sonnet, Opus 5.5
 * refuses `reasoning: {enabled: false}` and fails the whole batch.
 */
export function writerSettings(task: TaskDefinition, round: 1 | 2, mode: PipelineContext['mode'] = 'normal') {
  const w = task.writer;
  const strong = round === 2 || mode === 'baseline' ? w.escalation : undefined;
  return {
    template: round === 2 ? (strong?.template ?? w.promptTemplate) : w.promptTemplate,
    maxTokens: strong?.maxTokens ?? w.maxTokens,
    reasoning: strong?.reasoning ?? w.reasoning,
  };
}

function writerBody(
  task: TaskDefinition,
  row: Row,
  round: 1 | 2,
  st: RunState,
  rowId: string,
  mode: PipelineContext['mode'],
) {
  const s = writerSettings(task, round, mode);
  const vars: Record<string, string> = { ...row };
  if (round === 2) {
    const text = st.results.get(customId(rowId, 1))?.text?.trim();
    const parsed = text === undefined ? undefined : parseWriterOutput(task, text);
    vars.previous_answer = parsed?.ok ? parsed.value : (text ?? '(none)');
  }
  const messages = [
    ...(task.writer.system ? [{ role: 'system', content: task.writer.system }] : []),
    { role: 'user', content: render(s.template, vars) },
  ];
  return {
    messages,
    max_tokens: s.maxTokens,
    ...(s.reasoning ? { reasoning: s.reasoning } : {}),
    ...(task.writer.responseFormat ? { response_format: task.writer.responseFormat } : {}),
  };
}

export class BatchFailedError extends Error {
  constructor(batchId: string, model: string, reason: string) {
    super(`Batch ${batchId} (${model}) failed as a whole: ${reason}\nFix the task settings, then resume.`);
    this.name = 'BatchFailedError';
  }
}

export class TruncatedOutputError extends Error {
  constructor(round: 1 | 2, count: number, maxTokens: number) {
    super(
      `${count} round-${round} answers were cut off at max_tokens=${maxTokens}, usually by hidden reasoning. ` +
        `This is a task setting, not a flaky row: raise writer.maxTokens or set writer.reasoning, then resume.`,
    );
    this.name = 'TruncatedOutputError';
  }
}

/**
 * Expected cost of a batch, for the cost cap. Output length comes from this model's earlier answers
 * in the run (x1.5); before there are any, a quarter of max_tokens. Assuming every row uses all of
 * max_tokens overestimated the Opus baseline 3x and blocked it.
 */
export function estimateCost(
  requests: BatchRequest[],
  price: { inputPerToken: number; outputPerToken: number },
  maxTokens: number,
  st: RunState,
  model: string,
): number {
  const inputTokens = requests.reduce((n, r) => n + JSON.stringify(r.body).length / 4, 0);
  const seen = [...st.results.values()].filter((r) => r.ok && r.model === model).map((r) => r.outputTokens);
  const perRow = seen.length >= 20 ? Math.min(maxTokens, (1.5 * seen.reduce((a, b) => a + b, 0)) / seen.length) : maxTokens / 4;
  return inputTokens * price.inputPerToken + requests.length * perRow * price.outputPerToken;
}

async function collectBatch(ctx: PipelineContext, batch: BatchInfo): Promise<void> {
  log(ctx, `round ${batch.round}: waiting for batch ${batch.batchId} (${batch.customIds.length} rows)`);
  const final = await ctx.batch.waitForTerminal(batch.batchId, {
    ...(ctx.pollIntervalMs !== undefined ? { intervalMs: ctx.pollIntervalMs } : {}),
    onStatus: (status) => {
      ctx.ledger.append({ t: 'batch_status', batchId: batch.batchId, status });
      log(ctx, `  batch ${batch.batchId}: ${status}`);
    },
  });

  const st = replay(ctx.ledger.read());
  const price = ctx.prices[batch.model] ?? { inputPerToken: 0, outputPerToken: 0 };
  const expected = new Set(batch.customIds);
  const rowIdByCid = new Map(ctx.rows.map((r) => [customId(r.id, batch.round), r.id]));
  const rowIdOf = (cid: string): string => {
    const id = rowIdByCid.get(cid);
    if (id === undefined) throw new Error(`Batch ${batch.batchId} has custom_id ${cid}, which matches no row in this run`);
    return id;
  };
  const seen = new Set<string>();
  let rowCost = 0;
  let truncated = 0;

  for (const line of final.results) {
    if (!expected.has(line.custom_id) || seen.has(line.custom_id)) continue;
    seen.add(line.custom_id);
    if (st.results.get(line.custom_id)?.batchId === batch.batchId) continue; // already saved before a crash
    const costUsd = line.inputTokens * price.inputPerToken + line.outputTokens * price.outputPerToken;
    rowCost += costUsd;
    if (line.truncated) truncated++;
    ctx.ledger.append({
      t: 'batch_result',
      batchId: batch.batchId,
      round: batch.round,
      model: batch.model,
      customId: line.custom_id,
      rowId: rowIdOf(line.custom_id),
      ok: line.ok,
      ...(line.text !== undefined ? { text: line.text } : {}),
      ...(line.error !== undefined ? { error: line.error } : {}),
      inputTokens: line.inputTokens,
      outputTokens: line.outputTokens,
      costUsd,
    });
  }
  for (const cid of expected) {
    if (seen.has(cid) || st.results.get(cid)?.batchId === batch.batchId) continue;
    ctx.ledger.append({
      t: 'batch_result',
      batchId: batch.batchId,
      round: batch.round,
      model: batch.model,
      customId: cid,
      rowId: rowIdOf(cid),
      ok: false,
      error: `missing from results (batch ${final.status})`,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  }
  ctx.ledger.append({
    t: 'batch_finished',
    batchId: batch.batchId,
    status: final.status,
    costUsd: final.costUsd,
    undecodable: final.undecodable,
  });
  ctx.budget.charge(final.costUsd ?? rowCost);
  if (final.undecodable) log(ctx, `  warning: ${final.undecodable} result lines could not be decoded`);
  if (final.status === 'failed' && final.error) {
    // The provider rejected the batch as a whole (e.g. a setting the model does not allow).
    // Sending the same requests again would fail the same way.
    throw new BatchFailedError(batch.batchId, batch.model, final.error);
  }
  // A few cut-off answers are a model rambling on that row: they flow on as failures and get
  // escalated. Many of them mean the task's max_tokens or reasoning setting is wrong.
  const tolerance = ctx.truncationTolerance ?? 0.05;
  // Small batches (e.g. retries) may always lose one row; a tolerance of 0 allows none.
  const allowed = tolerance > 0 ? Math.max(1, tolerance * batch.customIds.length) : 0;
  if (truncated > allowed) {
    throw new TruncatedOutputError(batch.round, truncated, writerSettings(ctx.task, batch.round, ctx.mode).maxTokens);
  }
  if (truncated) log(ctx, `  ${truncated} answer(s) cut off at max_tokens; treated as failed rows`);
}

async function verifyRound(ctx: PipelineContext, round: 1 | 2, rows: RowRecord[]): Promise<void> {
  const st = replay(ctx.ledger.read());
  const question = verifyQuestion(ctx.task);
  const items: DecisionItem[] = [];
  for (const r of rows) {
    const res = st.results.get(customId(r.id, round));
    if (!res?.ok || st.verify.has(verifyKey(r.id, round))) continue;
    const parsed = parseWriterOutput(ctx.task, res.text ?? '');
    if (!parsed.ok) continue; // invalid output counts as rejected without spending a decision call
    items.push({
      rowId: r.id,
      round,
      stage: 'verify',
      state: verifyState(ctx.task, r.data, parsed.value),
      questions: { verdict: question },
    });
  }
  if (!items.length) return;
  log(ctx, `round ${round}: verifying ${items.length} answers with ${ctx.verifyDecider.id}`);
  await runDecisions(ctx, ctx.verifyDecider, items);
}

/**
 * Works out each row's outcome from the ledger and the thresholds. Pure, so a `collect` run (every
 * row through every stage) can be replayed under any thresholds to see what the pipeline would do.
 */
export function computeOutcomes(
  st: RunState,
  ctx: Pick<PipelineContext, 'task' | 'rows' | 'thresholds' | 'maxAttempts' | 'mode'>,
): RowOutcome[] {
  const maxAttempts = ctx.maxAttempts ?? 2;
  return ctx.rows.map((row): RowOutcome => {
    const base = { rowId: row.id, data: row.data, costUsd: st.costByRow.get(row.id) ?? 0 };
    const pending: RowOutcome = { ...base, status: 'pending', answer: '', confidence: null, verdict: '', model: '', round: 0 };

    if (ctx.mode === 'baseline') {
      const cid = customId(row.id, 1);
      const res = st.results.get(cid);
      if (!res || st.inFlight.has(cid)) return pending;
      if (!res.ok && (st.attempts.get(cid) ?? 0) < maxAttempts) return pending;
      const parsed = res.ok ? parseWriterOutput(ctx.task, res.text ?? '') : undefined;
      if (!parsed?.ok) {
        const verdict = res.ok ? 'invalid_output' : 'writer_failed';
        return { ...base, status: 'flagged', answer: (res.text ?? '').trim(), confidence: null, verdict, model: res.model, round: 1 };
      }
      return { ...base, status: 'accepted', answer: parsed.value, confidence: null, verdict: 'baseline', model: res.model, round: 1 };
    }

    if (ctx.task.triage) {
      const tri = st.triage.get(row.id);
      if (!tri) return pending;
      const o = triageOutcome(asChoice(tri.answers.answer), ctx.thresholds.t0);
      if (o.accepted) {
        return { ...base, status: 'accepted', answer: o.answer, confidence: o.probability, verdict: 'triage', model: tri.model, round: 0 };
      }
    }

    for (const round of [1, 2] as const) {
      const cid = customId(row.id, round);
      const res = st.results.get(cid);
      const isLast = round === 2;
      let rejected: RowOutcome;

      if (!res || st.inFlight.has(cid)) return { ...pending, round };
      if (!res.ok) {
        if ((st.attempts.get(cid) ?? 0) < maxAttempts) return { ...pending, round };
        rejected = { ...base, status: 'flagged', answer: '', confidence: null, verdict: 'writer_failed', model: res.model, round };
      } else {
        const parsed = parseWriterOutput(ctx.task, res.text ?? '');
        if (!parsed.ok) {
          rejected = { ...base, status: 'flagged', answer: (res.text ?? '').trim(), confidence: null, verdict: 'invalid_output', model: res.model, round };
        } else {
          const v = st.verify.get(verifyKey(row.id, round));
          if (!v) return { ...pending, round };
          const threshold = round === 1 ? ctx.thresholds.t1 : ctx.thresholds.t2;
          const o = verifyOutcome(asChoice(v.answers.verdict), threshold);
          const outcome = { ...base, answer: parsed.value, confidence: o.probability, verdict: o.verdict, model: res.model, round };
          if (o.accepted) return { ...outcome, status: 'accepted' };
          rejected = { ...outcome, status: 'flagged' };
        }
      }
      if (isLast) return rejected;
    }
    return pending;
  });
}
