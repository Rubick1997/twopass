import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { BenchState } from '../bench.ts';
import { requiredColumns } from '../check.ts';
import { asChoice, CANNOT_TELL } from '../decide/model.ts';
import type { FetchFn } from '../http.ts';
import { customId, parseLedger, replay, verifyKey, type LedgerEvent, type RunState } from '../ledger.ts';
import { isLockLive, isPidAlive, readRunLock } from '../lock.ts';
import { computeOutcomes, writerSettings, type RowOutcome, type RowRecord } from '../pipeline.ts';
import {
  allowedAnswers,
  appendOverride,
  decisionInputSchema,
  foldOverrides,
  makeOverride,
  MAX_ANSWER_CHARS,
  MAX_NOTE_CHARS,
  OverrideError,
  overridesPath,
  validateAnswer,
  readOverrides,
  type FoldedOutcome,
} from '../overrides.ts';
import { matchesLabel, reviewSummary, rewriteOutputs, summarize, type ReviewSummary } from '../report.ts';
import type { BenchReport } from '../bench.ts';
import { readCalibration } from '../runner.ts';
import type { ScoreRecord } from '../score.ts';
import { loadRun, type RunManifest } from '../run.ts';
import { batchDurationMs, median, spendByStage, type StageSpend } from '../stats.ts';
import { bucketsFromOpenRouter } from '../cost/usage.ts';
import { loadTask, parseWriterOutput, render, type TaskDefinition } from '../task.ts';
import { triageOutcome, verifyOutcome } from '../verdict.ts';
import type {
  ActivityItem,
  BalanceResponse,
  BatchRow,
  BenchConfigSummary,
  BenchDetail,
  BenchesResponse,
  BenchListItem,
  BenchRef,
  BenchReportResponse,
  ExpectedFinish,
  ExploreCalibration,
  ExploreCaching,
  RunCachingKind,
  ExploreResponse,
  ExploreRow,
  ExploreThresholds,
  OutcomeCounts,
  OutputsResponse,
  OverrideResponse,
  Reserve,
  ReviewAccuracy,
  ReviewCounts,
  ReviewFilter,
  ReviewResponse,
  ReviewRow,
  RoundAnswer,
  TriageInfo,
  RunActivity,
  RunDetail,
  RunListItem,
  RunsResponse,
  RunStatus,
  StageKey,
  StageProgress,
} from './api-types.ts';
import { shortBatchId, shortModel } from './models.ts';

// The local UI's API as plain functions: a runs folder in, plain objects out. server.ts only
// routes, sets headers and serves files. Everything is derived from the ledger (replay) and
// computeOutcomes, the same code the CLI uses, so the UI and the CLI cannot disagree.

export interface ApiOptions {
  /** Clock, for tests. */
  now?: () => number;
  /** Process liveness check, for tests. */
  pidAlive?: (pid: number) => boolean;
  /** The directory a user's shell would be in; decides whether resume commands need `--runs`. */
  cwd?: string;
}

export class NotFoundError extends Error {}
export class BadRequestError extends Error {}

/** Default batch duration when no batch of a model has finished anywhere in the runs folder. */
export const DEFAULT_BATCH_MS = 7 * 60_000;
/** OpenRouter batches end within 24 h; an older unfinished batch holds no reserve any more. */
const BATCH_WINDOW_MS = 24 * 3600_000;
const RECENT_LIMIT = 50;

const ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Validates a run or bench ID and returns its folder. Rejects anything outside
 * `^[A-Za-z0-9_.-]+$` and anything that does not resolve to a folder strictly inside the runs root.
 */
export function resolveInside(runsRoot: string, id: string): string {
  if (!ID_PATTERN.test(id)) throw new BadRequestError('Invalid ID');
  const root = resolve(runsRoot);
  const dir = resolve(root, id);
  if (!dir.startsWith(root + sep) || dir.slice(root.length + 1).includes(sep)) throw new BadRequestError('Invalid ID');
  return dir;
}

// ---------------------------------------------------------------- loading (cached by file stats)

interface LoadedRun {
  key: string;
  dir: string;
  manifest: RunManifest;
  records: RowRecord[];
  st: RunState;
  task: TaskDefinition | null;
  problem?: string;
  outcomes: RowOutcome[] | null;
  counts: OutcomeCounts | null;
  recent: ActivityItem[];
  check: RunDetail['check'];
}

const runCache = new Map<string, LoadedRun>();

function statKey(path: string): string {
  try {
    const s = statSync(path);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return '-';
  }
}

async function loadRunCached(dir: string): Promise<LoadedRun> {
  const key = ['manifest.json', 'ledger.jsonl', 'rows.jsonl'].map((f) => statKey(join(dir, f))).join('|');
  const hit = runCache.get(dir);
  if (hit && hit.key === key) return hit;

  const { manifest, records } = loadRun(dir);
  const ledgerPath = join(dir, 'ledger.jsonl');
  let events: LedgerEvent[] = [];
  let problem: string | undefined;
  try {
    events = existsSync(ledgerPath) ? parseLedger(readFileSync(ledgerPath, 'utf8'), ledgerPath) : [];
  } catch (err) {
    problem = (err as Error).message;
  }
  const st = replay(events);
  let task: TaskDefinition | null = null;
  try {
    task = await loadTask(manifest.taskPath);
  } catch (err) {
    problem ??= `Cannot load the task file ${manifest.taskPath}: ${(err as Error).message}`;
  }
  const outcomes =
    task && !problem
      ? computeOutcomes(st, { task, rows: records, thresholds: manifest.thresholds, mode: manifest.mode })
      : null;
  const loaded: LoadedRun = {
    key,
    dir,
    manifest,
    records,
    st,
    task,
    ...(problem ? { problem } : {}),
    outcomes,
    counts: outcomes ? countOutcomes(outcomes) : null,
    recent: describeEvents(events, RECENT_LIMIT),
    check: readCheck(dir),
  };
  runCache.set(dir, loaded);
  return loaded;
}

function countOutcomes(outcomes: RowOutcome[]): OutcomeCounts {
  const c: OutcomeCounts = { accepted: 0, flagged: 0, pending: 0, acceptedRound0: 0, rerun: 0 };
  for (const o of outcomes) {
    c[o.status]++;
    if (o.status === 'accepted' && o.round === 0) c.acceptedRound0++;
    if (o.round === 2) c.rerun++;
  }
  return c;
}

function readCheck(dir: string): RunDetail['check'] {
  try {
    const r = JSON.parse(readFileSync(join(dir, 'check-report.json'), 'utf8')) as { warnings?: unknown[]; errors?: unknown[]; changes?: unknown[] };
    return { warnings: r.warnings?.length ?? 0, errors: r.errors?.length ?? 0, changes: r.changes?.length ?? 0 };
  } catch {
    return null;
  }
}

function listDirs(root: string, marker: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && ID_PATTERN.test(d.name) && existsSync(join(root, d.name, marker)))
    .map((d) => d.name);
}

function readBench(dir: string): BenchState {
  return JSON.parse(readFileSync(join(dir, 'bench.json'), 'utf8')) as BenchState;
}

