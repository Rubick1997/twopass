import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { BenchState } from '../bench.ts';
import { asChoice } from '../decide/model.ts';
import type { FetchFn } from '../http.ts';
import { customId, parseLedger, replay, verifyKey, type LedgerEvent, type RunState } from '../ledger.ts';
import { isLockLive, isPidAlive, readRunLock } from '../lock.ts';
import { computeOutcomes, writerSettings, type RowOutcome, type RowRecord } from '../pipeline.ts';
import { summarize } from '../report.ts';
import { loadRun, type RunManifest } from '../run.ts';
import { batchDurationMs, median, spendByStage } from '../stats.ts';
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
  OutcomeCounts,
  Reserve,
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
