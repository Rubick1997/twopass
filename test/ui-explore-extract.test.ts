import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fitThreshold, NEVER } from '../src/calibrate.ts';
import { runVrduBench } from '../src/bench-vrdu.ts';
import { computeFieldOutcomes } from '../src/extract/outcomes.ts';
import { readRunState } from '../src/extract/review.ts';
import { loadRun } from '../src/run.ts';
import { loadTask } from '../src/task.ts';
import { readCalibration } from '../src/runner.ts';
import { getBenchExplore } from '../src/ui/api.ts';
import type { ExtractExploreResponse } from '../src/ui/api-types.ts';
import { replayAt, replayExtract, fitThresholds, type Pipeline } from '../ui/src/explore-extract.ts';
import { installFakeApi, setup } from './vrdu-bench-helpers.ts';

// The bench fixture: 30 documents d01..d30. The cheap writer gives garbage for n % 7 == 0 and a wrong b for n % 3 == 0;
// the strong writer is always right. Calibration = d01..d15, test = d16..d30.

afterEach(() => vi.unstubAllGlobals());

async function bench() {
  installFakeApi();
  const { root, options } = setup();
  const { benchDir } = await runVrduBench(options());
  const state = JSON.parse(readFileSync(join(benchDir, 'bench.json'), 'utf8'));
  return { root, runsRoot: join(root, 'runs'), benchDir, state };
}

describe('GET /api/benches/:id/explore for an extraction bench', () => {
  it('returns the report and the calibration field slots, built from the ledger only', async () => {
    const { runsRoot, state } = await bench();
    const d = (await getBenchExplore(runsRoot, state.benchId)) as ExtractExploreResponse;
    expect(d).toMatchObject({ kind: 'extract', decision: 'dec/main', target: 0.95, calibrationMissingReason: null });
    expect(d.report).toMatchObject({ kind: 'extract', documents: 15, fields: 45 });
    expect(d.calibration!.models).toEqual(['dec/main', 'dec/other']);
    expect(d.calibration!.slots).toHaveLength(15 * 3);
    const slot = d.calibration!.slots.find((s) => s.docId === 'd01' && s.field === 'a')!;
    expect(slot).toMatchObject({ goldPresent: true, correct1: true, correct2: true });
    expect(slot.a['dec/main']!.r1).toEqual({ choice: 'supported', p: 0.95 });
    // d07: the cheap writer gave garbage, so round 1 is unusable and has no checker answer
    expect(d.calibration!.slots.find((s) => s.docId === 'd07' && s.field === 'a')).toMatchObject({ correct1: false, correct2: true, a: { 'dec/main': { r1: null } } });
    // d04: c is absent in the gold
    expect(d.calibration!.slots.find((s) => s.docId === 'd04' && s.field === 'c')!.goldPresent).toBe(false);
    expect(d.calibration!.fitsByModel['dec/main']!.verify1).toBeCloseTo(0.95);
    // cached: the same object until a file changes
    expect(await getBenchExplore(runsRoot, state.benchId)).toBe(d);
  });

  it('without the calibration run folder: the report, calibration null and a reason', async () => {
    const { runsRoot, state } = await bench();
    renameSync(join(runsRoot, state.calibrationRunId), join(runsRoot, 'moved-away'));
    const d = (await getBenchExplore(runsRoot, state.benchId)) as ExtractExploreResponse;
    expect(d.kind).toBe('extract');
    expect(d.calibration).toBeNull();
    expect(d.calibrationMissingReason).toMatch(/not in the runs folder/);
    expect(d.report.documents).toBe(15);
  });
});

