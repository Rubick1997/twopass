import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { calibrateStage } from '../src/calibrate.ts';
import type { DecisionModel } from '../src/decide/model.ts';
import { Ledger, replay } from '../src/ledger.ts';
import { executePipeline } from '../src/pipeline.ts';
import { thresholdsFromCalibration, type CalibrationFile } from '../src/runner.ts';
import { scoreRun } from '../src/score.ts';
import { TRUTH, docs, extractContext, fakeServer, toyTask } from './extract-helpers.ts';
import { tempDir } from './helpers.ts';

/** A checker that is right whenever the proposed value is the truth, and counts its calls. */
function stubChecker(id: string) {
  const calls: string[][] = [];
  const model: DecisionModel = {
    id,
    decide: async (state, questions) => {
      const doc = (state as { document: string }).document;
      calls.push(Object.keys(questions));
      const answers = Object.fromEntries(
        Object.entries(questions).map(([f, q]) => {
          const ok = (q as { instructions: string }).instructions === `${f}=${TRUTH[doc]![f]}`;
          return [f, { type: 'choice', choice: ok ? 'supported' : 'unsupported', probabilities: { supported: ok ? 0.8 : 0.1, unsupported: 0.1, cannot_tell: 0.1 }, confidence: 1 }];
        }),
      );
      return { model: id, answers, costUsd: 0.01, latencyMs: 1 };
    },
  };
  return { model, calls };
}

async function collectRun() {
  const dir = tempDir();
  const api = fakeServer();
  await executePipeline(extractContext(dir, api.fetch, { mode: 'collect' }));
  return { dir, st: replay(new Ledger(join(dir, 'ledger.jsonl')).read()) };
}

const opts = (dir: string, st: ReturnType<typeof replay>, models: DecisionModel[], more: Record<string, unknown> = {}) => ({
  dir,
  task: toyTask,
  records: docs,
  labelColumn: 'gold',
  st,
  runModels: { triage: 'dec', verify: 'dec' },
  models,
  ...more,
});

describe('scoreRun on an extract run', () => {
  it("makes one point per field slot, and takes the run model's answers from the ledger", async () => {
    const { dir, st } = await collectRun();
    const [own] = await scoreRun(opts(dir, st, [stubChecker('dec').model]));
    expect(own!.spentUsd).toBe(0);
    expect(own!.points.triage).toEqual([]);
    // round 1: d1 and d2 usable (d3 was invalid JSON) -> 2 docs x 3 fields; round 2: all 3 docs x 3 fields
    expect(own!.points.verify1).toHaveLength(6);
    expect(own!.points.verify2).toHaveLength(9);
    expect(own!.points.verify1.filter((p) => !p.correct)).toHaveLength(1); // d2's b is WRONG
    expect(own!.points.verify2.filter((p) => !p.correct)).toHaveLength(1); // d2's a is DIFFERENT
    expect(own!.points.verify1.filter((p) => p.correct).every((p) => p.p > 0.9)).toBe(true);
  });

  it('asks another checker once per document with all fields, then reuses its cache', async () => {
    const { dir, st } = await collectRun();
    const first = stubChecker('other');
    const [a] = await scoreRun(opts(dir, st, [first.model]));
    expect(first.calls).toHaveLength(2 + 3); // 2 documents in verify1, 3 in verify2
    expect(first.calls.every((c) => c.join() === 'a,b,c')).toBe(true);
    expect(a!.spentUsd).toBeCloseTo(0.05);
    const second = stubChecker('other');
    const [b] = await scoreRun(opts(dir, st, [second.model]));
    expect(second.calls).toHaveLength(0);
    expect(b!.spentUsd).toBe(0);
    expect(b!.points).toEqual(a!.points);
    const line = JSON.parse(readFileSync(join(dir, 'scores.jsonl'), 'utf8').split('\n')[0]!);
    expect(Object.keys(line.answers)).toEqual(['a', 'b', 'c']);
  });

  it('scores only the stages asked for', async () => {
    const { dir, st } = await collectRun();
    const checker = stubChecker('other');
    const [r] = await scoreRun(opts(dir, st, [checker.model], { stages: ['verify1'] }));
    expect(checker.calls).toHaveLength(2);
    expect(r!.points.verify1).toHaveLength(6);
    expect(r!.points.verify2).toEqual([]);
  });

  it('feeds calibration with slot points, and thresholds work with no triage fit', async () => {
    const { dir, st } = await collectRun();
    const [r] = await scoreRun(opts(dir, st, [stubChecker('dec').model]));
    const cal: CalibrationFile = {
      runId: 'x',
      createdAt: '',
      target: 0.9,
      rows: 3,
      models: { dec: { verify1: calibrateStage(r!.points.verify1, 0.9), verify2: calibrateStage(r!.points.verify2, 0.9) } },
    };
    expect(cal.models.dec!.verify1!.n).toBe(6);
    expect(thresholdsFromCalibration(cal, 'dec', 'dec').t0).toBe(1.01);
  });
});
