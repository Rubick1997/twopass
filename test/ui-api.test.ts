import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configResult } from '../src/bench.ts';
import { Ledger, replay } from '../src/ledger.ts';
import { loadRun } from '../src/run.ts';
import { spendByStage } from '../src/stats.ts';
import { loadTask } from '../src/task.ts';
import {
  BadRequestError,
  describeEvents,
  getBalance,
  getBench,
  getBenchReport,
  getRun,
  listBenches,
  listRuns,
  NotFoundError,
  resolveInside,
} from '../src/ui/api.ts';
import { shortModel } from '../src/ui/models.ts';
import { ESCALATION, iso, lockRun, makeRoot, makeRun, MIN, results, submit, T0, triage, verify, WRITER, writeBench } from './ui-fixtures.ts';

const alive = () => true;
const dead = () => false;
const at = (offset: number) => ({ now: () => T0 + offset, cwd: '/somewhere/else' });

/** r1, r2 accepted in triage; r3 accepted in round 1; r4 wrong in round 1, fixed in round 2. */
function finishedRun(root: string, runId = 'run-finished') {
  const run = makeRun(root, runId);
  const { ledger } = run;
  triage(ledger, 'r1', 'card_arrival', 0.97, 0);
  triage(ledger, 'r2', 'age_limit', 0.97, 0);
  triage(ledger, 'r3', 'atm_support', 0.5, 0);
  triage(ledger, 'r4', 'card_linking', 0.5, 0);
  submit(ledger, 'batch-r1-aaaa', 1, WRITER, ['r3', 'r4'], 1 * MIN);
  results(ledger, 'batch-r1-aaaa', 1, WRITER, { r3: 'atm_support', r4: 'age_limit' }, 6 * MIN, { costUsd: 0.01, undecodable: 1 });
  verify(ledger, 'r3', 1, true, 6.5 * MIN);
  verify(ledger, 'r4', 1, false, 6.5 * MIN);
  submit(ledger, 'batch-r2-bbbb', 2, ESCALATION, ['r4'], 8 * MIN);
  results(ledger, 'batch-r2-bbbb', 2, ESCALATION, { r4: 'card_linking' }, 12 * MIN, { costUsd: null, perRowUsd: 0.003 });
  verify(ledger, 'r4', 2, true, 12.5 * MIN);
  return run;
}

/** All four rows unsure in triage; a round-1 batch submitted at +1 min and still in flight. */
function inFlightRun(root: string, runId = 'run-live') {
  const run = makeRun(root, runId);
  for (const id of run.rowIds) triage(run.ledger, id, 'card_arrival', 0.5, 0);
  submit(run.ledger, 'batch-live-cccc', 1, WRITER, run.rowIds, 1 * MIN);
  return run;
}

