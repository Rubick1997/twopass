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
  /** Review progress of flagged rows; null when outcomes are unknown. */
  review: { flagged: number; reviewed: number; remaining: number } | null;
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
    /** Pinned per-token prices (ModelPrice in src/cost/price.ts). Cache fields are absent in manifests before 2026-11-07. */
    prices: Record<
      string,
      {
        inputPerToken: number;
        outputPerToken: number;
        cacheReadPerToken?: number;
        cacheWritePerToken?: number;
        cacheWrite1hPerToken?: number;
        overrides?: Array<{ minPromptTokens: number; inputPerToken: number; outputPerToken: number }>;
      }
    >;
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

// ---------------------------------------------------------------- review queue

/** A row's pipeline status (computeOutcomes). */
export type PipelineStatus = 'accepted' | 'flagged' | 'pending';
/** "reviewed" once a person accepted or overrode the row. */
export type FinalStatus = PipelineStatus | 'reviewed';
export type ReviewFilter = 'flagged' | 'reviewed' | 'all';
export type ReviewAction = 'accept' | 'override';

export interface ReviewCounts {
  rows: number;
  /** Rows the pipeline flagged. */
  flagged: number;
  /** Flagged rows with a decision. */
  reviewed: number;
  /** Flagged rows without one. */
  remaining: number;
  /** Decided rows the pipeline had not flagged. */
  reviewedOther: number;
  /** Decisions that changed the answer. */
  overridden: number;
}

export interface ReviewAccuracy {
  noHuman: number;
  withHuman: number;
  correctNoHuman: number;
  correctWithHuman: number;
  /** Rows with a label. */
  of: number;
}

export interface VerifyInfo {
  /** supported | unsupported | cannot_tell */
  verdict: string;
  confidence: number | null;
  probabilities: { supported: number; unsupported: number; cannot_tell: number };
  model: string;
  costUsd: number;
}

export interface RoundAnswer {
  round: 1 | 2;
  model: string;
  /** Parsed answer, or the raw reply when it did not parse. */
  answer: string;
  /** The reply parsed against the task's output schema. */
  valid: boolean;
  error: string | null;
  inFlight: boolean;
  costUsd: number;
  verify: VerifyInfo | null;
}

export interface TriageInfo {
  model: string;
  choice: string;
  probability: number;
  /** Up to 3 labels with the highest probability (cannot_tell excluded, zeros dropped). */
  top: Array<{ label: string; probability: number }>;
  cannotTell: number;
  costUsd: number;
}

export interface ReviewInfo {
  action: ReviewAction;
  answer: string;
  /** The pipeline's answer when the decision was made. */
  previous: string;
  note: string | null;
  at: string;
  pipelineStatus: PipelineStatus | null;
  /** The pipeline's answer has changed since (the run was still going). */
  stale: boolean;
}

export interface ReviewRow {
  rowId: string;
  status: FinalStatus;
  pipelineStatus: PipelineStatus;
  /** The task's input columns. */
  input: Record<string, string>;
  /** The label column's value, when the run has one. */
  expected: string | null;
  /** The pipeline's final answer. */
  answer: string;
  /** `answer` is a valid answer for the task, so it can be accepted as is. */
  acceptable: boolean;
  /** The reviewer's answer if any, else `answer`. */
  finalAnswer: string;
  verdict: string;
  round: 0 | 1 | 2;
  model: string;
  confidence: number | null;
  costUsd: number;
  rounds: RoundAnswer[];
  triage: TriageInfo | null;
  review: ReviewInfo | null;
}

export interface ReviewResponse {
  runId: string;
  status: RunStatus;
  /** The run's lock is live: new rows may still be flagged. */
  running: boolean;
  filter: ReviewFilter;
  /** closed: answers come from `labels`. open: free text up to maxAnswerChars. */
  kind: 'closed' | 'open';
  labels: string[] | null;
  inputColumns: string[];
  labelColumn: string | null;
  maxAnswerChars: number;
  maxNoteChars: number;
  counts: ReviewCounts;
  accuracy: ReviewAccuracy | null;
  rows: ReviewRow[];
}

/** POST /api/runs/:id/overrides */
export type DecisionBody =
  | { rowId: string; action: 'accept'; note?: string }
  | { rowId: string; action: 'override'; answer: string; note?: string }
  | { rowId: string; action: 'clear' };

export interface OverrideResponse {
  row: ReviewRow;
  counts: ReviewCounts;
  accuracy: ReviewAccuracy | null;
}

/** POST /api/runs/:id/outputs */
export interface OutputsResponse {
  written: string[];
  at: string;
  counts: ReviewCounts;
}

export interface ApiError {
  error: string;
}

// ---------------------------------------------------------------- results explorer

export interface ExploreThresholds {
  t0: number;
  t1: number;
  t2: number;
}

export interface ExploreCostPer1k {
  triage: number;
  write1: number;
  verify1: number;
  write2: number;
  verify2: number;
  total: number;
}

export interface ExploreBin {
  lo: number;
  hi: number;
  n: number;
  meanP: number;
  accuracy: number;
}

/** One calibration row, reduced to what the threshold replay needs (no message text, no labels). */
export interface ExploreRow {
  id: string;
  /** Per decision model: probability of its chosen label, or null if it chose cannot_tell / gave no answer. `correct`: chosen label == true label. */
  triage: Record<string, { p: number | null; correct: boolean; usd: number }>;
  /** Round-1 writer. `correct` is null if the writer failed or its output did not parse (then this round cannot accept). */
  w1: { correct: boolean | null; usd: number };
  /** Per decision model: probability of "supported" if its choice was "supported", else null. */
  verify1: Record<string, { p: number | null; usd: number }>;
  w2: { correct: boolean | null; usd: number };
  verify2: Record<string, { p: number | null; usd: number }>;
}

export interface ExploreConfigResult {
  name: string;
  triage: string | null;
  verify: string | null;
  thresholds: ExploreThresholds | null;
  rows: number;
  autoAcceptShare: number;
  precision: number;
  flaggedShare: number;
  accuracyNoHuman: number;
  costPer1k: ExploreCostPer1k;
}

export interface ExploreReliability {
  config: string;
  stage: 'triage' | 'verify1' | 'verify2';
  model: string;
  n: number;
  eceRaw: number;
  eceCalibrated: number;
  raw: ExploreBin[];
  calibrated: ExploreBin[];
}

export interface ExploreCalibration {
  runId: string;
  rows: number;
  /** Decision models that have answers for the calibration rows. */
  models: string[];
  thresholdsByConfig: Record<string, ExploreThresholds>;
  /** The fitted threshold per model and stage (calibration.json), to preset a custom controller. */
  fitsByModel: Record<string, Partial<Record<'triage' | 'verify1' | 'verify2', number>>>;
  data: ExploreRow[];
  /** Set when the writer costs in the calibration run were recorded before prompt caching. */
  pricingNote: string | null;
}

export interface ExploreResponse {
  benchId: string;
  target: number;
  results: { configs: ExploreConfigResult[] };
  reliability: ExploreReliability[];
  calibration: ExploreCalibration | null;
  calibrationMissingReason: string | null;
}