/** runId → the bench it belongs to. */
function benchIndex(root: string): Map<string, { ref: BenchRef; bench: BenchState }> {
  const index = new Map<string, { ref: BenchRef; bench: BenchState }>();
  for (const id of listDirs(root, 'bench.json')) {
    let bench: BenchState;
    try {
      bench = readBench(join(root, id));
    } catch {
      continue;
    }
    if (bench.calibrationRunId) index.set(bench.calibrationRunId, { ref: { benchId: id, config: 'calibration' }, bench });
    for (const [config, runId] of Object.entries(bench.testRuns ?? {})) index.set(runId, { ref: { benchId: id, config }, bench });
  }
  return index;
}

// ---------------------------------------------------------------- status

function runStatus(run: LoadedRun, o: ApiOptions): { status: RunStatus; activity: RunActivity; lock: RunDetail['lock'] } {
  const lock = readRunLock(run.dir);
  const live = isLockLive(lock, now(o), o.pidAlive ?? isPidAlive);
  const lockInfo = lock ? { ...lock, live } : null;
  if (live) {
    const waiting = [...run.st.batches.values()].some((b) => !b.finished);
    return { status: 'running', activity: waiting ? 'waiting_on_batch' : 'working', lock: lockInfo };
  }
  if (!run.counts) return { status: 'unknown', activity: null, lock: lockInfo };
  return { status: run.counts.pending === 0 ? 'finished' : 'stopped', activity: null, lock: lockInfo };
}

const now = (o: ApiOptions) => (o.now ? o.now() : Date.now());

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function resumeCommand(runsRoot: string, runId: string, bench: { ref: BenchRef; bench: BenchState } | undefined, o: ApiOptions): string {
  const cwd = o.cwd ?? process.cwd();
  const runs = resolve(runsRoot) === resolve(cwd, 'runs') ? '' : ` --runs ${shellQuote(resolve(runsRoot))}`;
  if (bench) {
    const cap = bench.bench.maxUsd !== undefined ? String(bench.bench.maxUsd) : '<usd>';
    return `twopass bench banking77 --id ${bench.ref.benchId} --max-usd ${cap}${runs}`;
  }
  return `twopass resume ${runId}${runs}`;
}

function toListItem(run: LoadedRun, o: ApiOptions, bench: { ref: BenchRef; bench: BenchState } | undefined): RunListItem {
  const m = run.manifest;
  const { status, activity } = runStatus(run, o);
  const review = reviewOf(run);
  const benchCap = bench?.bench.maxUsd;
  const maxUsd = m.maxUsd ?? benchCap ?? null;
  return {
    runId: m.runId,
    createdAt: m.createdAt,
    mode: m.mode,
    rowCount: m.rowCount,
    models: m.models,
    status,
    activity,
    outcomes: run.counts,
    progress: run.counts && m.rowCount ? (m.rowCount - run.counts.pending) / m.rowCount : run.counts ? 1 : null,
    spentUsd: run.st.spentUsd,
    maxUsd,
    capScope: m.maxUsd !== undefined ? 'run' : benchCap !== undefined ? 'bench' : null,
    lastEventAt: run.st.lastAt ?? null,
    bench: bench?.ref ?? null,
    review: review ? { flagged: review.summary.flagged, reviewed: review.summary.reviewed, remaining: review.summary.remaining } : null,
    ...(run.problem ? { problem: run.problem } : {}),
  };
}

// ---------------------------------------------------------------- GET /api/runs

async function loadAllRuns(root: string): Promise<LoadedRun[]> {
  const runs: LoadedRun[] = [];
  for (const id of listDirs(root, 'manifest.json')) {
    try {
      runs.push(await loadRunCached(join(resolve(root), id)));
    } catch {
      // unreadable manifest or rows: not shown
    }
  }
  return runs;
}

const newestFirst = (a: { createdAt: string }, b: { createdAt: string }) => b.createdAt.localeCompare(a.createdAt);

export async function listRuns(runsRoot: string, o: ApiOptions = {}): Promise<RunsResponse> {
  const index = benchIndex(runsRoot);
  const runs = (await loadAllRuns(runsRoot)).map((r) => toListItem(r, o, index.get(r.manifest.runId)));
  return { runsRoot: resolve(runsRoot), runs: runs.sort(newestFirst) };
}

// ---------------------------------------------------------------- GET /api/runs/:id

export async function getRun(runsRoot: string, runId: string, o: ApiOptions = {}): Promise<RunDetail> {
  const dir = resolveInside(runsRoot, runId);
  if (!existsSync(join(dir, 'manifest.json'))) throw new NotFoundError(`No run ${runId}`);
  const run = await loadRunCached(dir);
  const bench = benchIndex(runsRoot).get(run.manifest.runId);
  const item = toListItem(run, o, bench);
  const { lock } = runStatus(run, o);
  const m = run.manifest;
  const stages = run.task ? stageProgress(run.st, run.task, m, run.records) : [];
  const activeStage = item.status === 'finished' ? null : (stages.find((s) => s.state === 'active')?.key ?? null);
  const all = await loadAllRuns(runsRoot);
  const medians = batchMedians(all.map((r) => r.st));
  const nowMs = now(o);
  const batches = batchRows(run, nowMs);

  return {
    ...item,
    manifest: {
      taskPath: m.taskPath,
      inputPath: m.inputPath,
      labelColumn: m.labelColumn ?? null,
      thresholds: m.thresholds,
      thresholdsSource: m.thresholdsSource,
      prices: m.prices,
      servedModels: m.servedModels ?? [],
    },
    check: run.check,
    resumeCommand: item.status === 'stopped' ? resumeCommand(runsRoot, m.runId, bench, o) : null,
    lock,
    stages,
    activeStage,
    batches,
    spend: spendByStage(run.st),
    precision: run.outcomes && m.labelColumn ? (summarize(run.outcomes, run.st, m.labelColumn).precision ?? null) : null,
    expectedFinish: expectedFinish({ status: item.status, st: run.st, stages, models: m.models, mode: m.mode, medians, nowMs }),
    reserveUsd: batches.reduce((n, b) => n + (b.reserveUsd ?? 0), 0),
    activity: item.activity,
    recent: run.recent,
  };
}

// ---------------------------------------------------------------- stage progress

/**
 * Which rows each stage handles, following executePipeline's routing. While an earlier stage is
 * unfinished, a later stage's total is an upper bound (rows that might still be routed to it).
 */
