import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareDocumentText, DEV_CALIBRATION_DOCS, pickSplit, refitVrduBench, runVrduBench } from '../src/bench-vrdu.ts';
import type { VrduDocument } from '../src/datasets/vrdu.ts';
import { docs, installFakeApi, setup } from './vrdu-bench-helpers.ts';

describe('pickSplit', () => {
  it('dev: first 15 calibrate, the next 15 test; test: the committed calibration and test splits', () => {
    const s = { dev: docs.map((d) => d.docId), calibration: ['c1'], test: ['t1'] };
    const dev = pickSplit(s, 'dev');
    expect(dev.calibration).toEqual(s.dev.slice(0, DEV_CALIBRATION_DOCS));
    expect(dev.test).toEqual(s.dev.slice(DEV_CALIBRATION_DOCS));
    expect(pickSplit(s, 'test')).toMatchObject({ calibration: ['c1'], test: ['t1'] });
  });
});

describe('compareDocumentText', () => {
  const rec = (id: string, text: string) => ({ id, data: { text } });
  const d = (text: string): VrduDocument => ({ docId: 'x', filename: '', template: '', text, gold: {} as VrduDocument['gold'] });
  it('counts changes that `check` explains, and says which are inside the text', () => {
    const r = compareDocumentText([d('a\r\nb')], [rec('x', 'a\nb')]);
    expect(r).toMatchObject({ documents: 1, changed: 1, changedInside: 1, kinds: { normalized_line_endings: 1 } });
    expect(compareDocumentText([d(' a b ')], [rec('x', 'a b')])).toMatchObject({ changed: 1, changedInside: 0, kinds: { trimmed_cells: 1 } });
    expect(compareDocumentText([d('a\fb')], [rec('x', 'ab')])).toMatchObject({ changedInside: 1, kinds: { removed_control_chars: 1 } });
    expect(compareDocumentText([d('same')], [rec('x', 'same')])).toMatchObject({ changed: 0 });
  });
  it('throws when the stored text differs in a way `check` does not explain', () => {
    expect(() => compareDocumentText([d('abc')], [rec('x', 'abd')])).toThrow(/does not explain/);
  });
});