describe('run status', () => {
  it('finished: no pending rows', async () => {
    const root = makeRoot();
    finishedRun(root);
    const r = await getRun(root, 'run-finished', { ...at(13 * MIN), pidAlive: dead });
    expect(r.status).toBe('finished');
    expect(r.outcomes).toMatchObject({ accepted: 4, flagged: 0, pending: 0, acceptedRound0: 2, rerun: 1 });
    expect(r.resumeCommand).toBeNull();
    expect(r.activeStage).toBeNull();
    expect(r.precision).toEqual({ correct: 4, of: 4 });
  });

  it('running while the lock is fresh and the pid alive; waiting on batch while one is in flight', async () => {
    const root = makeRoot();
    const { dir } = inFlightRun(root);
    lockRun(dir, 3 * MIN - 20_000);
    const r = await getRun(root, 'run-live', { ...at(3 * MIN), pidAlive: alive });
    expect(r.status).toBe('running');
    expect(r.activity).toBe('waiting_on_batch');
    expect(r.lock).toMatchObject({ pid: 4242, live: true });
    expect(r.resumeCommand).toBeNull();
  });

  it('stopped when the heartbeat is stale, even if the pid exists', async () => {
    const root = makeRoot();
    const { dir } = inFlightRun(root);
    lockRun(dir, 3 * MIN - 61_000);
    const r = await getRun(root, 'run-live', { ...at(3 * MIN), pidAlive: alive });
    expect(r.status).toBe('stopped');
    expect(r.lock).toMatchObject({ live: false });
  });

  it('stopped when the pid is gone (crash), with a fresh-looking heartbeat', async () => {
    const root = makeRoot();
    const { dir } = inFlightRun(root);
    lockRun(dir, 3 * MIN - 5_000);
    expect((await getRun(root, 'run-live', { ...at(3 * MIN), pidAlive: dead })).status).toBe('stopped');
  });

  it('stopped without a lock, with the exact resume command', async () => {
    const root = makeRoot();
    inFlightRun(root);
    const here = await getRun(root, 'run-live', { now: () => T0 + 3 * MIN, cwd: dirname(root), pidAlive: dead });
    expect(here.status).toBe('stopped');
    expect(here.resumeCommand).toBe('twopass resume run-live');
    const elsewhere = await getRun(root, 'run-live', at(3 * MIN));
    expect(elsewhere.resumeCommand).toBe(`twopass resume run-live --runs ${root.includes(' ') ? `'${root}'` : root}`);
  });

  it('a bench run resumes through the bench, with its cap', async () => {
    const root = makeRoot();
    inFlightRun(root);
    writeBench(root, 'bench-x', { jev: 'run-live' }, { maxUsd: 3 });
    const r = await getRun(root, 'run-live', { now: () => T0, cwd: dirname(root) });
    expect(r.bench).toEqual({ benchId: 'bench-x', config: 'jev' });
    expect(r.resumeCommand).toBe('twopass bench banking77 --id bench-x --max-usd 3');
    expect(r).toMatchObject({ maxUsd: 3, capScope: 'bench' });
  });

  it('unknown when the task file cannot be loaded', async () => {
    const root = makeRoot();
    const { dir } = inFlightRun(root);
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    m.taskPath = '/nonexistent/x.task.ts';
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m));
    const r = await getRun(root, 'run-live', at(0));
    expect(r.status).toBe('unknown');
    expect(r.problem).toMatch(/Cannot load the task file/);
  });
});

describe('stage progress', () => {
  it('follows the routing: triage, write, verify, re-run, verify', async () => {
    const root = makeRoot();
    finishedRun(root);
    const r = await getRun(root, 'run-finished', at(13 * MIN));
    expect(r.stages.map((s) => [s.key, s.done, s.total, s.totalIsEstimate, s.state])).toEqual([
      ['triage', 4, 4, false, 'done'],
      ['write1', 2, 2, false, 'done'],
      ['verify1', 2, 2, false, 'done'],
      ['write2', 1, 1, false, 'done'],
      ['verify2', 1, 1, false, 'done'],
    ]);
  });

  it('marks the active stage and gives upper bounds for later ones', async () => {
    const root = makeRoot();
    inFlightRun(root);
    const r = await getRun(root, 'run-live', at(3 * MIN));
    expect(r.activeStage).toBe('write1');
    const write1 = r.stages.find((s) => s.key === 'write1')!;
    expect(write1).toMatchObject({ total: 4, sent: 4, done: 0, state: 'active', totalIsEstimate: false });
    expect(r.stages.find((s) => s.key === 'verify1')).toMatchObject({ total: 4, totalIsEstimate: true, state: 'waiting' });
    expect(r.stages.find((s) => s.key === 'write2')).toMatchObject({ total: 4, totalIsEstimate: true });
  });

  it('round 1 is an estimate while triage is unfinished', async () => {
    const root = makeRoot();
    const { ledger } = makeRun(root, 'run-triage');
    triage(ledger, 'r1', 'card_arrival', 0.97, 0);
    triage(ledger, 'r2', 'card_arrival', 0.5, 0);
    const r = await getRun(root, 'run-triage', at(MIN));
    expect(r.stages[0]).toMatchObject({ key: 'triage', done: 2, total: 4, state: 'active' });
    expect(r.stages[1]).toMatchObject({ key: 'write1', total: 3, totalIsEstimate: true, state: 'waiting' });
  });

  it('baseline runs have one write stage', async () => {
    const root = makeRoot();
    makeRun(root, 'run-base', { mode: 'baseline' });
    const r = await getRun(root, 'run-base', at(0));
    expect(r.stages.map((s) => s.key)).toEqual(['write1']);
    expect(r.status).toBe('stopped');
  });
});