export function stageProgress(st: RunState, task: TaskDefinition, m: Pick<RunManifest, 'mode' | 'thresholds'>, rows: RowRecord[], maxAttempts = 2): StageProgress[] {
  const stages: Omit<StageProgress, 'state'>[] = [];
  const collect = m.mode === 'collect';

  /** Rows whose writer stage in `round` is settled: an answer, or out of attempts (and not in flight). */
  const writeSettled = (id: string, round: 1 | 2) => {
    const cid = customId(id, round);
    const res = st.results.get(cid);
    if (!res || st.inFlight.has(cid)) return false;
    return res.ok || (st.attempts.get(cid) ?? 0) >= maxAttempts;
  };
  const parsedOk = (id: string, round: 1 | 2) => {
    const res = st.results.get(customId(id, round));
    return !!res?.ok && parseWriterOutput(task, res.text ?? '').ok;
  };
  const writeStage = (round: 1 | 2, ids: string[], estimate: boolean): Omit<StageProgress, 'state'> => ({
    key: round === 1 ? 'write1' : 'write2',
    round,
    label: m.mode === 'baseline' ? 'Write (baseline)' : round === 1 ? 'Write' : 'Re-run',
    total: ids.length,
    totalIsEstimate: estimate,
    sent: ids.filter((id) => (st.attempts.get(customId(id, round)) ?? 0) > 0).length,
    done: ids.filter((id) => writeSettled(id, round)).length,
  });
  const verifyStage = (round: 1 | 2, ids: string[], estimate: boolean): Omit<StageProgress, 'state'> => {
    // rows that will be verified: a valid answer; while writing, rows not settled yet might be too
    const toVerify = ids.filter((id) => parsedOk(id, round));
    const unsettled = ids.filter((id) => !writeSettled(id, round)).length;
    return {
      key: round === 1 ? 'verify1' : 'verify2',
      round,
      label: 'Verify',
      total: toVerify.length + unsettled,
      totalIsEstimate: estimate || unsettled > 0,
      done: toVerify.filter((id) => st.verify.has(verifyKey(id, round))).length,
    };
  };

  if (m.mode === 'baseline') {
    stages.push(writeStage(1, rows.map((r) => r.id), false));
    return withStates(stages);
  }

  let round1 = rows.map((r) => r.id);
  let estimate1 = false;
  if (task.triage) {
    const done = rows.filter((r) => st.triage.has(r.id)).length;
    stages.push({ key: 'triage', round: 0, label: 'Triage', total: rows.length, totalIsEstimate: false, done });
    if (!collect) round1 = rows.filter((r) => !triageOutcome(asChoice(st.triage.get(r.id)?.answers.answer), m.thresholds.t0).accepted).map((r) => r.id);
    estimate1 = done < rows.length;
  }
  stages.push(writeStage(1, round1, estimate1));
  const v1 = verifyStage(1, round1, estimate1);
  stages.push(v1);

  // round 2: rows round 1 did not accept (or, in collect mode, every round-1 row)
  const round2 = collect
    ? round1
    : round1.filter((id) => {
        if (!writeSettled(id, 1)) return true; // undecided: may still need round 2
        if (!parsedOk(id, 1)) return true; // failed or invalid answer
        const v = st.verify.get(verifyKey(id, 1));
        if (!v) return true;
        return !verifyOutcome(asChoice(v.answers.verdict), m.thresholds.t1).accepted;
      });
  const estimate2 = v1.totalIsEstimate || v1.done < v1.total;
  stages.push(writeStage(2, round2, estimate2));
  stages.push(verifyStage(2, round2, estimate2));
  return withStates(stages);
}

function withStates(stages: Omit<StageProgress, 'state'>[]): StageProgress[] {
  let activeFound = false;
  return stages.map((s) => {
    const complete = !s.totalIsEstimate && s.done >= s.total;
    let state: StageProgress['state'];
    if (complete) state = s.total === 0 ? 'skipped' : 'done';
    else if (!activeFound) {
      state = 'active';
      activeFound = true;
    } else state = 'waiting';
    return { ...s, state };
  });
}

// ---------------------------------------------------------------- batches

