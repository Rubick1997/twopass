import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { fitThreshold, NEVER, type Point } from '../calibrate.ts';
import type { ModelPoints, Stage } from '../score.ts';
import type { Thresholds } from '../task.ts';
import { seededOrder, wilson, type Interval } from './stats.ts';

// The calibration points the gate keeps in the repo (`calibration.points` in the task config): for every calibration
// row and checker, the score and correctness at each stage of a `collect` run. CI recalibrates from this file alone,
// with no model calls. Built by `twopass gate calibrate` (from an existing run's ledger, or a new collect run).

export type StagePoint = [score: number, correct: 0 | 1];

export interface CalibrationPoints {
  kind: 'twopass-gate-calibration';
  version: 1;
  task: string;
  /** The collect run the writer answers (and the run's own checker answers) came from. */
  source: { runId: string; writer: string; escalation: string; note?: string };
  createdAt: string;
  /** Calibration row IDs → gold label. */
  rows: Record<string, string>;
  /** checker → stage → rowId → [score, correct]. A row without a point at a stage had no usable answer there. */
  checkers: Record<string, Partial<Record<Stage, Record<string, StagePoint>>>>;
}

const pointsSchema = z.looseObject({
  kind: z.literal('twopass-gate-calibration'),
  version: z.literal(1),
  task: z.string(),
  source: z.looseObject({ runId: z.string(), writer: z.string(), escalation: z.string() }),
  rows: z.record(z.string(), z.string()),
  checkers: z.record(z.string(), z.record(z.string(), z.record(z.string(), z.tuple([z.number(), z.union([z.literal(0), z.literal(1)])])))),
});

export function readCalibrationPoints(path: string): CalibrationPoints | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = pointsSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new Error(`${path}: not a calibration points file (${parsed.error.issues[0]?.path.join('.')}: ${parsed.error.issues[0]?.message})`);
  return parsed.data as unknown as CalibrationPoints;
}

/** scoreRun output (with row IDs) → the points of each checker. */
export function pointsFromScored(scored: ModelPoints[]): CalibrationPoints['checkers'] {
  const out: CalibrationPoints['checkers'] = {};
  for (const s of scored) {
    if (!s.ids) throw new Error(`${s.model}: scoreRun returned no row IDs (extraction task?)`);
    const entry: Partial<Record<Stage, Record<string, StagePoint>>> = {};
    for (const stage of ['triage', 'verify1', 'verify2'] as const) {
      const ids = s.ids[stage];
      if (!ids.length) continue;
      entry[stage] = Object.fromEntries(ids.map((id, i) => [id, [s.points[stage][i]!.score, s.points[stage][i]!.correct ? 1 : 0] as StagePoint]));
    }
    out[s.model] = entry;
  }
  return out;
}

/** The fit/check split: a seeded share of the calibration rows is held out. Deterministic for a given seed. */
export function splitRows(rowIds: string[], checkShare: number, seed: number): { fit: string[]; check: string[] } {
  const ordered = seededOrder([...rowIds].sort(), seed, (id) => id);
  const k = Math.round(checkShare * ordered.length);
  return { check: ordered.slice(0, k).sort(), fit: ordered.slice(k).sort() };
}

function stagePoints(cp: CalibrationPoints, checker: string, stage: Stage, ids: Set<string>): Point[] {
  const m = cp.checkers[checker]?.[stage];
  if (!m) return [];
  return Object.entries(m)
    .filter(([id]) => ids.has(id))
    .map(([, [score, correct]]) => ({ score, p: score, correct: correct === 1 }));
}

export function hasCheckerPoints(cp: CalibrationPoints, triage: string, verify: string, withTriage: boolean): boolean {
  return (!withTriage || !!cp.checkers[triage]?.triage) && !!cp.checkers[verify]?.verify1 && !!cp.checkers[verify]?.verify2;
}

/** Fits t0 (triage checker) and t1/t2 (verify checker) at `target` on the given rows, with the part 1 fit function. */
export function fitOnRows(cp: CalibrationPoints, o: { triage: string; verify: string; withTriage: boolean; target: number; rows: string[] }): Thresholds {
  const ids = new Set(o.rows);
  return {
    t0: o.withTriage ? fitThreshold(stagePoints(cp, o.triage, 'triage', ids), o.target).threshold : NEVER,
    t1: fitThreshold(stagePoints(cp, o.verify, 'verify1', ids), o.target).threshold,
    t2: fitThreshold(stagePoints(cp, o.verify, 'verify2', ids), o.target).threshold,
  };
}

export interface Replay {
  rows: number;
  accepted: number;
  acceptedRight: number;
  precision: Interval;
  acceptShare: number;
}

/**
 * Replays the pipeline on calibration rows under `t`, as `computeOutcomes` would on a collect run: accept at triage if
 * its score reaches t0, else at round 1 if verify1 reaches t1, else at round 2 if verify2 reaches t2, else flag.
 * A missing point (no usable answer) is never accepted. A score of 0 (abstained / not "supported") never passes.
 */
export function replayRows(cp: CalibrationPoints, o: { triage: string; verify: string; withTriage: boolean; rows: string[] }, t: Thresholds): Replay {
  const tri = cp.checkers[o.triage]?.triage ?? {};
  const v1 = cp.checkers[o.verify]?.verify1 ?? {};
  const v2 = cp.checkers[o.verify]?.verify2 ?? {};
  const pass = (p: StagePoint | undefined, th: number) => !!p && p[0] > 0 && p[0] >= th;
  let accepted = 0;
  let right = 0;
  for (const id of o.rows) {
    const hit = o.withTriage && pass(tri[id], t.t0) ? tri[id] : pass(v1[id], t.t1) ? v1[id] : pass(v2[id], t.t2) ? v2[id] : undefined;
    if (!hit) continue;
    accepted++;
    right += hit[1];
  }
  return { rows: o.rows.length, accepted, acceptedRight: right, precision: wilson(right, accepted), acceptShare: o.rows.length ? accepted / o.rows.length : NaN };
}
