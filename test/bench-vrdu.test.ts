import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareDocumentText, DEV_CALIBRATION_DOCS, pickSplit, runVrduBench } from '../src/bench-vrdu.ts';
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
