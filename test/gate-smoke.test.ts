import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gateCalibrate } from '../src/gate/calibrate-cmd.ts';
import { gateCompare, gateRecalibrate } from '../src/gate/compare-cmd.ts';
import { readIdFile } from '../src/gate/data.ts';
import { gateInit } from '../src/gate/init.ts';
import { buildNoise } from '../src/gate/noise.ts';
import { readResult } from '../src/gate/result.ts';
import { gateRun } from '../src/gate/run.ts';
import { loadGateConfig, readThresholdsFile } from '../src/gate/task-config.ts';
import { h } from './gate-fixtures.ts';

// Reusable mode end to end, no network: a 120-row CSV with 4 made-up labels, `gate init` → `calibrate --collect` →
// `run` (base, head) → `compare` → `recalibrate --write` → `run` → `compare`, through the real startRun / executeRun.
// A fake OpenRouter answers behind a stubbed global fetch. One row in five is "hard": the cheap writer and the checker
// both lean to a decoy label there, so loose thresholds let wrong answers through.

const LABELS = ['refund', 'delivery', 'login', 'billing'];
const OR_KEY = 'sk-or-SECRET-KEY-123';
const parse = (text: string) => {
  const m = /case \d+: (easy|hard), about (\w+)(?: though it mentions (\w+))?/.exec(text);
  if (!m) throw new Error(`fake: can't read "${text}"`);
  return { hard: m[1] === 'hard', gold: m[2]!, decoy: m[3] ?? m[2]! };
};
const probs = (choice: string, p: number, options: string[]) => Object.fromEntries(options.map((o) => [o, o === choice ? p : (1 - p) / (options.length - 1)]));

function fakeOpenRouter() {
  const batches = new Map<string, { model: string; requests: Array<{ custom_id: string; body: any }> }>();
  const calls = { decisions: 0, chat: 0, batches: 0, models: 0 };
  let n = 0;
  const models = ['anthropic/claude-haiku-5.5', 'anthropic/claude-sonnet-5.5'].flatMap((id) => [id, `${id}:batch`]).map((id) => ({
    id,
    context_length: 1_000_000,
    pricing: { prompt: id.includes('sonnet') ? '0.000002' : '0.0000001', completion: id.includes('sonnet') ? '0.00001' : '0.0000005' },
  }));
  models.push({ id: 'fake/checker', context_length: 32_000, pricing: { prompt: '0.0000001', completion: '0' } });

  const write = (model: string, body: any) => {
    const text = String(body.messages.at(-1).content);
    const { hard, gold, decoy } = parse(text);
    const label = model.includes('sonnet') || !hard ? gold : decoy;
    return { model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ label }) } }], usage: { prompt_tokens: 120, completion_tokens: 8 } };
  };

  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (url.startsWith('https://openrouter.ai/api/v1/models')) {
      calls.models++;
      return json(200, { data: models });
    }
    if (url.endsWith('/api/alpha/decisions')) {
      calls.decisions++;
      if (body.questions.answer) {
        const { hard, gold, decoy } = parse(String(body.state));
        const id = String(body.state);
        const choice = hard ? decoy : gold;
        // One constant score for every hard row: a fit on any sample cuts above it (this test checks plumbing, not statistics).
        const p = hard ? 0.7 : 0.93 + 0.06 * h(id);
        return json(200, { model: 'fake/checker-v1', answers: { answer: { type: 'choice', choice, probabilities: probs(choice, p, [...LABELS, 'cannot_tell']), confidence: p } }, usage: { cost: 0.00001 } });
      }
      const { gold } = parse(String(body.state.text));
      const right = body.state.proposed_label === gold;
      const p = right ? 0.93 + 0.06 * h(body.state.text) : 0.6;
      return json(200, { model: 'fake/checker-v1', answers: { verdict: { type: 'choice', choice: 'supported', probabilities: { supported: p, unsupported: 1 - p - 0.01, cannot_tell: 0.01 }, confidence: p } }, usage: { cost: 0.00001 } });
    }
    if (url === 'https://openrouter.ai/api/v1/chat/completions') {
      calls.chat++;
      return json(200, write(body.model, body));
    }
    if (url === 'https://openrouter.ai/api/v1/batches' && init?.method === 'POST') {
      calls.batches++;
      const id = `batch-${++n}`;
      batches.set(id, { model: body.model, requests: body.requests });
      return json(200, { id, status: 'validating' });
    }
    if (url.startsWith('https://openrouter.ai/api/v1/batches/')) {
      const id = url.split('/').pop()!;
      const b = batches.get(id)!;
      const results = b.requests.map((r) => ({ custom_id: r.custom_id, response: { status_code: 200, body: write(b.model, r.body) }, error: null }));
      return json(200, { id, status: 'completed', usage: { cost: 0.0001 }, results });
    }
    return json(404, { error: `fake: no route for ${url}` });
  };
  return { fetchFn, calls };
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