function batchRows(run: LoadedRun, nowMs: number): BatchRow[] {
  return [...run.st.batches.values()]
    .map((b): BatchRow => ({
      batchId: b.batchId,
      shortId: shortBatchId(b.batchId),
      round: b.round,
      model: b.model,
      rows: b.customIds.length,
      status: b.status,
      finished: b.finished,
      submittedAt: b.at,
      finishedAt: b.finishedAt ?? null,
      durationMs: batchDurationMs(b),
      costUsd: b.reportedCostUsd ?? b.resultCostUsd,
      undecodable: b.undecodable ?? 0,
      reserveUsd: b.finished || nowMs - Date.parse(b.at) > BATCH_WINDOW_MS ? null : batchReserve(run, b.round, b.model, b.customIds),
    }))
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

/**
 * Our estimate of what OpenRouter holds for an in-flight batch: it reserves the worst case at
 * submit time, every row at max_tokens. rows × (max_tokens × output price + input tokens × input
 * price), with the run's pinned prices. Input tokens: the average of this model's earlier answers
 * in the run, otherwise the rendered prompt's length / 4.
 */
export function batchReserve(run: Pick<LoadedRun, 'st' | 'task' | 'manifest' | 'records'>, round: 1 | 2, model: string, customIds: string[]): number | null {
  const price = run.manifest.prices[model];
  if (!price || !run.task) return null;
  const s = writerSettings(run.task, round, run.manifest.mode);
  const seen = [...run.st.results.values()].filter((r) => r.ok && r.model === model).map((r) => r.inputTokens);
  let inputTokens: number;
  if (seen.length) inputTokens = seen.reduce((a, b) => a + b, 0) / seen.length;
  else {
    const system = run.task.writer.system?.length ?? 0;
    const byCid = new Map(run.records.map((r) => [customId(r.id, round), r]));
    const lengths = customIds.map((cid) => {
      const row = byCid.get(cid);
      return row ? render(s.template, { previous_answer: '', ...row.data }).length : 0;
    });
    inputTokens = (system + lengths.reduce((a, b) => a + b, 0) / Math.max(lengths.length, 1)) / 4;
  }
  // Uncached input price on purpose: OpenRouter reserves before it knows about cache hits.
  return customIds.length * (s.maxTokens * price.outputPerToken + inputTokens * price.inputPerToken);
}

// ---------------------------------------------------------------- expected finish

export interface MedianInfo {
  ms: number;
  n: number;
}

/** Median wall-clock of completed batches per model, across every run in the folder. */
export function batchMedians(states: RunState[]): Map<string, MedianInfo> {
  const byModel = new Map<string, number[]>();
  for (const st of states) {
    for (const b of st.batches.values()) {
      const d = batchDurationMs(b);
      if (d === null || b.status !== 'completed') continue;
      byModel.set(b.model, [...(byModel.get(b.model) ?? []), d]);
    }
  }
  return new Map([...byModel].map(([model, ds]) => [model, { ms: median(ds), n: ds.length }]));
}

/**
 * Rough: each in-flight batch ends at submitted + the median duration of finished batches of the
 * same model (7 min if none), then one median round for each writer round not started yet.
 */
export function expectedFinish(x: {
  status: RunStatus;
  st: RunState;
  stages: StageProgress[];
  models: { writer: string; escalation: string };
  mode: RunManifest['mode'];
  medians: Map<string, MedianInfo>;
  nowMs: number;
}): ExpectedFinish {
  if (x.status === 'finished') return { at: null, basis: 'Finished.' };
  if (x.status !== 'running') return { at: null, basis: 'Not running, so no estimate.' };
  const med = (model: string) => x.medians.get(model) ?? { ms: DEFAULT_BATCH_MS, n: 0 };
  const describe = (model: string) => {
    const m = med(model);
    return m.n ? `median ${(m.ms / 60_000).toFixed(1)} min over ${m.n} ${shortModel(model)} batch${m.n === 1 ? '' : 'es'}` : `${shortModel(model)}: no finished batches yet, assumed 7 min`;
  };

  const parts: string[] = [];
  let end = x.nowMs;
  const inFlight = [...x.st.batches.values()].filter((b) => !b.finished);
  for (const b of inFlight) {
    end = Math.max(end, Date.parse(b.at) + med(b.model).ms);
    parts.push(`batch ${shortBatchId(b.batchId)} submitted + ${describe(b.model)}`);
  }
  const rounds = x.mode === 'baseline' ? ([1] as const) : ([1, 2] as const);
  for (const round of rounds) {
    const stage = x.stages.find((s) => s.key === (round === 1 ? 'write1' : 'write2'));
    const started = [...x.st.batches.values()].some((b) => b.round === round);
    if (!stage || started || stage.state === 'skipped' || stage.state === 'done') continue;
    if (stage.total === 0) continue;
    const model = round === 1 ? x.models.writer : x.models.escalation;
    end += med(model).ms;
    parts.push(`round ${round} not started: + ${describe(model)}`);
  }
  if (!parts.length) return { at: null, basis: 'No batch in flight or still to come; the remaining work is decision calls.' };
  return { at: new Date(end).toISOString(), basis: `Based on: ${parts.join('; ')}.` };
}

// ---------------------------------------------------------------- recent activity

const usd = (x: number) => `$${x < 0.01 ? x.toFixed(4) : x.toFixed(2)}`;

/**
 * The last `limit` things that happened, newest first, in plain words. Runs of similar events
 * (thousands of decisions, a batch's results) are folded into one line.
 */
export function describeEvents(events: LedgerEvent[], limit = RECENT_LIMIT): ActivityItem[] {
  const roundOf = new Map<string, 1 | 2>();
  const items: Array<ActivityItem & { group: string; n: number; cost: number; failed: number }> = [];
  for (const ev of events) {
    let group: string;
    let text: (n: number, cost: number, failed: number) => string;
    let cost = 0;
    let failed = 0;
    switch (ev.t) {
      case 'decision': {
        group = `decision:${ev.stage}:${ev.round}`;
        cost = ev.costUsd;
        const what = ev.stage === 'triage' ? 'triage decision' : 'answer verified';
        const whatPlural = ev.stage === 'triage' ? 'triage decisions' : 'answers verified';
        text = (n, c) => `round ${ev.round}: ${n} ${n === 1 ? what : whatPlural} by ${shortModel(ev.model)}, ${usd(c)}`;
        break;
      }
      case 'batch_submitted':
        roundOf.set(ev.batchId, ev.round);
        group = `submit:${ev.batchId}`;
        text = () => `round ${ev.round}: batch ${shortBatchId(ev.batchId)} submitted to ${shortModel(ev.model)}, ${ev.customIds.length} rows`;
        break;
      case 'batch_status':
        group = `status:${ev.batchId}:${ev.status}`;
        text = () => `round ${roundOf.get(ev.batchId) ?? '?'}: batch ${shortBatchId(ev.batchId)} is ${ev.status.replace(/_/g, ' ')}`;
        break;
      case 'batch_result':
        group = `result:${ev.batchId}`;
        cost = ev.costUsd;
        failed = ev.ok ? 0 : 1;
        text = (n, _c, f) => `round ${ev.round}: batch ${shortBatchId(ev.batchId)} returned ${n} result${n === 1 ? '' : 's'}${f ? ` (${f} failed)` : ''}`;
        break;
      case 'batch_finished': {
        group = `finished:${ev.batchId}`;
        const res = items.findLast((i) => i.group === `result:${ev.batchId}`);
        const batchCost = ev.costUsd ?? res?.cost ?? null; // provider total, else the rows' sum
        text = () =>
          `round ${roundOf.get(ev.batchId) ?? '?'}: batch ${shortBatchId(ev.batchId)} ${ev.status}` +
          `${res ? `, ${res.n} rows` : ''}${batchCost !== null ? `, ${usd(batchCost)}` : ''}` +
          `${ev.undecodable ? `, ${ev.undecodable} undecodable` : ''}`;
        break;
      }
      default:
        continue;
    }
    const last = items[items.length - 1];
    if (last && last.group === group) {
      last.n++;
      last.cost += cost;
      last.failed += failed;
      last.at = ev.at;
      last.text = text(last.n, last.cost, last.failed);
    } else {
      items.push({ group, n: 1, cost, failed, at: ev.at, text: text(1, cost, failed) });
    }
  }
  return items
    .slice(-limit)
    .reverse()
    .map(({ at, text }) => ({ at, text }));
}

// ---------------------------------------------------------------- benches

function scoresCostUsd(dir: string): number {
  const path = join(dir, 'scores.jsonl');
  if (!existsSync(path)) return 0;
  let total = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    try {
      if (line.trim()) total += (JSON.parse(line) as { costUsd?: number }).costUsd ?? 0;
    } catch {
      // torn line
    }
  }
  return total;
}

async function benchItem(runsRoot: string, benchId: string, o: ApiOptions, index: ReturnType<typeof benchIndex>): Promise<BenchListItem & { state: BenchState }> {
  const dir = resolveInside(runsRoot, benchId);
  const bench = readBench(dir);
  const summary = async (name: string, runId: string): Promise<BenchConfigSummary> => {
    const runDirPath = resolveInside(runsRoot, runId);
    if (!existsSync(join(runDirPath, 'manifest.json'))) return { name, runId, run: null };
    try {
      return { name, runId, run: toListItem(await loadRunCached(runDirPath), o, index.get(runId)) };
    } catch {
      return { name, runId, run: null };
    }
  };
  const calibration = bench.calibrationRunId ? await summary('calibration', bench.calibrationRunId) : null;
  const configs: BenchConfigSummary[] = [];
  for (const [name, runId] of Object.entries(bench.testRuns ?? {})) configs.push(await summary(name, runId));

  const runs = [calibration, ...configs].filter((c): c is BenchConfigSummary => !!c?.run);
  const spent =
    runs.reduce((n, c) => n + c.run!.spentUsd, 0) + (bench.calibrationRunId ? scoresCostUsd(resolveInside(runsRoot, bench.calibrationRunId)) : 0);
  const hasReport = existsSync(join(dir, 'bench-report.md'));
  const expected = bench.configs.length + 1; // configs + baseline
  let status: RunStatus;
  if (runs.some((c) => c.run!.status === 'running')) status = 'running';
  else if (hasReport && configs.length >= expected && runs.every((c) => c.run!.status === 'finished')) status = 'finished';
  else status = 'stopped';

  return {
    benchId: bench.benchId ?? benchId,
    createdAt: bench.createdAt,
    status,
    maxUsd: bench.maxUsd ?? null,
    spentUsd: spent,
    calibration,
    configs,
    hasReport,
    state: bench,
  };
}

export async function listBenches(runsRoot: string, o: ApiOptions = {}): Promise<BenchesResponse> {
  const index = benchIndex(runsRoot);
  const benches: BenchListItem[] = [];
  for (const id of listDirs(runsRoot, 'bench.json')) {
    try {
      const { state: _state, ...item } = await benchItem(runsRoot, id, o, index);
      benches.push(item);
    } catch {
      // unreadable bench.json
    }
  }
  return { benches: benches.sort(newestFirst) };
}

