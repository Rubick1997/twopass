import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stringify } from 'csv-stringify/sync';
import { DECISION_ALIASES, prefix, spentSoFar } from './bench.ts';
import { Budget } from './budget.ts';
import { clean } from './check.ts';
import { NEVER } from './calibrate.ts';
import { ensureVrdu, loadVrduDocuments, type VrduDocument } from './datasets/vrdu.ts';
import type { Answer } from './decide/model.ts';
import { OpenRouterDecisionModel } from './decide/openrouter.ts';
import { computeFieldOutcomes, unacceptedFields } from './extract/outcomes.ts';
import {
  buildExtractReport,
  FIELD_CSV_COLUMNS,
  fieldCsvRecords,
  renderExtractReport,
  type CalibrationFacts,
  type CheckerInput,
  type OperatingInput,
  type TextCheck,
} from './extract/report.ts';
import { customId, parseLedger, replay, verifyKey, type RunState } from './ledger.ts';
import type { RowRecord } from './pipeline.ts';
import { loadRun } from './run.ts';
import {
  calibrateRun,
  EXTRA_TARGETS,
  executeRun,
  readCalibration,
  refitCalibration,
  startRun,
  thresholdsFromCalibration,
  type CalibrationFile,
} from './runner.ts';
import { scoreRun } from './score.ts';
import { loadTask, type Thresholds } from './task.ts';
import { asChoice } from './decide/model.ts';

// `twopass bench vrdu`:
//   1. documents.jsonl + the committed splits → data/vrdu/<name>.csv (doc_id, template, text, gold)
//   2. calibration: a `collect` run on the calibration documents, thresholds fitted for the decision model and every --also model
//   3. test: one `normal` run with the fitted thresholds and one `baseline` run, concurrently
//   4. each --also checker judges the test run's round-1 values (stage verify1 only)
//   5. bench-report.json / bench-report.md (pure: src/extract/report.ts) and enriched-fields.csv in both test run dirs
// Resumable: `twopass bench vrdu --id <benchId>`. State lives in runs/<benchId>/bench.json with kind 'extract'.

/** Dev split: the first 15 dev documents calibrate, the other 15 test. Numbers from it are for debugging only. */
export const DEV_CALIBRATION_DOCS = 15;

export interface VrduBenchOptions {
  apiKey: string;
  anthropicApiKey?: string;
  runsRoot: string;
  dataDir: string;
  maxUsd: number;
  split: 'dev' | 'test';
  /** Decision model ID (aliases already resolved). */
  decision: string;
  /** Other checkers, judging the same round-1 values (aliases already resolved). */
  also: string[];
  baseline: string;
  target: number;
  maxRowsPerBatch?: number;
  id?: string;
  log: (m: string) => void;
  /** Test seams. Defaults: the repo's task file, committed splits, and `ensureVrdu`. */
  taskPath?: string;
  splitsPath?: string;
  ensureData?: (dataDir: string, log: (m: string) => void) => Promise<string>;
}

export interface VrduBenchState {
  kind: 'extract';
  benchId: string;
  createdAt: string;
  taskPath: string;
  split: 'dev' | 'test';
  decision: string;
  also: string[];
  baseline: string;
  target: number;
  calibrationDocuments: number;
  testDocuments: number;
  calibrationRunId?: string;
  calibrationPath?: string;
  /** `normal` and `baseline`. */
  testRuns: Record<string, string>;
  maxUsd?: number;
  /**
   * Set by `bench vrdu --id <id> --refit`: the round-2 threshold was refitted after the test split had been read once.
   * The report takes its thresholds from here when present, else from the normal run's manifest (which is never touched).
   */
  refit?: { at: string; previousThresholds: Thresholds; thresholds: Thresholds; reason: string };
  /** What `check` did to the document text, per run (calibration, normal, baseline). */
  textCheck?: Record<string, TextCheck>;
  /** The UI lists benches by `configs`; an extract bench has none. */
  configs: never[];
}

