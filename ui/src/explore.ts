import { fitThreshold, type Point } from '../../src/calibrate.ts';
import type { ExploreCostPer1k, ExploreRow } from '../../src/ui/api-types.ts';
import { formatPct } from './format.ts';

// The threshold replay behind the results explorer. Pure, so the browser runs it on every slider move.
// It must stay equivalent to `computeOutcomes` in src/pipeline.ts on a `collect` run (every row went
// through every stage): test/ui-explore.test.ts replays a fixture ledger both ways and compares.

/** A threshold of 1.01 means the stage never auto-accepts (NEVER in src/task.ts and src/calibrate.ts). */
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

// ---------------------------------------------------------------- refit (the "how accurate" slider)

export type Stage = 'triage' | 'verify1' | 'verify2';

/**
 * The (score, correct) points `scoreRun` in src/score.ts builds for one decision model and stage, read off the
 * compact rows: triage scores the chosen label's probability (0 when the model abstained) and is correct when that
 * label is the true one; a verify stage scores p(supported) when the model said "supported" (0 otherwise), is
 * correct when the writer's answer was, and exists only for rows whose writer answer parsed and was judged.
 * `p` is the score here: the calibration metrics that need the raw probability are not computed in the browser.
 */
export function stagePoints(rows: readonly ExploreRow[], model: string, stage: Stage): Point[] {
  const out: Point[] = [];
  for (const r of rows) {
    if (stage === 'triage') {
      const e = r.triage[model];
      if (!e) continue;
      const s = e.p ?? 0;
      out.push({ score: s, p: s, correct: e.correct });
    } else {
      const w = stage === 'verify1' ? r.w1 : r.w2;
      const e = (stage === 'verify1' ? r.verify1 : r.verify2)[model];
      if (w.correct === null || !e) continue;
      const s = e.p ?? 0;
      out.push({ score: s, p: s, correct: w.correct });
    }
  }
  return out;
}

/** Thresholds `calibrate` would fit for this controller at `target` precision (NEVER where no cut reaches it). */
export function refitThresholds(rows: readonly ExploreRow[], c: Controller, target: number): Thresholds {
  return {
    t0: fitThreshold(stagePoints(rows, c.triage, 'triage'), target).threshold,
    t1: fitThreshold(stagePoints(rows, c.verify, 'verify1'), target).threshold,
    t2: fitThreshold(stagePoints(rows, c.verify, 'verify2'), target).threshold,
  };
}

// ---------------------------------------------------------------- the 100-row waffle

export interface WaffleCounts {
  /** Answered automatically and right. */
  right: number;
  /** Answered automatically but wrong. */
  wrong: number;
  /** Sent to the reader to check. */
  check: number;
}

/** Rounds shares (summing to 1) to whole counts out of `total` that always sum to `total` (largest remainder). */
export function roundToTotal(shares: readonly number[], total = 100): number[] {
  const exact = shares.map((s) => Math.max(0, s) * total);
  const out = exact.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i]!++;
    left--;
  }
  return out;
}

export function waffleCounts(r: Pick<ReplayResult, 'n' | 'accepted' | 'acceptedCorrect' | 'flagged'>): WaffleCounts {
  if (!r.n) return { right: 0, wrong: 0, check: 100 };
  const [right, wrong, check] = roundToTotal([r.acceptedCorrect / r.n, (r.accepted - r.acceptedCorrect) / r.n, r.flagged / r.n]);
  return { right: right!, wrong: wrong!, check: check! };
}

/**
 * The one sentence next to the waffle. Counts are the waffle's, so the two agree; a share that rounds to no
 * square but is not zero is said to be "fewer than 1".
 */