export async function getBench(runsRoot: string, benchId: string, o: ApiOptions = {}): Promise<BenchDetail> {
  const dir = resolveInside(runsRoot, benchId);
  if (!existsSync(join(dir, 'bench.json'))) throw new NotFoundError(`No bench ${benchId}`);
  const { state, ...item } = await benchItem(runsRoot, benchId, o, benchIndex(runsRoot));
  const cwd = o.cwd ?? process.cwd();
  const runs = resolve(runsRoot) === resolve(cwd, 'runs') ? '' : ` --runs ${shellQuote(resolve(runsRoot))}`;
  return {
    ...item,
    state: state as unknown as Record<string, unknown>,
    resumeCommand:
      item.status === 'stopped' ? `twopass bench banking77 --id ${benchId} --max-usd ${state.maxUsd ?? '<usd>'}${runs}` : null,
  };
}

export function getBenchReport(runsRoot: string, benchId: string): BenchReportResponse {
  const path = join(resolveInside(runsRoot, benchId), 'bench-report.md');
  if (!existsSync(path)) throw new NotFoundError(`Bench ${benchId} has no report yet`);
  return { markdown: readFileSync(path, 'utf8') };
}

// ---------------------------------------------------------------- results explorer

/**
 * Whether a run's writer calls used prompt caching. The manifest's `writerCache` (the task's `writer.cacheSystem`
 * when the run was created) wins; runs made before it existed fall back to the ledger: `cached` if any writer
 * result's raw usage has cache-read or cache-write tokens, `uncached` if there are results and none has, and
 * `null` (unknown, no label) when there are no writer results. It never reads the live task file, which may have
 * caching on for a run that had none.
 */
export function runCaching(manifest: Pick<RunManifest, 'writerCache'>, st: RunState): RunCachingKind | null {
  if (manifest.writerCache !== undefined) return manifest.writerCache ? 'cached' : 'uncached';
  if (st.results.size === 0) return null;
  for (const r of st.results.values()) {
    if (r.usage === undefined) continue;
    try {
      const b = bucketsFromOpenRouter(r.usage);
      if (b.cacheRead > 0 || b.cacheWrite > 0) return 'cached';
    } catch {
      // usage that does not add up says nothing about caching
    }
  }
  return 'uncached';
}

type CostStage = 'triage' | 'write1' | 'verify1' | 'write2' | 'verify2';

/** What one test run spent per stage and how many rows went through each stage. */
interface StageUse {
  triageModel: string;
  verifyModel: string;
  spend: Record<CostStage, number>;
  rows: Record<CostStage, number>;
}

function stageUseFromRun(manifest: RunManifest, st: RunState): StageUse {
  const spend = spendByStage(st);
  const count = (round: 1 | 2) => [...st.verify.values()].filter((d) => d.round === round).length;
  const written = (round: 1 | 2) => [...st.results.values()].filter((r) => r.round === round).length;
  return {
    triageModel: manifest.models.triage,
    verifyModel: manifest.models.verify,
    spend,
    rows: { triage: st.triage.size, write1: written(1), verify1: count(1), write2: written(2), verify2: count(2) },
  };
}

/** The same, from a config's line in bench-report.json, when its run folder is missing. */
function stageUseFromReport(c: BenchReport['configs'][number]): StageUse | null {
  if (!c.triage || !c.verify || !c.costPer1k || !c.rows) return null;
  const reach = { triage: c.rows, write1: c.rows * (1 - c.round0Share), verify1: c.rows * (1 - c.round0Share), write2: c.rows * c.escalatedShare, verify2: c.rows * c.escalatedShare };
  const spend = Object.fromEntries((Object.keys(reach) as CostStage[]).map((k) => [k, (c.costPer1k[k] * c.rows) / 1000])) as Record<CostStage, number>;
  return { triageModel: c.triage, verifyModel: c.verify, spend, rows: reach };
}

export interface UnitCosts {
  triage: Record<string, number | null>;
  verify1: Record<string, number | null>;
  verify2: Record<string, number | null>;
  write1: number | null;
  write2: number | null;
}

/** Spend divided by rows reaching the stage, pooled over the runs that ran it; null where no run did. */
export function unitCostsFrom(uses: readonly StageUse[]): UnitCosts {
  const sums = new Map<string, { usd: number; rows: number }>();
  const add = (key: string, usd: number, rows: number) => {
    if (rows <= 0) return;
    const e = sums.get(key) ?? { usd: 0, rows: 0 };
    e.usd += usd;
    e.rows += rows;
    sums.set(key, e);
  };
  for (const u of uses) {
    add(`triage|${u.triageModel}`, u.spend.triage, u.rows.triage);
    add(`verify1|${u.verifyModel}`, u.spend.verify1, u.rows.verify1);
    add(`verify2|${u.verifyModel}`, u.spend.verify2, u.rows.verify2);
    add('write1', u.spend.write1, u.rows.write1);
    add('write2', u.spend.write2, u.rows.write2);
  }
  const unit = (key: string) => {
    const e = sums.get(key);
    return e ? e.usd / e.rows : null;
  };
  const byModel = (stage: 'triage' | 'verify1' | 'verify2') =>
    Object.fromEntries([...sums.keys()].filter((k) => k.startsWith(`${stage}|`)).map((k) => [k.slice(stage.length + 1), unit(k)]));
  return { triage: byModel('triage'), verify1: byModel('verify1'), verify2: byModel('verify2'), write1: unit('write1'), write2: unit('write2') };
}

/** Replaces every per-row `usd` with this bench's unit cost for the stage (null where the bench has none). */
export function repriceRows(rows: ExploreRow[], u: UnitCosts): void {
  for (const r of rows) {
    for (const m of Object.keys(r.triage)) r.triage[m]!.usd = u.triage[m] ?? null;
    r.w1.usd = u.write1;
    r.w2.usd = u.write2;
    for (const m of Object.keys(r.verify1)) r.verify1[m]!.usd = u.verify1[m] ?? null;
    for (const m of Object.keys(r.verify2)) r.verify2[m]!.usd = u.verify2[m] ?? null;
  }
}

/** scores.jsonl as the scorer reads it: the last record per model, stage and row wins; a torn line is skipped. */
export function readScoreRecords(dir: string): ScoreRecord[] {
  const path = join(dir, 'scores.jsonl');
  if (!existsSync(path)) return [];
  const byKey = new Map<string, ScoreRecord>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as ScoreRecord;
      byKey.set(`${r.model}|${r.stage}|${r.rowId}`, r);
    } catch {
      // a torn last line
    }
  }
  return [...byKey.values()];
}

/**
 * One compact row per calibration row, for the threshold replay in ui/src/explore.ts. The run's own models
 * answer from the ledger; other models from scores.jsonl, where a verify record counts only if it judged the
 * same writer answer (the rule `scoreRun` uses). Writer correctness uses the same parse and `matchesLabel`
 * as `computeOutcomes`.
 */
