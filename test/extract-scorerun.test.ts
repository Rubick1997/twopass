import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { calibrateStage, NEVER, type Point } from '../src/calibrate.ts';
import type { Answer, DecisionModel } from '../src/decide/model.ts';
import { Ledger, replay } from '../src/ledger.ts';
import { executePipeline } from '../src/pipeline.ts';
import { buildCalibration, thresholdsFromCalibration, type CalibrationFile } from '../src/runner.ts';
import { scoreRun, unacceptedRound2Points, type ModelPoints, type Verify2Slot } from '../src/score.ts';
import { TRUTH, docs, extractContext, fakeServer, toyTask } from './extract-helpers.ts';
import { tempDir } from './helpers.ts';

/** A checker that is right whenever the proposed value is the truth, and counts its calls. */
function stubChecker(id: string) {
  const calls: string[][] = [];
  const model: DecisionModel = {
    id,
    decide: async (state, questions) => {
      const doc = (state as { document: string }).document;
      calls.push(Object.keys(questions));
      const answers = Object.fromEntries(
        Object.entries(questions).map(([f, q]) => {
          const ok = (q as { instructions: string }).instructions === `${f}=${TRUTH[doc]![f]}`;
          return [f, { type: 'choice', choice: ok ? 'supported' : 'unsupported', probabilities: { supported: ok ? 0.8 : 0.1, unsupported: 0.1, cannot_tell: 0.1 }, confidence: 1 }];
        }),
      );
      return { model: id, answers, costUsd: 0.01, latencyMs: 1 };
    },
  };
  return { model, calls };
}

async function collectRun() {
  const dir = tempDir();
  const api = fakeServer();
  await executePipeline(extractContext(dir, api.fetch, { mode: 'collect' }));
  return { dir, st: replay(new Ledger(join(dir, 'ledger.jsonl')).read()) };
}

const opts = (dir: string, st: ReturnType<typeof replay>, models: DecisionModel[], more: Record<string, unknown> = {}) => ({
  dir,
  task: toyTask,
  records: docs,
  labelColumn: 'gold',
  st,
  runModels: { triage: 'dec', verify: 'dec' },
  models,
  ...more,
});

describe('scoreRun on an extract run', () => {
  it("makes one point per field slot, and takes the run model's answers from the ledger", async () => {
    const { dir, st } = await collectRun();
    const [own] = await scoreRun(opts(dir, st, [stubChecker('dec').model]));
    expect(own!.spentUsd).toBe(0);
    expect(own!.points.triage).toEqual([]);
    // round 1: d1 and d2 usable (d3 was invalid JSON) -> 2 docs x 3 fields; round 2: all 3 docs x 3 fields
    expect(own!.points.verify1).toHaveLength(6);
    expect(own!.points.verify2).toHaveLength(9);
    expect(own!.points.verify1.filter((p) => !p.correct)).toHaveLength(1); // d2's b is WRONG
    expect(own!.points.verify2.filter((p) => !p.correct)).toHaveLength(1); // d2's a is DIFFERENT
    expect(own!.points.verify1.filter((p) => p.correct).every((p) => p.p > 0.9)).toBe(true);
  });

  it('asks another checker once per document with all fields, then reuses its cache', async () => {
    const { dir, st } = await collectRun();
    const first = stubChecker('other');
    const [a] = await scoreRun(opts(dir, st, [first.model]));
    expect(first.calls).toHaveLength(2 + 3); // 2 documents in verify1, 3 in verify2
    expect(first.calls.every((c) => c.join() === 'a,b,c')).toBe(true);
    expect(a!.spentUsd).toBeCloseTo(0.05);
    const second = stubChecker('other');
    const [b] = await scoreRun(opts(dir, st, [second.model]));
    expect(second.calls).toHaveLength(0);
    expect(b!.spentUsd).toBe(0);
    expect(b!.points).toEqual(a!.points);
    const line = JSON.parse(readFileSync(join(dir, 'scores.jsonl'), 'utf8').split('\n')[0]!);
    expect(Object.keys(line.answers)).toEqual(['a', 'b', 'c']);
  });

  it('scores only the stages asked for', async () => {
    const { dir, st } = await collectRun();
    const checker = stubChecker('other');
    const [r] = await scoreRun(opts(dir, st, [checker.model], { stages: ['verify1'] }));
    expect(checker.calls).toHaveLength(2);
    expect(r!.points.verify1).toHaveLength(6);
    expect(r!.points.verify2).toEqual([]);
  });

  it('feeds calibration with slot points, and thresholds work with no triage fit', async () => {
    const { dir, st } = await collectRun();
    const [r] = await scoreRun(opts(dir, st, [stubChecker('dec').model]));
    const cal: CalibrationFile = {
      runId: 'x',
      createdAt: '',
      target: 0.9,
      rows: 3,
      models: { dec: { verify1: calibrateStage(r!.points.verify1, 0.9), verify2: calibrateStage(r!.points.verify2, 0.9) } },
    };
    expect(cal.models.dec!.verify1!.n).toBe(6);
    expect(thresholdsFromCalibration(cal, 'dec', 'dec').t0).toBe(1.01);
  });
});

