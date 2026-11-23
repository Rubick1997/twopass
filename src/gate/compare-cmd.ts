import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readCalibrationPoints } from './calibration.ts';
import { renderComment } from './comment.ts';
import { compareResults, type Comparison } from './compare.ts';
import { runGates, type GateId, type GateOutcome } from './gates.ts';
import { type NoiseFile } from './noise.ts';
import { proposeRecalibration, type RecalibrationProposal } from './recalibrate.ts';
import { readResult, type GateResult } from './result.ts';
import { reviewRows, type ReviewRow } from './review.ts';
import { loadGateConfig, readThresholdsFile } from './task-config.ts';
import { writeJson } from './data.ts';

export interface CompareOutput {
  comparison: Comparison;
  gates: Record<GateId, GateOutcome>;
  enforce: GateId;
  pass: boolean;
  proposal: RecalibrationProposal | undefined;
  review: ReviewRow[];
  comment: string;
}

export function readNoise(path: string): NoiseFile | undefined {
  if (!existsSync(path)) return undefined;
  const n = JSON.parse(readFileSync(path, 'utf8')) as NoiseFile;
  if (n.kind !== 'twopass-gate-noise') throw new Error(`${path} is not a noise file`);
  return n;
}

/** `twopass gate compare`: offline, on two result files and the task config. */
export function gateCompare(o: {
  basePath: string;
  headPath: string;
  taskPath: string;
  enforce?: GateId;
  allowMixedRouting?: boolean;
  commentPath?: string;
}): CompareOutput {
  const { config } = loadGateConfig(o.taskPath);
  const base = readResult(o.basePath);
  const head = readResult(o.headPath);
  if (base.routingKey !== head.routingKey && !o.allowMixedRouting) {
    throw new Error(
      `Base and head were routed differently, so their costs and answers aren't comparable:\n  base: ${base.routingKey}\n  head: ${head.routingKey}\n` +
        'Run both with the same keys set, or pass --allow-mixed-routing.',
    );
  }
  const noise = readNoise(config.noise);
  if (noise && noise.task !== config.name) throw new Error(`${config.noise} is for task ${noise.task}, not ${config.name}`);
  const comparison = compareResults(base, head);
  const gates = runGates(comparison, { noise, g2Tolerance: config.gate.g2Tolerance });
  const enforce = o.enforce ?? config.gate.enforce;
  const promiseFailed = !gates.g3.reasons.find((r) => r.check === 'promise')!.pass;
  const proposal = promiseFailed ? propose(config, o.taskPath, head) : undefined;
  const review = reviewRows(comparison);
  const comment = renderComment({ comparison, gates, enforce, noise, proposal, review, base, head, taskPath: o.taskPath, headPath: o.headPath });
  if (o.commentPath) writeFileSync(o.commentPath, comment);
  return { comparison, gates, enforce, pass: gates[enforce].pass, proposal, review, comment };
}

function propose(config: ReturnType<typeof loadGateConfig>['config'], taskPath: string, head: GateResult): RecalibrationProposal {
  return proposeRecalibration({
    head,
    points: readCalibrationPoints(config.calibration.points),
    pointsPath: config.calibration.points,
    taskPath,
    checkShare: config.calibration.checkShare,
    seed: config.calibration.seed,
    withTriage: head.triageStage ?? true,
    writerRequested: config.writer.model,
    escalationRequested: config.writer.escalation,
  });
}

/** `twopass gate recalibrate`: the proposal for a head result; with `write`, the thresholds file is replaced. */
export function gateRecalibrate(o: { taskPath: string; runPath: string; write?: boolean }): { proposal: RecalibrationProposal; wrote?: string } {
  const { config } = loadGateConfig(o.taskPath);
  const head = readResult(o.runPath);
  const proposal = propose(config, o.taskPath, head);
  if (!o.write) return { proposal };
  if (proposal.kind !== 'proposal') throw new Error(`Nothing to write: ${proposal.reason}`);
  if (!proposal.restores) throw new Error(`Not writing thresholds that don't restore the promise. ${proposal.note ?? ''}`);
  const prev = readThresholdsFile(config.checker.thresholds);
  writeJson(config.checker.thresholds, {
    thresholds: proposal.proposed,
    target: proposal.target,
    checker: proposal.checker,
    source:
      `gate recalibrate: fitted on ${proposal.fitRows} calibration rows, checked on ${proposal.checkRows} held-out rows ` +
      `(${(100 * proposal.checkProposed.precision.point).toFixed(1)}% right, ${(100 * proposal.checkProposed.acceptShare).toFixed(1)}% auto-accepted)` +
      (prev ? `; replaces ${JSON.stringify(prev.thresholds)}` : ''),
    fittedAt: new Date().toISOString(),
  });
  return { proposal, wrote: config.checker.thresholds };
}
