// Ground truth for the gate experiment: the ONLY file that reads the Banking77 test split.
//
//   node bench/gate/experiment/groundtruth.ts run <id|base> --max-usd <cap>   one full test-split run (paid)
//   node bench/gate/experiment/groundtruth.ts matrix                         offline: bench/gate/matrix.csv
//
// `run base` runs the CI config of ci-eval-gate; `run <id>` runs a candidate's head config from its branch, in a git
// worktree, so each side uses its own code. The config is copied with data = the test split and a slice of every test
// row; everything else (thresholds, prompts, models) is the side's own, resolved to absolute paths.
//
// Ground-truth rules (per candidate, on the test split, head vs base):
//   promise broken   head's accepted-row precision is below the target by more than its CI (Wilson upper < target)
//   real regression  promise broken, or head's precision clearly below base's (head upper < base point),
//                    or accuracy clearly lower (paired bootstrap 95% CI of head − base entirely below 0)
//   real improvement no regression, and auto-accept share or cost per 1,000 improves beyond noise

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { stringify as toCsv } from 'csv-stringify/sync';
import { readCsvRows } from '../../../src/gate/data.ts';
import { compareResults } from '../../../src/gate/compare.ts';
import { runGates } from '../../../src/gate/gates.ts';
import { readNoise } from '../../../src/gate/compare-cmd.ts';
import { readResult, type GateResult } from '../../../src/gate/result.ts';
import { bootstrapMeanDelta, pct } from '../../../src/gate/stats.ts';

const repo = resolve('.');
const TEST_CSV = join(repo, 'data', 'banking77', 'test.csv');
const OUT = join(repo, 'runs', 'gate-groundtruth');
const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
type Candidate = { id: string; branch: string; task: string; headFlags?: string[]; change: string; group: string; reuseBase?: string };
const { candidates } = JSON.parse(readFileSync('bench/gate/experiment/candidates.json', 'utf8')) as { candidates: Candidate[] };
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();

function worktree(name: string, sha: string): string {
  const dir = join(repo, 'runs', 'worktrees', name);
  if (!existsSync(dir)) {
    git('worktree', 'add', '--detach', dir, sha);
    symlinkSync(join(repo, 'data'), join(dir, 'data'));
    symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'));
  }
  return dir;
}

/** The side's config, pointed at the full test split. Paths become absolute (they were relative to the worktree). */
function testConfig(dir: string, task: string, name: string): string {
  const cfg = parseYaml(readFileSync(join(dir, task), 'utf8')) as Record<string, any>;
  const abs = (p: string) => (isAbsolute(p) ? p : join(dir, p));
  const ids = readCsvRows(TEST_CSV).map((r) => r.id!);
  const slice = join(OUT, 'test-ids.json');
  mkdirSync(OUT, { recursive: true });
  writeFileSync(slice, JSON.stringify({ note: 'every Banking77 test row; written by groundtruth.ts only', ids }) + '\n');
  cfg.data = TEST_CSV;
  cfg.slice = { file: slice, perLabel: 1000, seed: 0, exclude: [] };
  cfg.calibration = { ...cfg.calibration, rows: abs(cfg.calibration.rows), points: abs(cfg.calibration.points) };
  cfg.checker = { ...cfg.checker, thresholds: abs(cfg.checker.thresholds) };
  cfg.noise = abs(cfg.noise);
  if (cfg.prompts) cfg.prompts = { from: abs(cfg.prompts.from) };
  cfg.gate = { ...(cfg.gate ?? {}), maxUsd: 5 };
  const path = join(OUT, `${name}.task.yaml`);
  writeFileSync(path, '# groundtruth.ts: test-split copy of a gate config. Never committed.\n' + toYaml(cfg));
  return path;
}

