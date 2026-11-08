import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reuseCalibration, runBench, type BenchState } from '../src/bench.ts';
import { loadRun } from '../src/run.ts';
import type { CalibrationFile } from '../src/runner.ts';
import { BANKING77_LABELS } from '../tasks/banking77.labels.ts';
import { tempDir } from './helpers.ts';

const JEV = 'typesafe/jev-1.14';
const CLEF = 'cloudflare/clef';
const fit = (threshold: number) => ({ fit: { threshold, accepted: 1, precision: 1, coverage: 1, recall: 1 } });

function calibrationFile(dir: string, models: string[] = [JEV, CLEF], target = 0.95): string {
  const c: CalibrationFile = {
    runId: 'calib-from-another-bench',
    createdAt: '2026-11-06T21:00:00Z',
    target,
    rows: 1000,
    models: Object.fromEntries(models.map((m, i) => [m, { triage: fit(0.97 - i / 100), verify1: fit(0.96 - i / 100), verify2: fit(0.95 - i / 100) }])),
  } as CalibrationFile;
  const path = join(dir, 'calibration.json');
  writeFileSync(path, JSON.stringify(c));
  return path;
}

function state(configs: BenchState['configs']): BenchState {
  return {
    benchId: 'b',
    createdAt: '',
    taskPath: '',
    configs,
    baseline: 'opus',
    calibrationSize: 1000,
    testSize: null,
    target: 0.95,
    seed: 11,
    testRuns: {},
  };
}

describe('reuseCalibration', () => {
  it('records the path and marks it reused, without a calibration run', () => {
    const path = calibrationFile(tempDir());
    const s = state([{ name: 'clef', triage: CLEF, verify: CLEF }]);
    reuseCalibration(s, path, 0.95);
    expect(s).toMatchObject({ calibrationPath: path, calibrationReused: true });
    expect(s.calibrationRunId).toBeUndefined();
    reuseCalibration(s, path, 0.95); // same path again (resume): no-op
  });

  it('refuses a file missing a fit for a config model, a different target, or replacing a calibration', () => {
    const dir = tempDir();
    const path = calibrationFile(dir, [JEV]);
    expect(() => reuseCalibration(state([{ name: 'clef', triage: CLEF, verify: CLEF }]), path, 0.95)).toThrow(/no triage fit for cloudflare\/clef/);
    expect(() => reuseCalibration(state([{ name: 'jev', triage: JEV, verify: JEV }]), path, 0.9)).toThrow(/fitted to precision 0.95/);
    expect(() => reuseCalibration(state([]), join(dir, 'missing.json'), 0.95)).toThrow(/No calibration file/);
    const ran = { ...state([]), calibrationRunId: 'x-calib' };
    expect(() => reuseCalibration(ran, path, 0.95)).toThrow(/already has a calibration/);
  });
});

describe('runBench --calibration', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('skips the calibration run, records the path and uses its thresholds', async () => {
    const root = tempDir();
    const dataDir = join(root, 'data');
    mkdirSync(join(dataDir, 'banking77'), { recursive: true });
    const csv = ['id,text,label', ...Array.from({ length: 6 }, (_, i) => `${i},message ${i},${BANKING77_LABELS[i]}`)].join('\n') + '\n';
    writeFileSync(join(dataDir, 'banking77', 'train.csv'), csv);
    writeFileSync(join(dataDir, 'banking77', 'test.csv'), csv);
    const path = calibrationFile(root);
    const before = readFileSync(path, 'utf8');

    // Only the model list answers; every model call fails, so the test runs stop at their first request.
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input);
      requests.push(url);
      if (new URL(url).pathname.endsWith('/models')) {
        const ids = [JEV, CLEF, 'anthropic/claude-haiku-5.5:batch', 'anthropic/claude-sonnet-5.5:batch', 'anthropic/claude-opus-5.5:batch'];
        const data = ids.map((id) => ({ id, context_length: 200_000, pricing: { prompt: '0.000001', completion: '0.000005' } }));
        return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { message: 'no' } }), { status: 401, headers: { 'content-type': 'application/json' } });
    });

    const runsRoot = join(root, 'runs');
    await expect(
      runBench({
        apiKey: 'k',
        runsRoot,
        dataDir,
        maxUsd: 1,
        configs: [{ name: 'clef', triage: CLEF, verify: CLEF }],
        baseline: 'anthropic/claude-opus-5.5:batch',
        calibrationSize: 1000,
        testSize: 4,
        calibrationPath: path,
        target: 0.95,
        seed: 11,
        log: () => {},
      }),
    ).rejects.toThrow(/Some runs stopped/);

    const [benchId] = readdirSync(runsRoot).filter((d) => d.startsWith('bench-'));
    const saved = JSON.parse(readFileSync(join(runsRoot, benchId!, 'bench.json'), 'utf8')) as BenchState;
    expect(saved).toMatchObject({ calibrationPath: path, calibrationReused: true });
    expect(saved.calibrationRunId).toBeUndefined();
    expect(readdirSync(runsRoot).some((d) => d.endsWith('-calib'))).toBe(false);
    expect(Object.keys(saved.testRuns).sort()).toEqual(['baseline', 'clef']);
    const clef = loadRun(join(runsRoot, saved.testRuns.clef!)).manifest;
    expect(clef.thresholds).toEqual({ t0: 0.96, t1: 0.95, t2: 0.94 }); // clef's fits, not jev's
    expect(clef.thresholdsSource).toContain('calib-from-another-bench');
    expect(readFileSync(path, 'utf8')).toBe(before); // never modified
    expect(requests.filter((u) => new URL(u).pathname.endsWith('/models')).length).toBeGreaterThan(0);
  });
});
