import { asChoice } from '../decide/model.ts';
import { customId, verifyKey, type DecisionEvent, type RunState } from '../ledger.ts';
import type { PipelineContext, RowOutcome, RowRecord } from '../pipeline.ts';
import { parseExtraction, type TaskDefinition } from '../task.ts';
import { verifyOutcome, type Verdict } from '../verdict.ts';

// Per-field outcomes of an extraction run, derived from the ledger and the thresholds. Pure, like
// computeOutcomes: a `collect` ledger can be replayed under any thresholds.

export interface FieldOutcome {
  rowId: string;
  field: string;
  status: 'accepted' | 'flagged' | 'pending';
  /** The tool's own answer for this field (kept even when flagged). */
  value: string | null;
  /** p(supported) of the verdict that decided it. */
  confidence: number | null;
  verdict: Verdict | 'baseline' | '';
  /** Writer model that produced `value`. */
  model: string;
  round: 1 | 2;
  /** The document's total cost divided by the number of fields. */
  costUsd: number;
}

type WriterResult =
  | { state: 'pending' }
  | { state: 'failed'; model: string }
  | { state: 'invalid'; model: string }
  | { state: 'ok'; model: string; values: Record<string, string | null> };

function writerResult(st: RunState, task: TaskDefinition, rowId: string, round: 1 | 2, maxAttempts: number): WriterResult {
  const cid = customId(rowId, round);
  const res = st.results.get(cid);
  if (!res || st.inFlight.has(cid)) return { state: 'pending' };
  if (!res.ok) return (st.attempts.get(cid) ?? 0) < maxAttempts ? { state: 'pending' } : { state: 'failed', model: res.model };
  const parsed = parseExtraction(task, res.text ?? '');
  return parsed.ok ? { state: 'ok', model: res.model, values: parsed.values } : { state: 'invalid', model: res.model };
}

/**
 * The fields of a document a round's verify event does not accept at `threshold`. With no verify event
 * (writer failed, invalid output, or not verified yet) every field counts as not accepted. A field the
 * event has no answer for is cannot_tell with probability 0.
 */
export function unacceptedFields(task: TaskDefinition, st: RunState, rowId: string, round: 1 | 2, threshold: number): string[] {
  const fields = task.extract!.fields;
  const v = st.verify.get(verifyKey(rowId, round));
  if (!v) return [...fields];
  return fields.filter((f) => !verifyOutcome(asChoice(v.answers[f]), threshold).accepted);
}

type OutcomeContext = Pick<PipelineContext, 'task' | 'rows' | 'thresholds' | 'maxAttempts' | 'mode'>;

export function computeFieldOutcomes(st: RunState, ctx: OutcomeContext, opts: { maxRound?: 1 | 2 } = {}): FieldOutcome[] {
  return ctx.rows.flatMap((row) => rowFieldOutcomes(st, ctx, row, opts.maxRound ?? 2));
}

