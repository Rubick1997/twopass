import type { GateResult, ResultRow } from './result.ts';
import { wilson, type Interval } from './stats.ts';

// Pure: two result files → paired metrics. Labels and texts come from the files; nothing names a dataset.

export const isCorrect = (r: ResultRow): boolean => r.answer !== '' && r.answer === r.label;

export interface SideMetrics {
  n: number;
  /** Answer accuracy over every row (accepted or sent to a person); a row without an answer counts as wrong. */
  accuracy: number;
  correct: number;
  accepted: number;
  /** Auto-accepted rows that are right, with a Wilson 95% interval: the promise is about `lower`. */
  acceptedPrecision: Interval;
  /** Auto-accepted and wrong: what the promise exists to keep rare. */
  confidentWrong: number;
  acceptShare: number;
  sentToPersonShare: number;
  costPer1k: number;
}

export function sideMetrics(rows: ResultRow[], listUsd: number, totalRows: number): SideMetrics {
  const n = rows.length;
  const correct = rows.filter(isCorrect).length;
  const accepted = rows.filter((r) => r.status === 'accepted');
  const acceptedRight = accepted.filter(isCorrect).length;
  return {
    n,
    accuracy: n ? correct / n : NaN,
    correct,
    accepted: accepted.length,
    acceptedPrecision: wilson(acceptedRight, accepted.length),
    confidentWrong: accepted.length - acceptedRight,
    acceptShare: n ? accepted.length / n : NaN,
    sentToPersonShare: n ? rows.filter((r) => r.status === 'flagged').length / n : NaN,
    costPer1k: totalRows ? (listUsd / totalRows) * 1000 : NaN,
  };
}

export interface LabelDelta {
  label: string;
  n: number;
  baseAccuracy: number;
  headAccuracy: number;
  rightToWrong: number;
  wrongToRight: number;
  /** rightToWrong − wrongToRight: the label's net loss in rows. */
  netLoss: number;
  baseAcceptedWrong: number;
  headAcceptedWrong: number;
}

export interface Pair {
  base: ResultRow;
  head: ResultRow;
}

export interface Comparison {
  task: string;
  promise: number;
  base: SideMetrics;
  head: SideMetrics;
  pairs: Pair[];
  onlyBase: string[];
  onlyHead: string[];
  /** Rows whose answer differs between base and head. */
  answerFlips: number;
  rightToWrong: number;
  wrongToRight: number;
  labels: LabelDelta[];
  routing: { base: string; head: string; same: boolean };
  refs: { base: string; head: string };
}

/** Pairs rows by ID. Metrics are computed on the rows both files have, so the two sides are the same population. */
export function compareResults(base: GateResult, head: GateResult): Comparison {
  if (base.task !== head.task) throw new Error(`The files are for different tasks: ${base.task} vs ${head.task}`);
  const headById = new Map(head.rows.map((r) => [r.id, r]));
  const baseIds = new Set(base.rows.map((r) => r.id));
  const pairs: Pair[] = [];
  for (const b of base.rows) {
    const h = headById.get(b.id);
    if (h) pairs.push({ base: b, head: h });
  }
  const onlyBase = base.rows.filter((r) => !headById.has(r.id)).map((r) => r.id);
  const onlyHead = head.rows.filter((r) => !baseIds.has(r.id)).map((r) => r.id);

  const byLabel = new Map<string, Pair[]>();
  for (const p of pairs) {
    const list = byLabel.get(p.base.label) ?? [];
    list.push(p);
    byLabel.set(p.base.label, list);
  }
  const labels: LabelDelta[] = [...byLabel.entries()]
    .map(([label, ps]) => {
      const rw = ps.filter((p) => isCorrect(p.base) && !isCorrect(p.head)).length;
      const wr = ps.filter((p) => !isCorrect(p.base) && isCorrect(p.head)).length;
      const aw = (r: ResultRow) => r.status === 'accepted' && !isCorrect(r);
      return {
        label,
        n: ps.length,
        baseAccuracy: ps.filter((p) => isCorrect(p.base)).length / ps.length,
        headAccuracy: ps.filter((p) => isCorrect(p.head)).length / ps.length,
        rightToWrong: rw,
        wrongToRight: wr,
        netLoss: rw - wr,
        baseAcceptedWrong: ps.filter((p) => aw(p.base)).length,
        headAcceptedWrong: ps.filter((p) => aw(p.head)).length,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  return {
    task: base.task,
    promise: head.promise.acceptedPrecision,
    base: sideMetrics(pairs.map((p) => p.base), base.cost.listUsd, base.rows.length),
    head: sideMetrics(pairs.map((p) => p.head), head.cost.listUsd, head.rows.length),
    pairs,
    onlyBase,
    onlyHead,
    answerFlips: pairs.filter((p) => p.base.answer !== p.head.answer).length,
    rightToWrong: pairs.filter((p) => isCorrect(p.base) && !isCorrect(p.head)).length,
    wrongToRight: pairs.filter((p) => !isCorrect(p.base) && isCorrect(p.head)).length,
    labels,
    routing: { base: base.routingKey, head: head.routingKey, same: base.routingKey === head.routingKey },
    refs: { base: base.ref, head: head.ref },
  };
}
