import type { RunState } from './ledger.ts';

// Numbers shared by the bench report and the local UI, so the two can never disagree.

export const SPEND_STAGES = ['triage', 'write1', 'verify1', 'write2', 'verify2'] as const;
export type SpendStage = (typeof SPEND_STAGES)[number];
export type StageSpend = Record<SpendStage | 'total', number>;

/**
 * Money spent per stage, in USD. A batch counts the provider-reported total when there is one,
 * otherwise the sum of its rows collected so far (the same rule `replay` uses for `spentUsd`).
 * `total` is the ledger's `spentUsd`, which counts a batch only once it has finished.
 */
export function spendByStage(st: RunState): StageSpend {
  const cost: StageSpend = { triage: 0, write1: 0, verify1: 0, write2: 0, verify2: 0, total: 0 };
  for (const d of st.triage.values()) cost.triage += d.costUsd;
  for (const d of st.verify.values()) cost[d.round === 1 ? 'verify1' : 'verify2'] += d.costUsd;
  for (const b of st.batches.values()) {
    cost[b.round === 1 ? 'write1' : 'write2'] += b.reportedCostUsd ?? b.resultCostUsd;
  }
  cost.total = st.spentUsd;
  return cost;
}

/** Median of a list of numbers (need not be sorted); NaN for an empty list. */
export function median(values: number[]): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Wall-clock of a finished batch, submit to finish, in ms. */
export function batchDurationMs(b: { at: string; finishedAt?: string }): number | null {
  if (!b.finishedAt) return null;
  return Date.parse(b.finishedAt) - Date.parse(b.at);
}
