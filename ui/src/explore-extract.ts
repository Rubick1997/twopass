import { fitThreshold, NEVER, type Point } from '../../src/calibrate.ts';
import type { ChoiceAnswer } from '../../src/decide/model.ts';
import type { ExtractChoice, ExtractSlot } from '../../src/ui/api-types.ts';
import { verifyOutcome } from '../../src/verdict.ts';

// The replay behind the extraction explorer's "Try it" tab. Pure, so the browser runs it on every slider move.
// It must stay equivalent to `computeFieldOutcomes` (src/extract/outcomes.ts) on a collect-style ledger, and its
// fitted thresholds must equal what `buildCalibration` stores (verify1, verify2Conditional): test/ui-explore-extract.test.ts.

export { NEVER };

export type Pipeline = 'simple' | 'full';

/** What `verifyOutcome` reads, rebuilt from the reduced answer. A missing answer is cannot_tell with p = 0. */
const asAnswer = (a: ExtractChoice | null | undefined): ChoiceAnswer | undefined =>
  a ? { type: 'choice', choice: a.choice, probabilities: { supported: a.p }, confidence: a.p } : undefined;

/** The point `verifyPoint` (src/score.ts) makes of an answer: the score is p(supported) only when the checker chose "supported". */
const point = (a: ExtractChoice, correct: boolean): Point => ({ score: a.choice === 'supported' ? a.p : 0, p: a.p, correct });

const answers = (s: ExtractSlot, checker: string) => s.a[checker] ?? { r1: null, r2: null };

export interface Thresholds {
  t1: number;
  /** Fitted on the slots round 1 did not accept at t1 (the conditional fit the bench uses). */
  t2: number;
}

/** t1 on every round-1 point of the checker; t2 on the round-2 points of the slots round 1 does not accept at t1. */
export function fitThresholds(slots: readonly ExtractSlot[], checker: string, target: number): Thresholds {
  const p1: Point[] = [];
  for (const s of slots) {
    const a = answers(s, checker).r1;
    if (a) p1.push(point(a, s.correct1));
  }
  const t1 = fitThreshold(p1, target).threshold;
  const p2: Point[] = [];
  for (const s of slots) {
    const { r1, r2 } = answers(s, checker);
    if (!r2 || s.correct2 === null) continue;
    if (!verifyOutcome(asAnswer(r1), t1).accepted) p2.push(point(r2, s.correct2));
  }
  return { t1, t2: fitThreshold(p2, target).threshold };
}

export interface ReplayResult {
  n: number;
  accepted: number;
  acceptedCorrect: number;
  flagged: number;
  /** Flagged fields where the pipeline's own value (round 2's when it has one, in the full pipeline) is right. */
  flaggedCorrect: number;
  /** Correct share of the accepted fields; null when nothing was accepted. */
  precision: number | null;
  acceptedShare: number;
  flaggedShare: number;
  /** Accepted and wrong, per 1,000 fields. */
  confidentWrongPer1000: number;
  t1: number;
  /** Null for the simple pipeline, which has no round 2. */
  t2: number | null;
}

/**
 * simple: a field round 1 accepts at t1 is accepted; any other goes to a person.
 * full: a field round 1 does not accept goes to round 2 and is accepted if round 2 accepts it at t2; otherwise it goes
 * to a person. A field with no usable round 2 stays with round 1's value.
 */
export function replayExtract(slots: readonly ExtractSlot[], checker: string, target: number, pipeline: Pipeline): ReplayResult {
  return replayAt(slots, checker, fitThresholds(slots, checker, target), pipeline);
}

/** The same replay under thresholds given by hand (the tests compare it with `computeFieldOutcomes` on a grid). */
export function replayAt(slots: readonly ExtractSlot[], checker: string, t: Thresholds, pipeline: Pipeline): ReplayResult {
  let accepted = 0;
  let acceptedCorrect = 0;
  let flagged = 0;
  let flaggedCorrect = 0;
  for (const s of slots) {
    const { r1, r2 } = answers(s, checker);
    if (verifyOutcome(asAnswer(r1), t.t1).accepted) {
      accepted++;
      if (s.correct1) acceptedCorrect++;
      continue;
    }
    if (pipeline === 'full' && s.correct2 !== null) {
      if (verifyOutcome(asAnswer(r2), t.t2).accepted) {
        accepted++;
        if (s.correct2) acceptedCorrect++;
      } else {
        flagged++;
        if (s.correct2) flaggedCorrect++;
      }
      continue;
    }
    flagged++;
    if (s.correct1) flaggedCorrect++;
  }
  const n = slots.length;
  return {
    n,
    accepted,
    acceptedCorrect,
    flagged,
    flaggedCorrect,
    precision: accepted ? acceptedCorrect / accepted : null,
    acceptedShare: n ? accepted / n : 0,
    flaggedShare: n ? flagged / n : 0,
    confidentWrongPer1000: n ? (1000 * (accepted - acceptedCorrect)) / n : 0,
    t1: t.t1,
    t2: pipeline === 'full' ? t.t2 : null,
  };
}