describe('the replay (ui/src/explore-extract.ts)', () => {
  async function fixture() {
    const { runsRoot, state } = await bench();
    const d = (await getBenchExplore(runsRoot, state.benchId)) as ExtractExploreResponse;
    const calibDir = join(runsRoot, state.calibrationRunId);
    const { manifest, records } = loadRun(calibDir);
    return { d, state, calibDir, manifest, records, task: await loadTask(manifest.taskPath), st: readRunState(calibDir), runsRoot };
  }

  const grid = [
    { t1: 0.5, t2: 0.5 }, { t1: 0.8, t2: 0.8 }, { t1: 0.9, t2: 0.9 }, { t1: 0.95, t2: 0.95 }, { t1: 0.96, t2: 0.9 },
    { t1: 0.5, t2: 0.99 }, { t1: 1, t2: 1 }, { t1: NEVER, t2: NEVER }, { t1: NEVER, t2: 0.9 }, { t1: 0.9, t2: NEVER },
  ];

  it.each(['simple', 'full'] as const)('equals computeFieldOutcomes on the collect ledger, %s pipeline, for every threshold pair', async (pipeline: Pipeline) => {
    const { d, manifest, records, task, st } = await fixture();
    const ex = task.extract!;
    for (const t of grid) {
      const out = computeFieldOutcomes(st, { task, rows: records, thresholds: { t0: NEVER, ...t }, mode: 'normal' }, pipeline === 'simple' ? { maxRound: 1 } : {});
      expect(out.some((o) => o.status === 'pending')).toBe(false);
      const labelOf = new Map(records.map((r) => [r.id, r.data[manifest.labelColumn!]!]));
      const right = (o: (typeof out)[number]) => o.verdict !== 'writer_failed' && o.verdict !== 'invalid_output' && ex.isCorrect(o.field, o.value, labelOf.get(o.rowId)!);
      const acc = out.filter((o) => o.status === 'accepted');
      const flg = out.filter((o) => o.status === 'flagged');
      const r = replayAt(d.calibration!.slots, 'dec/main', t, pipeline);
      expect({ n: r.n, accepted: r.accepted, acceptedCorrect: r.acceptedCorrect, flagged: r.flagged, flaggedCorrect: r.flaggedCorrect }, JSON.stringify(t)).toEqual({
        n: out.length,
        accepted: acc.length,
        acceptedCorrect: acc.filter(right).length,
        flagged: flg.length,
        flaggedCorrect: flg.filter(right).length,
      });
    }
  });

  it('covers every path on the fixture: garbage round 1, wrong value, round 2 accepting and refusing', async () => {
    const { d } = await fixture();
    const slots = d.calibration!.slots;
    expect(slots.some((s) => s.a['dec/main']!.r1 === null)).toBe(true); // unusable round 1
    expect(slots.some((s) => !s.correct1 && s.a['dec/main']!.r1)).toBe(true); // a wrong value the checker saw
    const full = replayAt(slots, 'dec/main', { t1: 0.9, t2: 0.9 }, 'full');
    const simple = replayAt(slots, 'dec/main', { t1: 0.9, t2: 0.9 }, 'simple');
    expect(full.accepted).toBeGreaterThan(simple.accepted); // the stronger writer rescues fields
    expect(full.precision).toBe(1);
    expect(full.t2).toBe(0.9);
    expect(simple.t2).toBeNull();
    expect(replayAt(slots, 'dec/main', { t1: NEVER, t2: NEVER }, 'full')).toMatchObject({ accepted: 0, flagged: 45, precision: null, confidentWrongPer1000: 0 });
  });

  it('fits the thresholds buildCalibration stores at the bench target (verify1 and verify2Conditional)', async () => {
    const { d, state } = await fixture();
    const cal = readCalibration(state.calibrationPath);
    for (const model of d.calibration!.models) {
      const t = fitThresholds(d.calibration!.slots, model, 0.95);
      expect(t.t1, model).toBe(cal.models[model]!.verify1!.fit.threshold);
      expect(t.t2, model).toBe(cal.models[model]!.verify2Conditional?.fit.threshold ?? NEVER);
    }
    // a different target moves them; precision at the replay is at least the target when something is accepted
    const r = replayExtract(d.calibration!.slots, 'dec/main', 0.95, 'simple');
    expect(r.t1).toBe(cal.models['dec/main']!.verify1!.fit.threshold);
    expect(fitThreshold([], 0.95).threshold).toBe(NEVER);
    expect(existsSync(state.calibrationPath)).toBe(true);
  });
});
