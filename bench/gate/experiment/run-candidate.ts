// Runs one candidate change the way the CI workflow would, locally: base and head each run their own code from a git
// worktree, on the CI slice, then `gate compare` with head's code and config. No PR is opened.
//
//   node bench/gate/experiment/run-candidate.ts <id> --max-usd <cap per side> [--base <ref>]
//
// Paid: two gate runs (≈ $0.67 each for the Clef config). Results go to runs/gate-exp/<id>/ (base.json, head.json,
// comment.md, compare.txt); a side whose result file exists is reused, never re-run. Keys come from the repo's .env
// or the environment and are passed to the child processes only.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve('.');
const args = process.argv.slice(2);
const id = args[0];
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const maxUsd = flag('max-usd');
if (!id || !maxUsd) {
  console.error('usage: node bench/gate/experiment/run-candidate.ts <id> --max-usd <cap per side> [--base <ref>]');
  process.exit(1);
}
const { candidates } = JSON.parse(readFileSync('bench/gate/experiment/candidates.json', 'utf8')) as {
  candidates: Array<{ id: string; branch: string; task: string; headFlags?: string[]; baseFlags?: string[]; change: string }>;
};
const c = candidates.find((x) => x.id === id);
if (!c) throw new Error(`No candidate ${id} in candidates.json`);
try {
  process.loadEnvFile(join(repo, '.env'));
} catch {
  // environment only
}

const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const headSha = git('rev-parse', c.branch);
const baseSha = git('rev-parse', flag('base') ?? git('merge-base', 'ci-eval-gate', c.branch));
const out = join(repo, 'runs', 'gate-exp', id);
mkdirSync(out, { recursive: true });
console.log(`candidate ${id}: ${c.change}\n  base ${baseSha.slice(0, 7)}  head ${headSha.slice(0, 7)} (${c.branch})  cap $${maxUsd} per side`);

function worktree(name: string, sha: string): string {
  const dir = join(repo, 'runs', 'worktrees', name);
  if (!existsSync(dir)) {
    git('worktree', 'add', '--detach', dir, sha);
    // data/ and node_modules/ are not in git: link the repo's copies.
    symlinkSync(join(repo, 'data'), join(dir, 'data'));
    symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'));
  }
  const at = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  if (at !== sha) throw new Error(`${dir} is at ${at}, expected ${sha}; remove it with git worktree remove`);
  return dir;
}

function side(name: 'base' | 'head', sha: string, flags: string[]): string {
  const file = join(out, `${name}.json`);
  if (existsSync(file)) {
    console.log(`  ${name}: reusing ${file}`);
    return file;
  }
  const dir = worktree(`${id}-${name}-${sha.slice(0, 7)}`, sha);
  console.log(`  ${name}: gate run in ${dir}`);
  const r = spawnSync(
    'node',
    ['src/cli.ts', 'gate', 'run', '--task', c!.task, '--ref', `${id}-${name}`, '--out', file, '--max-usd', maxUsd!, '--runs-root', join(repo, 'runs'), ...flags],
    { cwd: dir, env: process.env, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' },
  );
  const lines = (r.stdout ?? '').split('\n').filter((l) => l && !/^\s+[✓⚠→]|^checking /.test(l));
  console.log(lines.map((l) => `    ${l}`).join('\n'));
  if (r.status !== 0) throw new Error(`${name} run failed (exit ${r.status})`);
  return file;
}

const basePath = side('base', baseSha, c.baseFlags ?? []);
const headPath = side('head', headSha, c.headFlags ?? []);
const headDir = worktree(`${id}-head-${headSha.slice(0, 7)}`, headSha);
const cmp = spawnSync('node', ['src/cli.ts', 'gate', 'compare', basePath, headPath, '--task', c.task, '--comment', join(out, 'comment.md')], {
  cwd: headDir,
  env: process.env,
  encoding: 'utf8',
});
writeFileSync(join(out, 'compare.txt'), cmp.stdout + (cmp.stderr ?? ''));
console.log(cmp.stdout + (cmp.stderr ?? ''));
console.log(`gate exit code ${cmp.status} (1 = the enforced gate failed); comment: ${join(out, 'comment.md')}`);