interface Splits {
  dev: string[];
  calibration: string[];
  test: string[];
}

function repoFile(...candidates: string[]): string {
  const paths = candidates.map((p) => fileURLToPath(new URL(p, import.meta.url)));
  const found = paths.find((p) => existsSync(p));
  if (!found) throw new Error(`Cannot find ${candidates[0]!.replace(/^(\.\.\/)+/, '')}`);
  return found;
}

// src/bench-vrdu.ts → tasks/vrdu.task.ts; dist/src/bench-vrdu.js → dist/tasks/vrdu.task.js
export const vrduTaskPath = (): string => repoFile('../tasks/vrdu.task.ts', '../tasks/vrdu.task.js');
// src/bench-vrdu.ts → bench/vrdu/splits.json; dist/src/bench-vrdu.js → bench/vrdu/splits.json (two levels up)
export const vrduSplitsPath = (): string => repoFile('../bench/vrdu/splits.json', '../../bench/vrdu/splits.json');

/** Which documents calibrate and which test. */
export function pickSplit(splits: Splits, split: 'dev' | 'test'): { name: string; calibration: string[]; test: string[] } {
  if (split === 'dev') {
    return { name: 'dev-', calibration: splits.dev.slice(0, DEV_CALIBRATION_DOCS), test: splits.dev.slice(DEV_CALIBRATION_DOCS, 2 * DEV_CALIBRATION_DOCS) };
  }
  return { name: '', calibration: splits.calibration, test: splits.test };
}

/** The CSV a run reads: doc_id, template, text, gold (JSON of the gold map). */
export function writeDocumentCsv(path: string, docs: VrduDocument[]): void {
  writeFileSync(
    path,
    stringify(docs.map((d) => ({ doc_id: d.docId, template: d.template, text: d.text, gold: JSON.stringify(d.gold) })), {
      header: true,
      columns: ['doc_id', 'template', 'text', 'gold'],
    }),
  );
}

/**
 * Compares the `text` each run stored (after `check`) with the dataset's. `check` applies its documented cell normalisation
 * (see `clean` in check.ts); a stored text that differs from `clean(original)` is a bug and throws. Differences that
 * `clean` explains are counted by kind, and the ones inside the text (not just trimmed at the ends) are reported.
 */
export function compareDocumentText(docs: VrduDocument[], records: RowRecord[]): TextCheck {
  const byId = new Map(docs.map((d) => [d.docId, d.text]));
  const out: TextCheck = { documents: 0, changed: 0, changedInside: 0, kinds: {} };
  for (const r of records) {
    const original = byId.get(r.id);
    if (original === undefined) throw new Error(`Run row ${r.id} is not in the dataset`);
    const stored = r.data.text ?? '';
    out.documents++;
    if (stored === original) continue;
    const { value, kinds } = clean(original);
    if (stored !== value) throw new Error(`Document ${r.id}: the stored text differs from the dataset in a way \`check\` does not explain`);
    out.changed++;
    for (const k of kinds) out.kinds[k] = (out.kinds[k] ?? 0) + 1;
    if ([...kinds].some((k) => k !== 'trimmed_cells')) out.changedInside++;
  }
  return out;
}

const mergeText = (a: TextCheck | undefined, b: TextCheck): TextCheck => {
  if (!a) return b;
  const kinds = { ...a.kinds };
  for (const [k, v] of Object.entries(b.kinds)) kinds[k] = (kinds[k] ?? 0) + v;
  return { documents: a.documents + b.documents, changed: a.changed + b.changed, changedInside: a.changedInside + b.changedInside, kinds };
};

function readLedger(dir: string): RunState {
  const path = join(dir, 'ledger.jsonl');
  return replay(existsSync(path) ? parseLedger(readFileSync(path, 'utf8'), path) : []);
}