function run(id: string, maxUsd: string): void {
  const isBase = id === 'base';
  const c = isBase ? undefined : candidates.find((x) => x.id === id);
  if (!isBase && !c) throw new Error(`No candidate ${id}`);
  const sha = git('rev-parse', isBase ? 'ci-eval-gate' : c!.branch);
  const out = join(OUT, `${id}.json`);
  if (existsSync(out)) return void console.log(`${id}: ${out} exists, not re-running`);
  const dir = worktree(`gt-${id}-${sha.slice(0, 7)}`, sha);
  const task = testConfig(dir, isBase ? 'gates/banking77.task.yaml' : c!.task, `${id}-${sha.slice(0, 7)}`);
  try {
    process.loadEnvFile(join(repo, '.env'));
  } catch {
    // environment only
  }
  console.log(`${id}: test split (${sha.slice(0, 7)}), cap $${maxUsd}`);
  const r = spawnSync('node', ['src/cli.ts', 'gate', 'run', '--task', task, '--ref', `${id}-test`, '--out', out, '--max-usd', maxUsd, '--runs-root', join(repo, 'runs'), ...(c?.headFlags ?? [])], {
    cwd: dir,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  console.log((r.stdout ?? '').split('\n').filter((l) => /wrote|WARNING|round 0/.test(l)).join('\n'));
  if (r.status !== 0) throw new Error(`${id} failed (exit ${r.status})`);
}

function truth(base: GateResult, head: GateResult) {
  const c = compareResults(base, head);
  const target = head.promise.acceptedPrecision;
  const brokenPromise = c.head.acceptedPrecision.upper < target;
  const precisionWorse = c.head.acceptedPrecision.upper < c.base.acceptedPrecision.point;
  const b = bootstrapMeanDelta(c.pairs.map((p) => +(p.base.answer === p.base.label)), c.pairs.map((p) => +(p.head.answer === p.head.label)), { seed: 42 });
  const accuracyWorse = b.upper < 0;
  const regression = brokenPromise || precisionWorse || accuracyWorse;
  const improvement = !regression && (c.head.acceptShare - c.base.acceptShare > 0.005 || c.head.costPer1k < 0.95 * c.base.costPer1k);
  return { c, brokenPromise, regression, improvement, verdict: regression ? 'regression' : improvement ? 'improvement' : 'neutral' };
}

function matrix(): void {
  const noise = readNoise('gates/banking77.noise.json');
  const gtBase = existsSync(join(OUT, 'base.json')) ? readResult(join(OUT, 'base.json')) : undefined;
  const rows: string[][] = [
    [
      'id', 'group', 'change', 'g1', 'g2', 'g3', 'ci_accuracy_delta_pts', 'ci_accepted_precision_delta_pts', 'ci_accept_share_head',
      'test_run', 'test_accuracy_delta_pts', 'test_accepted_precision_base', 'test_accepted_precision_head', 'test_accept_share_base', 'test_accept_share_head',
      'promise_broken_on_test', 'ground_truth', 'g1_right', 'g2_right', 'g3_right',
    ],
  ];
  const lines: string[] = [];
  for (const cand of candidates) {
    const dir = join(repo, 'runs', 'gate-exp', cand.id);
    if (!existsSync(join(dir, 'head.json'))) {
      rows.push([cand.id, cand.group, cand.change, 'not run', '', '', '', '', '', 'no', '', '', '', '', '', '', '', '', '', '']);
      continue;
    }
    const base = readResult(join(dir, 'base.json'));
    const head = readResult(join(dir, 'head.json'));
    const c = compareResults(base, head);
    // Jev-based candidates have no noise file of their own: their limits are noise-free.
    const g = runGates(c, { ...(base.models.verify === 'cloudflare/clef' && noise ? { noise } : {}), g2Tolerance: 0.01 });
    const gt = existsSync(join(OUT, `${cand.id}.json`)) && gtBase && base.models.verify === gtBase.models.verify ? truth(gtBase, readResult(join(OUT, `${cand.id}.json`))) : undefined;
    const pass = (x: boolean) => (x ? 'pass' : 'block');
    const right = (blocked: boolean) => (gt ? String(blocked === gt.regression) : '');
    rows.push(
      [
        cand.id, cand.group, cand.change, pass(g.g1.pass), pass(g.g2.pass), pass(g.g3.pass),
        (100 * (c.head.accuracy - c.base.accuracy)).toFixed(2), (100 * (c.head.acceptedPrecision.point - c.base.acceptedPrecision.point)).toFixed(2), (100 * c.head.acceptShare).toFixed(1),
        gt ? 'yes' : 'no',
        gt ? (100 * (gt.c.head.accuracy - gt.c.base.accuracy)).toFixed(2) : '',
        gt ? (100 * gt.c.base.acceptedPrecision.point).toFixed(2) : '', gt ? (100 * gt.c.head.acceptedPrecision.point).toFixed(2) : '',
        gt ? (100 * gt.c.base.acceptShare).toFixed(1) : '', gt ? (100 * gt.c.head.acceptShare).toFixed(1) : '',
        gt ? String(gt.brokenPromise) : '', gt ? gt.verdict : '',
        right(!g.g1.pass), right(!g.g2.pass), right(!g.g3.pass),
      ],
    );
    if (gt) {
      lines.push(
        `${cand.id}: test accuracy ${pct(gt.c.base.accuracy)} → ${pct(gt.c.head.accuracy)}; accepted right ${pct(gt.c.base.acceptedPrecision.point)} → ${pct(gt.c.head.acceptedPrecision.point)} ` +
          `(head CI ${pct(gt.c.head.acceptedPrecision.lower)}–${pct(gt.c.head.acceptedPrecision.upper)}); auto-accepted ${pct(gt.c.base.acceptShare)} → ${pct(gt.c.head.acceptShare)}; ` +
          `confident-wrong ${gt.c.base.confidentWrong} → ${gt.c.head.confidentWrong}; ground truth: ${gt.verdict}`,
      );
    }
  }
  if (gtBase) {
    const a = gtBase.rows.filter((r) => r.status === 'accepted');
    lines.unshift(`base on test: ${gtBase.rows.length} rows, accepted right ${pct(a.filter((r) => r.answer === r.label).length / a.length)}, auto-accepted ${pct(a.length / gtBase.rows.length)}`);
  }
  const path = join(repo, 'bench', 'gate', 'matrix.csv');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, toCsv(rows));
  console.log(lines.join('\n'));
  console.log(`\nwrote ${path}`);
}

if (args[0] === 'run') {
  const maxUsd = flag('max-usd');
  if (!args[1] || !maxUsd) throw new Error('usage: groundtruth.ts run <id|base> --max-usd <cap>');
  run(args[1], maxUsd);
} else if (args[0] === 'matrix') {
  matrix();
} else {
  console.error('usage: groundtruth.ts run <id|base> --max-usd <cap> | matrix');
  process.exit(1);
}
