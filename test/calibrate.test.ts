import { describe, expect, it } from 'vitest';
import {
  accuracyAtCoverage,
  applyIsotonic,
  auc,
  calibrateStage,
  ece,
  fitIsotonic,
  fitThreshold,
  NEVER,
  type Point,
} from '../src/calibrate.ts';
import { parseConfigs } from '../src/bench.ts';
import { triagePoint, verifyPoint } from '../src/score.ts';

const pt = (score: number, correct: boolean): Point => ({ score, p: score, correct });

describe('fitThreshold', () => {
  // 10 rows at 0.9 (all right), 10 at 0.7 (8 right), 10 at 0.5 (3 right)
  const points = [
    ...Array.from({ length: 10 }, () => pt(0.9, true)),
    ...Array.from({ length: 10 }, (_, i) => pt(0.7, i < 8)),
    ...Array.from({ length: 10 }, (_, i) => pt(0.5, i < 3)),
  ];

  it('accepts as many rows as possible while precision stays at the target', () => {
    expect(fitThreshold(points, 0.9)).toMatchObject({ threshold: 0.7, accepted: 20, precision: 0.9 });
    expect(fitThreshold(points, 0.95)).toMatchObject({ threshold: 0.9, accepted: 10, precision: 1 });
    expect(fitThreshold(points, 0.7)).toMatchObject({ threshold: 0.5, accepted: 30 });
  });

  it('only cuts between distinct scores, so ties are accepted or rejected together', () => {
    const fit = fitThreshold(points, 0.92);
    expect(fit.threshold).toBe(0.9);
    expect(fit.accepted).toBe(10);
  });

  it('returns NEVER when the target cannot be reached or too few rows qualify', () => {
    expect(fitThreshold(points.map((p) => ({ ...p, correct: false })), 0.5).threshold).toBe(NEVER);
    expect(fitThreshold([pt(0.99, true), pt(0.98, true)], 0.9).threshold).toBe(NEVER); // below minAccepted
  });

  it('never accepts a score of 0 (abstentions)', () => {
    const fit = fitThreshold([...Array.from({ length: 20 }, () => pt(0, true))], 0.5);
    expect(fit.threshold).toBe(NEVER);
  });
});

describe('isotonic calibration', () => {
  it('is monotone and matches observed accuracy per block', () => {
    const steps = fitIsotonic([pt(0.1, false), pt(0.2, true), pt(0.3, false), pt(0.9, true), pt(0.95, true)]);
    const ys = steps.map((s) => s.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    expect(applyIsotonic(steps, 0.1)).toBe(0);
    expect(applyIsotonic(steps, 0.25)).toBe(0.5); // 0.2 (right) and 0.3 (wrong) pooled
    expect(applyIsotonic(steps, 0.99)).toBe(1);
  });

  it('gives tied scores one calibrated value', () => {
    const steps = fitIsotonic([pt(1, false), pt(1, true), pt(1, true), pt(1, true)]);
    expect(steps).toEqual([{ x: 1, y: 0.75 }]);
  });

  it('fixes an overconfident model out of sample', () => {
    // says 0.99 every time, right 70% of the time
    const points = Array.from({ length: 200 }, (_, i) => ({ score: 0.99, p: 0.99, correct: i % 10 < 7 }));
    const c = calibrateStage(points, 0.9);
    expect(c.eceRaw).toBeCloseTo(0.29, 2);
    expect(c.eceCalibrated).toBeLessThan(0.05);
    expect(c.fit.threshold).toBe(NEVER);
  });
});

describe('metrics', () => {
  it('ece is 0 for a perfectly calibrated set and positive otherwise', () => {
    expect(ece([0.25, 0.25, 0.25, 0.25], [true, false, false, false])).toBeCloseTo(0);
    expect(ece([1, 1], [true, false])).toBeCloseTo(0.5);
  });

  it('auc ranks right answers above wrong ones', () => {
    expect(auc([pt(0.9, true), pt(0.1, false)])).toBe(1);
    expect(auc([pt(0.1, true), pt(0.9, false)])).toBe(0);
    expect(auc([pt(0.5, true), pt(0.5, false)])).toBe(0.5);
  });

  it('accuracy at coverage takes the most confident rows first', () => {
    const curve = accuracyAtCoverage([pt(0.9, true), pt(0.8, true), pt(0.3, false), pt(0.2, false)], [0.5, 1]);
    expect(curve).toEqual([
      { coverage: 0.5, accuracy: 1 },
      { coverage: 1, accuracy: 0.5 },
    ]);
  });
});

describe('scoring rules', () => {
  const choice = (c: string, probs: Record<string, number>) => ({ type: 'choice', choice: c, probabilities: probs, confidence: 1 });

  it('triage: score is the chosen option probability; cannot_tell scores 0 and counts as wrong', () => {
    expect(triagePoint(choice('a', { a: 0.8 }), 'a')).toEqual({ score: 0.8, p: 0.8, correct: true });
    expect(triagePoint(choice('a', { a: 0.8 }), 'b')).toEqual({ score: 0.8, p: 0.8, correct: false });
    expect(triagePoint(choice('cannot_tell', { cannot_tell: 0.9 }), 'a')).toEqual({ score: 0, p: 0, correct: false });
  });

  it('verify: only a "supported" verdict can be accepted, p(supported) is the calibration probability', () => {
    expect(verifyPoint(choice('supported', { supported: 0.9 }), true)).toEqual({ score: 0.9, p: 0.9, correct: true });
    expect(verifyPoint(choice('cannot_tell', { supported: 0.4, cannot_tell: 0.5 }), true)).toEqual({ score: 0, p: 0.4, correct: true });
  });
});

describe('bench configs', () => {
  it('expands aliases and a+b mixes', () => {
    expect(parseConfigs('jev,jev+clef,some/model')).toEqual([
      { name: 'jev', triage: 'typesafe/jev-1.14', verify: 'typesafe/jev-1.14' },
      { name: 'jev+clef', triage: 'typesafe/jev-1.14', verify: 'cloudflare/clef' },
      { name: 'some/model', triage: 'some/model', verify: 'some/model' },
    ]);
  });
});
