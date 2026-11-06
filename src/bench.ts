import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Budget } from './budget.ts';
import { applyIsotonic, ece, reliabilityBins, type Bin } from './calibrate.ts';
import { ensureBanking77 } from './datasets/banking77.ts';
import type { DecisionModel } from './decide/model.ts';
import { Ledger, replay, type RunState } from './ledger.ts';
import { computeOutcomes, type RowOutcome } from './pipeline.ts';
import { summarize } from './report.ts';
import { loadRun } from './run.ts';
import {
  calibrateRun,
  executeRun,
  readCalibration,
  startRun,
  thresholdsFromCalibration,
  type CalibrationFile,
} from './runner.ts';
import { scoreRun, type Stage } from './score.ts';
import { loadTask } from './task.ts';

// `twopass bench banking77`:
//   1. download Banking77 if needed
//   2. calibration: a `collect` run on a train slice, scored by every decision model, thresholds fitted
//   3. one test-split run per configuration, plus the frontier baseline, all at once
//   4. bench-report.json + bench-report.md
// Everything is resumable: `twopass bench banking77 --id <benchId>` picks up where it stopped.

export const DECISION_ALIASES: Record<string, string> = {
  jev: 'typesafe/jev-1.14',
  clef: 'cloudflare/clef',
  luna: 'openai/gpt-6-luna-decisions',
};

export interface BenchConfig {
  name: string;
  triage: string;
  verify: string;
}

/** "jev,clef,jev+clef" → configs. "a+b" means triage with a, verify with b. */
export function parseConfigs(spec: string): BenchConfig[] {
  return spec.split(',').map((name) => {
    const [t, v] = name.split('+');
    const triage = DECISION_ALIASES[t!] ?? t!;
    return { name, triage, verify: v ? (DECISION_ALIASES[v] ?? v) : triage };
  });
}

export interface BenchOptions {
  apiKey: string;
  runsRoot: string;
  dataDir: string;
  maxUsd: number;
  configs: BenchConfig[];
  baseline: string;
  calibrationSize: number;
  testSize?: number;
  /** Rows for the frontier baseline (default: same as the test runs). */
  baselineSize?: number;
  maxRowsPerBatch?: number;
  target: number;
  seed: number;
  id?: string;
  log: (m: string) => void;
}

interface BenchState {
  benchId: string;
  createdAt: string;
  taskPath: string;
  configs: BenchConfig[];
  baseline: string;
  calibrationSize: number;
  testSize: number | null;
  baselineSize?: number | null;
  target: number;
  seed: number;
  calibrationRunId?: string;
  calibrationPath?: string;
  testRuns: Record<string, string>;
}