/** A checker's answers to the round-1 values: the run's own from its ledger, others' from the score cache (stage verify1). */
export function checkerAnswers(dir: string, st: RunState, model: string, runVerifyModel: string): Map<string, Record<string, Answer>> {
  const out = new Map<string, Record<string, Answer>>();
  if (model === runVerifyModel) {
    for (const d of st.verify.values()) if (d.round === 1) out.set(d.rowId, d.answers);
    return out;
  }
  const path = join(dir, 'scores.jsonl');
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { model: string; stage: string; rowId: string; answers?: Record<string, Answer> };
      if (r.model === model && r.stage === 'verify1' && r.answers) out.set(r.rowId, r.answers);
    } catch {
      // torn last line
    }
  }
  return out;
}

export async function runVrduBench(o: VrduBenchOptions): Promise<{ benchDir: string; reportPath: string }> {
  const benchId = o.id ?? `bench-vrdu-${new Date().toISOString().slice(0, 10)}-${randomBytes(2).toString('hex')}`;
  const benchDir = resolve(o.runsRoot, benchId);
  const statePath = join(benchDir, 'bench.json');
  let state: VrduBenchState;
  if (existsSync(statePath)) {
    state = JSON.parse(readFileSync(statePath, 'utf8')) as VrduBenchState;
    if (state.kind !== 'extract') throw new Error(`${benchId} is not an extract bench`);
    o.log(`resuming ${benchId} (${state.split} split; its saved options apply)`);
  } else {
    if (o.id) throw new Error(`No bench found at ${benchDir}`);
    mkdirSync(benchDir, { recursive: true });
    state = {
      kind: 'extract',
      benchId,
      createdAt: new Date().toISOString(),
      taskPath: o.taskPath ?? vrduTaskPath(),
      split: o.split,
      decision: o.decision,
      also: [...new Set(o.also.filter((m) => m !== o.decision))],
      baseline: o.baseline,
      target: o.target,
      calibrationDocuments: 0,
      testDocuments: 0,
      testRuns: {},
      configs: [],
    };
  }
  const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  state.maxUsd = o.maxUsd;
  save();

  const budget = new Budget(o.maxUsd, spentSoFar(o.runsRoot, state));
  o.log(`bench ${benchId}: cap $${o.maxUsd}, spent so far $${budget.spentUsd.toFixed(2)}`);
  const keys = { apiKey: o.apiKey, ...(o.anthropicApiKey ? { anthropicApiKey: o.anthropicApiKey } : {}) };

  // ---- 1. documents and CSVs
  const documentsPath = await (o.ensureData ?? ensureVrdu)(o.dataDir, o.log);
  const docs = loadVrduDocuments(documentsPath);
  const byId = new Map(docs.map((d) => [d.docId, d]));
  const splits = JSON.parse(readFileSync(o.splitsPath ?? vrduSplitsPath(), 'utf8')) as Splits;
  const pick = pickSplit(splits, state.split);
  const take = (ids: string[]) =>
    ids.map((id) => {
      const d = byId.get(id);
      if (!d) throw new Error(`Split document ${id} is not in the dataset`);
      return d;
    });
  const calibrationDocs = take(pick.calibration);
  const testDocs = take(pick.test);
  state.calibrationDocuments = calibrationDocs.length;
  state.testDocuments = testDocs.length;
  const dataDir = join(resolve(o.dataDir), 'vrdu');
  mkdirSync(dataDir, { recursive: true });
  const calibrationCsv = join(dataDir, `${pick.name}calibration.csv`);
  const testCsv = join(dataDir, `${pick.name}test.csv`);
  writeDocumentCsv(calibrationCsv, calibrationDocs);
  writeDocumentCsv(testCsv, testDocs);
  save();

  const checkText = (name: string, runId: string, expected: VrduDocument[]) => {
    const { records } = loadRun(resolve(o.runsRoot, runId));
    const result = compareDocumentText(expected, records);
    (state.textCheck ??= {})[name] = result;
    if (result.changedInside) {
      o.log(
        `warning: check changed the text inside ${result.changedInside} of ${result.documents} ${name} documents ` +
          `(${Object.entries(result.kinds).map(([k, v]) => `${k} ${v}`).join(', ')})`,
      );
    }
    save();
  };

  // ---- 2. calibration
  if (!state.calibrationRunId) {
    const { manifest } = await startRun({
      ...keys,
      runsRoot: o.runsRoot,
      csvPath: calibrationCsv,
      taskPath: state.taskPath,
      mode: 'collect',
      labelColumn: 'gold',
      models: { triage: state.decision, verify: state.decision },
      runIdSuffix: 'calib',
      log: o.log,
    });
    state.calibrationRunId = manifest.runId;
    save();
    checkText('calibration', manifest.runId, calibrationDocs);
  }
  const decisionModels = [state.decision, ...state.also];
  if (!state.calibrationPath) {
    const calibDir = resolve(o.runsRoot, state.calibrationRunId);
    o.log(`calibration: collecting on ${calibrationDocs.length} documents (${state.calibrationRunId})`);
    await executeRun(calibDir, { ...keys, budget, ...(o.maxRowsPerBatch ? { maxRowsPerBatch: o.maxRowsPerBatch } : {}), log: prefix(o.log, 'calib') });
    const { path } = await calibrateRun(calibDir, { apiKey: o.apiKey, models: decisionModels, target: state.target, budget, log: prefix(o.log, 'calib') });
    state.calibrationPath = path;
    save();
  }
  const calibration = readCalibration(state.calibrationPath);
  const thresholds = thresholdsFromCalibration(calibration, state.decision, state.decision);
  const thresholdsSource = thresholdsSourceOf(calibration, state.decision);

  // ---- 3. test runs
  if (!state.testRuns.normal) {
    const { manifest } = await startRun({
      ...keys,
      runsRoot: o.runsRoot,
      csvPath: testCsv,
      taskPath: state.taskPath,
      labelColumn: 'gold',
      models: { triage: state.decision, verify: state.decision },
      thresholds: { values: thresholds, source: thresholdsSource },
      runIdSuffix: 'normal',
      log: o.log,
    });
    state.testRuns.normal = manifest.runId;
    save();
    checkText('normal', manifest.runId, testDocs);
  }
  if (!state.testRuns.baseline) {
    const { manifest } = await startRun({
      ...keys,
      runsRoot: o.runsRoot,
      csvPath: testCsv,
      taskPath: state.taskPath,
      labelColumn: 'gold',
      mode: 'baseline',
      models: { writer: state.baseline },
      runIdSuffix: 'baseline',
      log: o.log,
    });
    state.testRuns.baseline = manifest.runId;
    save();
    checkText('baseline', manifest.runId, testDocs);
  }
  o.log(`test runs: ${Object.entries(state.testRuns).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  const exec = (name: 'normal' | 'baseline') =>
    executeRun(resolve(o.runsRoot, state.testRuns[name]!), { ...keys, budget, ...(o.maxRowsPerBatch ? { maxRowsPerBatch: o.maxRowsPerBatch } : {}), log: prefix(o.log, name) });
  const settled = await Promise.allSettled((['normal', 'baseline'] as const).map(exec));
  const failed = settled.flatMap((s, i) => (s.status === 'rejected' ? [`${['normal', 'baseline'][i]}: ${String(s.reason)}`] : []));
  if (failed.length) throw new Error(`Some runs stopped:\n  ${failed.join('\n  ')}\nResume with: twopass bench vrdu --id ${benchId} --max-usd ${o.maxUsd}`);

  // ---- 4. other checkers on the test run's round-1 values
  const normalDir = resolve(o.runsRoot, state.testRuns.normal!);
  const baselineDir = resolve(o.runsRoot, state.testRuns.baseline!);
  if (state.also.length) {
    const { manifest, records } = loadRun(normalDir);
    const task = await loadTask(manifest.taskPath);
    o.log(`scoring ${state.also.join(', ')} on the test run's round-1 values`);
    await scoreRun({
      dir: normalDir,
      task,
      records,
      labelColumn: 'gold',
      st: readLedger(normalDir),
      runModels: { triage: manifest.models.triage, verify: manifest.models.verify },
      models: state.also.map((model) => new OpenRouterDecisionModel({ apiKey: o.apiKey, model })),
      stages: ['verify1'],
      budget,
      log: prefix(o.log, 'also'),
    });
  }

  // ---- 5. report
  const out = await assembleReport(state, calibration, normalDir, baselineDir);
  writeReportFiles(benchDir, out);
  o.log(`spent $${budget.spentUsd.toFixed(2)} of $${o.maxUsd}`);
  return { benchDir, reportPath: join(benchDir, 'bench-report.md') };
}

