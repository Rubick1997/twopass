import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { computeFieldOutcomes } from './extract/outcomes.ts';
import {
  buildExtractReport,
  FIELD_CSV_COLUMNS,
  fieldCsvRecords,
  renderExtractReport,
  type CalibrationFacts,
  type CheckerInput,
  type TextCheck,
} from './extract/report.ts';
import { parseLedger, replay, type RunState } from './ledger.ts';
import type { RowRecord } from './pipeline.ts';
import { loadRun } from './run.ts';
import { calibrateRun, executeRun, readCalibration, startRun, thresholdsFromCalibration, type CalibrationFile } from './runner.ts';
import { scoreRun } from './score.ts';
import { loadTask } from './task.ts';

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
  const thresholdsSource = `calibration ${calibration.runId} (target precision ${calibration.target}, one point per field slot)`;

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
  const task = await loadTask(state.taskPath);
  const normalRun = loadRun(normalDir);
  const baselineRun = loadRun(baselineDir);
  const normalSt = readLedger(normalDir);
  const baselineSt = readLedger(baselineDir);
  const verifyModel = normalRun.manifest.models.verify;
  const fit = (model: string, stage: 'verify1' | 'verify2') => calibration.models[model]?.[stage]?.fit.threshold ?? NEVER;
  const checkers: CheckerInput[] = decisionModels.map((model) => ({
    model,
    threshold: model === state.decision ? thresholds.t1 : fit(model, 'verify1'),
    answers: checkerAnswers(normalDir, normalSt, model, verifyModel),
  }));
  const report = buildExtractReport({
    benchId,
    createdAt: new Date().toISOString(),
    split: state.split,
    task,
    rows: normalRun.records,
    normal: normalSt,
    baseline: baselineSt,
    thresholds: normalRun.manifest.thresholds,
    thresholdsSource: normalRun.manifest.thresholdsSource,
    decisionModel: state.decision,
    baselineModel: state.baseline,
    checkers,
    calibration: calibrationFacts(calibration, decisionModels),
    target: state.target,
    ...(state.textCheck?.normal ? { textCheck: mergeText(state.textCheck.normal, state.textCheck.calibration ?? emptyText()) } : {}),
  });
  writeFileSync(join(benchDir, 'bench-report.json'), JSON.stringify(report, null, 2) + '\n');
  const reportPath = join(benchDir, 'bench-report.md');
  writeFileSync(reportPath, renderExtractReport(report));

  const ctx = { task, rows: normalRun.records, thresholds: normalRun.manifest.thresholds };
  writeFieldCsv(join(normalDir, 'enriched-fields.csv'), computeFieldOutcomes(normalSt, { ...ctx, mode: 'normal' }), normalRun.records);
  writeFieldCsv(join(baselineDir, 'enriched-fields.csv'), computeFieldOutcomes(baselineSt, { ...ctx, rows: baselineRun.records, mode: 'baseline' }), baselineRun.records);
  o.log(`spent $${budget.spentUsd.toFixed(2)} of $${o.maxUsd}`);
  return { benchDir, reportPath };
}

const emptyText = (): TextCheck => ({ documents: 0, changed: 0, changedInside: 0, kinds: {} });

function writeFieldCsv(path: string, outcomes: ReturnType<typeof computeFieldOutcomes>, rows: RowRecord[]): void {
  writeFileSync(path, stringify(fieldCsvRecords(outcomes, rows), { header: true, columns: [...FIELD_CSV_COLUMNS] }));
}

function calibrationFacts(c: CalibrationFile, models: string[]): CalibrationFacts {
  const out: CalibrationFacts = { runId: c.runId, documents: c.rows, models: {} };
  for (const m of models) {
    const e = c.models[m];
    if (!e) continue;
    out.models[m] = {
      ...(e.verify1 ? { verify1: { slots: e.verify1.n, wrong: e.verify1.n - e.verify1.correct } } : {}),
      ...(e.verify2 ? { verify2: { slots: e.verify2.n, wrong: e.verify2.n - e.verify2.correct } } : {}),
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
