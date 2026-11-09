import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeOutcomes } from '../src/pipeline.ts';
import { matchesLabel } from '../src/report.ts';
import { Ledger, replay as replayLedger } from '../src/ledger.ts';
import { loadRun } from '../src/run.ts';
import { loadTask } from '../src/task.ts';
import { buildExploreRows, getBenchExplore, NotFoundError, PRICING_NOTE, readScoreRecords } from '../src/ui/api.ts';
import { tempDir } from './helpers.ts';
import { CLEF, EXPLORE_ROWS, exploreBench, exploreRun, JEV, makeRoot, TASK, writeBench } from './ui-fixtures.ts';
import { coverageCurve, NEVER, replay, type Controller, type Thresholds } from '../ui/src/explore.ts';

const JEV_JEV: Controller = { triage: JEV, verify: JEV };

async function loaded(root: string, runId = 'run-calib', scores: Array<Record<string, unknown>> = []) {
  const run = exploreRun(root, runId);
  if (scores.length) writeFileSync(join(run.dir, 'scores.jsonl'), scores.map((s) => JSON.stringify(s)).join('\n') + '\n');
  const { manifest, records } = loadRun(run.dir);
  const st = replayLedger(new Ledger(join(run.dir, 'ledger.jsonl')).read());
  const task = await loadTask(TASK);
  const built = buildExploreRows({
    task,
    records,
    labelColumn: 'label',
    st,
    runModels: { triage: manifest.models.triage, verify: manifest.models.verify },
    scores: readScoreRecords(run.dir),
  });
  return { run, records, st, task, ...built };
}

describe('replay equals computeOutcomes', () => {
  const grid: Thresholds[] = [
    { t0: 0.9, t1: 0.9, t2: 0.9 },
    { t0: 0.5, t1: 0.5, t2: 0.5 },
    { t0: 0.75, t1: 0.75, t2: 0.75 },
    { t0: 0.97, t1: 0.95, t2: 0.99 },
    { t0: 0.96, t1: 0.9, t2: 0.96 },
    { t0: 1.0, t1: 1.0, t2: 1.0 },
    { t0: NEVER, t1: NEVER, t2: NEVER },
    { t0: NEVER, t1: 0.9, t2: NEVER },
    { t0: 0.9, t1: NEVER, t2: 0.9 },
    { t0: 0.9, t1: 0.9, t2: NEVER },
  ];

  it('gives the same accepted, flagged, correct-accepted and no-human counts for the run\'s own models', async () => {
    const { records, st, task, rows } = await loaded(makeRoot());
    expect(rows).toHaveLength(EXPLORE_ROWS);
    for (const t of grid) {
      const out = computeOutcomes(st, { task, rows: records, thresholds: t, mode: 'normal' });
      expect(out.some((o) => o.status === 'pending'), JSON.stringify(t)).toBe(false);
      const accepted = out.filter((o) => o.status === 'accepted');
      const ok = (o: (typeof out)[number]) => matchesLabel(o.answer, o.data.label);
      const r = replay(rows, JEV_JEV, t);
      expect(
        { n: r.n, accepted: r.accepted, flagged: r.flagged, round0: r.round0, correct: r.acceptedCorrect, noHuman: r.accuracyNoHuman },
        JSON.stringify(t),
      ).toEqual({
        n: out.length,
        accepted: accepted.length,
        flagged: out.filter((o) => o.status === 'flagged').length,
        round0: accepted.filter((o) => o.round === 0).length,
        correct: accepted.filter(ok).length,
        noHuman: out.filter(ok).length / out.length,
      });
    }
  });

  it('covers every path: round 0, 1, 2, flagged, cannot_tell, invalid and failed writers, never', async () => {
    const { records, st, task, rows } = await loaded(makeRoot());
    const t = { t0: 0.9, t1: 0.9, t2: 0.9 };
    const out = computeOutcomes(st, { task, rows: records, thresholds: t, mode: 'normal' });
    const where = Object.fromEntries(out.map((o) => [o.rowId, `${o.status}${o.status === 'accepted' ? o.round : ''}`]));
    expect(where).toEqual({
      r1: 'accepted0', r2: 'accepted1', r3: 'accepted2', r4: 'accepted0', r5: 'flagged',
      r6: 'accepted2', r7: 'flagged', r8: 'accepted1', r9: 'accepted1',
    });
    expect(out.find((o) => o.rowId === 'r6')!.verdict).toBe('supported'); // r6 round 1 was invalid, round 2 parsed
    expect(replay(rows, JEV_JEV, t)).toMatchObject({ accepted: 7, round0: 2, flagged: 2, acceptedCorrect: 5 });
    // 'never' at every stage: nothing accepted, all flagged, answers are the round-2 writer's
    const never = replay(rows, JEV_JEV, { t0: NEVER, t1: NEVER, t2: NEVER });
    expect(never).toMatchObject({ accepted: 0, flagged: 9, precision: null });
    expect(never.accuracyNoHuman).toBeCloseTo(8 / 9); // only r7's round-2 answer is wrong
  });
});

