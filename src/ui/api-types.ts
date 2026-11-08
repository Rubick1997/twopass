// Response types of the local UI's JSON API (`twopass ui`). The server builds them in api.ts;
// the browser app imports this file type-only. Keep it free of imports so the app's tsconfig
// (no Node types) can check it.

export type RunMode = 'normal' | 'collect' | 'baseline';

/**
 * running:  run.lock exists, its heartbeat is < 60 s old and the pid is alive
 * finished: no pending rows
 * stopped:  pending rows and nothing running (crash, Ctrl-C, cost cap, never started)
 * unknown:  the task file could not be loaded, so outcomes cannot be computed
 */
export type RunStatus = 'running' | 'finished' | 'stopped' | 'unknown';

/** What a running run is doing right now. */
export type RunActivity = 'waiting_on_batch' | 'working' | null;

export interface OutcomeCounts {
  accepted: number;
  flagged: number;
  pending: number;
  /** Accepted in round 0 (triage), without a writer. */
  acceptedRound0: number;
  /** Rows that reached round 2. */
  rerun: number;
}

export interface RunModels {
  writer: string;
  escalation: string;
  triage: string;
  verify: string;
}

export interface BenchRef {
  benchId: string;
  /** "jev", "clef+jev", "baseline", or "calibration". */
  config: string;
}

export interface RunListItem {
  runId: string;
  createdAt: string;
  mode: RunMode;
  rowCount: number;
  models: RunModels;
  status: RunStatus;
  activity: RunActivity;
  outcomes: OutcomeCounts | null;
  /** Share of rows that are no longer pending, 0..1. */
  progress: number | null;
  spentUsd: number;
  /** The run's own cap, or the bench's shared cap for a bench run (see capScope). */
  maxUsd: number | null;
  capScope: 'run' | 'bench' | null;
  lastEventAt: string | null;
  bench: BenchRef | null;
  /** Set when status is "unknown". */
  problem?: string;
}

export interface RunsResponse {
  runsRoot: string;
  runs: RunListItem[];
}

export type StageKey = 'triage' | 'write1' | 'verify1' | 'write2' | 'verify2';

export interface StageProgress {
  key: StageKey;
  round: 0 | 1 | 2;
  label: string;
  /** Rows this stage will handle. An upper bound while `totalIsEstimate`. */
  total: number;
  totalIsEstimate: boolean;
  /** Triage/verify: decisions made. Write: results collected (rows that got any answer). */
  done: number;
  /** Write stages only: rows submitted in a batch. */
  sent?: number;
  state: 'waiting' | 'active' | 'done' | 'skipped';
}

export interface BatchRow {
  batchId: string;
  shortId: string;
  round: 1 | 2;
  model: string;
  rows: number;
  status: string;
  finished: boolean;
  submittedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  costUsd: number;
  undecodable: number;
  /** Worst-case amount OpenRouter holds for this batch while it is in flight. */
  reserveUsd: number | null;
}

export interface StageSpend {
  triage: number;
  write1: number;
  verify1: number;
  write2: number;
  verify2: number;
  total: number;
}

export interface ExpectedFinish {
  /** ISO time, or null when there is no basis for an estimate. */
  at: string | null;
  /** Plain-words explanation of how `at` was computed, or why there is none. */
  basis: string;
}

export interface ActivityItem {
  at: string;
  text: string;
}

export interface RunDetail extends RunListItem {
  manifest: {
    taskPath: string;
    inputPath: string;
    labelColumn: string | null;
    thresholds: { t0: number; t1: number; t2: number };
    thresholdsSource: string;
    prices: Record<string, { inputPerToken: number; outputPerToken: number }>;
    servedModels: string[];
  };
  check: { warnings: number; errors: number; changes: number } | null;
  /** Shell command that continues the run; null when it is running or finished. */
  resumeCommand: string | null;
  lock: { pid: number; startedAt: string; heartbeatAt: string; live: boolean } | null;
  stages: StageProgress[];
  activeStage: StageKey | null;
  batches: BatchRow[];
  spend: StageSpend;
  /** Precision of accepted rows, when the run has a label column. */
  precision: { correct: number; of: number } | null;
  expectedFinish: ExpectedFinish;
  /** Worst-case reserve held for this run's in-flight batches. */
  reserveUsd: number;
  activity: RunActivity;
  recent: ActivityItem[];
}

export interface BenchConfigSummary {
  name: string;
  runId: string;
  run: RunListItem | null;
}

export interface BenchListItem {
  benchId: string;
  createdAt: string;
  status: RunStatus;
  maxUsd: number | null;
  spentUsd: number;
  calibration: BenchConfigSummary | null;
  configs: BenchConfigSummary[];
  hasReport: boolean;
}

export interface BenchesResponse {
  benches: BenchListItem[];
}

export interface BenchDetail extends BenchListItem {
  /** bench.json as stored. */
  state: Record<string, unknown>;
  resumeCommand: string | null;
}

export interface BenchReportResponse {
  markdown: string;
}

export interface ReserveBatch {
  runId: string;
  batchId: string;
  rows: number;
  usd: number;
}

export interface Reserve {
  totalUsd: number;
  batches: ReserveBatch[];
}

export type BalanceResponse =
  | {
      available: true;
      totalCredits: number;
      totalUsage: number;
      /** totalCredits - totalUsage, as OpenRouter reports it (may already exclude reserves). */
      balanceUsd: number;
      fetchedAt: string;
      reserve: Reserve;
    }
  | { available: false; reason: string; reserve: Reserve };

export interface ApiError {
  error: string;
}
