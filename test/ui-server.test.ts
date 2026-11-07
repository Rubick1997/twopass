import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startUiServer, type UiServer } from '../src/ui/server.ts';
import { tempDir } from './helpers.ts';
import { makeRoot, makeRun, MIN, results, submit, T0, triage, WRITER, writeBench } from './ui-fixtures.ts';

const KEY = 'not-a-real-key-FAKE-KEY-0123456789';

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Raw HTTP, so the test controls the Host header and the exact path bytes. */
function get(port: number, path: string, o: { host?: string; method?: string } = {}): Promise<Reply> {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers: { host: o.host ?? `127.0.0.1:${port}` } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', fail);
    req.end();
  });
}

let ui: UiServer;
let root: string;
const bodies: string[] = [];
const fetchCalls: string[] = [];

async function hit(path: string, o: { host?: string; method?: string } = {}) {
  const r = await get(ui.port, path, o);
  bodies.push(r.body, JSON.stringify(r.headers));
  return r;
}

beforeAll(async () => {
  root = makeRoot();
  const { ledger } = makeRun(root, 'run-a');
  for (const id of ['r1', 'r2', 'r3', 'r4']) triage(ledger, id, 'card_arrival', 0.5, 0);
  submit(ledger, 'batch-a', 1, WRITER, ['r1', 'r2'], MIN);
  results(ledger, 'batch-a', 1, WRITER, { r1: 'card_arrival', r2: 'age_limit' }, 5 * MIN);
  submit(ledger, 'batch-b', 1, WRITER, ['r3', 'r4'], 6 * MIN);
  const benchDir = writeBench(root, 'bench-a', { jev: 'run-a' });
  writeFileSync(join(benchDir, 'bench-report.md'), '# Bench bench-a\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');

  const dist = join(tempDir(), 'ui');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>TwoPass</title><div id="root"></div>');
  writeFileSync(join(dist, 'assets', 'app-123.js'), 'console.log(1)');
  writeFileSync(join(root, '..', 'secret.txt'), 'outside the dist folder');

  ui = await startUiServer({
    runsRoot: root,
    port: 0,
    distDir: dist,
    apiKey: KEY,
    now: () => T0 + 7 * MIN,
    fetch: (async (url: string, init: RequestInit) => {
      fetchCalls.push(`${url} ${(init.headers as Record<string, string>).Authorization}`);
      return new Response(JSON.stringify({ data: { total_credits: 10, total_usage: 4 } }));
    }) as typeof fetch,
  });
});

afterAll(async () => {
  await ui?.close();
});