describe('replay with another verify model', () => {
  const clef = (stage: string, rowId: string, verdict: unknown, answer?: string, costUsd = 0.0001) => ({
    model: CLEF, servedAs: CLEF, stage, rowId, ...(answer !== undefined ? { answer } : {}), verdict, costUsd, latencyMs: 1,
  });
  const supported = (p: number) => ({ type: 'choice', choice: 'supported', probabilities: { supported: p, unsupported: 1 - p, cannot_tell: 0 }, confidence: p });

  it('uses scores.jsonl answers and ignores a score for a different writer answer', async () => {
    const { rows, models } = await loaded(makeRoot(), 'run-calib', [
      clef('verify1', 'r2', supported(0.99), 'age_limit'), // judged the writer's answer
      clef('verify1', 'r9', supported(0.99), 'card_linking'), // judged another answer (the writer said age_limit): ignored
      clef('verify1', 'r8', { type: 'choice', choice: 'unsupported', probabilities: { supported: 0.99, unsupported: 0.01, cannot_tell: 0 }, confidence: 0.9 }, 'card_linking'),
    ]);
    expect(models).toContain(CLEF);
    const r2 = rows.find((r) => r.id === 'r2')!;
    const r8 = rows.find((r) => r.id === 'r8')!;
    expect(r2.verify1[CLEF]).toEqual({ p: 0.99, usd: 0.0001 });
    expect(rows.find((r) => r.id === 'r9')!.verify1[CLEF]).toBeUndefined();
    expect(r8.verify1[CLEF]).toEqual({ p: null, usd: 0.0001 }); // chose unsupported: cannot accept, whatever its p(supported)

    const c: Controller = { triage: JEV, verify: CLEF };
    const r = replay(rows, c, { t0: NEVER, t1: 0.9, t2: 0.9 });
    // only r2 has a clef verdict, and it accepts in round 1; everyone else is flagged (no clef entry at round 2)
    expect(r).toMatchObject({ accepted: 1, acceptedCorrect: 1, flagged: 8, round0: 0 });
    expect(r.costPer1k.verify1).toBeCloseTo((1000 * 0.0002) / 9);
    expect(r.costPer1k.verify2).toBe(0);
  });
});

describe('cost and coverage curve', () => {
  it('accumulates cost per stage for the stages a row reaches', async () => {
    const { rows } = await loaded(makeRoot());
    // t0 = 0.9: r1 and r4 stop in round 0. Others pay write1 ($0.0005) and verify1 ($0.002) ...
    const r = replay(rows, JEV_JEV, { t0: 0.9, t1: 0.9, t2: 0.9 });
    const k = (x: number) => (1000 * x) / 9;
    expect(r.costPer1k.triage).toBeCloseTo(k(9 * 0.001));
    expect(r.costPer1k.write1).toBeCloseTo(k(7 * 0.0005));
    // verify1 is paid for the 7 rows that reach round 1, minus r6 and r7 (no parsed writer output: no verify call)
    expect(r.costPer1k.verify1).toBeCloseTo(k(5 * 0.002));
    // round 2: r3, r5, r6, r7 (r2, r8, r9 accepted in round 1)
    expect(r.costPer1k.write2).toBeCloseTo(k(4 * 0.004));
    expect(r.costPer1k.verify2).toBeCloseTo(k(4 * 0.002));
    expect(r.costPer1k.total).toBeCloseTo(
      r.costPer1k.triage + r.costPer1k.write1 + r.costPer1k.verify1 + r.costPer1k.write2 + r.costPer1k.verify2,
    );
  });

  it('coverageCurve sweeps 0.50 to 1.00; coverage does not grow with t', async () => {
    const { rows } = await loaded(makeRoot());
    const curve = coverageCurve(rows, JEV_JEV);
    expect(curve).toHaveLength(51);
    expect(curve[0]!.t).toBe(0.5);
    expect(curve.at(-1)!.t).toBe(1);
    expect(curve.at(-1)!.acceptedShare).toBeLessThanOrEqual(curve[0]!.acceptedShare);
    for (let i = 1; i < curve.length; i++) expect(curve[i]!.acceptedShare).toBeLessThanOrEqual(curve[i - 1]!.acceptedShare + 1e-12);
    expect(curve[40]!.t).toBe(0.9);
    expect(curve[40]!.acceptedShare).toBeCloseTo(7 / 9);
    expect(coverageCurve(rows, JEV_JEV, 0.5, 1, 0.1)).toHaveLength(6);
  });
});