describe('bench vrdu --split dev, end to end on mocks', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('calibrates, runs normal and baseline, scores --also, writes the reports, and resumes with --id', async () => {
    const api = installFakeApi();
    const { root, options } = setup();
    const { benchDir, reportPath } = await runVrduBench(options({ id: undefined }));

    // state
    const state = JSON.parse(readFileSync(join(benchDir, 'bench.json'), 'utf8'));
    expect(state).toMatchObject({ kind: 'extract', split: 'dev', calibrationDocuments: 15, testDocuments: 15 });
    expect(Object.keys(state.testRuns).sort()).toEqual(['baseline', 'normal']);
    const runs = readdirSync(join(root, 'runs')).filter((d) => !d.startsWith('bench-'));
    expect(runs.some((r) => r.endsWith('-calib'))).toBe(true);

    // data files
    const csv = readFileSync(join(root, 'data', 'vrdu', 'dev-test.csv'), 'utf8');
    expect(csv.split('\n')[0]).toBe('doc_id,template,text,gold');
    expect(existsSync(join(root, 'data', 'vrdu', 'dev-calibration.csv'))).toBe(true);

    // thresholds: t0 unused (never), t1 / t2 fitted from slots
    const normalManifest = JSON.parse(readFileSync(join(root, 'runs', state.testRuns.normal, 'manifest.json'), 'utf8'));
    expect(normalManifest.thresholds.t0).toBe(1.01);
    expect(normalManifest.thresholds.t1).toBeCloseTo(0.95);

    // report
    const md = readFileSync(reportPath, 'utf8');
    expect(md.split('\n')[0]).toMatch(/^\*\*45 fields · \d+% accepted at \d+% precision · \d+ sent to a person · \$[\d.]+ per 1,000 fields · dev split, these numbers are for debugging only\*\*$/);
    const report = JSON.parse(readFileSync(join(benchDir, 'bench-report.json'), 'utf8'));
    expect(report).toMatchObject({ kind: 'extract', split: 'dev', debugOnly: true, documents: 15, fields: 45 });
    expect(report.checkers.map((c: { model: string }) => c.model)).toEqual(['dec/main', 'dec/other']);
    expect(report.checkers[1].slots).toBeGreaterThan(0);
    expect(report.configs.baseline.accuracy).toBe(1);
    expect(report.configs.full.confidentWrong).toBe(0);
    expect(report.textCheck.changedInside).toBeGreaterThan(0); // the fixture has CRLF inside every document
    expect(md).toContain('## Document text');

    // enriched-fields.csv in both test run dirs
    for (const name of ['normal', 'baseline']) {
      const lines = readFileSync(join(root, 'runs', state.testRuns[name], 'enriched-fields.csv'), 'utf8').trim().split('\n');
      expect(lines[0]).toBe('doc_id,field,value,gold,correct,verdict,confidence,model,round,cost_usd');
      expect(lines).toHaveLength(1 + 45);
    }

    // the "other" checker was asked about round 1 only: 15 test documents, minus the garbage ones
    const decisions = readFileSync(join(root, 'runs', state.testRuns.normal, 'scores.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(decisions.every((r) => r.model === 'dec/other' && r.stage === 'verify1')).toBe(true);

    // resume: nothing is requested again, and the report is the same
    const before = api.requests.length;
    const again = await runVrduBench(options({ id: state.benchId }));
    expect(api.requests.length).toBe(before);
    const report2 = JSON.parse(readFileSync(join(again.benchDir, 'bench-report.json'), 'utf8'));
    expect({ ...report2, createdAt: '' }).toEqual({ ...report, createdAt: '' });
  });

  it('resume after a stop re-uses the saved runs and does not start new ones', async () => {
    const api = installFakeApi();
    const { root, options } = setup();
    // a cap too low for the test runs: the bench stops, keeping its state
    await expect(runVrduBench(options({ id: undefined, maxUsd: 0.03 }))).rejects.toThrow();
    const [benchId] = readdirSync(join(root, 'runs')).filter((d) => d.startsWith('bench-'));
    const first = readdirSync(join(root, 'runs')).length;
    expect(api.requests.length).toBeGreaterThan(0);
    await runVrduBench(options({ id: benchId!, maxUsd: 5 }));
    const names = readdirSync(join(root, 'runs'));
    expect(names.length).toBeGreaterThanOrEqual(first);
    expect(names.filter((n) => n.endsWith('-calib'))).toHaveLength(1);
    expect(names.filter((n) => n.endsWith('-normal'))).toHaveLength(1);
    expect(names.filter((n) => n.endsWith('-baseline'))).toHaveLength(1);
  });

  it('refuses an unknown --id', async () => {
    installFakeApi();
    const { options } = setup();
    await expect(runVrduBench(options({ id: 'bench-nope' }))).rejects.toThrow(/No bench found/);
  });
});

describe('round-2 threshold: conditional fit, fallback and --refit', () => {
  afterEach(() => vi.unstubAllGlobals());
  const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

  it('new benches use verify2Conditional for t2 and say so', async () => {
    installFakeApi();
    const { root, options } = setup();
    const { benchDir } = await runVrduBench(options({ id: undefined }));
    const state = readJson(join(benchDir, 'bench.json'));
    const cal = readJson(state.calibrationPath);
    const m = readJson(join(root, 'runs', state.testRuns.normal, 'manifest.json'));
    expect(cal.models['dec/main'].verify2Conditional.n).toBeLessThan(cal.models['dec/main'].verify2.n);
    expect(cal.models['dec/main'].operatingPoints['0.98']).toBeDefined();
    expect(m.thresholds.t2).toBe(cal.models['dec/main'].verify2Conditional.fit.threshold);
    expect(m.thresholdsSource).toContain('t2 on the slots round 1 did not accept');
  });

  it('falls back to the verify2 fit for an old calibration file', async () => {
    installFakeApi();
    const { root, options } = setup();
    const { benchDir } = await runVrduBench(options({ id: undefined }));
    const benchId = benchDir.split('/').pop()!;
    // Back to the point after calibration, with a calibration file made before the conditional fit existed.
    const statePath = join(benchDir, 'bench.json');
    const state = readJson(statePath);
    state.testRuns = {};
    writeFileSync(statePath, JSON.stringify(state));
    const cal = readJson(state.calibrationPath);
    for (const e of Object.values(cal.models) as Array<Record<string, unknown>>) {
      delete e.verify2Conditional;
      delete e.operatingPoints;
    }
    writeFileSync(state.calibrationPath, JSON.stringify(cal));
    await runVrduBench(options({ id: benchId, maxUsd: 5 }));
    const after = readJson(join(root, 'runs', benchId, 'bench.json'));
    const m = readJson(join(root, 'runs', after.testRuns.normal, 'manifest.json'));
    expect(m.thresholds.t2).toBe(cal.models['dec/main'].verify2.fit.threshold);
    expect(m.thresholdsSource).toContain('t2 on all slots');
    const md = readFileSync(join(root, 'runs', benchId, 'bench-report.md'), 'utf8');
    expect(md).not.toContain('## 98% operating point'); // an old calibration has none
  });

  it('--refit makes no HTTP call, keeps .first copies once, records refit, leaves the runs alone, and the report shows both reads', async () => {
    installFakeApi();
    const { root, options } = setup();
    const { benchDir } = await runVrduBench(options({ id: undefined }));
    const state0 = readJson(join(benchDir, 'bench.json'));
    const normalDir = join(root, 'runs', state0.testRuns.normal);
    const baselineDir = join(root, 'runs', state0.testRuns.baseline);
    // Pretend the test split was first read with a t2 fitted on all slots: a different t2 in the normal manifest.
    const manifestPath = join(normalDir, 'manifest.json');
    const manifest = readJson(manifestPath);
    manifest.thresholds.t2 = 0.5;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const bytes = () => [manifestPath, join(normalDir, 'ledger.jsonl'), join(baselineDir, 'manifest.json'), join(baselineDir, 'ledger.jsonl')].map((p) => readFileSync(p, 'utf8'));
    const runFiles = bytes();
    const firstReport = readFileSync(join(benchDir, 'bench-report.md'), 'utf8');
    const calPath = state0.calibrationPath as string;
    const firstCal = readFileSync(calPath, 'utf8');

    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: unknown) => {
      calls.push(String(input));
      throw new Error('the refit must not make HTTP calls');
    });
    const keys = { o: process.env.OPENROUTER_API_KEY, a: process.env.ANTHROPIC_API_KEY };
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await refitVrduBench({ runsRoot: join(root, 'runs'), id: state0.benchId, log: () => {} });
    } finally {
      if (keys.o !== undefined) process.env.OPENROUTER_API_KEY = keys.o;
      if (keys.a !== undefined) process.env.ANTHROPIC_API_KEY = keys.a;
    }
    expect(calls).toEqual([]);
    expect(bytes()).toEqual(runFiles);

    const state = readJson(join(benchDir, 'bench.json'));
    expect(state.refit).toMatchObject({ reason: 'round-2 threshold fitted on fields round 1 did not accept', previousThresholds: { t2: 0.5 } });
    expect(state.refit.thresholds.t2).not.toBe(0.5);
    expect(readFileSync(join(benchDir, 'bench-report.first.md'), 'utf8')).toBe(firstReport);
    expect(readFileSync(join(benchDir, 'calibration.first.json').replace(benchDir, join(root, 'runs', state.calibrationRunId)), 'utf8')).toBe(firstCal);
    const md = readFileSync(join(benchDir, 'bench-report.md'), 'utf8');
    expect(md).toContain('full, first read (round-2 threshold fitted on all fields)');
    expect(md).toContain('## Method change after the first test read');
    expect(md).toContain('## 98% operating point');
    const report = readJson(join(benchDir, 'bench-report.json'));
    expect(report.thresholds.t2).toBe(state.refit.thresholds.t2);
    expect(existsSync(join(benchDir, 'bench-report.first.json'))).toBe(true);

    // a second refit does not overwrite the first copies, and keeps the first-read thresholds
    await refitVrduBench({ runsRoot: join(root, 'runs'), id: state0.benchId, log: () => {} });
    expect(readFileSync(join(benchDir, 'bench-report.first.md'), 'utf8')).toBe(firstReport);
    expect(readFileSync(join(root, 'runs', state.calibrationRunId, 'calibration.first.json'), 'utf8')).toBe(firstCal);
    expect(readJson(join(benchDir, 'bench.json')).refit.previousThresholds.t2).toBe(0.5);
    expect(bytes()).toEqual(runFiles);
    expect(calls).toEqual([]);
  });

  it('--refit stops when the cached answers on disk do not match the saved calibration', async () => {
    installFakeApi();
    const { root, options } = setup();
    const { benchDir } = await runVrduBench(options({ id: undefined }));
    const state = readJson(join(benchDir, 'bench.json'));
    writeFileSync(join(root, 'runs', state.calibrationRunId, 'scores.jsonl'), '');
    await expect(refitVrduBench({ runsRoot: join(root, 'runs'), id: state.benchId, log: () => {} })).rejects.toThrow(/does not match the saved calibration/);
  });
});
