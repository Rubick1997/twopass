import { isCorrect, type Comparison } from './compare.ts';
import { labelLimit, type NoiseFile } from './noise.ts';
import { bootstrapMeanDelta } from './stats.ts';

// The three gates, run on the same comparison. Only the enforced one (G3 by default) decides the exit code;
// the others are reported as "what they would have said".
//
// G1  aggregate threshold:   head accuracy ≥ lowest of the noise runs − 0.5 points
// G2  aggregate paired delta: bootstrap 95% lower bound of (head − base) accuracy ≥ −tolerance
// G3  the promise:            (1) head accepted-precision Wilson lower bound ≥ target − noise allowance
//                             (2) no label loses more rows (net right→wrong) than unchanged main does, min 2
//                             (3) confident-wrong count doesn't rise more than unchanged main moves

export type GateId = 'g1' | 'g2' | 'g3';

export interface GateReason {
  check: string;
  pass: boolean;
  detail: string;
}

export interface GateOutcome {
  id: GateId;
  name: string;
  pass: boolean;
  reasons: GateReason[];
}

export interface GateOptions {
  noise?: NoiseFile;
  g2Tolerance: number;
  seed?: number;
  resamples?: number;
}

const pts = (x: number) => `${(100 * x).toFixed(1)}%`;

export function gateG1(c: Comparison, o: GateOptions): GateOutcome {
  const floor = (o.noise ? o.noise.metrics.accuracy.min : c.base.accuracy) - 0.005;
  const pass = c.head.accuracy >= floor;
  return {
    id: 'g1',
    name: 'G1 aggregate threshold',
    pass,
    reasons: [
      {
        check: 'accuracy',
        pass,
        detail: `head accuracy ${pts(c.head.accuracy)} vs floor ${pts(floor)} (${o.noise ? 'lowest noise run' : 'base, no noise file'} − 0.5 pts)`,
      },
    ],
  };
}

export function gateG2(c: Comparison, o: GateOptions): GateOutcome {
  const b = bootstrapMeanDelta(
    c.pairs.map((p) => (isCorrect(p.base) ? 1 : 0)),
    c.pairs.map((p) => (isCorrect(p.head) ? 1 : 0)),
    { seed: o.seed ?? 42, resamples: o.resamples ?? 2000 },
  );
  const pass = b.lower >= -o.g2Tolerance;
  return {
    id: 'g2',
    name: 'G2 aggregate paired delta',
    pass,
    reasons: [
      {
        check: 'accuracy delta',
        pass,
        detail: `head − base ${b.delta >= 0 ? '+' : ''}${(100 * b.delta).toFixed(1)} pts, 95% CI [${(100 * b.lower).toFixed(1)}, ${(100 * b.upper).toFixed(1)}]; lower bound must be ≥ −${(100 * o.g2Tolerance).toFixed(1)}`,
      },
    ],
  };
}

/** Allowances G3 takes from the noise file (0 without one). */
export function noiseAllowances(noise: NoiseFile | undefined) {
  return {
    acceptedLower: noise ? noise.metrics.acceptedLower.spread : 0,
    confidentWrong: noise ? noise.metrics.confidentWrong.spread : 0,
  };
}

export function gateG3(c: Comparison, o: GateOptions): GateOutcome {
  const allow = noiseAllowances(o.noise);
  const target = c.promise;
  const lower = c.head.acceptedPrecision.lower;
  const promiseOk = lower >= target - allow.acceptedLower;

  const broken = c.labels.filter((l) => l.netLoss > labelLimit(o.noise, l.label));
  const cwRise = c.head.confidentWrong - c.base.confidentWrong;
  const cwOk = cwRise <= allow.confidentWrong;

  return {
    id: 'g3',
    name: 'G3 promise gate',
    pass: promiseOk && !broken.length && cwOk,
    reasons: [
      {
        check: 'promise',
        pass: promiseOk,
        detail:
          `auto-accepted rows ≥${pts(target)} right: lower bound ${pts(lower)} (${c.head.acceptedPrecision.k}/${c.head.acceptedPrecision.n} right` +
          `${allow.acceptedLower ? `, noise allowance ${(100 * allow.acceptedLower).toFixed(1)} pts` : ''})`,
      },
      {
        check: 'labels',
        pass: !broken.length,
        detail: broken.length
          ? `${broken.length} label(s) lost more rows than unchanged main does: ` +
            broken.map((l) => `${l.label} −${l.netLoss} (limit ${labelLimit(o.noise, l.label)})`).join(', ')
          : 'no label lost more rows than unchanged main does',
      },
      {
        check: 'confident-wrong',
        pass: cwOk,
        detail: `auto-accepted but wrong: ${c.base.confidentWrong} → ${c.head.confidentWrong} (${cwRise >= 0 ? '+' : ''}${cwRise}; allowance +${allow.confidentWrong})`,
      },
    ],
  };
}

export function runGates(c: Comparison, o: GateOptions): Record<GateId, GateOutcome> {
  return { g1: gateG1(c, o), g2: gateG2(c, o), g3: gateG3(c, o) };
}
