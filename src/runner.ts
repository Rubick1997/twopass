import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AnthropicBatchProvider, anthropicSyncCaller, isAnthropicDirect } from './batch/anthropic.ts';
import { OpenRouterBatchProvider, openRouterSyncCaller } from './batch/openrouter.ts';
import { SyncBatchProvider } from './batch/sync.ts';
import type { BatchProvider } from './batch/provider.ts';
import { RoutingBatchProvider } from './batch/router.ts';
import { Budget } from './budget.ts';
import { calibrateStage, NEVER, type StageCalibration, type ThresholdFit } from './calibrate.ts';
import { OpenRouterDecisionModel } from './decide/openrouter.ts';
import { Ledger, parseLedger, replay, type RunState } from './ledger.ts';
import { acquireRunLock } from './lock.ts';
import { executePipeline, type RowOutcome } from './pipeline.ts';
import { CheckFailedError, checkCsv, formatCheckSummary, writeCheckOutputs } from './check.ts';
import type { DecisionModel } from './decide/model.ts';
import type { FetchFn } from './http.ts';
import { fetchModelList, pricesFrom, type OpenRouterModel } from './prices.ts';
import { foldOverrides, readOverrides } from './overrides.ts';
import { writeOutputs } from './report.ts';
import {
  createRunDir,
  loadRun,
  newRunId,
  runDir,
  sample,
  sha256File,
  toRecords,
  writeManifest,
  type RunManifest,
  type RunModels,
} from './run.ts';
import { conditionalFit, scoreRun, STAGES, unacceptedRound2Points, type ModelPoints, type Stage } from './score.ts';
import { loadTask, validateThresholds, type Thresholds } from './task.ts';

export interface StartRunOptions {
  apiKey: string;
  runsRoot: string;
  csvPath: string;
  taskPath: string;
  mode?: RunManifest['mode'];
  sample?: number;
  seed?: number;
  limit?: number;
  labelColumn?: string;
  models?: Partial<RunModels>;
  thresholds?: { values: Thresholds; source: string };
  maxUsd?: number;
  runIdSuffix?: string;
  /**
   * `sync` (eval gate): writer calls one by one at list price. The writer / escalation IDs must then be the IDs to call:
   * an Anthropic ID (`claude-haiku-5-5`) or a plain OpenRouter ID (no `:batch`). See `src/batch/route.ts`.
   */
  transport?: 'sync';
  /** Prints check warnings before the run starts. */
  log?: (m: string) => void;
  /** For tests: every HTTP call startRun makes (the model list) goes through this. */
  fetch?: FetchFn;
}

export { CheckFailedError };

/**
 * Checks and normalizes the CSV (`twopass check`), then creates the run directory and manifest.
 * Throws CheckFailedError, before any network call and without creating anything, when the CSV
 * has errors. Calls no model; the only request is OpenRouter's model list (context lengths, prices).
 */
