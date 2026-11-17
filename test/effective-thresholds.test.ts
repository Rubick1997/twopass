import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { effectiveThresholdsInfo } from '../src/run.ts';

const manifest = { runId: 'r-normal', thresholds: { t0: 1.01, t1: 0.8, t2: 0.4 }, thresholdsSource: 'calibration c1' };

function runsRoot(bench: object | null): string {
  const root = mkdtempSync(join(tmpdir(), 'twopass-eff-'));
  mkdirSync(join(root, 'r-normal'));
  if (bench) {
    mkdirSync(join(root, 'bench-x'));
    writeFileSync(join(root, 'bench-x', 'bench.json'), JSON.stringify(bench));
  }
  return root;
}

describe('effectiveThresholdsInfo', () => {
  it('uses the refitted thresholds of the extract bench whose normal test run this is', () => {
    const root = runsRoot({ kind: 'extract', testRuns: { normal: 'r-normal' }, refit: { thresholds: { t0: 1.01, t1: 0.8, t2: 1.01 } } });
    const e = effectiveThresholdsInfo(join(root, 'r-normal'), manifest);
    expect(e.thresholds.t2).toBe(1.01);
    expect(e.refitBench).toBe('bench-x');
    expect(e.source).toBe('calibration c1; refitted in bench-x after the first test read');
  });

  it("falls back to the manifest's without a refit, for another run, or with no bench", () => {
    for (const bench of [
      { kind: 'extract', testRuns: { normal: 'r-normal' } },
      { kind: 'extract', testRuns: { normal: 'other' }, refit: { thresholds: { t0: 1, t1: 1, t2: 1 } } },
      null,
    ]) {
      const e = effectiveThresholdsInfo(join(runsRoot(bench), 'r-normal'), manifest);
      expect(e).toEqual({ thresholds: manifest.thresholds, source: 'calibration c1', refitBench: null });
    }
  });
});
