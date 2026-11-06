import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'csv-stringify/sync';
import type { RunState } from './ledger.ts';
import type { RowOutcome } from './pipeline.ts';

export const OUTPUT_COLUMNS = ['answer', 'confidence', 'verdict', 'model', 'round', 'cost_usd', 'status'] as const;

export interface Summary {
  rows: number;
  accepted: number;
  acceptedRound0: number;
  rerun: number;
  flagged: number;
  pending: number;
  spentUsd: number;
  minutes: number;
  /** Only when a label column is given. */
  precision?: { correct: number; of: number };
  rounds: RoundTiming[];
}

export interface RoundTiming {
  round: 1 | 2;
  batches: number;
  medianMinutes: number;
  worstMinutes: number;
}

export function summarize(outcomes: RowOutcome[], st: RunState, labelColumn?: string): Summary {
  const accepted = outcomes.filter((o) => o.status === 'accepted');
  const summary: Summary = {
    rows: outcomes.length,
    accepted: accepted.length,
    acceptedRound0: accepted.filter((o) => o.round === 0).length,
    rerun: outcomes.filter((o) => o.round === 2).length,
    flagged: outcomes.filter((o) => o.status === 'flagged').length,
    pending: outcomes.filter((o) => o.status === 'pending').length,
    spentUsd: st.spentUsd,
    minutes: st.firstAt && st.lastAt ? (Date.parse(st.lastAt) - Date.parse(st.firstAt)) / 60_000 : 0,
    rounds: roundTimings(st),
  };
  if (labelColumn) {
    const correct = accepted.filter((o) => norm(o.answer) === norm(o.data[labelColumn] ?? '')).length;
    summary.precision = { correct, of: accepted.length };
  }
  return summary;
}

const norm = (s: string) => s.trim().toLowerCase();

function roundTimings(st: RunState): RoundTiming[] {
  return ([1, 2] as const).flatMap((round) => {
    const mins = [...st.batches.values()]
      .filter((b) => b.round === round && b.finishedAt)
      .map((b) => (Date.parse(b.finishedAt!) - Date.parse(b.at)) / 60_000)
      .sort((a, b) => a - b);
    if (!mins.length) return [];
    return [{ round, batches: mins.length, medianMinutes: median(mins), worstMinutes: mins[mins.length - 1]! }];
  });
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** e.g. "3,080 rows · 2,710 auto-accepted at 97% precision · 312 re-run · 58 need a look · $1.94 · 41 min" */
export function summaryLine(s: Summary): string {
  const n = (x: number) => x.toLocaleString('en-US');
  const precision = s.precision?.of ? ` at ${Math.round((100 * s.precision.correct) / s.precision.of)}% precision` : '';
  const parts = [
    `${n(s.rows)} rows`,
    `${n(s.accepted)} auto-accepted${precision}`,
    `${n(s.rerun)} re-run`,
    `${n(s.flagged)} need a look`,
    ...(s.pending ? [`${n(s.pending)} pending`] : []),
    `$${s.spentUsd.toFixed(2)}`,
    `${Math.round(s.minutes)} min`,
  ];
  return parts.join(' · ');
}

export function writeOutputs(runDir: string, outcomes: RowOutcome[], inputColumns: string[]): void {
  const columns = [...inputColumns.filter((c) => !(OUTPUT_COLUMNS as readonly string[]).includes(c)), ...OUTPUT_COLUMNS];
  const toRecord = (o: RowOutcome) => ({
    ...o.data,
    answer: o.answer,
    confidence: o.confidence === null ? '' : o.confidence.toFixed(4),
    verdict: o.verdict,
    model: o.model,
    round: o.status === 'pending' ? '' : String(o.round),
    cost_usd: o.costUsd.toFixed(6),
    status: o.status,
  });
  writeFileSync(join(runDir, 'enriched.csv'), stringify(outcomes.map(toRecord), { header: true, columns }));
  writeFileSync(
    join(runDir, 'review.csv'),
    stringify(outcomes.filter((o) => o.status === 'flagged').map(toRecord), { header: true, columns }),
  );
}