describe('twopass ui server', () => {
  it('listens on 127.0.0.1 only', () => {
    const address = ui.server.address();
    expect(typeof address === 'object' && address?.address).toBe('127.0.0.1');
    expect(ui.url).toBe(`http://127.0.0.1:${ui.port}/`);
  });

  it('serves every API endpoint as JSON', async () => {
    const runs = await hit('/api/runs');
    expect(runs.status).toBe(200);
    expect(runs.headers['content-type']).toMatch(/application\/json/);
    expect(runs.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(runs.body).runs.map((r: { runId: string }) => r.runId)).toEqual(['run-a']);

    const run = JSON.parse((await hit('/api/runs/run-a')).body);
    expect(run).toMatchObject({ runId: 'run-a', status: 'stopped', bench: { benchId: 'bench-a', config: 'jev' } });
    expect(run.batches).toHaveLength(2);

    expect(JSON.parse((await hit('/api/benches')).body).benches[0]).toMatchObject({ benchId: 'bench-a', hasReport: true });
    expect(JSON.parse((await hit('/api/benches/bench-a')).body)).toMatchObject({ benchId: 'bench-a', state: { benchId: 'bench-a' } });
    expect(JSON.parse((await hit('/api/benches/bench-a/report')).body).markdown).toMatch(/^# Bench bench-a/);

    const balance = JSON.parse((await hit('/api/balance')).body);
    expect(balance).toMatchObject({ available: true, totalCredits: 10, totalUsage: 4, balanceUsd: 6 });
    expect(balance.reserve.batches).toEqual([expect.objectContaining({ runId: 'run-a', batchId: 'batch-b', rows: 2 })]);
    expect(fetchCalls).toEqual([`https://openrouter.ai/api/v1/credits Bearer ${KEY}`]);
  });

  it('404s unknown runs, benches and API paths', async () => {
    expect((await hit('/api/runs/nope')).status).toBe(404);
    expect((await hit('/api/benches/nope')).status).toBe(404);
    expect((await hit('/api/benches/bench-a/report/extra')).status).toBe(404);
    expect((await hit('/api/whatever')).status).toBe(404);
  });

  it('rejects a Host header other than 127.0.0.1:<port> or localhost:<port> (DNS rebinding)', async () => {
    for (const host of ['evil.example', `evil.example:${ui.port}`, '127.0.0.1', `127.0.0.1:${ui.port + 1}`, `localhost.evil.example:${ui.port}`]) {
      const r = await hit('/api/runs', { host });
      expect(r.status, host).toBe(403);
      expect(r.body).not.toContain('run-a');
    }
    expect((await hit('/api/runs', { host: `localhost:${ui.port}` })).status).toBe(200);
  });

  it('rejects path traversal in run and bench IDs', async () => {
    // "/.." and "/%2e%2e" are normalized away by URL parsing before routing: never a run lookup.
    for (const path of ['/api/runs/..', '/api/runs/%2e%2e', '/api/benches/%2E%2E/report']) {
      const r = await hit(path);
      expect(r.status, path).toBe(404);
      expect(r.body).not.toContain('run-a');
    }
    // Encoded slashes and anything else outside [A-Za-z0-9_.-] are refused by the ID check.
    for (const path of ['/api/runs/..%2F..%2Fetc', '/api/runs/run-a%2F..%2F..', '/api/benches/..%2Fbench-a', '/api/runs/%00', '/api/runs/run%20a']) {
      const r = await hit(path);
      expect(r.status, path).toBe(400);
    }
    expect((await hit('/api/runs/%E0%A4%A')).status).toBe(400); // bad encoding
  });

  it('serves static files and never anything outside the dist folder', async () => {
    const index = await hit('/');
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toMatch(/text\/html/);
    expect(index.headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(index.headers['x-content-type-options']).toBe('nosniff');
    expect(index.body).toContain('TwoPass');

    const js = await hit('/assets/app-123.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/text\/javascript/);
    expect(js.headers['cache-control']).toMatch(/immutable/);

    expect((await hit('/assets/missing.js')).status).toBe(404);
    expect((await hit('/some/page')).body).toContain('TwoPass'); // hash routing: index.html
    for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/..%2F..%2Fsecret.txt', '/..%2Fsecret.txt']) {
      const r = await hit(path);
      expect(r.body, path).not.toContain('outside the dist folder');
      expect([400, 404, 200]).toContain(r.status);
      if (r.status === 200) expect(r.body).toContain('<div id="root">');
    }
  });

  it('is read-only', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect((await hit('/api/runs', { method })).status, method).toBe(405);
    }
    expect((await hit('/api/runs', { method: 'HEAD' })).status).toBe(200);
  });

  it('says how to build the app when dist/ui is missing', async () => {
    const bare = await startUiServer({ runsRoot: root, port: 0, distDir: join(tempDir(), 'none') });
    try {
      const r = await get(bare.port, '/');
      expect(r.status).toBe(503);
      expect(r.body).toContain('pnpm build');
      expect((await get(bare.port, '/api/runs')).status).toBe(200);
    } finally {
      await bare.close();
    }
  });

  it('tries the next port when one is busy', async () => {
    const blocker = createServer();
    await new Promise<void>((ok) => blocker.listen(0, '127.0.0.1', ok));
    const busy = (blocker.address() as { port: number }).port;
    let next: UiServer;
    try {
      next = await startUiServer({ runsRoot: root, port: busy, distDir: join(tempDir(), 'none') });
    } finally {
      blocker.close();
    }
    try {
      expect(next.port).toBeGreaterThan(busy);
      expect(next.port).toBeLessThanOrEqual(busy + 10);
    } finally {
      await next.close();
    }
  });

  it('never sends the API key in any response', async () => {
    expect(bodies.length).toBeGreaterThan(20);
    for (const b of bodies) expect(b).not.toContain(KEY);
    expect(bodies.join('\n')).not.toContain('FAKE-KEY');
  });
});
