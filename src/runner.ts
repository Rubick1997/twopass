import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { OpenRouterBatchProvider } from './batch/openrouter.ts';
import { Budget } from './budget.ts';
import { calibrateStage, type StageCalibration } from './calibrate.ts';
import { OpenRouterDecisionModel } from './decide/openrouter.ts';
import { Ledger, replay, type RunState } from './ledger.ts';
import { executePipeline, type RowOutcome } from './pipeline.ts';
import { fetchPrices } from './prices.ts';
import { writeOutputs } from './report.ts';
import {
  createRunDir,
  loadRun,
  newRunId,
  readCsv,
  runDir,
  sample,
  sha256File,
  toRecords,
  writeManifest,
  type RunManifest,
  type RunModels,
} from './run.ts';
import { scoreRun, STAGES, type Stage } from './score.ts';
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
}

/** Creates the run directory and manifest. Does not call any model except the price list. */
export async function startRun(o: StartRunOptions): Promise<{ dir: string; manifest: RunManifest }> {
  const task = await loadTask(o.taskPath);
  const csv = readCsv(o.csvPath);
  let records = toRecords(csv.rows, task.idColumn);
  if (o.sample) records = sample(records, o.sample, o.seed ?? 7);
  if (o.limit) records = records.slice(0, o.limit);
  if (o.labelColumn && !csv.columns.includes(o.labelColumn)) throw new Error(`No column "${o.labelColumn}" in ${o.csvPath}`);

  const mode = o.mode ?? 'normal';
  const models: RunModels = {
    writer: o.models?.writer ?? task.models.writer,
    escalation: o.models?.escalation ?? task.models.escalation,
    triage: o.models?.triage ?? task.models.triage ?? task.models.decision,
    verify: o.models?.verify ?? task.models.verify ?? task.models.decision,
  };
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
    inputColumns: csv.columns,
    rowCount: records.length,
    ...(o.labelColumn ? { labelColumn: o.labelColumn } : {}),
    mode,
    models,
    thresholds: thresholds.values,
    thresholdsSource: thresholds.source,
    prices: await fetchPrices(o.apiKey, writerModels),
    ...(o.maxUsd !== undefined ? { maxUsd: o.maxUsd } : {}),
    taskSha256: sha256File(o.taskPath),
  };
  const dir = runDir(o.runsRoot, runId);
  createRunDir(dir, manifest, records);
  return { dir, manifest };
}

export class TaskChangedError extends Error {}

export interface ExecuteOptions {
  apiKey: string;
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
    batch: new OpenRouterBatchProvider({ apiKey: o.apiKey }),
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
  writeOutputs(dir, outcomes, manifest.inputColumns);
  return { manifest, outcomes, st };
}

// ---------------------------------------------------------------- calibration

export interface CalibrationFile {
  runId: string;
  createdAt: string;
  /** Precision the thresholds were fitted to reach. */
  target: number;
  rows: number;
  models: Record<string, { servedAs?: string[] } & Partial<Record<Stage, StageCalibration>>>;
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

  const calibration: CalibrationFile = {
    runId: manifest.runId,
    createdAt: new Date().toISOString(),
    target: o.target,
    rows: records.length,
    models: {},
  };
  for (const s of scored) {
    const entry: CalibrationFile['models'][string] = {};
    for (const stage of STAGES) if (s.points[stage].length) entry[stage] = calibrateStage(s.points[stage], o.target);
    calibration.models[s.model] = entry;
  }
  const path = join(dir, 'calibration.json');
  writeFileSync(path, JSON.stringify(calibration, null, 2) + '\n');
  return { path, calibration, spentUsd: scored.reduce((n, s) => n + s.spentUsd, 0) };
}

export function readCalibration(path: string): CalibrationFile {
  return JSON.parse(readFileSync(path, 'utf8')) as CalibrationFile;
}

/** t0 from the triage model's triage fit, t1/t2 from the verify model's verify fits. */
export function thresholdsFromCalibration(c: CalibrationFile, triage: string, verify: string): Thresholds {
  const get = (model: string, stage: Stage) => {
    const fit = c.models[model]?.[stage]?.fit;
    if (!fit) throw new Error(`Calibration ${c.runId} has no ${stage} fit for ${model}. Calibrate with --models including it.`);
    return fit.threshold;
  };
  return { t0: get(triage, 'triage'), t1: get(verify, 'verify1'), t2: get(verify, 'verify2') };
}