export function outcomeSentence(r: Pick<ReplayResult, 'n' | 'accepted' | 'acceptedCorrect' | 'flagged'>): string {
  const w = waffleCounts(r);
  const auto = w.right + w.wrong;
  if (!r.n) return 'No rows to replay.';
  if (auto === 0) return 'Out of every 100 rows, none are answered automatically: all 100 come to you to check.';
  const wrongShare = r.n ? (r.accepted - r.acceptedCorrect) / r.n : 0;
  const wrong = w.wrong === 0 ? (wrongShare > 0 ? 'fewer than 1 of those is wrong' : 'none of those are wrong') : w.wrong === 1 ? 'about 1 of those is wrong' : `about ${w.wrong} of those are wrong`;
  const check = w.check === 0 ? 'none come to you to check' : w.check === 1 ? '1 comes to you to check' : `${w.check} come to you to check`;
  return `Out of every 100 rows, about ${auto} ${auto === 1 ? 'is' : 'are'} answered automatically — ${wrong} — and ${check}.`;
}

// ---------------------------------------------------------------- plain names

const FRIENDLY: ReadonlyArray<readonly [string, string]> = [
  ['jev', 'Jev'],
  ['clef', 'Clef'],
  ['luna', 'Luna'],
  ['haiku', 'Haiku'],
  ['sonnet', 'Sonnet'],
  ['opus', 'Opus'],
];

/** "typesafe/jev-1.14" → "Jev", "anthropic/claude-opus-5.5:batch" → "Opus"; otherwise the part after the slash, capitalised. */
export function friendlyModel(id: string): string {
  const lower = id.toLowerCase();
  const hit = FRIENDLY.find(([k]) => lower.includes(k));
  if (hit) return hit[1];
  const tail = (id.split('/').pop() ?? id).replace(/:batch$/, '');
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}

export interface ConfigLike {
  name: string;
  triage: string | null;
  verify: string | null;
}

/** "Clef", "Jev + Clef"; the baseline: "Opus on every row" (or its name when the model is unknown). */
export function friendlyConfig(c: ConfigLike, baselineModel: string | null = null): string {
  if (c.triage && c.verify) return c.triage === c.verify ? friendlyModel(c.triage) : `${friendlyModel(c.triage)} + ${friendlyModel(c.verify)}`;
  return baselineModel ? `${friendlyModel(baselineModel)} on every row` : c.name.charAt(0).toUpperCase() + c.name.slice(1);
}

/** "Clef answers, Clef checks"; the baseline: "Opus answers every row, nothing is checked". */
export function configDescription(c: ConfigLike, baselineModel: string | null = null): string {
  if (c.triage && c.verify) return `${friendlyModel(c.triage)} answers, ${friendlyModel(c.verify)} checks`;
  return `${baselineModel ? friendlyModel(baselineModel) : 'One model'} answers every row, nothing is checked`;
}

/**
 * The configuration to highlight: of those with thresholds (not the baseline), the one that answers the most rows
 * automatically while keeping precision at or above the target; if none reaches it, the most precise one.
 */
export function bestConfig(configs: ReadonlyArray<ConfigLike & { precision: number; autoAcceptShare: number }>, target: number): string | null {
  const ours = configs.filter((c) => c.triage && c.verify);
  const onTarget = ours.filter((c) => c.precision >= target);
  const pool = onTarget.length ? onTarget : ours;
  let best: (typeof pool)[number] | undefined;
  for (const c of pool) {
    if (!best) best = c;
    else if (onTarget.length ? c.autoAcceptShare > best.autoAcceptShare : c.precision > best.precision) best = c;
  }
  return best?.name ?? null;
}

// ---------------------------------------------------------------- setup cards and cost wording

/** The stats line on a setup card. Only the automatic share: the "right" figure is in the tiles, on the same rows the sliders use. */
export function cardStats(autoAcceptShare: number): string {
  return `${formatPct(autoAcceptShare)} answered automatically`;
}

/** Visible tag after a cost figure; only when the bench's costs were recorded without prompt caching (`pricingNote` set). */
export function uncachedTag(pricingNote: string | null | undefined): string | null {
  return pricingNote ? '(uncached)' : null;
}

/** The one footnote line for every cost figure; null when `pricingNote` is not set. */
export function costFootnoteText(pricingNote: string | null | undefined): string | null {
  return pricingNote
    ? '* Costs as recorded in this benchmark, without prompt caching. Caching makes the writing steps about 85–90% cheaper, which matters most for setups that write every row, like Opus answering every row; the decision-model steps cost the same. See the README’s Cost section for cached numbers.'
    : null;
}