/** What `thresholdsSource` says: whether t2 came from the conditional fit or the old all-slots one. */
export function thresholdsSourceOf(calibration: CalibrationFile, decision: string): string {
  const base = `calibration ${calibration.runId} (target precision ${calibration.target}, `;
  return calibration.models[decision]?.verify2Conditional
    ? `${base}t1 on all field slots, t2 on the slots round 1 did not accept)`
    : `${base}one point per field slot, t2 on all slots)`;
}

interface AssembledReport {
  report: ReturnType<typeof buildExtractReport>;
  markdown: string;
  normalDir: string;
  baselineDir: string;
  normalCsv: string;
  baselineCsv: string;
}

/**
 * Pure over what is on disk: reads the test runs (never writes them), the task and the calibration, and builds the report.
 * Thresholds come from the bench state's `refit` when present, else from the normal run's manifest.
 */
async function assembleReport(
  state: VrduBenchState,
  calibration: CalibrationFile,
  normalDir: string,
  baselineDir: string,
): Promise<AssembledReport> {
  const task = await loadTask(state.taskPath);
  const normalRun = loadRun(normalDir);
  const baselineRun = loadRun(baselineDir);
  const normalSt = readLedger(normalDir);
  const baselineSt = readLedger(baselineDir);
  const verifyModel = normalRun.manifest.models.verify;
  const decisionModels = [state.decision, ...state.also];
  const thresholds = state.refit?.thresholds ?? normalRun.manifest.thresholds;
  const thresholdsSource = state.refit
    ? `${thresholdsSourceOf(calibration, state.decision)}, refitted after the first test read`
    : normalRun.manifest.thresholdsSource;
  const fit = (model: string, stage: 'verify1' | 'verify2') => calibration.models[model]?.[stage]?.fit.threshold ?? NEVER;
  const checkers: CheckerInput[] = decisionModels.map((model) => ({
    model,
    threshold: model === state.decision ? thresholds.t1 : fit(model, 'verify1'),
    answers: checkerAnswers(normalDir, normalSt, model, verifyModel),
  }));
  const operating = operatingInput(calibration, state.decision, decisionModels, (model) => checkerAnswers(normalDir, normalSt, model, verifyModel));
  const report = buildExtractReport({
    benchId: state.benchId,
    createdAt: new Date().toISOString(),
    split: state.split,
    task,
    rows: normalRun.records,
    normal: normalSt,
    baseline: baselineSt,
    thresholds,
    thresholdsSource,
    decisionModel: state.decision,
    baselineModel: state.baseline,
    checkers,
    calibration: calibrationFacts(calibration, decisionModels),
    target: state.target,
    ...(state.textCheck?.normal ? { textCheck: mergeText(state.textCheck.normal, state.textCheck.calibration ?? emptyText()) } : {}),
    ...(state.refit ? { refit: { at: state.refit.at, previousThresholds: state.refit.previousThresholds, reason: state.refit.reason } } : {}),
    ...(operating ? { operating } : {}),
  });
  const ctx = { task, rows: normalRun.records, thresholds };
  const csv = (outcomes: ReturnType<typeof computeFieldOutcomes>, rows: RowRecord[]) =>
    stringify(fieldCsvRecords(outcomes, rows), { header: true, columns: [...FIELD_CSV_COLUMNS] });
  return {
    report,
    markdown: renderExtractReport(report),
    normalDir,
    baselineDir,
    normalCsv: csv(computeFieldOutcomes(normalSt, { ...ctx, mode: 'normal' }), normalRun.records),
    baselineCsv: csv(computeFieldOutcomes(baselineSt, { ...ctx, rows: baselineRun.records, mode: 'baseline' }), baselineRun.records),
  };
}

