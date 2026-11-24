import { NEVER } from '../calibrate.ts';
import type { Thresholds } from '../task.ts';
import { fitOnRows, hasCheckerPoints, replayRows, splitRows, type CalibrationPoints, type Replay } from './calibration.ts';
import type { GateResult } from './result.ts';

// When the promise breaks, propose thresholds that restore it, and show what they cost in automation.
// A proposal only: nothing is written unless a person runs `twopass gate recalibrate --write` and commits the result,
// and that commit goes through the gate like any other.
//
// Fits on the calibration rows only (80% fit / 20% check, seeded); never on the CI slice or the test split.

export type RecalibrationProposal =
  | {
      kind: 'proposal';
      current: Thresholds;
      proposed: Thresholds;
      target: number;
      /** On the held-out check rows: current vs proposed thresholds. */
      checkCurrent: Replay;
      checkProposed: Replay;
      fitRows: number;
      checkRows: number;
      /** The proposed thresholds reach the target precision on the check rows. */
      restores: boolean;
      /** Fewer than MIN_CHECK_ACCEPTED held-out rows were accepted: the check is a sanity check, not evidence. */
      checkTooSmall: boolean;
      checker: { triage: string; verify: string };
      note?: string;
    }
  | { kind: 'cannot-restore'; reason: string; current: Thresholds; target: number; checkCurrent?: Replay; fitRows?: number; checkRows?: number }
  | { kind: 'needs-points'; reason: string; command: string };

/** Below this many accepted held-out rows, the comment says the check proves little. */
export const MIN_CHECK_ACCEPTED = 30;

export interface RecalibrateOptions {
  head: GateResult;
  points: CalibrationPoints | undefined;
  pointsPath: string;
  taskPath: string;
  checkShare: number;
  seed: number;
  withTriage: boolean;
  /** Writer the CI run used, by the name the task file gives (calibration points must come from the same writer). */
  writerRequested: string;
  escalationRequested: string;
}

const sameWriter = (a: string, b: string) => a.replace(/:batch$/, '').replace(/^anthropic\//, '').replace(/\./g, '-') === b.replace(/:batch$/, '').replace(/^anthropic\//, '').replace(/\./g, '-');

export function proposeRecalibration(o: RecalibrateOptions): RecalibrationProposal {
  const { head, points } = o;
  const target = head.promise.acceptedPrecision;
  const triage = head.models.triage;
  const verify = head.models.verify;
  const cmd = `twopass gate calibrate --task ${o.taskPath} --max-usd <cap>`;
  if (!points) return { kind: 'needs-points', reason: `No calibration points at ${o.pointsPath}.`, command: cmd };
  if (!sameWriter(points.source.writer, o.writerRequested) || !sameWriter(points.source.escalation, o.escalationRequested)) {
    return {
      kind: 'needs-points',
      reason:
        `The calibration points were collected with writer ${points.source.writer} / ${points.source.escalation}; this change uses ` +
        `${o.writerRequested} / ${o.escalationRequested}. The checker's scores depend on the writer's mistakes, so new points are needed (a collect run on the calibration rows).`,
      command: `${cmd} --collect`,
    };
  }
  if (!hasCheckerPoints(points, triage, verify, o.withTriage)) {
    const missing = [o.withTriage && !points.checkers[triage]?.triage ? triage : '', !points.checkers[verify]?.verify1 ? verify : ''].filter(Boolean);
    return {
      kind: 'needs-points',
      reason: `The calibration points have no scores for ${[...new Set(missing)].join(', ')}. Score the calibration rows with it (decision calls only, the writer answers are reused).`,
      command: `${cmd} --models ${[...new Set(missing)].join(',')}`,
    };
  }

  const { fit, check } = splitRows(Object.keys(points.rows), o.checkShare, o.seed);
  const who = { triage, verify, withTriage: o.withTriage };
  const proposed = fitOnRows(points, { ...who, target, rows: fit });
  const checkCurrent = replayRows(points, { ...who, rows: check }, head.thresholds);
  if (proposed.t1 >= NEVER && proposed.t2 >= NEVER && (!o.withTriage || proposed.t0 >= NEVER)) {
    return {
      kind: 'cannot-restore',
      reason: `No threshold reaches ${(100 * target).toFixed(0)}% precision on the ${fit.length} fit rows for ${verify}: every stage would have to send all rows to a person.`,
      current: head.thresholds,
      target,
      checkCurrent,
      fitRows: fit.length,
      checkRows: check.length,
    };
  }
  const checkProposed = replayRows(points, { ...who, rows: check }, proposed);
  const restores = checkProposed.accepted > 0 && checkProposed.precision.point >= target;
  return {
    kind: 'proposal',
    current: head.thresholds,
    proposed,
    target,
    checkCurrent,
    checkProposed,
    fitRows: fit.length,
    checkRows: check.length,
    restores,
    checkTooSmall: checkProposed.accepted < MIN_CHECK_ACCEPTED,
    checker: { triage, verify },
    ...(restores
      ? {}
      : { note: `On the ${check.length} held-out rows the proposed thresholds reach ${(100 * checkProposed.precision.point).toFixed(1)}%, below the ${(100 * target).toFixed(0)}% target. They don't restore the promise.` }),
  };
}