export async function startRun(o: StartRunOptions): Promise<{ dir: string; manifest: RunManifest }> {
  const task = await loadTask(o.taskPath);
  const mode = o.mode ?? 'normal';
  const models: RunModels = {
    writer: o.models?.writer ?? task.models.writer,
    escalation: o.models?.escalation ?? task.models.escalation,
    triage: o.models?.triage ?? task.models.triage ?? task.models.decision,
    verify: o.models?.verify ?? task.models.verify ?? task.models.decision,
  };
  // One GET /models serves both the context-length check and the prices.
  let modelList: Promise<OpenRouterModel[]> | undefined;
  const loadModels = () => (modelList ??= fetchModelList(o.apiKey, o.fetch ?? fetch));

  const check = await checkCsv(o.csvPath, task, {
    ...(o.labelColumn ? { labelColumn: o.labelColumn } : {}),
    models:
      mode === 'baseline'
        ? { writer: models.writer }
        : { writer: models.writer, escalation: models.escalation, ...(task.triage ? { triage: models.triage } : {}), verify: models.verify },
    loadModels,
  });
  const summary = formatCheckSummary(check.report, { heading: `checking ${o.csvPath}` });
  if (check.report.errors.length) {
    throw new CheckFailedError(
      `${summary}\n  Full report: twopass check ${o.csvPath} --task ${o.taskPath}${o.labelColumn ? ` --label ${o.labelColumn}` : ''}`,
      check.report,
    );
  }
  if (check.report.warnings.length) o.log?.(summary);

  let records = toRecords(check.rows, task.idColumn);
  if (o.sample) records = sample(records, o.sample, o.seed ?? 7);
  if (o.limit) records = records.slice(0, o.limit);
  let thresholds = o.thresholds;
  if (!thresholds) {
    if (mode === 'normal' && !task.thresholds) throw new Error('The task has no thresholds. Pass them or a calibration file.');
    thresholds = { values: task.thresholds ?? { t0: 1, t1: 1, t2: 1 }, source: task.thresholds ? 'task file' : 'none (not used in this mode)' };
  }
  validateThresholds(thresholds.values);

  const runId = newRunId(task.name) + (o.runIdSuffix ? `-${o.runIdSuffix}` : '');
  const writerModels = mode === 'baseline' ? [models.writer] : [models.writer, models.escalation];
  const manifest: RunManifest = {
    runId,
    createdAt: new Date().toISOString(),
    taskPath: resolve(o.taskPath),
    inputPath: resolve(o.csvPath),
    inputColumns: check.columns,
    rowCount: records.length,
    ...(o.labelColumn ? { labelColumn: o.labelColumn } : {}),
    mode,
    models,
    thresholds: thresholds.values,
    thresholdsSource: thresholds.source,
    prices: pricesFrom(await loadModels(), writerModels, o.transport ?? 'batch'),
    ...(o.transport ? { transport: o.transport } : {}),
    ...(o.maxUsd !== undefined ? { maxUsd: o.maxUsd } : {}),
    taskSha256: sha256File(o.taskPath),
    writerCache: task.writer.cacheSystem ?? null,
    input: {
      originalSha256: check.report.input.sha256,
      normalizedSha256: check.report.output.sha256,
      checkReport: 'check-report.json',
      warnings: check.report.warnings.length,
    },
  };
  const dir = runDir(o.runsRoot, runId);
  createRunDir(dir, manifest, records);
  writeCheckOutputs(dir, check);
  return { dir, manifest };
}

export class TaskChangedError extends Error {}

export interface ExecuteOptions {
  apiKey: string;
  /** Key for Claude models called directly (writer / escalation IDs like `claude-haiku-5-5`). */
  anthropicApiKey?: string;
  /** Shared budget (bench). Otherwise one is made from the manifest's cap. */
  budget?: Budget;
  maxUsdOverride?: number;
  allowTaskChange?: boolean;
  maxRowsPerBatch?: number;
  log?: (m: string) => void;
}

export async function executeRun(
  dir: string,
  o: ExecuteOptions,
): Promise<{ manifest: RunManifest; outcomes: RowOutcome[]; st: RunState }> {
  const { manifest, records } = loadRun(dir);
  if (o.maxUsdOverride !== undefined) manifest.maxUsd = o.maxUsdOverride;

  const sha = sha256File(manifest.taskPath);
  if (manifest.taskSha256 && sha !== manifest.taskSha256 && !manifest.taskChanges?.some((c) => c.sha256 === sha)) {
    if (!o.allowTaskChange) {
      throw new TaskChangedError(
        `The task file changed since this run started (${manifest.taskPath}). ` +
          `Resume with --allow-task-change to continue with the new version; the change is recorded in the manifest.`,
      );
    }
    (manifest.taskChanges ??= []).push({ at: new Date().toISOString(), sha256: sha });
  }
  writeManifest(dir, manifest);

  // Heartbeat for `twopass ui`. Advisory: a stale lock from a crash is simply overwritten.
  const lock = acquireRunLock(dir);
  try {
    return await executeLocked(dir, manifest, records, o);
  } finally {
    lock.release();
  }
}