describe('GET /api/benches/:id/explore (getBenchExplore)', () => {
  it('returns the table, reliability and the compact calibration rows', async () => {
    const root = makeRoot();
    exploreRun(root);
    exploreBench(root, 'bench-x', { calibrationRunId: 'run-calib' });
    const r = await getBenchExplore(root, 'bench-x');
    expect(r).toMatchObject({ benchId: 'bench-x', target: 0.95, calibrationMissingReason: null });
    expect(r.results.configs.map((c) => c.name)).toEqual(['jev', 'baseline']);
    expect(r.results.configs[0]).toMatchObject({ triage: JEV, thresholds: { t0: 0.9, t1: 0.9, t2: 0.9 }, precision: 0.96, costPer1k: { total: 15 } });
    expect(r.results.configs[1]).toMatchObject({ thresholds: null });
    expect(r.reliability.map((x) => `${x.config}/${x.stage}`)).toEqual(['jev/triage', 'jev/verify1', 'jev/verify2']);
    expect(r.reliability[0]).toMatchObject({ model: JEV, n: 9, eceRaw: 0.12, eceCalibrated: 0.03 });
    expect(r.reliability[0]!.raw[0]).toEqual({ lo: 0.9, hi: 1, n: 9, meanP: 0.95, accuracy: 0.8 });
    const c = r.calibration!;
    expect(c).toMatchObject({ runId: 'run-calib', rows: 9, models: [JEV], thresholdsByConfig: { jev: { t0: 0.9, t1: 0.9, t2: 0.9 } } });
    expect(c.fitsByModel[JEV]).toEqual({ triage: 0.93, verify1: 0.91 });
    expect(c.data).toHaveLength(9);
    expect(Object.keys(c.data[0]!).sort()).toEqual(['id', 'triage', 'verify1', 'verify2', 'w1', 'w2']); // no text, no label
    expect(c.pricingNote).toBe(PRICING_NOTE); // fixture results carry no usage
    // the response replays to the numbers computed from the ledger
    expect(replay(c.data, JEV_JEV, c.thresholdsByConfig.jev!)).toMatchObject({ accepted: 7, flagged: 2 });
  });

  it('has no pricing note when the writer results carry usage', async () => {
    const root = makeRoot();
    exploreRun(root, 'run-calib', { usage: true });
    exploreBench(root, 'bench-x', { calibrationRunId: 'run-calib' });
    expect((await getBenchExplore(root, 'bench-x')).calibration!.pricingNote).toBeNull();
  });

  it('404s an unknown bench and a bench without bench-report.json', async () => {
    const root = makeRoot();
    await expect(getBenchExplore(root, 'bench-nope')).rejects.toBeInstanceOf(NotFoundError);
    writeBench(root, 'bench-early', {});
    await expect(getBenchExplore(root, 'bench-early')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('returns calibration: null with a reason when the calibration run folder is missing', async () => {
    const root = makeRoot();
    const run = exploreRun(root);
    exploreBench(root, 'bench-x', { calibrationRunId: 'run-calib' });
    rmSync(run.dir, { recursive: true });
    const r = await getBenchExplore(root, 'bench-x');
    expect(r.calibration).toBeNull();
    expect(r.calibrationMissingReason).toMatch(/run-calib.*not in the runs folder/);
    expect(r.results.configs).toHaveLength(2);
    expect(r.reliability).toHaveLength(3);
  });

  it('finds the calibration run of a reused calibration through calibration.json', async () => {
    const root = makeRoot();
    exploreRun(root, 'run-other-bench-calib');
    const file = join(tempDir(), 'calibration.json');
    writeFileSync(file, JSON.stringify({ runId: 'run-other-bench-calib', target: 0.95, rows: 9, models: {} }));
    exploreBench(root, 'bench-reuse', { calibrationPath: file, calibrationReused: true });
    const r = await getBenchExplore(root, 'bench-reuse');
    expect(r.calibration).toMatchObject({ runId: 'run-other-bench-calib', rows: 9 });
    expect(r.calibrationMissingReason).toBeNull();
  });

  it('rebuilds when the ledger or scores.jsonl change', async () => {
    const root = makeRoot();
    const run = exploreRun(root);
    exploreBench(root, 'bench-x', { calibrationRunId: 'run-calib' });
    const first = await getBenchExplore(root, 'bench-x');
    expect(await getBenchExplore(root, 'bench-x')).toBe(first); // cached
    mkdirSync(run.dir, { recursive: true });
    appendFileSync(
      join(run.dir, 'scores.jsonl'),
      JSON.stringify({ model: CLEF, servedAs: CLEF, stage: 'triage', rowId: 'r1', verdict: { type: 'choice', choice: 'card_arrival', probabilities: { card_arrival: 0.9, cannot_tell: 0.1 }, confidence: 0.9 }, costUsd: 0.0001, latencyMs: 1 }) + '\n',
    );
    const second = await getBenchExplore(root, 'bench-x');
    expect(second).not.toBe(first);
    expect(second.calibration!.models).toContain(CLEF);
  });
});
