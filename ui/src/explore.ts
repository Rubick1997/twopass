import type { ExploreCostPer1k, ExploreRow } from '../../src/ui/api-types.ts';

// The threshold replay behind the results explorer. Pure, so the browser runs it on every slider move.
// It must stay equivalent to `computeOutcomes` in src/pipeline.ts on a `collect` run (every row went
// through every stage): test/ui-explore.test.ts replays a fixture ledger both ways and compares.

/** A threshold of 1.01 means the stage never auto-accepts (NEVER in src/task.ts). */
export const NEVER = 1.01;

export interface Controller {
  /** Decision model that triages (round 0). */
  triage: string;
  /** Decision model that verifies the writers' answers (rounds 1 and 2). */
  verify: string;
}

export interface Thresholds {
  t0: number;
  t1: number;
  t2: number;
}

export interface ReplayResult {
  n: number;
  accepted: number;
  acceptedCorrect: number;
  flagged: number;
  /** Rows accepted by triage alone. */
  round0: number;
  acceptedShare: number;
  round0Share: number;
  /** Correct share of the accepted rows; null when nothing was accepted. */
  precision: number | null;
  flaggedShare: number;
  /** (correct accepted + correct flagged) / n, a flagged row answering with the round-2 writer's answer. */
  accuracyNoHuman: number;
  costPer1k: ExploreCostPer1k;
}

export function replay(rows: readonly ExploreRow[], c: Controller, t: Thresholds): ReplayResult {
  let accepted = 0;
  let acceptedCorrect = 0;
  let flagged = 0;
  let flaggedCorrect = 0;
  let round0 = 0;
  const cost = { triage: 0, write1: 0, verify1: 0, write2: 0, verify2: 0 };

  for (const r of rows) {
    const tri = r.triage[c.triage];
    cost.triage += tri?.usd ?? 0;
    if (tri && tri.p !== null && tri.p >= t.t0) {
      accepted++;
      round0++;
      if (tri.correct) acceptedCorrect++;
      continue;
    }
    const v1 = r.verify1[c.verify];
    cost.write1 += r.w1.usd;
    cost.verify1 += v1?.usd ?? 0;
    if (r.w1.correct !== null && v1 && v1.p !== null && v1.p >= t.t1) {
      accepted++;
      if (r.w1.correct) acceptedCorrect++;
      continue;
    }
    const v2 = r.verify2[c.verify];
    cost.write2 += r.w2.usd;
    cost.verify2 += v2?.usd ?? 0;
    if (r.w2.correct !== null && v2 && v2.p !== null && v2.p >= t.t2) {
      accepted++;
      if (r.w2.correct) acceptedCorrect++;
      continue;
    }
    flagged++;
    if (r.w2.correct === true) flaggedCorrect++;
  }

  const n = rows.length;
  const per1k = (x: number) => (n ? (1000 * x) / n : 0);
  const costPer1k: ExploreCostPer1k = {
    triage: per1k(cost.triage),
    write1: per1k(cost.write1),
    verify1: per1k(cost.verify1),
    write2: per1k(cost.write2),
    verify2: per1k(cost.verify2),
    total: 0,
  };
  costPer1k.total = costPer1k.triage + costPer1k.write1 + costPer1k.verify1 + costPer1k.write2 + costPer1k.verify2;
  return {
    n,
    accepted,
    acceptedCorrect,
    flagged,
    round0,
    acceptedShare: n ? accepted / n : 0,
    round0Share: n ? round0 / n : 0,
    precision: accepted ? acceptedCorrect / accepted : null,
    flaggedShare: n ? flagged / n : 0,
    accuracyNoHuman: n ? (acceptedCorrect + flaggedCorrect) / n : 0,
    costPer1k,
  };
}

export interface CurvePoint {
  t: number;
  acceptedShare: number;
  precision: number | null;
}

/** Sweeps one threshold t = t0 = t1 = t2 and returns accepted share and precision at each step. */
export function coverageCurve(rows: readonly ExploreRow[], c: Controller, from = 0.5, to = 1.0, step = 0.01): CurvePoint[] {
  const steps = Math.round((to - from) / step);
  const out: CurvePoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = Math.round((from + i * step) * 1e6) / 1e6;
    const r = replay(rows, c, { t0: t, t1: t, t2: t });
    out.push({ t, acceptedShare: r.acceptedShare, precision: r.precision });
  }
  return out;
}

/** Controllers worth offering: every triage model with every verify model that has any answers. */
export function controllersFor(rows: readonly ExploreRow[], models: readonly string[]): Controller[] {
  const has = (pick: (r: ExploreRow) => Record<string, unknown>) => models.filter((m) => rows.some((r) => m in pick(r)));
  const triage = has((r) => r.triage);
  const verify = has((r) => ({ ...r.verify1, ...r.verify2 }));
  return triage.flatMap((t) => verify.map((v) => ({ triage: t, verify: v })));
}
