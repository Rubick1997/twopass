import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Budget } from '../budget.ts';
import { OpenRouterDecisionModel } from '../decide/openrouter.ts';
import { Ledger, replay } from '../ledger.ts';
import { loadRun } from '../run.ts';
import { executeRun, noCallModel, startRun } from '../runner.ts';
import { scoreRun } from '../score.ts';
import { loadTask } from '../task.ts';
import { fitOnRows, formatCalibrationPoints, pointsFromScored, readCalibrationPoints, replayRows, type CalibrationPoints } from './calibration.ts';
import { loadRows, readIdFile, writeJson, writeRunCsv } from './data.ts';
import { idColumnOf, loadGateConfig, type ThresholdsFile } from './task-config.ts';
import { resolveRoute } from '../batch/route.ts';
import { pct } from './stats.ts';

// `twopass gate calibrate`: fills the calibration points file and fits the thresholds file the gate runs on.
//   --from-run <dir>   reuse an existing labeled collect run on the calibration rows (Banking77: the part 1 run).
//                      Answers already in its ledger / scores.jsonl are free; others are asked only with --max-usd.
//   --collect          start a new collect run on the calibration rows (writer answers change with the writer).
//   --models a,b       also score these checkers (decision calls only; the writer answers are reused).

export interface GateCalibrateOptions {
  taskPath: string;
  fromRun?: string;
  collect?: boolean;
  models?: string[];
  maxUsd?: number;
  /** Fit and write thresholds for the task's checker (default true). */
  writeThresholds?: boolean;
  /** Fit at this precision instead of the promise (e.g. 0.93 to automate more). The promise the gate checks doesn't change. */
  target?: number;
  runsRoot?: string;
  env: { openRouterKey?: string; anthropicKey?: string };
  log?: (m: string) => void;
}