function rowFieldOutcomes(st: RunState, ctx: OutcomeContext, row: RowRecord, maxRound: 1 | 2): FieldOutcome[] {
  const { task } = ctx;
  const fields = task.extract!.fields;
  const maxAttempts = ctx.maxAttempts ?? 2;
  const costUsd = (st.costByRow.get(row.id) ?? 0) / fields.length;
  const make = (
    field: string,
    status: FieldOutcome['status'],
    value: string | null,
    confidence: number | null,
    verdict: FieldOutcome['verdict'],
    model: string,
    round: 1 | 2,
  ): FieldOutcome => ({ rowId: row.id, field, status, value, confidence, verdict, model, round, costUsd });
  const allPending = (round: 1 | 2) => fields.map((f) => make(f, 'pending', null, null, '', '', round));

  if (ctx.mode === 'baseline') {
    const w = writerResult(st, task, row.id, 1, maxAttempts);
    if (w.state === 'pending') return allPending(1);
    if (w.state !== 'ok') {
      const verdict = w.state === 'failed' ? 'writer_failed' : 'invalid_output';
      return fields.map((f) => make(f, 'flagged', null, null, verdict, w.model, 1));
    }
    return fields.map((f) => make(f, 'accepted', w.values[f] ?? null, null, 'baseline', w.model, 1));
  }

  // ---- round 1
  const w1 = writerResult(st, task, row.id, 1, maxAttempts);
  if (w1.state === 'pending') return allPending(1);
  let v1: DecisionEvent | undefined;
  if (w1.state === 'ok') {
    v1 = st.verify.get(verifyKey(row.id, 1));
    if (!v1) return allPending(1);
  }
  const r1 = fields.map((f) => {
    if (w1.state !== 'ok') {
      const verdict: Verdict = w1.state === 'failed' ? 'writer_failed' : 'invalid_output';
      return { field: f, accepted: false, value: null as string | null, confidence: null as number | null, verdict, model: w1.model };
    }
    const o = verifyOutcome(asChoice(v1!.answers[f]), ctx.thresholds.t1);
    return { field: f, accepted: o.accepted, value: w1.values[f] ?? null, confidence: o.probability as number | null, verdict: o.verdict, model: w1.model };
  });
  const from1 = (x: (typeof r1)[number], status: 'accepted' | 'flagged') => make(x.field, status, x.value, x.confidence, x.verdict, x.model, 1);
  if (r1.every((x) => x.accepted)) return r1.map((x) => from1(x, 'accepted'));
  if (maxRound === 1) return r1.map((x) => from1(x, x.accepted ? 'accepted' : 'flagged'));

  // ---- round 2: only for the fields round 1 did not accept
  const w2 = writerResult(st, task, row.id, 2, maxAttempts);
  if (w2.state === 'pending') return r1.map((x) => (x.accepted ? from1(x, 'accepted') : make(x.field, 'pending', null, null, '', '', 2)));
  if (w2.state !== 'ok') {
    return r1.map((x) => {
      if (x.accepted) return from1(x, 'accepted');
      if (w1.state === 'ok') return from1(x, 'flagged');
      const verdict = w2.state === 'failed' ? 'writer_failed' : 'invalid_output';
      return make(x.field, 'flagged', null, null, verdict, w2.model, 2);
    });
  }
  const v2 = st.verify.get(verifyKey(row.id, 2));
  return r1.map((x) => {
    if (x.accepted) return from1(x, 'accepted');
    if (!v2) return make(x.field, 'pending', null, null, '', '', 2);
    const o = verifyOutcome(asChoice(v2.answers[x.field]), ctx.thresholds.t2);
    return make(x.field, o.accepted ? 'accepted' : 'flagged', w2.values[x.field] ?? null, o.probability, o.verdict, w2.model, 2);
  });
}

/** Document-level outcome from the field outcomes of one document (given in field order). */
export function documentOutcome(row: RowRecord, fields: FieldOutcome[], fieldOrder: readonly string[]): RowOutcome {
  const base = { rowId: row.id, data: row.data, costUsd: fields.reduce((n, f) => n + f.costUsd, 0) };
  const answer = JSON.stringify(Object.fromEntries(fieldOrder.map((name) => [name, fields.find((f) => f.field === name)?.value ?? null])));
  const latest = fields.reduce((a, b) => (b.round > a.round ? b : a), fields[0]!);
  const round = latest.round;
  const model = fields.filter((f) => f.round === round).find((f) => f.model)?.model ?? latest.model;

  if (fields.some((f) => f.status === 'pending')) {
    return { ...base, status: 'pending', answer: '', confidence: null, verdict: '', model: '', round };
  }
  const confidence = fields.some((f) => f.confidence === null) ? null : Math.min(...fields.map((f) => f.confidence!));
  const unaccepted = fields.filter((f) => f.status !== 'accepted');
  if (!unaccepted.length) {
    const verdict = fields.every((f) => f.verdict === 'baseline') ? 'baseline' : 'supported';
    return { ...base, status: 'accepted', answer, confidence, verdict, model, round };
  }
  const lowest = unaccepted.reduce((a, b) => ((b.confidence ?? -1) < (a.confidence ?? -1) ? b : a));
  return { ...base, status: 'flagged', answer, confidence, verdict: lowest.verdict as RowOutcome['verdict'], model, round };
}

export function computeExtractOutcomes(st: RunState, ctx: OutcomeContext): RowOutcome[] {
  const fields = computeFieldOutcomes(st, ctx);
  const byRow = new Map<string, FieldOutcome[]>();
  for (const f of fields) (byRow.get(f.rowId) ?? byRow.set(f.rowId, []).get(f.rowId)!).push(f);
  return ctx.rows.map((row) => documentOutcome(row, byRow.get(row.id)!, ctx.task.extract!.fields));
}

/** Labeled correctness of a document-level answer: every field correct. Undefined for non-extract tasks. */
export function documentCorrectness(task: TaskDefinition): ((answer: string, label: string | undefined) => boolean) | undefined {
  const ex = task.extract;
  if (!ex) return undefined;
  return (answer, label) => {
    if (!label?.trim() || !answer) return false;
    let values: Record<string, unknown>;
    try {
      values = JSON.parse(answer) as Record<string, unknown>;
    } catch {
      return false;
    }
    return ex.fields.every((f) => ex.isCorrect(f, typeof values[f] === 'string' ? (values[f] as string) : null, label));
  };
}