describe('batches', () => {
  it('reports duration, cost and undecodable lines, and the in-flight age basis', async () => {
    const root = makeRoot();
    finishedRun(root);
    const r = await getRun(root, 'run-finished', at(13 * MIN));
    const [b2, b1] = r.batches; // newest first
    expect(b1).toMatchObject({ batchId: 'batch-r1-aaaa', shortId: '…aaaa', round: 1, rows: 2, finished: true, durationMs: 5 * MIN, costUsd: 0.01, undecodable: 1, reserveUsd: null });
    // no provider total: the sum of the rows
    expect(b2).toMatchObject({ round: 2, durationMs: 4 * MIN, undecodable: 0 });
    expect(b2!.costUsd).toBeCloseTo(0.003);
    expect(b2!.submittedAt).toBe(iso(8 * MIN));
  });
});

describe('expected finish', () => {
  it('in-flight batch: submitted + median for its model, then one median round per round not started', async () => {
    const root = makeRoot();
    finishedRun(root); // haiku batch took 5 min, sonnet 4 min
    const { dir } = inFlightRun(root);
    lockRun(dir, 3 * MIN);
    const r = await getRun(root, 'run-live', { ...at(3 * MIN), pidAlive: alive });
    expect(r.expectedFinish.at).toBe(iso(1 * MIN + 5 * MIN + 4 * MIN));
    expect(r.expectedFinish.basis).toMatch(/median 5\.0 min over 1 haiku batch/);
  });

  it('assumes 7 minutes per batch when no batch of the model has finished', async () => {
    const root = makeRoot();
    const { dir } = inFlightRun(root);
    lockRun(dir, 3 * MIN);
    const r = await getRun(root, 'run-live', { ...at(3 * MIN), pidAlive: alive });
    expect(r.expectedFinish.at).toBe(iso(1 * MIN + 7 * MIN + 7 * MIN));
    expect(r.expectedFinish.basis).toMatch(/assumed 7 min/);
  });

  it('a batch past its median ends "now"; a stopped or finished run has no estimate', async () => {
    const root = makeRoot();
    finishedRun(root);
    const { dir } = inFlightRun(root);
    lockRun(dir, 30 * MIN);
    const late = await getRun(root, 'run-live', { ...at(30 * MIN), pidAlive: alive });
    expect(late.expectedFinish.at).toBe(iso(30 * MIN + 4 * MIN));
    const stopped = await getRun(root, 'run-live', { ...at(30 * MIN), pidAlive: dead });
    expect(stopped.expectedFinish).toEqual({ at: null, basis: expect.stringMatching(/Not running/) });
    expect((await getRun(root, 'run-finished', at(30 * MIN))).expectedFinish.at).toBeNull();
  });
});

describe('spend by stage', () => {
  it('splits spend into triage, write and verify per round', async () => {
    const root = makeRoot();
    const { dir } = finishedRun(root);
    const r = await getRun(root, 'run-finished', at(13 * MIN));
    expect(r.spend.triage).toBeCloseTo(0.004);
    expect(r.spend.write1).toBeCloseTo(0.01);
    expect(r.spend.verify1).toBeCloseTo(0.004);
    expect(r.spend.write2).toBeCloseTo(0.003);
    expect(r.spend.verify2).toBeCloseTo(0.002);
    expect(r.spend.total).toBeCloseTo(0.023);
    expect(r.spend).toEqual(spendByStage(replay(new Ledger(join(dir, 'ledger.jsonl')).read())));
  });

  it('equals the bench report for the same ledger', async () => {
    const root = makeRoot();
    const { dir, ledger } = makeRun(root, 'run-base', { mode: 'baseline' });
    submit(ledger, 'batch-base-dddd', 1, WRITER, ['r1', 'r2', 'r3', 'r4'], 0);
    results(ledger, 'batch-base-dddd', 1, WRITER, { r1: 'card_arrival', r2: 'age_limit', r3: 'atm_support', r4: 'card_linking' }, 5 * MIN, { costUsd: 0.04 });
    const r = await getRun(root, 'run-base', at(6 * MIN));
    const { manifest, records } = loadRun(dir);
    const st = replay(ledger.read());
    const bench = await configResult('baseline', dir, manifest.runId, true, manifest.models, manifest.thresholds, records, st, await loadTask(manifest.taskPath), {
      runId: 'c',
      createdAt: '',
      target: 0.95,
      rows: 0,
      models: {},
    });
    for (const k of ['triage', 'write1', 'verify1', 'write2', 'verify2', 'total'] as const) {
      expect((1000 * r.spend[k]) / 4).toBeCloseTo(bench.costPer1k[k], 10);
    }
  });
});

