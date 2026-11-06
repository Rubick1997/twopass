// Threshold fitting and calibration metrics. Pure functions over (score, correct) pairs.
//
// - A threshold is fitted per decision model and stage on a held-out labeled slice: the lowest score
//   cut that keeps precision at or above a target while accepting as many rows as possible.
// - Isotonic regression (pool adjacent violators) maps raw probabilities to calibrated ones. It is
//   monotone, so a threshold on the raw score selects the same rows as one on the calibrated score.
// - Calibrated ECE is measured out of sample (2-fold), otherwise isotonic would look perfect.

export interface Point {
  /** Score used to accept: the probability of the chosen answer (0 when the model abstained). */
  score: number;
  /** Probability the model gave that the answer is correct, for calibration metrics. */
  p: number;
  correct: boolean;
}

/** Above 1: no score can reach it, so the stage never auto-accepts. */
export const NEVER = 1.01;

export interface ThresholdFit {
  threshold: number;
  accepted: number;
  precision: number;
  /** Share of all rows accepted. */
  coverage: number;
  /** Share of the correct rows that were accepted. */
  recall: number;
}

export function fitThreshold(points: Point[], target: number, minAccepted = 10): ThresholdFit {
  const sorted = [...points].sort((a, b) => b.score - a.score);
  const totalCorrect = points.filter((p) => p.correct).length;
  let best: ThresholdFit = { threshold: NEVER, accepted: 0, precision: NaN, coverage: 0, recall: 0 };
  let correct = 0;
  sorted.forEach((pt, i) => {
    if (pt.correct) correct++;
    const next = sorted[i + 1];
    if (next && next.score === pt.score) return; // can only cut between distinct scores
    const accepted = i + 1;
    const precision = correct / accepted;
    if (pt.score <= 0 || accepted < minAccepted || precision < target) return;
    if (accepted > best.accepted) {
      best = {
        threshold: pt.score,
        accepted,
        precision,
        coverage: accepted / points.length,
        recall: totalCorrect ? correct / totalCorrect : 0,
      };
    }
  });
  return best;
}

export interface IsoStep {
  /** Upper end of the score range this step covers. */
  x: number;
  y: number;
}

/** Pool-adjacent-violators isotonic regression of correct ~ p. */
export function fitIsotonic(points: Pick<Point, 'p' | 'correct'>[]): IsoStep[] {
  const sorted = [...points].sort((a, b) => a.p - b.p);
  const blocks: Array<{ x: number; sum: number; n: number }> = [];
  for (const pt of sorted) {
    const last = blocks[blocks.length - 1];
    if (last && last.x === pt.p) {
      // Equal scores must share one calibrated value (Jev returns p = 1.0 for many rows).
      last.sum += pt.correct ? 1 : 0;
      last.n++;
    } else {
      blocks.push({ x: pt.p, sum: pt.correct ? 1 : 0, n: 1 });
    }
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1]!;
      const a = blocks[blocks.length - 2]!;
      if (a.sum / a.n <= b.sum / b.n) break;
      blocks.splice(blocks.length - 2, 2, { x: b.x, sum: a.sum + b.sum, n: a.n + b.n });
    }
  }
  return blocks.map((b) => ({ x: b.x, y: b.sum / b.n }));
}

export function applyIsotonic(steps: IsoStep[], p: number): number {
  if (!steps.length) return p;
  for (const s of steps) if (p <= s.x) return s.y;
  return steps[steps.length - 1]!.y;
}

export interface Bin {
  lo: number;
  hi: number;
  n: number;
  meanP: number;
  accuracy: number;
}

export function reliabilityBins(ps: number[], ys: boolean[], bins = 10): Bin[] {
  const out: Bin[] = [];
  for (let b = 0; b < bins; b++) {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    const idx = ps.map((_, i) => i).filter((i) => Math.min(Math.floor(ps[i]! * bins), bins - 1) === b);
    if (!idx.length) {
      out.push({ lo, hi, n: 0, meanP: NaN, accuracy: NaN });
      continue;
    }
    const meanP = idx.reduce((s, i) => s + ps[i]!, 0) / idx.length;
    const accuracy = idx.filter((i) => ys[i]).length / idx.length;
    out.push({ lo, hi, n: idx.length, meanP, accuracy });
  }
  return out;
}

export function ece(ps: number[], ys: boolean[], bins = 10): number {
  return reliabilityBins(ps, ys, bins).reduce((s, b) => (b.n ? s + (b.n / ps.length) * Math.abs(b.meanP - b.accuracy) : s), 0);
}

export function brier(ps: number[], ys: boolean[]): number {
  return ps.reduce((s, p, i) => s + (p - (ys[i] ? 1 : 0)) ** 2, 0) / ps.length;
}

/** Probability that a random correct row scores above a random wrong one. */
export function auc(points: Pick<Point, 'p' | 'correct'>[]): number {
  const pos = points.filter((x) => x.correct).map((x) => x.p);
  const neg = points.filter((x) => !x.correct).map((x) => x.p);
  if (!pos.length || !neg.length) return NaN;
  let s = 0;
  for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0;
  return s / (pos.length * neg.length);
}

/** Accuracy of the top-scoring share of rows, for each coverage level. */
export function accuracyAtCoverage(points: Point[], levels = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]) {
  const sorted = [...points].sort((a, b) => b.score - a.score);
  return levels.map((coverage) => {
    const k = Math.max(1, Math.round(coverage * sorted.length));
    const top = sorted.slice(0, k);
    return { coverage, accuracy: top.filter((p) => p.correct).length / k };
  });
}

/** Seeded shuffle, so cross-validation folds are the same on every run. */
function shuffled<T>(items: T[], seed: number): T[] {
  const copy = [...items];
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

export interface StageCalibration {
  n: number;
  correct: number;
  auc: number;
  brierRaw: number;
  brierCalibrated: number;
  eceRaw: number;
  /** Out of sample: isotonic fitted on one half, measured on the other, averaged over both. */
  eceCalibrated: number;
  fit: ThresholdFit;
  reliabilityRaw: Bin[];
  reliabilityCalibrated: Bin[];
  accuracyAtCoverage: Array<{ coverage: number; accuracy: number }>;
  isotonic: IsoStep[];
}

export function calibrateStage(points: Point[], target: number, seed = 7): StageCalibration {
  const ps = points.map((p) => p.p);
  const ys = points.map((p) => p.correct);

  // 2-fold out-of-sample calibrated probabilities
  const order = shuffled(points.map((_, i) => i), seed);
  const half = Math.floor(order.length / 2);
  const folds = [order.slice(0, half), order.slice(half)];
  const calibrated = new Array<number>(points.length);
  folds.forEach((evalIdx, f) => {
    const fitIdx = folds[1 - f]!;
    const steps = fitIsotonic(fitIdx.map((i) => points[i]!));
    for (const i of evalIdx) calibrated[i] = applyIsotonic(steps, points[i]!.p);
  });

  return {
    n: points.length,
    correct: ys.filter(Boolean).length,
    auc: auc(points),
    brierRaw: brier(ps, ys),
    brierCalibrated: brier(calibrated, ys),
    eceRaw: ece(ps, ys),
    eceCalibrated: ece(calibrated, ys),
    fit: fitThreshold(points, target),
    reliabilityRaw: reliabilityBins(ps, ys),
    reliabilityCalibrated: reliabilityBins(calibrated, ys),
    accuracyAtCoverage: accuracyAtCoverage(points),
    isotonic: fitIsotonic(points),
  };
}
