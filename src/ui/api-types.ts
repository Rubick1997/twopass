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
  /** `extract` for `bench vrdu`: no configs, no results explorer; the report is `bench-report.md`. */
  kind: 'classify' | 'extract';
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

/** Closed-choice and open-ended runs (`kind` closed | open) or extraction runs (`kind` extract). */
export type ReviewResponse = ClassifyReviewResponse | ExtractReviewResponse;

export interface ClassifyReviewResponse {
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

/** POST /api/runs/:id/overrides (extraction runs add `field`, and an override's answer may be null) */
export type DecisionBody =
  | { rowId: string; action: 'accept'; note?: string }
  | { rowId: string; action: 'override'; answer: string; note?: string }
  | { rowId: string; action: 'clear' };

export type FieldDecisionBody =
  | { rowId: string; field: string; action: 'accept'; note?: string }
  /** `answer: null` = "not in this document". */
  | { rowId: string; field: string; action: 'override'; answer: string | null; note?: string }
  | { rowId: string; field: string; action: 'clear' };

// ---- extraction runs: one item per field slot

export interface ExtractReviewCounts {
  /** Field slots in the run. */
  fields: number;
  documents: number;
  /** Fields the pipeline flagged. */
  flagged: number;
  reviewed: number;
  remaining: number;
  reviewedOther: number;
  overridden: number;
}

/** One round's value for a field, as the writer gave it and the checker judged it. */
export interface FieldRoundInfo {
  round: 1 | 2;
  model: string;
  /** null: the writer says the document does not state the field (or gave no usable reply, see `verdict`). */
  value: string | null;
  /** supported | unsupported | cannot_tell | writer_failed | invalid_output */
  verdict: string;
  probabilities: { supported: number; unsupported: number; cannot_tell: number } | null;
  /** [start, end) offsets of the value in the document text; at most 20. */
  spans: Array<[number, number]>;
}

export interface FieldReviewInfo {
  action: ReviewAction;
  /** null = "not in this document". */
  value: string | null;
  previous: string | null;
  note: string | null;
  at: string;
  pipelineStatus: PipelineStatus | null;
  stale: boolean;
}

export interface FieldItem {
  docId: string;
  field: string;
  status: FinalStatus;
  pipelineStatus: PipelineStatus;
  /** The value the pipeline ended with (kept when flagged). */
  value: string | null;
  /** The reviewer's value if any, else `value`. */
  finalValue: string | null;
  /** The round that produced `value`. */
  round: 1 | 2;
  verdict: string;
  /** Whether the value can be accepted as it is (the writer gave a usable reply). */
  acceptable: boolean;
  round1: FieldRoundInfo | null;
  round2: FieldRoundInfo | null;
  /** The gold values (empty list = the form does not state the field); null without a label column. */
  expected: string[] | null;
  /** `value` matches the gold, `finalValue` matches the gold; null without a label column. */
  valueCorrect: boolean | null;
  finalCorrect: boolean | null;
  review: FieldReviewInfo | null;
}

export interface ExtractReviewResponse {
  kind: 'extract';
  runId: string;
  status: RunStatus;
  running: boolean;
  filter: ReviewFilter;
  fields: string[];
  labelColumn: string | null;
  maxAnswerChars: number;
  maxNoteChars: number;
  counts: ExtractReviewCounts;
  accuracy: ReviewAccuracy | null;
  /** Document text by doc id, once per document, for the documents that have an item. */
  documents: Record<string, string>;
  items: FieldItem[];
}

export interface ExtractOverrideResponse {
  kind: 'extract';
  item: FieldItem;
  counts: ExtractReviewCounts;
  accuracy: ReviewAccuracy | null;
}

export type OverrideResponse = ClassifyOverrideResponse | ExtractOverrideResponse;

export interface ClassifyOverrideResponse {
  row: ReviewRow;
  counts: ReviewCounts;
  accuracy: ReviewAccuracy | null;
}

/** POST /api/runs/:id/outputs */
export interface OutputsResponse {
  written: string[];
  at: string;
  counts: ReviewCounts | ExtractReviewCounts;
}

export interface ApiError {
  error: string;
}

// ---------------------------------------------------------------- results explorer

/** The pieces of bench-report.json (extraction) that the explorer reads. */
export interface ExtractSlotMetrics {
  fields: number;
  pending: number;
  accepted: number;
  acceptedShare: number;
  precision: number | null;
  confidentWrong: number;
  confidentWrongShare: number;
  flagged: number;
  flaggedShare: number;
  flaggedOwnRight: number | null;
  accuracy: number;
  exactAccuracy: number;
}
export interface ExtractCostStages {
  write1: number;
  verify1: number;
  write2: number;
  verify2: number;
  total: number;
}
export interface ExtractConfigMetrics extends ExtractSlotMetrics {
  documents: number;
  costPer1kDocuments: ExtractCostStages;
  costPer1kFields: ExtractCostStages;
}
export interface ExtractWriterAlone {
  fields: number;
  documents: number;
  unusableDocuments: number;
  accuracy: number;
  exactAccuracy: number;
  costPer1kDocuments: ExtractCostStages;
  costPer1kFields: ExtractCostStages;
}
export interface ExtractReliabilityBin {
  lo: number;
  hi: number;
  n: number;
  meanP: number;
  accuracy: number;
}
export interface ExtractCannotTell {
  proposals: number;
  cannotTell: number;
  share: number | null;
}
export interface ExtractCheckerResult {
  model: string;
  threshold: number;
  slots: number;
  accepted: number;
  acceptedShare: number;
  precision: number | null;
  confidentWrong: number;
  cannotTell: { value: ExtractCannotTell; null: ExtractCannotTell };
  reliability: { eceRaw: number; eceCalibrated: number | null; raw: ExtractReliabilityBin[]; calibrated: ExtractReliabilityBin[] | null };
}
export interface ExtractReportData {
  benchId: string;
  kind: 'extract';
  createdAt: string;
  split: 'dev' | 'test';
  debugOnly: boolean;
  documents: number;
  fields: number;
  target: number;
  decisionModel: string;
  baselineModel: string;
  thresholds: ExploreThresholds;
  thresholdsSource: string;
  configs: { baseline: ExtractConfigMetrics; writerAlone: ExtractWriterAlone; simple: ExtractConfigMetrics; full: ExtractConfigMetrics };
  presence: Record<'full' | 'simple', { present: ExtractSlotMetrics; absent: ExtractSlotMetrics }>;
  perField: Record<'full' | 'simple', Record<string, ExtractSlotMetrics>>;
  checkers: ExtractCheckerResult[];
  refit: { at: string; previousThresholds: ExploreThresholds; reason: string; fullFirstRead: ExtractConfigMetrics } | null;
  operatingPoint: { target: number; thresholds: ExploreThresholds; simple: ExtractConfigMetrics; full: ExtractConfigMetrics; checkers: ExtractCheckerResult[] } | null;
  calibration: {
    runId: string;
    documents: number;
    models: Record<
      string,
      {
        verify1?: { slots: number; wrong: number };
        verify1Quality?: { auc: number; eceRaw: number; eceCalibrated: number };
        verify2?: { slots: number; wrong: number };
        verify2Conditional?: { slots: number; wrong: number };
      }
    >;
  };
  textCheck: { documents: number; changed: number; changedInside: number; kinds: Record<string, number> } | null;
  minutes: unknown;
}


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
/** Whether a run's writer calls used prompt caching; null when unknown (no writer results yet). */
export type RunCachingKind = 'cached' | 'uncached';
export type ExploreCaching = RunCachingKind | null;

export interface ExploreRow {
  id: string;
  /** Per decision model: probability of its chosen label, or null if it chose cannot_tell / gave no answer. `correct`: chosen label == true label. */
  triage: Record<string, { p: number | null; correct: boolean; usd: number | null }>;
  /** Round-1 writer. `correct` is null if the writer failed or its output did not parse (then this round cannot accept). */
  w1: { correct: boolean | null; usd: number | null };
  /** Per decision model: probability of "supported" if its choice was "supported", else null. */
  verify1: Record<string, { p: number | null; usd: number | null }>;
  w2: { correct: boolean | null; usd: number | null };
  verify2: Record<string, { p: number | null; usd: number | null }>;
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
  /** Whether this config's own run used prompt caching (null: run folder missing or nothing to tell). */
  caching: ExploreCaching;
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
  /**
   * Where the per-row costs in `data` come from. `calibration-run`: the bench's own calibration run (recorded
   * per row). `test-runs`: the calibration was reused from another bench, so `usd` holds unit costs from this
   * bench's test runs (null where this bench never ran that model or stage).
   */
  costSource: { kind: 'calibration-run' | 'test-runs'; caching: ExploreCaching | 'mixed' };
}

export interface ExploreResponse {
  kind: 'classify';
  benchId: string;
  /** When the bench started (bench-report.json), for the page title. */
  createdAt: string | null;
  target: number;
  /** The baseline's writer model (bench.json), for the comparison line. */
  baselineModel: string | null;
  results: { configs: ExploreConfigResult[] };
  reliability: ExploreReliability[];
  calibration: ExploreCalibration | null;
  calibrationMissingReason: string | null;
}

// ---- extraction benches

/** A checker's answer to one proposed field value, reduced to what `verifyOutcome` reads. */
export interface ExtractChoice {
  /** supported | unsupported; anything else (cannot_tell, or an answer of another kind) is cannot_tell. */
  choice: 'supported' | 'unsupported' | 'cannot_tell';
  /** probabilities.supported (0 when absent). */
  p: number;
}

/** One field slot of one calibration document: whether the writers' values were right, and each checker's answers. */
export interface ExtractSlot {
  docId: string;
  field: string;
  /** The gold label states a value for this field. */
  goldPresent: boolean;
  /** The round-1 value is right (false when round 1 gave no usable reply). */
  correct1: boolean;
  /** The round-2 value is right; null when round 2 gave no usable reply. */
  correct2: boolean | null;
  /** By checker model. null: the checker gave no answer for this slot. */
  a: Record<string, { r1: ExtractChoice | null; r2: ExtractChoice | null }>;
}

export interface ExtractExploreCalibration {
  runId: string;
  documents: number;
  /** Checker models that have answers, the decision model first. */
  models: string[];
  /** The thresholds in calibration.json at the bench target, per model (for comparison with the live refit). */
  fitsByModel: Record<string, { verify1?: number; verify2Conditional?: number }>;
  slots: ExtractSlot[];
}

/** `report` is the bench's bench-report.json (ExtractReport in src/extract/report.ts). */
export interface ExtractExploreResponse {
  kind: 'extract';
  benchId: string;
  createdAt: string | null;
  target: number;
  decision: string;
  baselineModel: string | null;
  report: ExtractReportData;
  calibration: ExtractExploreCalibration | null;
  calibrationMissingReason: string | null;
}