function writeReportFiles(benchDir: string, a: AssembledReport): void {
  writeFileSync(join(benchDir, 'bench-report.json'), JSON.stringify(a.report, null, 2) + '\n');
  writeFileSync(join(benchDir, 'bench-report.md'), a.markdown);
  writeFileSync(join(a.normalDir, 'enriched-fields.csv'), a.normalCsv);
  writeFileSync(join(a.baselineDir, 'enriched-fields.csv'), a.baselineCsv);
}

/** The 98% operating point from the calibration; undefined for a calibration made before it existed. */
function operatingInput(
  c: CalibrationFile,
  decision: string,
  models: string[],
  answers: (model: string) => CheckerInput['answers'],
): OperatingInput | undefined {
  const target = EXTRA_TARGETS[0]!;
  const own = c.models[decision]?.operatingPoints?.[String(target)];
  if (!own) return undefined;
  const checkers: CheckerInput[] = [];
  for (const model of models) {
    const op = c.models[model]?.operatingPoints?.[String(target)];
    if (op) checkers.push({ model, threshold: op.verify1.threshold, answers: answers(model) });
  }
  return { target, thresholds: { t0: NEVER, t1: own.verify1.threshold, t2: own.verify2Conditional.threshold }, checkers };
}

export const REFIT_REASON = 'round-2 threshold fitted on fields round 1 did not accept';

