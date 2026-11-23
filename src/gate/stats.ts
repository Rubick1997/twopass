import { createHash } from 'node:crypto';

// Small, pure statistics for the gate. Everything random is seeded, so a gate decision is reproducible.

/** mulberry32: the same generator `calibrate.ts` and `run.ts` use for seeded shuffles. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable, seeded order key for an ID: sorting by it is a seeded shuffle that doesn't depend on input order. */
export const orderKey = (seed: number | string, id: string): string => createHash('sha256').update(`${seed}\u0000${id}`).digest('hex');

export function seededOrder<T>(items: T[], seed: number | string, id: (x: T) => string): T[] {
  const keyed = items.map((x) => ({ x, k: orderKey(seed, id(x)) }));
  keyed.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  return keyed.map((e) => e.x);
}

export interface Interval {
  /** k / n, or NaN when n = 0. */
  point: number;
  lower: number;
  upper: number;
  k: number;
  n: number;
}

/** Wilson score interval for a proportion (95% by default). With n = 0 the bounds are 0 and 1. */
export function wilson(k: number, n: number, z = 1.959963984540054): Interval {
  if (n === 0) return { point: NaN, lower: 0, upper: 1, k, n };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { point: p, lower: Math.max(0, centre - half), upper: Math.min(1, centre + half), k, n };
}

/**
 * Paired bootstrap of the mean difference `head[i] - base[i]` (values 0/1 or any number).
 * Returns the percentile interval at `level` (95% by default). Seeded, so the same inputs give the same bounds.
 */
export function bootstrapMeanDelta(base: number[], head: number[], o: { resamples?: number; seed?: number; level?: number } = {}): { delta: number; lower: number; upper: number } {
  if (base.length !== head.length) throw new Error('bootstrap: paired arrays differ in length');
  const n = base.length;
  if (!n) return { delta: 0, lower: 0, upper: 0 };
  const d = base.map((b, i) => head[i]! - b);
  const delta = d.reduce((a, b) => a + b, 0) / n;
  const B = o.resamples ?? 2000;
  const rand = rng(o.seed ?? 42);
  const means = new Float64Array(B);
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += d[Math.floor(rand() * n)]!;
    means[b] = s / n;
  }
  means.sort();
  const alpha = (1 - (o.level ?? 0.95)) / 2;
  const at = (q: number) => means[Math.min(B - 1, Math.max(0, Math.floor(q * B)))]!;
  return { delta, lower: at(alpha), upper: at(1 - alpha) };
}

export const pct = (x: number, digits = 1): string => (Number.isFinite(x) ? `${(100 * x).toFixed(digits)}%` : 'n/a');
