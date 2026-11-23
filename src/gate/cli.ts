import { parseArgs } from 'node:util';
import { gateCalibrate } from './calibrate-cmd.ts';
import { gateCompare, gateRecalibrate } from './compare-cmd.ts';
import { renderProposal } from './comment.ts';
import { writeJson } from './data.ts';
import { gateInit, gateSlice } from './init.ts';
import { buildNoise } from './noise.ts';
import { readResult } from './result.ts';
import { gateRun } from './run.ts';
import { pct } from './stats.ts';
import { loadGateConfig } from './task-config.ts';

export const GATE_USAGE = `twopass gate: a CI gate that enforces the precision promise on auto-accepted rows

  twopass gate init --data <csv> --text <col> --label <col> [--id <col>] [--name <name>]
      [--per-label 20] [--calibration-per-label 15] [--target 0.95] [--writer …] [--escalation …] [--checker …] [--force]
      writes gates/<name>.task.yaml, the calibration rows, the CI slice and .github/workflows/eval-gate.yml (no API calls)
  twopass gate calibrate --task <file> [--from-run <dir> | --collect] [--models a,b] [--target 0.95] [--max-usd <n>]
      fits the thresholds the gate runs on, from calibration rows only. Without --max-usd no model is called.
  twopass gate slice --task <file> [--write]              rebuilds the CI slice from the config (no API calls)
  twopass gate run --task <file> --ref <name> --out <file> [--max-usd <n>] [--limit <n>] [--resume <runId>]
      [--allow-threshold-mismatch]   experiments only: run on thresholds fitted for another checker (recorded, warned)
      runs the CI slice through the full pipeline (sync calls, list price) and writes a result file
  twopass gate noise --task <file> --runs <a.json> <b.json> …    unchanged-main spread → the task's noise file
  twopass gate compare <base.json> <head.json> --task <file> [--gate g1|g2|g3|all] [--comment out.md] [--allow-mixed-routing]
      offline; exits 1 when the enforced gate fails
  twopass gate recalibrate --task <file> --run <head.json> [--write]
      proposes thresholds that restore the promise; --write replaces the thresholds file (commit it as its own change)

  Keys: OPENROUTER_API_KEY (checker), ANTHROPIC_API_KEY (optional: Claude models go direct).`;