// ---- the conditional round-2 population

const choice = (c: string, p: number): Answer => ({ type: 'choice', choice: c, probabilities: { supported: p, unsupported: 1 - p, cannot_tell: 0 }, confidence: 1 });
const pt = (score: number, correct: boolean): Point => ({ score, p: score, correct });

/**
 * 30 easy slots: round 1 is confident and right (p .99), round 2 also right (.9).
 * 20 hard slots: round 1 does not accept (cannot_tell); round 2 is .85 and wrong on ten, .8 and right on ten.
 * Fitted on all 50 slots, t2 = .9 (the easy ones carry it); on the 20 hard ones nothing reaches 95%.
 */
function synthetic(verify1Easy: number): ModelPoints {
  const slots: Verify2Slot[] = [];
  const verify1: Point[] = [];
  for (let i = 0; i < 30; i++) {
    verify1.push(pt(verify1Easy, true));
    slots.push({ point: pt(0.9, true), verify1: choice('supported', verify1Easy) });
  }
  for (let i = 0; i < 20; i++) {
    const right = i >= 10;
    verify1.push({ score: 0, p: 0, correct: right });
    slots.push({ point: pt(right ? 0.8 : 0.85, right), verify1: choice('cannot_tell', 0) });
  }
  return { model: 'm', points: { triage: [], verify1, verify2: slots.map((s) => s.point) }, verify2Slots: slots, spentUsd: 0 };
}

describe('conditional round-2 calibration', () => {
  it('fits verify2 on exactly the slots verify1 did not accept, and keeps the all-slots fit', () => {
    const m = synthetic(0.99);
    const cal = buildCalibration('c', 25, 0.95, [m]).models.m!;
    expect(cal.verify1!.fit.threshold).toBe(0.99);
    expect(cal.verify2!.n).toBe(50);
    expect(cal.verify2!.fit.threshold).toBe(0.9); // all slots: the easy ones carry it
    expect(cal.verify2Conditional!.n).toBe(20); // exactly the hard slots
    expect(cal.verify2Conditional!.correct).toBe(10);
    expect(cal.verify2Conditional!.fit.threshold).toBe(NEVER); // no threshold reaches 95% on them
    const pop = unacceptedRound2Points(m.verify2Slots!, 0.99);
    expect(pop).toHaveLength(20);
    expect(pop.every((p) => p.score >= 0.8 && p.score <= 0.85)).toBe(true);
  });

  it('a verify1 fit of NEVER puts every slot in the population', () => {
    const m = synthetic(0.99);
    expect(unacceptedRound2Points(m.verify2Slots!, NEVER)).toHaveLength(50);
    // too few confident round-1 slots: the fit is NEVER
    const few: ModelPoints = { ...m, points: { ...m.points, verify1: m.points.verify1.slice(25) } };
    const cal = buildCalibration('c', 25, 0.95, [few]).models.m!;
    expect(cal.verify1!.fit.threshold).toBe(NEVER);
    expect(cal.verify2Conditional!.n).toBe(50);
  });

  it('a missing round-1 answer (unusable round-1 reply) counts as not accepted', () => {
    const slots: Verify2Slot[] = [{ point: pt(0.9, true), verify1: undefined }];
    expect(unacceptedRound2Points(slots, 0.5)).toHaveLength(1);
  });

  it('stores 0.98 fits for verify1 and the conditional verify2, conditional on the 0.98 verify1 threshold', () => {
    const cal = buildCalibration('c', 25, 0.95, [synthetic(0.99)]).models.m!;
    const op = cal.operatingPoints!['0.98']!;
    expect(op.verify1.threshold).toBe(0.99);
    expect(op.verify2Conditional.n).toBe(20);
    expect(op.verify2Conditional.threshold).toBe(NEVER);
  });

  it('thresholdsFromCalibration takes t2 from the conditional fit, and from verify2 for an older file', () => {
    const cal = buildCalibration('c', 25, 0.95, [synthetic(0.99)]);
    expect(thresholdsFromCalibration(cal, 'm', 'm')).toMatchObject({ t1: 0.99, t2: NEVER });
    const old = structuredClone(cal);
    delete old.models.m!.verify2Conditional;
    delete old.models.m!.operatingPoints;
    expect(thresholdsFromCalibration(old, 'm', 'm')).toMatchObject({ t1: 0.99, t2: 0.9 });
  });

  it("scoreRun pairs each verify2 slot with the same model's verify1 answer (none when round 1 was unusable)", async () => {
    const { dir, st } = await collectRun();
    const [own] = await scoreRun(opts(dir, st, [stubChecker('dec').model]));
    const slots = own!.verify2Slots!;
    expect(slots).toHaveLength(9);
    expect(slots.filter((s) => s.verify1 === undefined)).toHaveLength(3); // d3's round-1 reply was invalid
    expect(slots.map((s) => s.point)).toEqual(own!.points.verify2);
  });
});
