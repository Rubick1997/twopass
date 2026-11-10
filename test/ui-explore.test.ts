import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fitThreshold, NEVER as CAL_NEVER } from '../src/calibrate.ts';
import type { DecisionModel } from '../src/decide/model.ts';
import { computeOutcomes } from '../src/pipeline.ts';
import { scoreRun } from '../src/score.ts';
import { matchesLabel } from '../src/report.ts';
import { Ledger, replay as replayLedger } from '../src/ledger.ts';
import { loadRun } from '../src/run.ts';
import { loadTask } from '../src/task.ts';
import { buildExploreRows, getBenchExplore, NotFoundError, PRICING_NOTE, readScoreRecords } from '../src/ui/api.ts';
import { tempDir } from './helpers.ts';
import { CLEF, EXPLORE_ROWS, exploreBench, exploreRun, exploreRunLarge, JEV, makeRoot, TASK, writeBench } from './ui-fixtures.ts';
import { exploreHref, parseHash } from '../ui/src/hooks.ts';
import {
  bestConfig,
  cardStats,
  costFootnoteText,
  configDescription,
  coverageCurve,
  friendlyConfig,
  friendlyModel,
  NEVER,
  outcomeSentence,
  refitThresholds,
  replay,
  roundToTotal,
  stagePoints,
  uncachedTag,
  waffleCounts,
  type Controller,
  type Thresholds,
} from '../ui/src/explore.ts';

const JEV_JEV: Controller = { triage: JEV, verify: JEV };