export async function gateMain(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      task: { type: 'string' },
      data: { type: 'string' },
      text: { type: 'string' },
      label: { type: 'string' },
      id: { type: 'string' },
      name: { type: 'string' },
      'per-label': { type: 'string' },
      'calibration-per-label': { type: 'string' },
      writer: { type: 'string' },
      escalation: { type: 'string' },
      checker: { type: 'string' },
      target: { type: 'string' },
      force: { type: 'boolean' },
      ref: { type: 'string' },
      out: { type: 'string' },
      'max-usd': { type: 'string' },
      limit: { type: 'string' },
      resume: { type: 'string' },
      'allow-threshold-mismatch': { type: 'boolean' },
      runs: { type: 'string', multiple: true },
      'runs-root': { type: 'string' },
      gate: { type: 'string' },
      comment: { type: 'string' },
      'allow-mixed-routing': { type: 'boolean' },
      run: { type: 'string' },
      write: { type: 'boolean' },
      'from-run': { type: 'string' },
      collect: { type: 'boolean' },
      models: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [sub, ...rest] = positionals;
  const log = (m: string) => console.log(m);
  const num = (v: string | undefined, name: string) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number, got ${v}`);
    return n;
  };
  const need = (v: string | undefined, name: string): string => {
    if (!v) throw new Error(`--${name} is required (twopass gate --help)`);
    return v;
  };
  const env = { openRouterKey: process.env.OPENROUTER_API_KEY, anthropicKey: process.env.ANTHROPIC_API_KEY };
  if (values.help || !sub) {
    console.log(GATE_USAGE);
    return sub ? 0 : 1;
  }

  switch (sub) {
    case 'init': {
      const r = gateInit({
        data: need(values.data, 'data'),
        text: need(values.text, 'text'),
        label: need(values.label, 'label'),
        ...(values.id ? { id: values.id } : {}),
        ...(values.name ? { name: values.name } : {}),
        ...(values['per-label'] ? { perLabel: num(values['per-label'], 'per-label')! } : {}),
        ...(values['calibration-per-label'] ? { calibrationPerLabel: num(values['calibration-per-label'], 'calibration-per-label')! } : {}),
        ...(values.writer ? { writer: values.writer } : {}),
        ...(values.escalation ? { escalation: values.escalation } : {}),
        ...(values.checker ? { checker: values.checker } : {}),
        ...(values.target ? { target: Number(values.target) } : {}),
        ...(values.force ? { force: true } : {}),
      });
      log(`wrote ${r.files.join(', ')}`);
      log(`CI slice: ${r.sliceRows} rows; calibration rows: ${r.calibrationRows}`);
      const short = Object.entries(r.shortLabels);
      if (short.length) log(`note: ${short.length} label(s) have fewer rows than --per-label: ${short.map(([l, n]) => `${l} (${n})`).join(', ')}`);
      log(`next: twopass gate calibrate --task ${r.taskPath} --collect --max-usd <cap>`);
      return 0;
    }
    case 'slice': {
      const r = gateSlice(need(values.task, 'task'), { write: !!values.write });
      log(`${r.ids.length} rows; ${r.changed ? (values.write ? 'slice file rewritten' : 'differs from the committed slice file (pass --write to replace it)') : 'matches the slice file'}`);
      return r.changed && !values.write ? 1 : 0;
    }
    case 'calibrate': {
      const maxUsd = num(values['max-usd'], 'max-usd');
      await gateCalibrate({
        taskPath: need(values.task, 'task'),
        ...(values['from-run'] ? { fromRun: values['from-run'] } : {}),
        ...(values.collect ? { collect: true } : {}),
        ...(values.models ? { models: values.models.split(',').map((m) => m.trim()).filter(Boolean) } : {}),
        ...(maxUsd !== undefined ? { maxUsd } : {}),
        ...(values['runs-root'] ? { runsRoot: values['runs-root'] } : {}),
        ...(values.target ? { target: Number(values.target) } : {}),
        env,
        log,
      });
      return 0;
    }
    case 'run': {
      const maxUsd = num(values['max-usd'], 'max-usd');
      const limit = num(values.limit, 'limit');
      await gateRun({
        taskPath: need(values.task, 'task'),
        ref: need(values.ref, 'ref'),
        out: need(values.out, 'out'),
        ...(maxUsd !== undefined ? { maxUsd } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(values.resume ? { resume: values.resume } : {}),
        ...(values['allow-threshold-mismatch'] ? { allowThresholdMismatch: true } : {}),
        ...(values['runs-root'] ? { runsRoot: values['runs-root'] } : {}),
        env,
        log,
      });
      return 0;
    }
    case 'noise': {
      const taskPath = need(values.task, 'task');
      const files = [...(values.runs ?? []), ...rest];
      const { config } = loadGateConfig(taskPath);
      const noise = buildNoise(files.map(readResult));
      writeJson(config.noise, noise);
      const m = noise.metrics;
      log(`wrote ${config.noise} from ${noise.runs} runs`);
      log(`  accuracy ${pct(m.accuracy.min)}–${pct(m.accuracy.max)}; auto-accepted right ${pct(m.acceptedPrecision.min)}–${pct(m.acceptedPrecision.max)}; precision spread ${(100 * m.acceptedPrecision.spread).toFixed(1)} pts`);
      log(`  auto-accepted ${pct(m.acceptShare.min)}–${pct(m.acceptShare.max)}; confident-wrong ${m.confidentWrong.min}–${m.confidentWrong.max}; answer flips between runs ≤ ${noise.maxAnswerFlips}; identical rows ${pct(noise.identicalShare)}`);
      return 0;
    }
    case 'compare': {
      const [basePath, headPath] = rest;
      if (!basePath || !headPath) throw new Error('usage: twopass gate compare <base.json> <head.json> --task <file>');
      const g = values.gate;
      if (g && !['g1', 'g2', 'g3', 'all'].includes(g)) throw new Error(`--gate must be g1, g2, g3 or all, got ${g}`);
      const r = gateCompare({
        basePath,
        headPath,
        taskPath: need(values.task, 'task'),
        ...(g && g !== 'all' ? { enforce: g as 'g1' | 'g2' | 'g3' } : {}),
        ...(values['allow-mixed-routing'] ? { allowMixedRouting: true } : {}),
        ...(values.comment ? { commentPath: values.comment } : {}),
      });
      for (const id of ['g1', 'g2', 'g3'] as const) {
        const o = r.gates[id];
        log(`${o.pass ? 'PASS' : 'FAIL'} ${o.name}${id === r.enforce ? ' (enforced)' : ''}`);
        for (const reason of o.reasons) log(`  ${reason.pass ? 'ok  ' : 'FAIL'} ${reason.check}: ${reason.detail}`);
      }
      if (values.comment) log(`comment: ${values.comment}`);
      if (g === 'all') return r.gates.g1.pass && r.gates.g2.pass && r.gates.g3.pass ? 0 : 1;
      return r.pass ? 0 : 1;
    }
    case 'recalibrate': {
      const taskPath = need(values.task, 'task');
      const runPath = need(values.run, 'run');
      const r = gateRecalibrate({ taskPath, runPath, write: !!values.write });
      log(renderProposal(r.proposal, taskPath, runPath).join('\n'));
      if (r.wrote) log(`\nwrote ${r.wrote}. Commit it as its own change; that commit goes through the gate too.`);
      return 0;
    }
    default:
      console.error(`Unknown gate command "${sub}".\n\n${GATE_USAGE}`);
      return 1;
  }
}