export async function gateCalibrate(o: GateCalibrateOptions): Promise<{ points: CalibrationPoints; thresholds?: ThresholdsFile; spentUsd: number }> {
  const log = o.log ?? (() => {});
  const loaded = loadGateConfig(o.taskPath);
  const { config } = loaded;
  const triage = config.checker.triage ?? config.checker.model;
  const verify = config.checker.model;
  const calibIds = readIdFile(config.calibration.rows);
  const calibSet = new Set(calibIds);
  const runsRoot = resolve(o.runsRoot ?? 'runs');
  if (o.fromRun && o.collect) throw new Error('Pass --from-run or --collect, not both.');

  let dir = o.fromRun ? resolve(o.fromRun) : undefined;
  if (!dir && !o.collect) {
    const existing = readCalibrationPoints(config.calibration.points);
    if (!existing) throw new Error(`No calibration points yet. Use --from-run <collect run> or --collect.`);
    dir = join(runsRoot, existing.source.runId);
  }
  if (o.collect) {
    if (o.maxUsd === undefined) throw new Error('--collect calls models: pass --max-usd.');
    if (!o.env.openRouterKey) throw new Error('OPENROUTER_API_KEY is not set.');
    // A collect run is not time-critical: batches, at half the list price.
    const routeOpts = { transport: 'batch' as const, anthropicKey: !!o.env.anthropicKey, ...(config.provider ? { claude: config.provider.claude } : {}) };
    const writer = resolveRoute(config.writer.model, routeOpts);
    const escalation = resolveRoute(config.writer.escalation, routeOpts);
    const rows = loadRows(config.data, config.columns, idColumnOf(config));
    const csvPath = join(runsRoot, 'gate-inputs', `${config.name}-calibration.csv`);
    writeRunCsv(csvPath, rows, calibIds);
    const { dir: d } = await startRun({
      apiKey: o.env.openRouterKey,
      runsRoot,
      csvPath,
      taskPath: loaded.path,
      mode: 'collect',
      labelColumn: config.columns.label,
      models: { writer: writer.callId, escalation: escalation.callId, triage, verify },
      maxUsd: o.maxUsd,
      runIdSuffix: 'gate-calib',
      log,
    });
    log(`collect run ${d} on ${calibIds.length} calibration rows (batches; cap $${o.maxUsd})`);
    await executeRun(d, { apiKey: o.env.openRouterKey, ...(o.env.anthropicKey ? { anthropicApiKey: o.env.anthropicKey } : {}), log });
    dir = d;
  }

  const { manifest, records } = loadRun(dir!);
  if (!manifest.labelColumn) throw new Error(`${dir} is not a labeled run.`);
  const outside = records.filter((r) => !calibSet.has(r.id));
  if (outside.length) {
    throw new Error(`${dir} has ${outside.length} row(s) that are not calibration rows (first: ${outside[0]!.id}). Calibration never uses slice or test rows.`);
  }
  const models = [...new Set([triage, verify, ...(o.models ?? [])])];
  const task = await loadTask(manifest.taskPath);
  const st = replay(new Ledger(join(dir!, 'ledger.jsonl')).read());
  const paid = o.maxUsd !== undefined;
  if (paid && !o.env.openRouterKey) throw new Error('OPENROUTER_API_KEY is not set.');
  const budget = new Budget(o.maxUsd);
  const scored = await scoreRun({
    dir: dir!,
    task,
    records,
    labelColumn: manifest.labelColumn,
    st,
    runModels: { triage: manifest.models.triage, verify: manifest.models.verify },
    models: models.map((m) => (paid ? new OpenRouterDecisionModel({ apiKey: o.env.openRouterKey!, model: m }) : noCallModel(m))),
    ledgerOnly: !paid,
    budget,
    log,
  });
  const spentUsd = scored.reduce((s, x) => s + x.spentUsd, 0);

  const previous = readCalibrationPoints(config.calibration.points);
  const sameSource = previous?.source.runId === manifest.runId;
  const fresh = pointsFromScored(scored);
  for (const m of models) {
    const n = Object.keys(fresh[m]?.verify1 ?? {}).length;
    if (!n) throw new Error(`${m}: no verify scores on the calibration rows${paid ? '' : '. They are not in the run yet: pass --max-usd to ask the model'}.`);
  }
  const points: CalibrationPoints = {
    kind: 'twopass-gate-calibration',
    version: 1,
    task: config.name,
    source: { runId: manifest.runId, writer: manifest.models.writer, escalation: manifest.models.escalation },
    createdAt: new Date().toISOString(),
    rows: Object.fromEntries(records.map((r) => [r.id, r.data[manifest.labelColumn!] ?? ''])),
    checkers: { ...(sameSource ? previous!.checkers : {}), ...fresh },
  };
  mkdirSync(dirname(resolve(config.calibration.points)), { recursive: true });
  writeFileSync(config.calibration.points, formatCalibrationPoints(points));
  log(`wrote ${config.calibration.points}: ${records.length} rows, checkers ${Object.keys(points.checkers).join(', ')}${spentUsd ? `, spent $${spentUsd.toFixed(4)}` : ''}`);

  if (o.writeThresholds === false) return { points, spentUsd };
  const target = o.target ?? config.promise.acceptedPrecision;
  if (target !== config.promise.acceptedPrecision) {
    log(`fitting at ${target}, not the promise's ${config.promise.acceptedPrecision}: the gate still checks ${config.promise.acceptedPrecision}`);
  }
  const who = { triage, verify, withTriage: !!task.triage };
  const t = fitOnRows(points, { ...who, target, rows: Object.keys(points.rows) });
  const all = replayRows(points, { ...who, rows: Object.keys(points.rows) }, t);
  const thresholds: ThresholdsFile = {
    thresholds: t,
    target,
    checker: { triage, verify },
    source: `fitted on ${records.length} calibration rows of run ${manifest.runId} (writer ${manifest.models.writer})`,
    fittedAt: new Date().toISOString(),
  };
  writeJson(config.checker.thresholds, thresholds);
  log(`wrote ${config.checker.thresholds}: t0 ${t.t0}, t1 ${t.t1}, t2 ${t.t2} (calibration rows: ${pct(all.acceptShare)} auto-accepted at ${pct(all.precision.point)})`);
  return { points, thresholds, spentUsd };
}