export function buildExploreRows(o: {
  task: TaskDefinition;
  records: RowRecord[];
  labelColumn: string;
  st: RunState;
  runModels: { triage: string; verify: string };
  scores: ScoreRecord[];
}): { rows: ExploreRow[]; models: string[] } {
  const { task, st, runModels } = o;
  const models = new Set<string>(task.triage ? [runModels.triage, runModels.verify] : [runModels.verify]);
  const scoreIndex = new Map<string, ScoreRecord>();
  for (const r of o.scores) {
    models.add(r.model);
    scoreIndex.set(`${r.model}|${r.stage}|${r.rowId}`, r);
  }

  const triageEntry = (answer: unknown, label: string, usd: number) => {
    const a = asChoice(answer as never);
    if (!a || a.choice === CANNOT_TELL) return { p: null, correct: false, usd };
    return { p: a.probabilities[a.choice] ?? 0, correct: matchesLabel(a.choice, label), usd };
  };
  const verifyEntry = (answer: unknown, usd: number) => {
    const a = asChoice(answer as never);
    return { p: a?.choice === 'supported' ? (a.probabilities.supported ?? 0) : null, usd };
  };

  const rows = o.records.map((row): ExploreRow => {
    const label = row.data[o.labelColumn] ?? '';
    const out: ExploreRow = { id: row.id, triage: {}, w1: { correct: null, usd: 0 }, verify1: {}, w2: { correct: null, usd: 0 }, verify2: {} };

    if (task.triage) {
      for (const m of models) {
        const own = m === runModels.triage ? st.triage.get(row.id) : undefined;
        if (own) out.triage[m] = triageEntry(own.answers.answer, label, own.costUsd);
        else if (m !== runModels.triage) {
          const rec = scoreIndex.get(`${m}|triage|${row.id}`);
          if (rec) out.triage[m] = triageEntry(rec.verdict, label, rec.costUsd);
        }
      }
    }

    for (const round of [1, 2] as const) {
      const res = st.results.get(customId(row.id, round));
      const parsed = res?.ok ? parseWriterOutput(task, res.text ?? '') : undefined;
      const writer = { correct: parsed?.ok ? matchesLabel(parsed.value, label) : null, usd: res?.costUsd ?? 0 };
      const verifyOut = round === 1 ? out.verify1 : out.verify2;
      if (round === 1) out.w1 = writer;
      else out.w2 = writer;
      if (!parsed?.ok) continue; // no writer answer, nothing was verified
      const stage = round === 1 ? 'verify1' : 'verify2';
      for (const m of models) {
        const own = m === runModels.verify ? st.verify.get(verifyKey(row.id, round)) : undefined;
        if (own) verifyOut[m] = verifyEntry(own.answers.verdict, own.costUsd);
        else if (m !== runModels.verify) {
          const rec = scoreIndex.get(`${m}|${stage}|${row.id}`);
          if (rec && rec.answer === parsed.value) verifyOut[m] = verifyEntry(rec.verdict, rec.costUsd);
        }
      }
    }
    return out;
  });
  return { rows, models: [...models] };
}

interface ExploreCacheEntry {
  key: string;
  value: ExploreResponse;
}
const exploreCache = new Map<string, ExploreCacheEntry>();

/**
 * Everything the results explorer needs for one bench: the test-split table and reliability bins from
 * bench-report.json, and the calibration run's rows for the threshold replay. Without the calibration
 * run folder, the table and reliability are still returned, with `calibration: null` and a reason.
 */
export async function getBenchExplore(runsRoot: string, benchId: string): Promise<ExploreResponse> {
  const dir = resolveInside(runsRoot, benchId);
  const reportPath = join(dir, 'bench-report.json');
  if (!existsSync(join(dir, 'bench.json'))) throw new NotFoundError(`No bench ${benchId}`);
  if (!existsSync(reportPath)) throw new NotFoundError(`Bench ${benchId} has no bench-report.json yet`);
  const state = readBench(dir);

  // The calibration run: its own id, or (reused calibration) the run named inside calibration.json.
  let calibRunId = state.calibrationRunId;
  let reason: string | null = null;
  if (!calibRunId && state.calibrationPath) {
    try {
      calibRunId = readCalibration(state.calibrationPath).runId;
    } catch {
      reason = `The calibration file ${state.calibrationPath} could not be read.`;
    }
  }
  if (!calibRunId && !reason) reason = 'This bench has no calibration run.';
  let calibDir: string | null = null;
  if (calibRunId) {
    calibDir = resolveInside(runsRoot, calibRunId);
    if (!existsSync(join(calibDir, 'manifest.json'))) {
      reason = `The calibration run ${calibRunId} is not in the runs folder.`;
      calibDir = null;
    }
  }

  // The test run behind each report config: bench.json's testRuns, else the runId in the report.
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as BenchReport;
  const configs = report.configs ?? [];
  const testDirs = new Map<string, string | null>();
  for (const c of configs) {
    const id = state.testRuns?.[c.name] ?? c.runId;
    let d: string | null = null;
    try {
      if (id) d = resolveInside(runsRoot, id);
    } catch {
      d = null;
    }
    testDirs.set(c.name, d && existsSync(join(d, 'manifest.json')) ? d : null);
  }

  const key = [
    reportPath,
    join(dir, 'bench.json'),
    ...[...testDirs.values()].flatMap((d) => (d ? [join(d, 'manifest.json'), join(d, 'ledger.jsonl')] : [])),
    ...(calibDir ? [join(calibDir, 'manifest.json'), join(calibDir, 'ledger.jsonl'), join(calibDir, 'scores.jsonl')] : []),
  ]
    .map(statKey)
    .join('|');
  const hit = exploreCache.get(dir);
  if (hit && hit.key === key) return hit.value;

  const thresholdsByConfig: Record<string, ExploreThresholds> = {};
  for (const c of configs) if (c.thresholds) thresholdsByConfig[c.name] = c.thresholds;
  const fitsByModel: ExploreCalibration['fitsByModel'] = {};
  for (const [model, stages] of Object.entries(report.calibrationFits ?? {})) {
    const fits: ExploreCalibration['fitsByModel'][string] = {};
    for (const stage of ['triage', 'verify1', 'verify2'] as const) {
      const t = stages[stage]?.fit?.threshold;
      if (typeof t === 'number') fits[stage] = t;
    }
    fitsByModel[model] = fits;
  }

  // Each config's own caching, and the per-stage use of the non-baseline test runs (for re-pricing).
  const configCaching = new Map<string, ExploreCaching>();
  const testUses: StageUse[] = [];
  const testCaching: ExploreCaching[] = [];
  for (const c of configs) {
    const d = testDirs.get(c.name) ?? null;
    let caching: ExploreCaching = null;
    let use: StageUse | null = null;
    if (d) {
      try {
        const run = await loadRunCached(d);
        caching = runCaching(run.manifest, run.st);
        if (run.manifest.mode !== 'baseline' && c.triage) use = stageUseFromRun(run.manifest, run.st);
      } catch {
        use = c.triage ? stageUseFromReport(c) : null;
      }
    } else if (c.triage) use = stageUseFromReport(c);
    configCaching.set(c.name, caching);
    if (use) {
      testUses.push(use);
      testCaching.push(caching);
    }
  }

  let calibration: ExploreCalibration | null = null;
  if (calibDir) {
    try {
      const run = await loadRunCached(calibDir);
      if (!run.manifest.labelColumn) reason = `The calibration run ${run.manifest.runId} has no label column.`;
      else if (!run.task) reason = run.problem ?? `The task file of the calibration run could not be loaded.`;
      else {
        const { rows, models } = buildExploreRows({
          task: run.task,
          records: run.records,
          labelColumn: run.manifest.labelColumn,
          st: run.st,
          runModels: { triage: run.manifest.models.triage, verify: run.manifest.models.verify },
          scores: readScoreRecords(calibDir),
        });
        const ownCalibration = !!state.calibrationRunId && !state.calibrationReused;
        let costSource: ExploreCalibration['costSource'];
        if (ownCalibration) {
          costSource = { kind: 'calibration-run', caching: runCaching(run.manifest, run.st) };
        } else {
          // A calibration reused from another bench: its per-row costs are that bench's, so price the rows
          // from this bench's own test runs.
          repriceRows(rows, unitCostsFrom(testUses));
          const kinds = new Set(testUses.flatMap((_, i) => (testCaching[i] ? [testCaching[i]!] : [])));
          costSource = { kind: 'test-runs', caching: kinds.size > 1 ? 'mixed' : ([...kinds][0] ?? null) };
        }
        calibration = {
          runId: run.manifest.runId,
          rows: rows.length,
          models,
          thresholdsByConfig,
          fitsByModel,
          data: rows,
          costSource,
        };
      }
    } catch (err) {
      reason = `The calibration run could not be read: ${(err as Error).message}`;
    }
  }

  const value: ExploreResponse = {
    benchId: report.benchId ?? benchId,
    createdAt: typeof report.createdAt === 'string' ? report.createdAt : null,
    target: report.target,
    baselineModel: typeof state.baseline === 'string' ? state.baseline : null,
    results: {
      configs: configs.map((c) => ({
        name: c.name,
        triage: c.triage,
        verify: c.verify,
        thresholds: c.thresholds,
        rows: c.rows,
        autoAcceptShare: c.autoAcceptShare,
        precision: c.precision,
        flaggedShare: c.flaggedShare,
        accuracyNoHuman: c.accuracyNoHuman,
        costPer1k: c.costPer1k,
        caching: configCaching.get(c.name) ?? null,
      })),
    },
    reliability: configs.flatMap((c) =>
      (c.calibration ?? []).map((s) => ({
        config: c.name,
        stage: s.stage,
        model: s.model,
        n: s.n,
        eceRaw: s.eceRaw,
        eceCalibrated: s.eceCalibrated,
        raw: s.reliabilityRaw,
        calibrated: s.reliabilityCalibrated,
      })),
    ),
    calibration,
    calibrationMissingReason: calibration ? null : (reason ?? 'The calibration run is not available.'),
  };
  exploreCache.set(dir, { key, value });
  return value;
}