/**
 * Round 2 on the test run was triggered by t1 (`unacceptedFields(..., t1)` in `verifyRound`, and the same call in
 * `computeFieldOutcomes`), and verify2 was asked for every field t1 did not accept. Only the accept decision at t2 can
 * change, so replaying under a new t2 is exact. This checks the ledger really holds every answer that replay needs.
 */
export function assertReplayable(task: Awaited<ReturnType<typeof loadTask>>, st: RunState, rows: RowRecord[], t1: number): void {
  for (const row of rows) {
    if (!st.verify.has(verifyKey(row.id, 1))) continue;
    const need = unacceptedFields(task, st, row.id, 1, t1);
    if (!need.length || !st.results.get(customId(row.id, 2))?.ok) continue;
    const v2 = st.verify.get(verifyKey(row.id, 2));
    if (!v2) throw new Error(`Cannot replay: document ${row.id} needs a round-2 verify answer that is not in the ledger`);
    const missing = need.filter((f) => !asChoice(v2.answers[f]));
    if (missing.length) throw new Error(`Cannot replay: document ${row.id} has no round-2 answer for ${missing.join(', ')}`);
  }
}

/**
 * `bench vrdu --id <id> --refit`: refits the round-2 threshold from data already on disk and rewrites the reports.
 * Makes no model call and builds no network client: it needs no API key.
 */