describe('runs and benches lists', () => {
  it('lists runs newest first with their bench', async () => {
    const root = makeRoot();
    finishedRun(root, 'run-old');
    makeRun(root, 'run-new', { createdAt: iso(60 * MIN), maxUsd: 2 });
    writeBench(root, 'bench-y', { jev: 'run-old' });
    const { runs } = await listRuns(root, at(70 * MIN));
    expect(runs.map((r) => r.runId)).toEqual(['run-new', 'run-old']);
    expect(runs[0]).toMatchObject({ maxUsd: 2, capScope: 'run', bench: null, progress: 0, status: 'stopped', lastEventAt: null });
    expect(runs[1]).toMatchObject({ bench: { benchId: 'bench-y', config: 'jev' }, progress: 1, status: 'finished', lastEventAt: iso(12.5 * MIN) });
  });

  it('summarizes a bench and serves its report on request', async () => {
    const root = makeRoot();
    finishedRun(root, 'run-a');
    const dir = writeBench(root, 'bench-z', { jev: 'run-a', baseline: 'run-missing' }, { maxUsd: 5 });
    const { benches } = await listBenches(root, at(0));
    expect(benches).toHaveLength(1);
    expect(benches[0]).toMatchObject({ benchId: 'bench-z', maxUsd: 5, hasReport: false, status: 'stopped' });
    expect(benches[0]!.configs.map((c) => [c.name, c.run?.status ?? null])).toEqual([
      ['jev', 'finished'],
      ['baseline', null],
    ]);
    const detail = await getBench(root, 'bench-z', { now: () => T0, cwd: dirname(root) });
    expect(detail.resumeCommand).toBe('twopass bench banking77 --id bench-z --max-usd 5');
    expect(() => getBenchReport(root, 'bench-z')).toThrow(NotFoundError);
    writeFileSync(join(dir, 'bench-report.md'), '# Bench bench-z\n');
    expect(getBenchReport(root, 'bench-z')).toEqual({ markdown: '# Bench bench-z\n' });
    expect((await getBench(root, 'bench-z', at(0))).hasReport).toBe(true);
  });

  it('an empty or missing runs folder is an empty list', async () => {
    expect((await listRuns(join(makeRoot(), 'nope'))).runs).toEqual([]);
    expect((await listBenches(makeRoot())).benches).toEqual([]);
  });
});