// ---------------------------------------------------------------- balance

const creditsSchema = z.looseObject({
  data: z.looseObject({ total_credits: z.number(), total_usage: z.number() }),
});

export interface BalanceCache {
  at: number;
  value: { totalCredits: number; totalUsage: number; fetchedAt: string } | { error: string };
}

export const CREDITS_URL = 'https://openrouter.ai/api/v1/credits';
export const BALANCE_TTL_MS = 30_000;

/** Worst-case reserve for every in-flight batch in the folder (started < 24 h ago). */
export async function estimateReserve(runsRoot: string, o: ApiOptions = {}): Promise<Reserve> {
  const nowMs = now(o);
  const batches: Reserve['batches'] = [];
  for (const run of await loadAllRuns(runsRoot)) {
    for (const b of run.st.batches.values()) {
      if (b.finished || nowMs - Date.parse(b.at) > BATCH_WINDOW_MS) continue;
      const usdReserve = batchReserve(run, b.round, b.model, b.customIds);
      if (usdReserve !== null) batches.push({ runId: run.manifest.runId, batchId: b.batchId, rows: b.customIds.length, usd: usdReserve });
    }
  }
  return { totalUsd: batches.reduce((n, b) => n + b.usd, 0), batches };
}

/**
 * OpenRouter balance (GET /credits, cached 30 s in `cache`) plus our reserve estimate.
 * The key is only ever placed in the Authorization header; errors are scrubbed of it.
 */
export async function getBalance(
  runsRoot: string,
  o: ApiOptions & { apiKey?: string; fetch?: FetchFn; cache?: { current?: BalanceCache } } = {},
): Promise<BalanceResponse> {
  const reserve = await estimateReserve(runsRoot, o);
  const key = o.apiKey;
  if (!key) return { available: false, reason: 'OPENROUTER_API_KEY is not set in the environment of twopass ui.', reserve };
  const cache = o.cache ?? {};
  const nowMs = now(o);
  if (!cache.current || nowMs - cache.current.at >= BALANCE_TTL_MS) {
    try {
      const res = await (o.fetch ?? fetch)(CREDITS_URL, { method: 'GET', headers: { Authorization: `Bearer ${key}`, 'X-Title': 'TwoPass' } });
      if (!res.ok) throw new Error(`OpenRouter answered HTTP ${res.status}`);
      const parsed = creditsSchema.parse(await res.json());
      cache.current = {
        at: nowMs,
        value: { totalCredits: parsed.data.total_credits, totalUsage: parsed.data.total_usage, fetchedAt: new Date(nowMs).toISOString() },
      };
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).split(key).join('[key]');
      cache.current = { at: nowMs, value: { error: `Could not read the balance: ${message.slice(0, 200)}` } };
    }
  }
  const v = cache.current.value;
  if ('error' in v) return { available: false, reason: v.error, reserve };
  return { available: true, ...v, balanceUsd: v.totalCredits - v.totalUsage, reserve };
}

// ---------------------------------------------------------------- review queue

interface FoldedRun {
  key: string;
  folded: FoldedOutcome[];
  summary: ReviewSummary;
}

const foldCache = new Map<string, FoldedRun>();

/** The run's outcomes with overrides.jsonl folded in; null when outcomes are unknown. Cached by file stats. */
function reviewOf(run: LoadedRun): FoldedRun | null {
  if (!run.outcomes) return null;
  const key = `${run.key}|${statKey(overridesPath(run.dir))}`;
  const hit = foldCache.get(run.dir);
  if (hit && hit.key === key) return hit;
  const folded = foldOverrides(run.outcomes, readOverrides(run.dir));
  const result = { key, folded, summary: reviewSummary(folded, run.manifest.labelColumn) };
  foldCache.set(run.dir, result);
  return result;
}

const FILTERS: readonly ReviewFilter[] = ['flagged', 'reviewed', 'all'];

export function parseReviewFilter(value: string | null): ReviewFilter {
  if (value === null || value === '') return 'flagged';
  if (!(FILTERS as readonly string[]).includes(value)) throw new BadRequestError('filter must be flagged, reviewed or all');
  return value as ReviewFilter;
}

/** Up to `n` labels by probability (ties by name), without cannot_tell and without zeros. */
export function topLabels(probabilities: Record<string, number>, n = 3): Array<{ label: string; probability: number }> {
  return Object.entries(probabilities)
    .filter(([label, p]) => label !== CANNOT_TELL && typeof p === 'number' && p > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([label, probability]) => ({ label, probability }));
}

/** The columns a reviewer reads: what the task's prompts use, without the id and label columns. */
function reviewInputColumns(task: TaskDefinition, m: RunManifest): string[] {
  const skip = new Set([task.idColumn, m.labelColumn].filter((c): c is string => !!c));
  const cols = requiredColumns(task).map((r) => r.column).filter((c) => !skip.has(c));
  return cols.length ? cols : m.inputColumns.filter((c) => !skip.has(c));
}