async function loaded(root: string, runId = 'run-calib', scores: Array<Record<string, unknown>> = [], make: (root: string, runId: string) => ReturnType<typeof exploreRun> = exploreRun) {
  const run = make(root, runId);
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

describe('explore route', () => {
  it('parses #/benches/:id/explore and keeps the other routes', () => {
    expect(parseHash('#/benches/bench-x/explore')).toEqual({ page: 'explore', id: 'bench-x' });
    expect(parseHash(exploreHref('bench-x'))).toEqual({ page: 'explore', id: 'bench-x' });
    expect(parseHash('#/benches/bench-x')).toEqual({ page: 'bench', id: 'bench-x' });
    expect(parseHash('#/runs/r1/review')).toEqual({ page: 'review', id: 'r1' });
    expect(parseHash('#/runs/r1/explore').page).toBe('notfound');
    expect(parseHash('#/benches/b/review').page).toBe('notfound');
  });
});

describe('refit: the "how accurate" slider', () => {
  const never: DecisionModel['decide'] = () => Promise.reject(new Error('the refit test must not call a model'));
  const STAGES = ['triage', 'verify1', 'verify2'] as const;

  it('builds the same points per model and stage as scoreRun, and fits the same thresholds', async () => {
    const { run, records, st, task, rows, models } = await loaded(makeRoot(), 'run-calib-big', [], exploreRunLarge);
    expect(rows).toHaveLength(80);
    expect(models).toEqual([JEV, CLEF]);
    const scored = await scoreRun({
      dir: run.dir, task, records, labelColumn: 'label', st, runModels: { triage: JEV, verify: JEV },
      models: [{ id: JEV, decide: never }, { id: CLEF, decide: never }], ledgerOnly: true,
    });
    const view = (p: { score: number; correct: boolean }) => [p.score, p.correct];
    for (const m of scored) {
      for (const stage of STAGES) {
        expect(m.points[stage].length, `${m.model} ${stage}`).toBeGreaterThan(20);
        expect(stagePoints(rows, m.model, stage).map(view), `${m.model} ${stage}`).toEqual(m.points[stage].map(view));
      }
    }
    // the fixture covers the cases that matter: abstentions, unparsed writer outputs, missing scores, 4-decimal scores
    expect(rows.some((r) => r.triage[JEV]!.p === null)).toBe(true);
    expect(rows.some((r) => r.w1.correct === null)).toBe(true);
    expect(rows.filter((r) => r.w1.correct !== null && !(CLEF in r.verify1)).length).toBeGreaterThan(0);
    expect(stagePoints(rows, CLEF, 'triage').some((p) => p.score.toFixed(2) !== p.score.toString())).toBe(true);

    const jev = scored.find((m) => m.model === JEV)!;
    const clef = scored.find((m) => m.model === CLEF)!;
    for (const target of [0.8, 0.9, 0.95, 0.99]) {
      expect(refitThresholds(rows, { triage: JEV, verify: CLEF }, target), `target ${target}`).toEqual({
        t0: fitThreshold(jev.points.triage, target).threshold,
        t1: fitThreshold(clef.points.verify1, target).threshold,
        t2: fitThreshold(clef.points.verify2, target).threshold,
      });
      expect(refitThresholds(rows, { triage: CLEF, verify: JEV }, target), `target ${target}`).toEqual({
        t0: fitThreshold(clef.points.triage, target).threshold,
        t1: fitThreshold(jev.points.verify1, target).threshold,
        t2: fitThreshold(jev.points.verify2, target).threshold,
      });
    }
    // the fits are real cuts at a reachable target and "never" at an unreachable one
    const t = refitThresholds(rows, { triage: JEV, verify: CLEF }, 0.8);
    expect(t.t0).toBeGreaterThan(0.5);
    expect(t.t0).toBeLessThanOrEqual(1);
    expect(refitThresholds(rows, JEV_JEV, 1.001)).toEqual({ t0: NEVER, t1: NEVER, t2: NEVER }); // no cut can reach it
    expect(NEVER).toBe(CAL_NEVER);
  });

  it('refits the bench target to the thresholds the bench ran with, and replays to its precision', async () => {
    const { rows } = await loaded(makeRoot(), 'run-calib-big', [], exploreRunLarge);
    const target = 0.95;
    const fitted = refitThresholds(rows, JEV_JEV, target);
    const r = replay(rows, JEV_JEV, fitted);
    // every stage that accepts anything does so at or above the target, measured the way calibrate measures it
    for (const [stage, th] of [['triage', fitted.t0], ['verify1', fitted.t1], ['verify2', fitted.t2]] as const) {
      const pts = stagePoints(rows, JEV, stage);
      const acc = pts.filter((p) => p.score > 0 && p.score >= th);
      if (th <= 1) expect(acc.filter((p) => p.correct).length / acc.length, stage).toBeGreaterThanOrEqual(target);
    }
    expect(r.accepted).toBeGreaterThan(0);
  });

  it('on the 9-row fixture (fewer than 10 rows per stage) every stage is "never"', async () => {
    const { rows } = await loaded(makeRoot());
    expect(refitThresholds(rows, JEV_JEV, 0.95)).toEqual({ t0: NEVER, t1: NEVER, t2: NEVER });
  });
});

describe('the 100-row waffle and its sentence', () => {
  it('rounds shares to whole squares that always sum to 100', () => {
    expect(roundToTotal([0.5, 0.5])).toEqual([50, 50]);
    expect(roundToTotal([1 / 3, 1 / 3, 1 / 3])).toEqual([34, 33, 33]);
    expect(roundToTotal([0.915, 0.055, 0.03])).toEqual([92, 5, 3]);
    expect(roundToTotal([0.004, 0.004, 0.992])).toEqual([1, 0, 99]); // equal remainders: the earlier share gets the square
    expect(roundToTotal([0, 0, 1])).toEqual([0, 0, 100]);
    for (let i = 0; i < 200; i++) {
      const a = (i * 37) % 101 / 100;
      const b = ((i * 53) % 101 / 100) * (1 - a);
      const out = roundToTotal([a, b, 1 - a - b]);
      expect(out.reduce((x, y) => x + y, 0)).toBe(100);
      expect(out.every((x) => x >= 0)).toBe(true);
    }
  });

  it('counts right, wrong and to-check squares from a replay', () => {
    expect(waffleCounts({ n: 1000, accepted: 975, acceptedCorrect: 932, flagged: 25 })).toEqual({ right: 93, wrong: 4, check: 3 });
    expect(waffleCounts({ n: 9, accepted: 7, acceptedCorrect: 5, flagged: 2 })).toEqual({ right: 56, wrong: 22, check: 22 });
    expect(waffleCounts({ n: 0, accepted: 0, acceptedCorrect: 0, flagged: 0 })).toEqual({ right: 0, wrong: 0, check: 100 });
  });

  it('writes the sentence from the same counts, never claiming more than the squares show', () => {
    expect(outcomeSentence({ n: 1000, accepted: 975, acceptedCorrect: 932, flagged: 25 })).toBe(
      'Out of every 100 rows, about 97 are answered automatically — about 4 of those are wrong — and 3 come to you to check.',
    );
    expect(outcomeSentence({ n: 1000, accepted: 1000, acceptedCorrect: 1000, flagged: 0 })).toBe(
      'Out of every 100 rows, about 100 are answered automatically — none of those are wrong — and none come to you to check.',
    );
    expect(outcomeSentence({ n: 1000, accepted: 500, acceptedCorrect: 498, flagged: 500 })).toBe(
      'Out of every 100 rows, about 50 are answered automatically — fewer than 1 of those is wrong — and 50 come to you to check.',
    );
    expect(outcomeSentence({ n: 1000, accepted: 990, acceptedCorrect: 980, flagged: 10 })).toBe(
      'Out of every 100 rows, about 99 are answered automatically — about 1 of those is wrong — and 1 comes to you to check.',
    );
    expect(outcomeSentence({ n: 50, accepted: 0, acceptedCorrect: 0, flagged: 50 })).toBe(
      'Out of every 100 rows, none are answered automatically: all 100 come to you to check.',
    );
  });
});

describe('plain names', () => {
  it('names models and configurations for people', () => {
    expect(['typesafe/jev-1.14', 'cloudflare/clef', 'openai/gpt-6-luna-decisions', 'anthropic/claude-haiku-5.5:batch', 'anthropic/claude-sonnet-5.5:batch', 'anthropic/claude-opus-5.5:batch', 'acme/widget-9:batch'].map(friendlyModel)).toEqual([
      'Jev', 'Clef', 'Luna', 'Haiku', 'Sonnet', 'Opus', 'Widget-9',
    ]);
    const clef = { name: 'clef', triage: CLEF, verify: CLEF };
    const mix = { name: 'jev+clef', triage: JEV, verify: CLEF };
    const base = { name: 'baseline', triage: null, verify: null };
    expect([clef, mix].map((c) => friendlyConfig(c))).toEqual(['Clef', 'Jev + Clef']);
    expect(friendlyConfig(base, 'anthropic/claude-opus-5.5:batch')).toBe('Opus on every row');
    expect(friendlyConfig(base, null)).toBe('Baseline');
    expect([clef, mix].map((c) => configDescription(c))).toEqual(['Clef answers, Clef checks', 'Jev answers, Clef checks']);
    expect(configDescription(base, 'anthropic/claude-opus-5.5:batch')).toBe('Opus answers every row, nothing is checked');
  });

  it('highlights the configuration that automates the most at the target, else the most precise', () => {
    const cfg = (name: string, precision: number, autoAcceptShare: number, ours = true) => ({ name, triage: ours ? JEV : null, verify: ours ? JEV : null, precision, autoAcceptShare });
    expect(bestConfig([cfg('jev', 0.954, 0.57), cfg('clef', 0.956, 0.97), cfg('luna', 0.99, 0.05), cfg('mix', 0.944, 0.74), cfg('baseline', 1, 1, false)], 0.95)).toBe('clef');
    expect(bestConfig([cfg('a', 0.9, 0.9), cfg('b', 0.93, 0.5), cfg('baseline', 1, 1, false)], 0.95)).toBe('b');
    expect(bestConfig([cfg('baseline', 1, 1, false)], 0.95)).toBeNull();
  });
});

describe('setup cards and uncached cost wording', () => {
  it('setup cards state only the automatic share, never a "right" figure', () => {
    expect(cardStats(0.97)).toBe('97% answered automatically');
    expect(cardStats(0.97).toLowerCase()).not.toContain('right');
  });

  it('tags costs as uncached, with the footnote, only when pricingNote is set', () => {
    expect(uncachedTag(PRICING_NOTE)).toBe('(uncached)');
    expect(costFootnoteText(PRICING_NOTE)).toBe(
      '* Costs as recorded in this benchmark, without prompt caching. Caching makes the writing steps about 85–90% cheaper, which matters most for setups that write every row, like Opus answering every row; the decision-model steps cost the same. See the README’s Cost section for cached numbers.',
    );
    for (const none of [null, undefined, '']) {
      expect(uncachedTag(none)).toBeNull();
      expect(costFootnoteText(none)).toBeNull();
    }
  });
});

describe('explore tabs in the URL', () => {
  it('reads ?tab= on the explore route only, and keeps the old URL', () => {
    expect(parseHash('#/benches/bench-x/explore?tab=results')).toEqual({ page: 'explore', id: 'bench-x', tab: 'results' });
    expect(parseHash(exploreHref('bench-x', 'method'))).toEqual({ page: 'explore', id: 'bench-x', tab: 'method' });
    expect(exploreHref('bench-x')).toBe('#/benches/bench-x/explore');
    expect(parseHash('#/benches/bench-x/explore?')).toEqual({ page: 'explore', id: 'bench-x' });
    expect(parseHash('#/benches/bench-x?tab=results')).toEqual({ page: 'bench', id: 'bench-x' });
    expect(parseHash('#/?tab=x')).toEqual({ page: 'home' });
  });
});
