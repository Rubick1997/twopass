import { compareResults, sideMetrics } from './compare.ts';
import type { GateResult } from './result.ts';

// N result files from unchanged `main` → how much every metric moves when nothing changed.
// The checkers are not deterministic (Phase 0: Clef's confidence moved up to 0.29 on identical input),
// so every gate limit is "beyond what unchanged main does", never "any change at all".

export interface MetricSpread {
  values: number[];
  min: number;
  max: number;
  /** max − min over the runs. */
  spread: number;
}

export interface NoiseFile {
  kind: 'twopass-gate-noise';
  version: 1;
  task: string;
  runs: number;
  routingKey: string;
  createdAt: string;
  refs: string[];
  metrics: Record<'accuracy' | 'acceptedPrecision' | 'acceptedLower' | 'acceptShare' | 'confidentWrong' | 'costPer1k', MetricSpread>;
  /** Per label, the largest net right→wrong loss between any two runs (ordered pairs), and the row count. */
  perLabel: Record<string, { n: number; maxNetLoss: number }>;
  /** Over all pairs of runs: the largest number of rows whose answer differed, and whose accept decision differed. */
  maxAnswerFlips: number;
  maxAcceptFlips: number;
  /** Share of rows with the same answer and status in every run. 1 means the pipeline was deterministic here. */
  identicalShare: number;
}

const spread = (values: number[]): MetricSpread => {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { values, min, max, spread: max - min };
};

export function buildNoise(results: GateResult[]): NoiseFile {
  if (results.length < 2) throw new Error(`Noise needs at least 2 runs of unchanged main, got ${results.length}`);
  const first = results[0]!;
  for (const r of results) {
    if (r.task !== first.task) throw new Error(`Noise runs are for different tasks (${first.task}, ${r.task})`);
    if (r.routingKey !== first.routingKey) throw new Error(`Noise runs used different routing:\n  ${first.routingKey}\n  ${r.routingKey}`);
    if (JSON.stringify(r.thresholds) !== JSON.stringify(first.thresholds)) throw new Error('Noise runs used different thresholds');
  }
  // Only rows every run has.
  const common = results.reduce((ids, r) => new Set(r.rows.filter((x) => ids.has(x.id)).map((x) => x.id)), new Set(first.rows.map((x) => x.id)));
  const sides = results.map((r) => sideMetrics(r.rows.filter((x) => common.has(x.id)), r.cost.listUsd, r.rows.length));
  const perLabel: NoiseFile['perLabel'] = {};
  let maxAnswerFlips = 0;
  let maxAcceptFlips = 0;
  for (let i = 0; i < results.length; i++) {
    for (let j = 0; j < results.length; j++) {
      if (i === j) continue;
      const c = compareResults(results[i]!, results[j]!);
      maxAnswerFlips = Math.max(maxAnswerFlips, c.answerFlips);
      maxAcceptFlips = Math.max(maxAcceptFlips, c.pairs.filter((p) => (p.base.status === 'accepted') !== (p.head.status === 'accepted')).length);
      for (const l of c.labels) {
        const cur = perLabel[l.label] ?? { n: l.n, maxNetLoss: 0 };
        cur.maxNetLoss = Math.max(cur.maxNetLoss, l.netLoss);
        perLabel[l.label] = cur;
      }
    }
  }
  const byId = results.map((r) => new Map(r.rows.map((x) => [x.id, x])));
  const identical = [...common].filter((id) => {
    const rows = byId.map((m) => m.get(id)!);
    return rows.every((x) => x.answer === rows[0]!.answer && x.status === rows[0]!.status);
  }).length;

  return {
    kind: 'twopass-gate-noise',
    version: 1,
    task: first.task,
    runs: results.length,
    routingKey: first.routingKey,
    createdAt: new Date().toISOString(),
    refs: results.map((r) => `${r.ref}${r.gitSha ? `@${r.gitSha.slice(0, 7)}` : ''}`),
    metrics: {
      accuracy: spread(sides.map((s) => s.accuracy)),
      acceptedPrecision: spread(sides.map((s) => s.acceptedPrecision.point)),
      acceptedLower: spread(sides.map((s) => s.acceptedPrecision.lower)),
      acceptShare: spread(sides.map((s) => s.acceptShare)),
      confidentWrong: spread(sides.map((s) => s.confidentWrong)),
      costPer1k: spread(sides.map((s) => s.costPer1k)),
    },
    perLabel,
    maxAnswerFlips,
    maxAcceptFlips,
    identicalShare: common.size ? identical / common.size : NaN,
  };
}

/** The per-label limit G3 uses: the noise maximum, but never below `floor` rows. */
export const labelLimit = (noise: NoiseFile | undefined, label: string, floor = 2): number => Math.max(floor, noise?.perLabel[label]?.maxNetLoss ?? 0);