function reviewRow(run: LoadedRun, o: FoldedOutcome, inputColumns: string[]): ReviewRow {
  const { st, task, manifest: m } = run;
  const rounds: RoundAnswer[] = [];
  for (const round of [1, 2] as const) {
    const cid = customId(o.rowId, round);
    const res = st.results.get(cid);
    const inFlight = st.inFlight.has(cid);
    if (!res && !inFlight) continue;
    const parsed = res?.ok && task ? parseWriterOutput(task, res.text ?? '') : undefined;
    const v = st.verify.get(verifyKey(o.rowId, round));
    const verdict = v ? asChoice(v.answers.verdict) : undefined;
    rounds.push({
      round,
      model: res?.model ?? [...st.batches.values()].find((b) => b.round === round && b.customIds.includes(cid))?.model ?? '',
      answer: parsed?.ok ? parsed.value : (res?.text ?? '').trim(),
      valid: !!parsed?.ok,
      error: res ? (res.ok ? (parsed && !parsed.ok ? parsed.error : null) : (res.error ?? 'failed')) : null,
      inFlight,
      costUsd: res?.costUsd ?? 0,
      verify: v
        ? {
            verdict: verdict?.choice ?? 'cannot_tell',
            confidence: verdict?.confidence ?? null,
            probabilities: {
              supported: verdict?.probabilities.supported ?? 0,
              unsupported: verdict?.probabilities.unsupported ?? 0,
              cannot_tell: verdict?.probabilities[CANNOT_TELL] ?? 0,
            },
            model: v.model,
            costUsd: v.costUsd,
          }
        : null,
    });
  }
  let triage: TriageInfo | null = null;
  const tri = st.triage.get(o.rowId);
  const triAnswer = tri ? asChoice(tri.answers.answer) : undefined;
  if (tri && triAnswer) {
    triage = {
      model: tri.model,
      choice: triAnswer.choice,
      probability: triAnswer.probabilities[triAnswer.choice] ?? 0,
      top: topLabels(triAnswer.probabilities),
      cannotTell: triAnswer.probabilities[CANNOT_TELL] ?? 0,
      costUsd: tri.costUsd,
    };
  }
  const r = o.review;
  return {
    rowId: o.rowId,
    status: o.status,
    pipelineStatus: o.pipelineStatus,
    input: Object.fromEntries(inputColumns.map((c) => [c, o.data[c] ?? ''])),
    expected: m.labelColumn ? (o.data[m.labelColumn] ?? null) : null,
    answer: o.answer,
    acceptable: !!task && isValidAnswer(task, o.answer),
    finalAnswer: o.finalAnswer,
    verdict: o.verdict,
    round: o.round,
    model: o.model,
    confidence: o.confidence,
    costUsd: o.costUsd,
    rounds,
    triage,
    review: r
      ? {
          action: r.action,
          answer: r.answer,
          previous: r.previous,
          note: r.note ?? null,
          at: r.at,
          pipelineStatus: r.pipelineStatus ?? null,
          stale: r.previous !== o.answer,
        }
      : null,
  };
}

function isValidAnswer(task: TaskDefinition, answer: string): boolean {
  if (!answer) return false;
  try {
    validateAnswer(task, answer);
    return true;
  } catch {
    return false;
  }
}

function countsOf(s: ReviewSummary, rows: number): ReviewCounts {
  return { rows, flagged: s.flagged, reviewed: s.reviewed, remaining: s.remaining, reviewedOther: s.reviewedOther, overridden: s.overridden };
}

const accuracyOf = (s: ReviewSummary): ReviewAccuracy | null => (s.accuracy?.of ? s.accuracy : null);

/** A run whose outcomes are known, with the task loaded; otherwise a 400 that says why. */
async function reviewableRun(runsRoot: string, runId: string): Promise<{ run: LoadedRun & { task: TaskDefinition }; review: FoldedRun }> {
  const dir = resolveInside(runsRoot, runId);
  if (!existsSync(join(dir, 'manifest.json'))) throw new NotFoundError(`No run ${runId}`);
  const run = await loadRunCached(dir);
  const review = reviewOf(run);
  if (!run.task || !review) throw new BadRequestError(`This run cannot be reviewed: ${run.problem ?? 'its outcomes are unknown'}`);
  return { run: run as LoadedRun & { task: TaskDefinition }, review };
}

// ---------------------------------------------------------------- GET /api/runs/:id/review

export async function getReview(runsRoot: string, runId: string, filterParam: string | null, o: ApiOptions = {}): Promise<ReviewResponse> {
  const filter = parseReviewFilter(filterParam);
  const { run, review } = await reviewableRun(runsRoot, runId);
  const { status } = runStatus(run, o);
  const inputColumns = reviewInputColumns(run.task, run.manifest);
  const keep = (f: FoldedOutcome) => (filter === 'all' ? true : filter === 'flagged' ? f.pipelineStatus === 'flagged' : f.review !== null);
  const labels = allowedAnswers(run.task);
  return {
    runId: run.manifest.runId,
    status,
    running: status === 'running',
    filter,
    kind: labels ? 'closed' : 'open',
    labels,
    inputColumns,
    labelColumn: run.manifest.labelColumn ?? null,
    maxAnswerChars: MAX_ANSWER_CHARS,
    maxNoteChars: MAX_NOTE_CHARS,
    counts: countsOf(review.summary, run.records.length),
    accuracy: accuracyOf(review.summary),
    rows: review.folded.filter(keep).map((f) => reviewRow(run, f, inputColumns)),
  };
}

// ---------------------------------------------------------------- POST /api/runs/:id/overrides

/**
 * Validates a reviewer's decision (body shape, row exists, answer allowed by the task) and appends
 * it to overrides.jsonl, the only file this endpoint writes.
 */
export async function postOverride(runsRoot: string, runId: string, body: unknown, o: ApiOptions = {}): Promise<OverrideResponse> {
  const { run } = await reviewableRun(runsRoot, runId);
  const parsed = decisionInputSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BadRequestError(`Invalid decision: ${issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'bad body'}`);
  }
  const outcome = run.outcomes?.find((x) => x.rowId === parsed.data.rowId);
  let record;
  try {
    record = makeOverride(parsed.data, outcome, run.task, new Date(now(o)));
  } catch (err) {
    if (err instanceof OverrideError) throw err.code === 'unknown_row' ? new NotFoundError(err.message) : new BadRequestError(err.message);
    throw err;
  }
  appendOverride(run.dir, record);
  const after = reviewOf(run)!; // overrides.jsonl changed size, so this re-reads it
  const row = after.folded.find((f) => f.rowId === record.rowId)!;
  return {
    row: reviewRow(run, row, reviewInputColumns(run.task, run.manifest)),
    counts: countsOf(after.summary, run.records.length),
    accuracy: accuracyOf(after.summary),
  };
}

// ---------------------------------------------------------------- POST /api/runs/:id/outputs

/** Same as `twopass report --write`: rewrites enriched.csv and review.csv (and nothing else). */
export async function postOutputs(runsRoot: string, runId: string, o: ApiOptions = {}): Promise<OutputsResponse> {
  const { run } = await reviewableRun(runsRoot, runId);
  const report = await rewriteOutputs(run.dir);
  const summary = reviewSummary(report.folded, report.manifest.labelColumn);
  return { written: ['enriched.csv', 'review.csv'], at: new Date(now(o)).toISOString(), counts: countsOf(summary, report.folded.length) };
}