describe('reusable mode, end to end (no network)', () => {
  let fake: ReturnType<typeof fakeOpenRouter>;
  beforeEach(() => {
    fake = fakeOpenRouter();
    vi.stubGlobal('fetch', fake.fetchFn);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('init → calibrate → run base/head → compare (red, with proposal) → recalibrate --write → run → compare (green)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'twopass-smoke-'));
    const env = { openRouterKey: OR_KEY };
    const runsRoot = join(tmp, 'runs');
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);

    const init = gateInit({
      data: resolve('test/fixtures/gate-smoke.csv'),
      id: 'id',
      text: 'message',
      label: 'topic',
      name: 'smoke',
      dir: join(tmp, 'gates'),
      workflow: join(tmp, '.github/workflows/eval-gate.yml'),
      checker: 'fake/checker',
      calibrationPerLabel: 10,
      perLabel: 20,
      twopassVersion: '0.0.1',
      // 90% keeps the fake's 40 calibration rows able to reach the target with a margin.
      target: 0.9,
    });
    expect(init).toMatchObject({ sliceRows: 80, calibrationRows: 40, shortLabels: {} });
    const yaml = readFileSync(init.taskPath, 'utf8').replaceAll(tmp, '<tmp>').replaceAll(resolve('.'), '<repo>');
    expect(yaml).toMatchSnapshot('task.yaml');
    const workflow = readFileSync(join(tmp, '.github/workflows/eval-gate.yml'), 'utf8');
    expect(workflow).toContain(`TASK: ${init.taskPath}`);
    expect(workflow).toContain('TWOPASS_VERSION: 0.0.1');
    expect(workflow).not.toContain('pull_request_target:');
    expect(workflow).not.toContain('__');
    const { config } = loadGateConfig(init.taskPath);
    const slice = new Set(readIdFile(config.slice.file));
    expect(readIdFile(config.calibration.rows).filter((id) => slice.has(id))).toEqual([]);
    await expect(gateRun({ taskPath: init.taskPath, ref: 'base', out: join(tmp, 'x.json'), env, runsRoot })).rejects.toThrow(/No thresholds/);

    // calibrate: a collect run on the 40 calibration rows (batches), then the fit
    const cal = await gateCalibrate({ taskPath: init.taskPath, collect: true, maxUsd: 1, env, runsRoot, log });
    expect(cal.thresholds!.thresholds.t0).toBeGreaterThan(0.6); // above the hard rows' wrong triage picks
    expect(fake.calls.batches).toBe(2);

    // base
    const base = await gateRun({ taskPath: init.taskPath, ref: 'base', out: join(tmp, 'base.json'), env, runsRoot, log });
    expect(base.rows).toHaveLength(80);
    expect(base.routes.map((r) => `${r.provider}:${r.callId}`)).toEqual(['openrouter:anthropic/claude-haiku-5.5', 'openrouter:anthropic/claude-sonnet-5.5']);
    expect(fake.calls.batches).toBe(2); // the gate run is sync: no new batches
    const acceptedWrong = (r: typeof base) => r.rows.filter((x) => x.status === 'accepted' && x.answer !== x.label).length;

    // head: someone loosens the thresholds to "automate more"
    const th = readThresholdsFile(config.checker.thresholds)!;
    writeFileSync(config.checker.thresholds, JSON.stringify({ ...th, thresholds: { t0: 0.5, t1: 0.5, t2: 0.5 }, source: 'hand-edited' }));
    await gateRun({ taskPath: init.taskPath, ref: 'head', out: join(tmp, 'head.json'), env, runsRoot, log });

    expect(acceptedWrong(readResult(join(tmp, 'head.json')))).toBeGreaterThan(acceptedWrong(base));
    const red = gateCompare({ basePath: join(tmp, 'base.json'), headPath: join(tmp, 'head.json'), taskPath: init.taskPath, commentPath: join(tmp, 'comment.md') });
    expect(red.pass).toBe(false);
    expect(red.gates.g3.reasons.find((r) => r.check === 'promise')!.pass).toBe(false);
    expect(red.proposal).toMatchObject({ kind: 'proposal', restores: true });
    expect(red.review.length).toBeGreaterThan(0);
    expect(red.review.length).toBeLessThanOrEqual(10);
    const comment = readFileSync(join(tmp, 'comment.md'), 'utf8');
    expect(comment.split('\n')[0]).toBe('<!-- twopass-eval-gate:smoke -->');
    expect(comment).toContain('Recalibration proposal');

    // mixed routing is refused unless allowed
    const mixed = { ...readResult(join(tmp, 'head.json')), routingKey: 'something else' };
    writeFileSync(join(tmp, 'head-mixed.json'), JSON.stringify(mixed));
    expect(() => gateCompare({ basePath: join(tmp, 'base.json'), headPath: join(tmp, 'head-mixed.json'), taskPath: init.taskPath })).toThrow(/routed differently/);
    expect(() => gateCompare({ basePath: join(tmp, 'base.json'), headPath: join(tmp, 'head-mixed.json'), taskPath: init.taskPath, allowMixedRouting: true })).not.toThrow();

    // apply the proposal, as its own change, and run again
    const rec = gateRecalibrate({ taskPath: init.taskPath, runPath: join(tmp, 'head.json'), write: true });
    expect(rec.wrote).toBe(config.checker.thresholds);
    expect(readThresholdsFile(config.checker.thresholds)!.source).toContain('gate recalibrate');
    await gateRun({ taskPath: init.taskPath, ref: 'head-recalibrated', out: join(tmp, 'head2.json'), env, runsRoot, log });
    const green = gateCompare({ basePath: join(tmp, 'base.json'), headPath: join(tmp, 'head2.json'), taskPath: init.taskPath });
    expect(green.gates.g3.reasons.find((r) => r.check === 'promise')!.pass).toBe(true);

    // noise from two unchanged runs
    expect(buildNoise([readResult(join(tmp, 'base.json')), readResult(join(tmp, 'base.json'))]).identicalShare).toBe(1);

    // keys never reach a file or a log line
    for (const f of filesUnder(tmp)) expect(readFileSync(f, 'utf8'), f).not.toContain('SECRET');
    expect(logs.join('\n')).not.toContain('SECRET');
    expect(logs.join('\n')).toContain('OPENROUTER_API_KEY set');
  }, 60_000);
});