export async function runBench(o: BenchOptions): Promise<{ benchDir: string; reportPath: string }> {
  const benchId = o.id ?? `bench-${new Date().toISOString().slice(0, 10)}-${randomBytes(2).toString('hex')}`;
  const benchDir = resolve(o.runsRoot, benchId);
  const statePath = join(benchDir, 'bench.json');
  let state: BenchState;
  if (existsSync(statePath)) {
    state = JSON.parse(readFileSync(statePath, 'utf8')) as BenchState;
    o.log(`resuming ${benchId}`);
  } else {
    if (o.id) throw new Error(`No bench found at ${benchDir}`);
    mkdirSync(benchDir, { recursive: true });
    state = {
      benchId,
      createdAt: new Date().toISOString(),
      taskPath: taskPath(),
      configs: o.configs,
      baseline: o.baseline,
      calibrationSize: o.calibrationSize,
      testSize: o.testSize ?? null,
      baselineSize: o.baselineSize ?? null,
      target: o.target,
      seed: o.seed,
      testRuns: {},
    };
  }
  const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  if (o.baselineSize !== undefined && o.baselineSize !== state.baselineSize) {
    // Changing the baseline size is allowed only while the baseline has not spent anything.
    const existing = state.testRuns.baseline;
    if (existing && hasSpent(resolve(o.runsRoot, existing))) {
      throw new Error(`The baseline run ${existing} has already started; its size cannot change.`);
    }
    if (existing) o.log(`baseline size ${state.baselineSize ?? 'all'} → ${o.baselineSize}; replacing unstarted run ${existing}`);
    delete state.testRuns.baseline;
    state.baselineSize = o.baselineSize;
  }
  save();

  const budget = new Budget(o.maxUsd, spentSoFar(o.runsRoot, state));
  o.log(`bench ${benchId}: cap $${o.maxUsd}, spent so far $${budget.spentUsd.toFixed(2)}`);
  const data = await ensureBanking77(o.dataDir, o.log);
  const decisionModels = [...new Set(state.configs.flatMap((c) => [c.triage, c.verify]))];
  const first = state.configs[0]!;

  // ---- 2. calibration on a train slice
  if (!state.calibrationRunId) {
    const { manifest } = await startRun({
      apiKey: o.apiKey,
      runsRoot: o.runsRoot,
      csvPath: data.train,
      taskPath: state.taskPath,
      mode: 'collect',
      sample: state.calibrationSize,
      seed: state.seed,
      labelColumn: 'label',
      models: { triage: first.triage, verify: first.verify },
      runIdSuffix: 'calib',
    });
    state.calibrationRunId = manifest.runId;
    save();
  }
  const calibDir = resolve(o.runsRoot, state.calibrationRunId);
  if (!state.calibrationPath) {
    o.log(`calibration: collecting on ${state.calibrationSize} train rows (${state.calibrationRunId})`);
    await executeRun(calibDir, { apiKey: o.apiKey, budget, log: prefix(o.log, 'calib') });
    const { path } = await calibrateRun(calibDir, {
      apiKey: o.apiKey,
      models: decisionModels,
      target: state.target,
      budget,
      log: prefix(o.log, 'calib'),
    });
    state.calibrationPath = path;
    save();
  }
  const calibration = readCalibration(state.calibrationPath);

  // ---- 3. test runs
  const all = [...state.configs.map((c) => ({ ...c, baseline: false })), { name: 'baseline', triage: '', verify: '', baseline: true }];
  for (const c of all) {
    if (state.testRuns[c.name]) continue;
    const { manifest } = await startRun({
      apiKey: o.apiKey,
      runsRoot: o.runsRoot,
      csvPath: data.test,
      taskPath: state.taskPath,
      labelColumn: 'label',
      ...(c.baseline && state.baselineSize
        ? { sample: state.baselineSize, seed: state.seed }
        : state.testSize
          ? { sample: state.testSize, seed: state.seed }
          : {}),
      ...(c.baseline
        ? { mode: 'baseline' as const, models: { writer: state.baseline } }
        : {
            models: { triage: c.triage, verify: c.verify },
            thresholds: {
              values: thresholdsFromCalibration(calibration, c.triage, c.verify),
              source: `calibration ${calibration.runId} (target precision ${calibration.target})`,
            },
          }),
      runIdSuffix: c.name.replace(/\+/g, '-'),
    });
    state.testRuns[c.name] = manifest.runId;
    save();
  }
  o.log(`test runs: ${Object.entries(state.testRuns).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  const exec = (c: (typeof all)[number]) =>
    executeRun(resolve(o.runsRoot, state.testRuns[c.name]!), {
      apiKey: o.apiKey,
      budget,
      ...(o.maxRowsPerBatch ? { maxRowsPerBatch: o.maxRowsPerBatch } : {}),
      log: prefix(o.log, c.name),
    });
  // With a batch row limit, keep balance reservations small: the configs first, then the baseline.
  const groups = o.maxRowsPerBatch ? [all.filter((c) => !c.baseline), all.filter((c) => c.baseline)] : [all];
  const failed: string[] = [];
  for (const group of groups) {
    const settled = await Promise.allSettled(group.map(exec));
    settled.forEach((s, i) => s.status === 'rejected' && failed.push(`${group[i]!.name}: ${String(s.reason)}`));
  }
  if (failed.length) throw new Error(`Some runs stopped:\n  ${failed.join('\n  ')}\nResume with: twopass bench banking77 --id ${benchId}`);

  // ---- 4. report
  const report = await buildReport(o.runsRoot, state, calibration);
  writeFileSync(join(benchDir, 'bench-report.json'), JSON.stringify(report, null, 2) + '\n');
  const reportPath = join(benchDir, 'bench-report.md');
  writeFileSync(reportPath, renderReport(report));
  o.log(`spent $${budget.spentUsd.toFixed(2)} of $${o.maxUsd}`);
  return { benchDir, reportPath };
}

function taskPath(): string {
  // src/bench.ts → tasks/banking77.task.ts; dist/src/bench.js → dist/tasks/banking77.task.js
  const candidates = ['../tasks/banking77.task.ts', '../tasks/banking77.task.js'].map((p) => fileURLToPath(new URL(p, import.meta.url)));
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('Cannot find tasks/banking77.task.ts');
  return found;
}

function prefix(log: (m: string) => void, name: string) {
  return (m: string) => log(`[${name}] ${m}`);
}

function hasSpent(dir: string): boolean {
  const path = join(dir, 'ledger.jsonl');
  return existsSync(path) && readFileSync(path, 'utf8').trim().length > 0;
}

function spentSoFar(runsRoot: string, state: BenchState): number {
  const ids = [state.calibrationRunId, ...Object.values(state.testRuns)].filter((x): x is string => !!x);
  let total = 0;
  for (const id of ids) {
    const dir = resolve(runsRoot, id);
    if (!existsSync(join(dir, 'ledger.jsonl'))) continue;
    total += replay(new Ledger(join(dir, 'ledger.jsonl')).read()).spentUsd;
    if (existsSync(join(dir, 'scores.jsonl'))) {
      for (const line of readFileSync(join(dir, 'scores.jsonl'), 'utf8').split('\n')) {
        try {
          if (line.trim()) total += (JSON.parse(line) as { costUsd: number }).costUsd;
        } catch {
          // torn line
        }
      }
    }
  }
  return total;
}

// ---------------------------------------------------------------- report

interface StageEce {
  stage: Stage;
  model: string;
  n: number;
  eceRaw: number;
  eceCalibrated: number;
  reliabilityRaw: Bin[];
  reliabilityCalibrated: Bin[];
}

export interface ConfigResult {
  name: string;
  runId: string;
  triage: string | null;
  verify: string | null;
  thresholds: { t0: number; t1: number; t2: number } | null;
  rows: number;
  round0Share: number;
  autoAcceptShare: number;
  escalatedShare: number;
  flaggedShare: number;
  /** Precision of the rows accepted without a human. */
  precision: number;
  /** Share of rows whose final answer is right, before any human review. */
  accuracyNoHuman: number;
  /** Decision model's own top-1 accuracy in round 0 (the 0.870 claim for Jev). */
  triageTop1: number | null;
  costPer1k: Record<'triage' | 'write1' | 'verify1' | 'write2' | 'verify2' | 'total', number>;
  minutes: { round0: number | null; rounds: Array<{ round: 1 | 2; median: number; worst: number }>; total: number };
  calibration: StageEce[];
}

export interface BenchReport {
  benchId: string;
  createdAt: string;
  calibrationRunId: string;
  calibrationRows: number;
  target: number;
  configs: ConfigResult[];
  calibrationFits: CalibrationFile['models'];
}

async function buildReport(runsRoot: string, state: BenchState, calibration: CalibrationFile): Promise<BenchReport> {
  const configs: ConfigResult[] = [];
  for (const [name, runId] of Object.entries(state.testRuns)) {
    const dir = resolve(runsRoot, runId);
    const { manifest, records } = loadRun(dir);
    const st = replay(new Ledger(join(dir, 'ledger.jsonl')).read());
    const task = await loadTask(manifest.taskPath);
    const baseline = manifest.mode === 'baseline';
    configs.push(await configResult(name, dir, manifest.runId, baseline, manifest.models, manifest.thresholds, records, st, task, calibration));
  }
  return {
    benchId: state.benchId,
    createdAt: new Date().toISOString(),
    calibrationRunId: calibration.runId,
    calibrationRows: calibration.rows,
    target: calibration.target,
    configs,
    calibrationFits: calibration.models,
  };
}

async function configResult(
  name: string,
  dir: string,
  runId: string,
  baseline: boolean,
  models: { triage: string; verify: string; writer: string },
  thresholds: { t0: number; t1: number; t2: number },
  records: Array<{ id: string; data: Record<string, string> }>,
  st: RunState,
  task: Awaited<ReturnType<typeof loadTask>>,
  calibration: CalibrationFile,
): Promise<ConfigResult> {
  const outcomes = computeOutcomes(st, { task, rows: records, thresholds, mode: baseline ? 'baseline' : 'normal' });
  const n = outcomes.length;
  const label = (o: RowOutcome) => o.data.label ?? '';
  const accepted = outcomes.filter((o) => o.status === 'accepted');
  const s = summarize(outcomes, st, 'label');

  const cost = { triage: 0, write1: 0, verify1: 0, write2: 0, verify2: 0, total: 0 };
  for (const d of st.triage.values()) cost.triage += d.costUsd;
  for (const d of st.verify.values()) cost[d.round === 1 ? 'verify1' : 'verify2'] += d.costUsd;
  for (const b of st.batches.values()) {
    const c = b.reportedCostUsd ?? b.resultCostUsd;
    cost[b.round === 1 ? 'write1' : 'write2'] += c;
  }
  cost.total = st.spentUsd;
  const per1k = Object.fromEntries(Object.entries(cost).map(([k, v]) => [k, (1000 * v) / n])) as ConfigResult['costPer1k'];

  const triageTimes = [...st.triage.values()].map((d) => Date.parse(d.at)).sort((a, b) => a - b);

  let triageTop1: number | null = null;
  const stages: StageEce[] = [];
  if (!baseline) {
    const tri = [...st.triage.entries()];
    const byId = new Map(records.map((r) => [r.id, r.data]));
    triageTop1 = tri.filter(([id, d]) => (d.answers.answer as { choice?: string }).choice === byId.get(id)?.label).length / tri.length;

    const ledgerOnly = (id: string): DecisionModel => ({
      id,
      decide: () => Promise.reject(new Error('report never calls models')),
    });
    const scored = await scoreRun({
      dir,
      task,
      records,
      labelColumn: 'label',
      st,
      runModels: { triage: models.triage, verify: models.verify },
      models: [...new Set([models.triage, models.verify])].map(ledgerOnly),
      ledgerOnly: true,
    });
    for (const [stage, model] of [
      ['triage', models.triage],
      ['verify1', models.verify],
      ['verify2', models.verify],
    ] as const) {
      const pts = scored.find((x) => x.model === model)?.points[stage] ?? [];
      const iso = calibration.models[model]?.[stage]?.isotonic;
      if (!pts.length || !iso) continue;
      const ps = pts.map((p) => p.p);
      const ys = pts.map((p) => p.correct);
      const cal = ps.map((p) => applyIsotonic(iso, p));
      stages.push({
        stage,
        model,
        n: pts.length,
        eceRaw: ece(ps, ys),
        eceCalibrated: ece(cal, ys),
        reliabilityRaw: reliabilityBins(ps, ys),
        reliabilityCalibrated: reliabilityBins(cal, ys),
      });
    }
  }

  return {
    name,
    runId,
    triage: baseline ? null : models.triage,
    verify: baseline ? null : models.verify,
    thresholds: baseline ? null : thresholds,
    rows: n,
    round0Share: outcomes.filter((o) => o.status === 'accepted' && o.round === 0).length / n,
    autoAcceptShare: accepted.length / n,
    escalatedShare: baseline ? 0 : outcomes.filter((o) => o.round === 2).length / n,
    flaggedShare: outcomes.filter((o) => o.status === 'flagged').length / n,
    precision: accepted.filter((o) => o.answer === label(o)).length / Math.max(accepted.length, 1),
    accuracyNoHuman: outcomes.filter((o) => o.answer === label(o)).length / n,
    triageTop1,
    costPer1k: per1k,
    minutes: {
      round0: triageTimes.length ? (triageTimes[triageTimes.length - 1]! - triageTimes[0]!) / 60_000 : null,
      rounds: s.rounds.map((r) => ({ round: r.round, median: r.medianMinutes, worst: r.worstMinutes })),
      total: s.minutes,
    },
    calibration: stages,
  };
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const usd = (x: number) => `$${x.toFixed(2)}`;
const short = (m: string | null) => (m ? (Object.entries(DECISION_ALIASES).find(([, v]) => v === m)?.[0] ?? m) : '—');

export function renderReport(r: BenchReport): string {
  const lines: string[] = [];
  lines.push(`# Bench ${r.benchId}`, '');
  lines.push(
    `Thresholds fitted on ${r.calibrationRows} held-out train rows (run \`${r.calibrationRunId}\`) for ` +
      `≥${pct(r.target)} precision. Numbers below are on the test split.`,
    '',
  );
  lines.push('| Config | Triage | Verify | t0 / t1 / t2 | Auto-accepted | …in round 0 | Escalated | Flagged | Precision (auto) | Accuracy, no human | Cost / 1k rows |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of r.configs) {
    const t = c.thresholds ? [c.thresholds.t0, c.thresholds.t1, c.thresholds.t2].map((x) => (x > 1 ? 'never' : x.toFixed(2))).join(' / ') : '—';
    lines.push(
      `| ${c.name} | ${short(c.triage)} | ${short(c.verify)} | ${t} | ${pct(c.autoAcceptShare)} | ${pct(c.round0Share)} | ${pct(c.escalatedShare)} | ${pct(c.flaggedShare)} | ${pct(c.precision)} | ${pct(c.accuracyNoHuman)} | ${usd(c.costPer1k.total)} |`,
    );
  }
  lines.push('', '## Cost per 1,000 rows by stage', '');
  lines.push('| Config | Triage | Write r1 | Verify r1 | Write r2 | Verify r2 | Total |', '|---|---|---|---|---|---|---|');
  for (const c of r.configs) {
    const k = c.costPer1k;
    lines.push(`| ${c.name} | ${usd(k.triage)} | ${usd(k.write1)} | ${usd(k.verify1)} | ${usd(k.write2)} | ${usd(k.verify2)} | ${usd(k.total)} |`);
  }
  lines.push('', '## Wall-clock', '');
  lines.push('| Config | Round 0 | Round 1 (median / worst) | Round 2 (median / worst) | Total |', '|---|---|---|---|---|');
  for (const c of r.configs) {
    const rd = (n: 1 | 2) => {
      const x = c.minutes.rounds.find((y) => y.round === n);
      return x ? `${x.median.toFixed(1)} / ${x.worst.toFixed(1)} min` : '—';
    };
    lines.push(`| ${c.name} | ${c.minutes.round0 === null ? '—' : `${Math.round(c.minutes.round0 * 60)} s`} | ${rd(1)} | ${rd(2)} | ${c.minutes.total.toFixed(0)} min |`);
  }
  lines.push('', '## Calibration on the test split (ECE, raw → after isotonic fitted on the calibration slice)', '');
  lines.push('| Config | Stage | Model | n | ECE raw | ECE calibrated |', '|---|---|---|---|---|---|');
  for (const c of r.configs) {
    for (const s of c.calibration) {
      lines.push(`| ${c.name} | ${s.stage} | ${short(s.model)} | ${s.n} | ${s.eceRaw.toFixed(3)} | ${s.eceCalibrated.toFixed(3)} |`);
    }
  }
  lines.push('', '## Round-0 top-1 accuracy (decision model picking the label itself)', '');
  for (const c of r.configs) if (c.triageTop1 !== null) lines.push(`- ${c.name} (${short(c.triage)}): ${c.triageTop1.toFixed(3)}`);
  lines.push('', 'Reference: Jev is reported (secondhand) at 0.870 on Banking77.', '');
  return lines.join('\n');
}

/** Lists bench directories, newest first. */
export function listBenches(runsRoot: string): string[] {
  if (!existsSync(runsRoot)) return [];
  return readdirSync(runsRoot)
    .filter((d) => d.startsWith('bench-') && existsSync(join(runsRoot, d, 'bench.json')))
    .sort()
    .reverse();
}