export async function refitVrduBench(o: { runsRoot: string; id: string; log: (m: string) => void }): Promise<{ benchDir: string; reportPath: string }> {
  const benchDir = resolve(o.runsRoot, o.id);
  const statePath = join(benchDir, 'bench.json');
  if (!existsSync(statePath)) throw new Error(`No bench found at ${benchDir}`);
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as VrduBenchState;
  if (state.kind !== 'extract') throw new Error(`${o.id} is not an extract bench`);
  if (!state.calibrationRunId || !state.calibrationPath || !state.testRuns.normal || !state.testRuns.baseline) {
    throw new Error(`${o.id} has not finished its calibration and test runs; resume it first`);
  }
  const calibDir = resolve(o.runsRoot, state.calibrationRunId);
  const normalDir = resolve(o.runsRoot, state.testRuns.normal);
  const baselineDir = resolve(o.runsRoot, state.testRuns.baseline);
  const decisionModels = [state.decision, ...state.also];
  const before = readCalibration(state.calibrationPath);

  // 1. the calibration again, from the ledger and scores.jsonl only
  const fresh = await refitCalibration(calibDir, { models: decisionModels, target: before.target });
  for (const [model, old] of Object.entries(before.models)) {
    for (const stage of ['verify1', 'verify2'] as const) {
      const a = old[stage];
      const b = fresh.models[model]?.[stage];
      if (!a) continue;
      if (!b || a.n !== b.n || a.correct !== b.correct || a.fit.threshold !== b.fit.threshold) {
        throw new Error(`Refit: ${model} ${stage} does not match the saved calibration (n ${a.n} vs ${b?.n}); the cached answers on disk are incomplete or changed. Stopping.`);
      }
    }
  }

  // 2. thresholds: t1 must not move, t2 comes from the conditional fit
  const manifest = loadRun(normalDir).manifest;
  const thresholds = thresholdsFromCalibration(fresh, state.decision, state.decision);
  if (thresholds.t1 !== manifest.thresholds.t1) throw new Error(`Refit: t1 would change (${manifest.thresholds.t1} to ${thresholds.t1}); replay is only valid for t2. Stopping.`);
  if (!fresh.models[state.decision]?.verify2Conditional) throw new Error('Refit: no verify2Conditional fit for the decision model (no slots round 1 did not accept). Stopping.');
  const task = await loadTask(state.taskPath);
  assertReplayable(task, readLedger(normalDir), loadRun(normalDir).records, thresholds.t1);

  const next: VrduBenchState = {
    ...state,
    refit: {
      at: new Date().toISOString(),
      previousThresholds: state.refit?.previousThresholds ?? manifest.thresholds,
      thresholds,
      reason: REFIT_REASON,
    },
  };
  const assembled = await assembleReport(next, fresh, normalDir, baselineDir);
  if (assembled.report.configs.full.pending || assembled.report.configs.simple.pending) throw new Error('Refit: some fields are still pending in the test run. Stopping.');

  // 3. writes (the test runs' manifests and ledgers are not touched)
  const keep = (path: string, first: string) => {
    if (existsSync(path) && !existsSync(first)) copyFileSync(path, first);
  };
  keep(state.calibrationPath, join(calibDir, 'calibration.first.json'));
  keep(join(benchDir, 'bench-report.md'), join(benchDir, 'bench-report.first.md'));
  keep(join(benchDir, 'bench-report.json'), join(benchDir, 'bench-report.first.json'));
  writeFileSync(state.calibrationPath, JSON.stringify(fresh, null, 2) + '\n');
  writeFileSync(statePath, JSON.stringify(next, null, 2) + '\n');
  writeReportFiles(benchDir, assembled);
  o.log(`refit ${o.id}: t2 ${manifest.thresholds.t2.toFixed(3)} -> ${thresholds.t2.toFixed(3)} (replay only, no model calls)`);
  return { benchDir, reportPath: join(benchDir, 'bench-report.md') };
}

const emptyText = (): TextCheck => ({ documents: 0, changed: 0, changedInside: 0, kinds: {} });

function calibrationFacts(c: CalibrationFile, models: string[]): CalibrationFacts {
  const out: CalibrationFacts = { runId: c.runId, documents: c.rows, models: {} };
  for (const m of models) {
    const e = c.models[m];
    if (!e) continue;
    out.models[m] = {
      ...(e.verify1 ? { verify1: { slots: e.verify1.n, wrong: e.verify1.n - e.verify1.correct } } : {}),
      ...(e.verify2 ? { verify2: { slots: e.verify2.n, wrong: e.verify2.n - e.verify2.correct } } : {}),
      ...(e.verify2Conditional ? { verify2Conditional: { slots: e.verify2Conditional.n, wrong: e.verify2Conditional.n - e.verify2Conditional.correct } } : {}),
    };
  }
  return out;
}

/** "jev,luna" → model IDs. */
export function parseAlso(spec: string | undefined): string[] {
  return (spec ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((m) => DECISION_ALIASES[m] ?? m);
}