async function executeLocked(
  dir: string,
  manifest: RunManifest,
  records: ReturnType<typeof loadRun>['records'],
  o: ExecuteOptions,
): Promise<{ manifest: RunManifest; outcomes: RowOutcome[]; st: RunState }> {
  const task = await loadTask(manifest.taskPath);
  const ledger = new Ledger(join(dir, 'ledger.jsonl'));
  const budget = o.budget ?? new Budget(manifest.maxUsd, replay(ledger.read()).spentUsd);
  const decider = (model: string) => new OpenRouterDecisionModel({ apiKey: o.apiKey, model });
  const triageDecider = decider(manifest.models.triage);

  const outcomes = await executePipeline({
    task,
    rows: records,
    ledger,
    budget,
    triageDecider,
    verifyDecider: manifest.models.verify === manifest.models.triage ? triageDecider : decider(manifest.models.verify),
    batch: batchProviderFor(manifest, o),
    writerModel: manifest.models.writer,
    escalationModel: manifest.models.escalation,
    thresholds: manifest.thresholds,
    prices: manifest.prices,
    mode: manifest.mode,
    ...(o.maxRowsPerBatch ? { maxRowsPerBatch: o.maxRowsPerBatch } : {}),
    ...(o.log ? { log: o.log } : {}),
  });

  const st = replay(ledger.read());
  manifest.servedModels = [...new Set([...st.triage.values(), ...st.verify.values()].map((d) => d.model))].sort();
  writeManifest(dir, manifest);
  // The pipeline above never reads overrides.jsonl. Only the output files fold in a reviewer's
  // decisions, so a run finishing after (or during) review doesn't put reviewed rows back in review.csv.
  writeOutputs(dir, foldOverrides(outcomes, readOverrides(dir)), manifest.inputColumns);
  return { manifest, outcomes, st };
}

/** Batches (the default) route by ID shape; a `sync` run calls each request directly, through the same router rule. */
export function batchProviderFor(manifest: Pick<RunManifest, 'transport'>, o: Pick<ExecuteOptions, 'apiKey' | 'anthropicApiKey'>): BatchProvider {
  if (manifest.transport === 'sync') {
    const openRouter = openRouterSyncCaller({ apiKey: o.apiKey });
    const anthropic = o.anthropicApiKey ? anthropicSyncCaller({ apiKey: o.anthropicApiKey }) : undefined;
    return new SyncBatchProvider({
      callerFor: (model) => {
        if (!isAnthropicDirect(model)) return openRouter;
        if (!anthropic) throw new Error(`Model ${model} uses Anthropic directly: set ANTHROPIC_API_KEY`);
        return anthropic;
      },
    });
  }
  return new RoutingBatchProvider(
    new OpenRouterBatchProvider({ apiKey: o.apiKey }),
    o.anthropicApiKey ? new AnthropicBatchProvider({ apiKey: o.anthropicApiKey }) : undefined,
  );
}

// ---------------------------------------------------------------- calibration

/** Extra precision targets an extraction calibration stores fits for (besides the file's `target`). */
export const EXTRA_TARGETS = [0.98];

/** Fits at another precision target: verify1, and verify2 on the slots that verify1 threshold did not accept. */
export interface OperatingPoint {
  verify1: ThresholdFit;
  verify2Conditional: ThresholdFit & { n: number; correct: number };
}

export interface ModelCalibration extends Partial<Record<Stage, StageCalibration>> {
  servedAs?: string[];
  /**
   * Extraction tasks: verify2 restricted to the slots the same model's verify1 did not accept at its fitted verify1
   * threshold (the fields a real run sends to round 2). `verify2` stays as the all-slots fit, for the record.
   */
  verify2Conditional?: StageCalibration;
  /** Extraction tasks: other targets, keyed by the target ("0.98"). */
  operatingPoints?: Record<string, OperatingPoint>;
}

export interface CalibrationFile {
  runId: string;
  createdAt: string;
  /** Precision the thresholds were fitted to reach. */
  target: number;
  rows: number;
  models: Record<string, ModelCalibration>;
}

/** Pure: scored points per model -> the calibration file. Extraction models also get the conditional round-2 fit. */
export function buildCalibration(runId: string, rows: number, target: number, scored: ModelPoints[]): CalibrationFile {
  const calibration: CalibrationFile = { runId, createdAt: new Date().toISOString(), target, rows, models: {} };
  for (const s of scored) {
    const entry: ModelCalibration = {};
    for (const stage of STAGES) if (s.points[stage].length) entry[stage] = calibrateStage(s.points[stage], target);
    if (s.verify2Slots) {
      const t1 = entry.verify1?.fit.threshold ?? NEVER;
      const conditional = unacceptedRound2Points(s.verify2Slots, t1);
      if (conditional.length) entry.verify2Conditional = calibrateStage(conditional, target);
      if (s.points.verify1.length && s.verify2Slots.length) {
        entry.operatingPoints = Object.fromEntries(EXTRA_TARGETS.map((t) => [String(t), conditionalFit(s.points.verify1, s.verify2Slots!, t)]));
      }
    }
    calibration.models[s.model] = entry;
  }
  return calibration;
}