describe('IDs and paths', () => {
  it('rejects anything but a plain folder name inside the runs root', async () => {
    const root = makeRoot();
    for (const bad of ['..', '.', '../etc', 'a/b', '', 'x\\y', '%2e%2e', 'run id']) {
      expect(() => resolveInside(root, bad), bad).toThrow(BadRequestError);
    }
    expect(resolveInside(root, 'ok-id_1.2')).toBe(join(root, 'ok-id_1.2'));
    await expect(getRun(root, '..')).rejects.toBeInstanceOf(BadRequestError);
    await expect(getRun(root, 'missing')).rejects.toBeInstanceOf(NotFoundError);
    await expect(getBench(root, '..')).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe('balance', () => {
  it('without a key: not available, with a reason; the reserve is still estimated', async () => {
    const root = makeRoot();
    inFlightRun(root);
    const b = await getBalance(root, at(3 * MIN));
    expect(b.available).toBe(false);
    if (!b.available) expect(b.reason).toMatch(/OPENROUTER_API_KEY/);
    expect(b.reserve.batches).toHaveLength(1);
    // worst case: 4 rows × 60 max_tokens × $1e-6, plus the prompt's input tokens
    expect(b.reserve.totalUsd).toBeGreaterThan(4 * 60 * 1e-6);
    expect(b.reserve.totalUsd).toBeLessThan(4 * 60 * 1e-6 + 4 * 2000 * 1e-7);
  });

  it('reserve uses the input tokens seen for the model in the run', async () => {
    const root = makeRoot();
    const { ledger } = makeRun(root, 'run-r');
    for (const id of ['r1', 'r2', 'r3', 'r4']) triage(ledger, id, 'card_arrival', 0.5, 0);
    submit(ledger, 'batch-one', 1, WRITER, ['r1'], 0);
    results(ledger, 'batch-one', 1, WRITER, { r1: 'card_arrival' }, MIN, { inputTokens: 500 });
    submit(ledger, 'batch-two', 1, WRITER, ['r2', 'r3'], 2 * MIN);
    const r = await getRun(root, 'run-r', at(3 * MIN));
    expect(r.reserveUsd).toBeCloseTo(2 * (60 * 1e-6 + 500 * 1e-7), 12);
    // batches older than 24 h hold nothing any more
    expect((await getBalance(root, at(25 * 60 * MIN))).reserve.totalUsd).toBe(0);
  });

  it('reads the credits endpoint with the key, caches 30 s, and never echoes the key', async () => {
    const root = makeRoot();
    const key = 'not-a-real-key-TESTKEY';
    let calls = 0;
    const okFetch = (async (url: string, init: RequestInit) => {
      calls++;
      expect(url).toBe('https://openrouter.ai/api/v1/credits');
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${key}`);
      return new Response(JSON.stringify({ data: { total_credits: 25, total_usage: 7.5 } }));
    }) as typeof fetch;
    const cache = {};
    let now = T0;
    const o = { apiKey: key, fetch: okFetch, cache, now: () => now };
    expect(await getBalance(root, o)).toMatchObject({ available: true, totalCredits: 25, totalUsage: 7.5, balanceUsd: 17.5 });
    now += 29_000;
    await getBalance(root, o);
    expect(calls).toBe(1);
    now += 2_000;
    await getBalance(root, o);
    expect(calls).toBe(2);

    const leaky = (async () => {
      throw new Error(`connect failed for Bearer ${key}`);
    }) as typeof fetch;
    const failed = await getBalance(root, { apiKey: key, fetch: leaky, cache: {} });
    expect(failed.available).toBe(false);
    expect(JSON.stringify(failed)).not.toContain(key);
  });
});

describe('recent activity', () => {
  it('folds runs of similar events into plain-words lines, newest first', async () => {
    const root = makeRoot();
    const { ledger } = finishedRun(root);
    const lines = describeEvents(ledger.read());
    expect(lines.map((l) => l.text)).toEqual([
      'round 2: 1 answer verified by jev, $0.0020',
      'round 2: batch …bbbb completed, 1 rows, $0.0030',
      'round 2: batch …bbbb returned 1 result',
      'round 2: batch …bbbb submitted to sonnet, 1 rows',
      'round 1: 2 answers verified by jev, $0.0040',
      'round 1: batch …aaaa completed, 2 rows, $0.01, 1 undecodable',
      'round 1: batch …aaaa returned 2 results',
      'round 1: batch …aaaa submitted to haiku, 2 rows',
      'round 0: 4 triage decisions by jev, $0.0040',
    ]);
    expect(describeEvents(ledger.read(), 2)).toHaveLength(2);
  });

  it('short model names', () => {
    expect(['anthropic/claude-haiku-5.5:batch', 'anthropic/claude-sonnet-5.5:batch', 'anthropic/claude-opus-5.5:batch', 'typesafe/jev-1.14-20261014', 'cloudflare/clef', 'openai/gpt-6-luna-decisions', 'acme/other-1:batch'].map(shortModel)).toEqual([
      'haiku',
      'sonnet',
      'opus',
      'jev',
      'clef',
      'luna',
      'other-1',
    ]);
  });
});