/**
 * Scores a labeled `collect` run with each decision model (reusing the run's own answers and a
 * cache) and fits per-stage thresholds. Writes <runDir>/calibration.json.
 */
export async function calibrateRun(
  dir: string,
  o: { apiKey: string; models: string[]; target: number; budget?: Budget; log?: (m: string) => void },
): Promise<{ path: string; calibration: CalibrationFile; spentUsd: number }> {
  const { manifest, records } = loadRun(dir);
  if (!manifest.labelColumn) throw new Error('Calibration needs a labeled run (--label).');
  if (manifest.mode !== 'collect') {
    o.log?.('warning: this run was not made with --collect, so later stages only saw the rows earlier stages rejected');
  }
  const task = await loadTask(manifest.taskPath);
  const st = replay(new Ledger(join(dir, 'ledger.jsonl')).read());
  const scored = await scoreRun({
    dir,
    task,
    records,
    labelColumn: manifest.labelColumn,
    st,
    runModels: { triage: manifest.models.triage, verify: manifest.models.verify },
    models: o.models.map((model) => new OpenRouterDecisionModel({ apiKey: o.apiKey, model })),
    ...(o.budget ? { budget: o.budget } : {}),
    ...(o.log ? { log: o.log } : {}),
  });

  const calibration = buildCalibration(manifest.runId, records.length, o.target, scored);
  const path = join(dir, 'calibration.json');
  writeFileSync(path, JSON.stringify(calibration, null, 2) + '\n');
  return { path, calibration, spentUsd: scored.reduce((n, s) => n + s.spentUsd, 0) };
}

/** A decision model that must never be asked anything: the refit path has no network client at all. */
export const noCallModel = (id: string): DecisionModel => ({
  id,
  decide: async () => {
    throw new Error(`refit must not call a model (${id})`);
  },
});

/**
 * Recomputes the calibration of a finished `collect` run from data already on disk: the run's ledger (read without
 * opening a Ledger, so nothing is repaired or written) and its scores.jsonl cache. Makes no model call; the models
 * given to scoreRun throw if asked, and `ledgerOnly` means they never are. Does not write the file.
 */
export async function refitCalibration(dir: string, o: { models: string[]; target: number }): Promise<CalibrationFile> {
  const { manifest, records } = loadRun(dir);
  if (!manifest.labelColumn) throw new Error('Calibration needs a labeled run (--label).');
  const task = await loadTask(manifest.taskPath);
  const ledgerPath = join(dir, 'ledger.jsonl');
  const st = replay(existsSync(ledgerPath) ? parseLedger(readFileSync(ledgerPath, 'utf8'), ledgerPath) : []);
  const scored = await scoreRun({
    dir,
    task,
    records,
    labelColumn: manifest.labelColumn,
    st,
    runModels: { triage: manifest.models.triage, verify: manifest.models.verify },
    models: o.models.map(noCallModel),
    ledgerOnly: true,
  });
  return buildCalibration(manifest.runId, records.length, o.target, scored);
}

export function readCalibration(path: string): CalibrationFile {
  return JSON.parse(readFileSync(path, 'utf8')) as CalibrationFile;
}

/** t0 from the triage model's triage fit, t1/t2 from the verify model's verify fits (t2: the conditional fit when present). */
export function thresholdsFromCalibration(c: CalibrationFile, triage: string, verify: string): Thresholds {
  const get = (model: string, stage: Stage) => {
    const fit = c.models[model]?.[stage]?.fit;
    if (!fit) throw new Error(`Calibration ${c.runId} has no ${stage} fit for ${model}. Calibrate with --models including it.`);
    return fit.threshold;
  };
  // An extraction task has no triage stage: its model's entry has no triage fit at all, and t0 is unused.
  const noTriageStage = c.models[triage] !== undefined && c.models[triage]!.triage === undefined && c.models[triage]!.verify1 !== undefined;
  // Extraction: t2 is fitted on the fields round 1 did not accept, when the calibration has that fit.
  const t0 = noTriageStage ? NEVER : get(triage, 'triage');
  const t1 = get(verify, 'verify1');
  return { t0, t1, t2: c.models[verify]?.verify2Conditional?.fit.threshold ?? get(verify, 'verify2') };
}
