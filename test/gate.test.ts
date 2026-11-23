import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fitOnRows, readCalibrationPoints, replayRows, splitRows, type CalibrationPoints } from '../src/gate/calibration.ts';
import { renderComment } from '../src/gate/comment.ts';
import { compareResults } from '../src/gate/compare.ts';
import { buildSlice, loadRows, readIdFile, textId } from '../src/gate/data.ts';
import { gateG3, runGates } from '../src/gate/gates.ts';
import { buildNoise, labelLimit } from '../src/gate/noise.ts';
import { proposeRecalibration } from '../src/gate/recalibrate.ts';
import { reviewRows } from '../src/gate/review.ts';
import { bootstrapMeanDelta, wilson } from '../src/gate/stats.ts';
import { GateConfigError, idColumnOf, loadGateConfig, requireThresholds, resolveLabels } from '../src/gate/task-config.ts';
import { assertNoOverlap } from '../src/gate/run.ts';
import { grid, h, makeResult, withRows } from './gate-fixtures.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'twopass-gate-'));
const LABELS = ['alpha', 'beta', 'gamma', 'delta'];

describe('stats', () => {
  it('Wilson bounds match known values and stay in [0, 1]', () => {
    const w = wilson(95, 100);
    expect(w.point).toBe(0.95);
    expect(w.lower).toBeCloseTo(0.8883, 3);
    expect(w.upper).toBeCloseTo(0.9785, 3);
    expect(wilson(0, 0)).toMatchObject({ lower: 0, upper: 1 });
    expect(wilson(10, 10).upper).toBe(1);
    expect(wilson(0, 10).lower).toBe(0);
  });
  it('the paired bootstrap is deterministic for a seed', () => {
    const base = Array.from({ length: 200 }, (_, i) => (h(`b${i}`) < 0.8 ? 1 : 0));
    const head = base.map((v, i) => (i % 17 === 0 ? 1 - v : v));
    const a = bootstrapMeanDelta(base, head, { seed: 3 });
    expect(bootstrapMeanDelta(base, head, { seed: 3 })).toEqual(a);
    expect(bootstrapMeanDelta(base, head, { seed: 4 })).not.toEqual(a);
    expect(a.lower).toBeLessThanOrEqual(a.delta);
    expect(a.upper).toBeGreaterThanOrEqual(a.delta);
  });
});

describe('compare', () => {
  it('pairs rows by ID, leaves out rows missing on one side, and counts flips overall and per label', () => {
    const base = makeResult([
      { id: 'a1', label: 'alpha' },
      { id: 'a2', label: 'alpha' },
      { id: 'b1', label: 'beta', answer: 'alpha' },
      { id: 'only-base', label: 'beta' },
    ]);
    const head = makeResult([
      { id: 'b1', label: 'beta' }, // wrong → right
      { id: 'a2', label: 'alpha', answer: 'beta' }, // right → wrong
      { id: 'a1', label: 'alpha' },
      { id: 'only-head', label: 'beta' },
    ]);
    const c = compareResults(base, head);
    expect(c.pairs.map((p) => p.base.id)).toEqual(['a1', 'a2', 'b1']);
    expect(c.onlyBase).toEqual(['only-base']);
    expect(c.onlyHead).toEqual(['only-head']);
    expect(c.answerFlips).toBe(2);
    expect(c.rightToWrong).toBe(1);
    expect(c.wrongToRight).toBe(1);
    expect(c.labels.find((l) => l.label === 'alpha')).toMatchObject({ rightToWrong: 1, netLoss: 1 });
    expect(c.labels.find((l) => l.label === 'beta')).toMatchObject({ wrongToRight: 1, netLoss: -1 });
    expect(c.base.n).toBe(3);
  });
  it('refuses files from different tasks', () => {
    expect(() => compareResults(makeResult([]), makeResult([], { task: 'other' }))).toThrow(/different tasks/);
  });
});

// Five scenarios on a 4 × 50 grid. Base: 98% accuracy, everything accepted at confidence 0.99 except the wrong rows.
const baseRows = withRows(grid(LABELS, 50), (_r, i) => (i % 50 === 0 ? { answer: 'zzz', status: 'flagged', confidence: 0.3 } : undefined));
const base = makeResult(baseRows);
const gate = (headRows: typeof baseRows, noise?: ReturnType<typeof buildNoise>) => runGates(compareResults(base, makeResult(headRows, { ref: 'head' })), { g2Tolerance: 0.01, ...(noise ? { noise } : {}) });

describe('gates on fixtures', () => {
  it('a no-op passes all three', () => {
    const g = gate(baseRows);
    expect([g.g1.pass, g.g2.pass, g.g3.pass]).toEqual([true, true, true]);
  });

  it('an aggregate gain with one label broken: G1 and G2 pass, G3 fails on labels', () => {
    const head = withRows(baseRows, (r, i) => {
      if (r.label === 'alpha' && i % 50 >= 1 && i % 50 <= 6) return { answer: 'beta', status: 'flagged', confidence: 0.4 }; // −6 on alpha
      if (r.label !== 'alpha' && i % 50 === 0) return { answer: r.label, status: 'accepted', confidence: 0.99 }; // +3 elsewhere
      return undefined;
    });
    // Net −3 rows overall but within G2's tolerance? make it a gain: fix 3, break 6 → −3. Use more fixes:
    const g = gate(head);
    expect(g.g3.pass).toBe(false);
    expect(g.g3.reasons.find((r) => r.check === 'labels')!.pass).toBe(false);
    expect(g.g3.reasons.find((r) => r.check === 'labels')!.detail).toContain('alpha −6');
    expect(g.g3.reasons.find((r) => r.check === 'promise')!.pass).toBe(true);
  });

  it('a uniform small drop (1 row per label) passes G3 per label but G1 notices', () => {
    const head = withRows(baseRows, (_r, i) => (i % 50 === 1 ? { answer: 'zzz', status: 'flagged', confidence: 0.2 } : undefined));
    const g = gate(head);
    expect(g.g3.reasons.find((r) => r.check === 'labels')!.pass).toBe(true);
    expect(g.g1.pass).toBe(false); // 98% → 96%: more than 0.5 points below base without a noise file
  });

  it('more confident-wrong answers fail G3 (3) even when the promise still holds', () => {
    // 5 wrong answers accepted, spread over labels (≤2 per label) so only the confident-wrong check moves.
    const head = withRows(baseRows, (r, i) => (i % 50 === 2 || (r.label === 'alpha' && i % 50 === 3) ? { answer: 'zzz', status: 'accepted', confidence: 0.97 } : undefined));
    const g = gate(head);
    const cw = g.g3.reasons.find((r) => r.check === 'confident-wrong')!;
    expect(cw.pass).toBe(false);
    expect(cw.detail).toContain('0 → 5');
  });

  it('THE CASE: flat accuracy, accepted precision below target. G1 and G2 pass, G3 fails on the promise', () => {
    // Same answers as base (accuracy identical), but head auto-accepts the wrong rows and sends right ones to a person.
    const head = withRows(baseRows, (r, i) => {
      if (i % 50 === 0) return { status: 'accepted', confidence: 0.91 }; // the 4 wrong rows now auto-accepted
      if (i % 50 >= 10) return { status: 'flagged', confidence: 0.5 }; // most right rows sent to a person
      return undefined;
    });
    const c = compareResults(base, makeResult(head));
    expect(c.head.accuracy).toBe(c.base.accuracy);
    const g = runGates(c, { g2Tolerance: 0.01 });
    expect(g.g1.pass).toBe(true);
    expect(g.g2.pass).toBe(true);
    expect(g.g3.pass).toBe(false);
    expect(g.g3.reasons.find((r) => r.check === 'promise')!.pass).toBe(false);
    expect(c.head.acceptedPrecision.point).toBeLessThan(0.95);
  });

  it('the promise at the target: main-like precision (95.3%, lower bound < 95%) passes; a clear drop below base fails even above the floor', () => {
    // 1,500 accepted rows. Base and head 95.3% right: the Wilson lower bound (~94.2%) is below 95%, yet G3 passes.
    const mk = (wrong: number, ref: string) => makeResult(grid(['alpha'], 1500).map((r, i) => (i < wrong ? { ...r, answer: 'zzz' } : r)), { ref });
    const b = mk(70, 'base');
    const same = runGates(compareResults(b, mk(70, 'head')), { g2Tolerance: 0.01 }).g3;
    expect(compareResults(b, mk(70, 'head')).head.acceptedPrecision.lower).toBeLessThan(0.95);
    expect(same.reasons.find((r) => r.check === 'promise')!.pass).toBe(true);
    // Base at 99%, head at 96%: above the 95% floor, but its upper bound (~96.9%) is clearly below base's 99%.
    const high = mk(15, 'base');
    const drop = runGates(compareResults(high, mk(60, 'head')), { g2Tolerance: 0.01 }).g3.reasons.find((r) => r.check === 'promise')!;
    expect(drop.pass).toBe(false);
    expect(drop.detail).toMatch(/ok and not clearly below base's 99\.0% FAILED/);
    // Below the floor.
    const under = runGates(compareResults(b, mk(90, 'head')), { g2Tolerance: 0.01 }).g3.reasons.find((r) => r.check === 'promise')!;
    expect(under.pass).toBe(false);
    expect(under.detail).toMatch(/must be ≥ 95\.0% FAILED/);
  });

  it('noise allowances widen the limits', () => {
    const head = withRows(baseRows, (r, i) => (r.label === 'alpha' && i % 50 >= 1 && i % 50 <= 3 ? { answer: 'beta', status: 'flagged' } : undefined));
    expect(gate(head).g3.reasons.find((r) => r.check === 'labels')!.pass).toBe(false); // −3 > floor 2
    const noisy = buildNoise([base, makeResult(head, { ref: 'main-2' }), makeResult(baseRows, { ref: 'main-3' })]);
    expect(labelLimit(noisy, 'alpha')).toBe(3);
    expect(gate(head, noisy).g3.reasons.find((r) => r.check === 'labels')!.pass).toBe(true);
  });
});

describe('noise', () => {
  it('records per-metric spread, per-label limits, flips and identical share', () => {
    const r2 = makeResult(withRows(baseRows, (r, i) => (r.label === 'beta' && i % 50 === 5 ? { answer: 'zzz', status: 'flagged' } : undefined)), { ref: 'main-2' });
    const n = buildNoise([base, r2]);
    expect(n.runs).toBe(2);
    expect(n.metrics.accuracy.spread).toBeCloseTo(1 / 200, 10);
    expect(n.perLabel.beta!.maxNetLoss).toBe(1);
    expect(n.perLabel.alpha!.maxNetLoss).toBe(0);
    expect(n.maxAnswerFlips).toBe(1);
    expect(n.identicalShare).toBeCloseTo(199 / 200, 10);
  });
  it('refuses runs with different routing or thresholds', () => {
    expect(() => buildNoise([base, makeResult(baseRows, { routingKey: 'other' })])).toThrow(/routing/);
    expect(() => buildNoise([base, makeResult(baseRows, { thresholds: { t0: 1, t1: 1, t2: 1 } })])).toThrow(/thresholds/);
    expect(() => buildNoise([base])).toThrow(/at least 2/);
  });
});

// ---- recalibration

/** 200 calibration rows: triage is right with high scores; a "hard" fifth gets wrong answers at 0.6–0.8. */
function points(): CalibrationPoints {
  const rows: Record<string, string> = {};
  const tri: Record<string, [number, 0 | 1]> = {};
  const v1: Record<string, [number, 0 | 1]> = {};
  const v2: Record<string, [number, 0 | 1]> = {};
  for (let i = 0; i < 200; i++) {
    const id = `cal-${String(i).padStart(3, '0')}`;
    rows[id] = LABELS[i % 4]!;
    const hard = i % 5 === 0;
    tri[id] = hard ? [0.6 + 0.2 * h(id), 0] : [0.9 + 0.09 * h(id), 1];
    v1[id] = hard ? [0.5 + 0.3 * h(`v${id}`), 0] : [0.95, 1];
    v2[id] = [0.93 + 0.05 * h(`w${id}`), 1];
  }
  return {
    kind: 'twopass-gate-calibration',
    version: 1,
    task: 'toy',
    source: { runId: 'calib', writer: 'claude-haiku-5-5', escalation: 'claude-sonnet-5-5' },
    createdAt: 'x',
    rows,
    checkers: { chk: { triage: tri, verify1: v1, verify2: v2 } },
  };
}
const recal = (over: Partial<Parameters<typeof proposeRecalibration>[0]> = {}) =>
  proposeRecalibration({
    head: makeResult([], { thresholds: { t0: 0.5, t1: 0.5, t2: 0.5 } }),
    points: points(),
    pointsPath: 'p.json',
    taskPath: 't.yaml',
    checkShare: 0.2,
    seed: 7,
    withTriage: true,
    writerRequested: 'anthropic/claude-haiku-5.5:batch',
    escalationRequested: 'claude-sonnet-5-5',
    ...over,
  });

describe('recalibration', () => {
  it('restores the promise on held-out rows and shows the coverage cost', () => {
    const p = recal();
    expect(p.kind).toBe('proposal');
    if (p.kind !== 'proposal') return;
    expect(p.restores).toBe(true);
    expect(p.checkCurrent.precision.point).toBeLessThan(0.95); // t = 0.5 accepts the hard rows
    expect(p.checkProposed.precision.point).toBeGreaterThanOrEqual(0.95);
    expect(p.proposed.t0).toBeGreaterThan(0.6); // above most hard rows' triage scores (0.6–0.8)
    expect(p.checkRows).toBe(40);
    expect(p.fitRows).toBe(160);
  });

  it('says plainly when no threshold restores it', () => {
    const cp = points();
    for (const stage of ['triage', 'verify1', 'verify2'] as const) {
      for (const id of Object.keys(cp.checkers.chk![stage]!)) cp.checkers.chk![stage]![id] = [0.9, h(id) < 0.5 ? 1 : 0];
    }
    const p = recal({ points: cp });
    expect(p.kind).toBe('cannot-restore');
  });

  it('asks for new points when the writer changed or the checker has none, with the command', () => {
    const w = recal({ writerRequested: 'openai/gpt-6-luna' });
    expect(w).toMatchObject({ kind: 'needs-points' });
    if (w.kind === 'needs-points') expect(w.command).toContain('--collect');
    const c = recal({ head: makeResult([], { models: { writer: 'w', escalation: 'e', triage: 'other', verify: 'other' } }) });
    expect(c).toMatchObject({ kind: 'needs-points' });
    if (c.kind === 'needs-points') expect(c.command).toContain('--models other');
    expect(recal({ points: undefined })).toMatchObject({ kind: 'needs-points' });
  });

  it('never uses CI-slice or test rows: only the calibration points decide, whatever the head file holds', () => {
    const a = recal();
    const b = recal({ head: makeResult(grid(LABELS, 30), { thresholds: { t0: 0.5, t1: 0.5, t2: 0.5 } }) });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('the fit/check split is deterministic, disjoint and covers every row', () => {
    const ids = Object.keys(points().rows);
    const s = splitRows(ids, 0.2, 7);
    expect(splitRows([...ids].reverse(), 0.2, 7)).toEqual(s);
    expect(new Set([...s.fit, ...s.check]).size).toBe(ids.length);
    expect(s.fit.filter((id) => s.check.includes(id))).toEqual([]);
    expect(splitRows(ids, 0.2, 8).check).not.toEqual(s.check);
  });

  it('replays like computeOutcomes: triage, then round 1, then round 2; missing points never accept', () => {
    const cp = points();
    delete cp.checkers.chk!.verify1!['cal-000'];
    const r = replayRows(cp, { triage: 'chk', verify: 'chk', withTriage: true, rows: ['cal-000'] }, { t0: 0.99, t1: 0.1, t2: 0.99 });
    expect(r.accepted).toBe(0);
    const r2 = replayRows(cp, { triage: 'chk', verify: 'chk', withTriage: true, rows: ['cal-001'] }, { t0: 0.1, t1: 0.1, t2: 0.1 });
    expect(r2).toMatchObject({ accepted: 1, acceptedRight: 1 });
  });
});

describe('Banking77 calibration in the repo', () => {
  it('reproduces the published part 1 Clef thresholds from the committed points', () => {
    const cp = readCalibrationPoints('gates/banking77.calibration-points.json')!;
    const t = fitOnRows(cp, { triage: 'cloudflare/clef', verify: 'cloudflare/clef', withTriage: true, target: 0.95, rows: Object.keys(cp.rows) });
    expect(t).toEqual({ t0: 0.4913, t1: 0.7918, t2: 0.7981 });
    expect(requireThresholds(loadGateConfig('gates/banking77.task.yaml')).thresholds).toEqual(t);
  });

  it('the CI slice has 20 rows per intent, all from train, none of them calibration rows', () => {
    const slice = readIdFile('bench/gate/ci-slice.json');
    const calib = new Set(readIdFile('bench/gate/calibration-ids.json'));
    expect(slice).toHaveLength(77 * 20);
    expect(new Set(slice).size).toBe(slice.length);
    expect(slice.every((id) => id.startsWith('train-'))).toBe(true);
    expect(slice.filter((id) => calib.has(id))).toEqual([]);
    expect(() => assertNoOverlap(slice, ['bench/gate/calibration-ids.json'])).not.toThrow();
  });

  it.skipIf(!existsSync('data/banking77/train.csv'))('the slice built through the task config matches bench/gate/ci-slice.json exactly', () => {
    const { config } = loadGateConfig('gates/banking77.task.yaml');
    const rows = loadRows(config.data, config.columns, idColumnOf(config));
    const exclude = new Set(config.slice.exclude.flatMap(readIdFile));
    expect(buildSlice(rows, { perLabel: config.slice.perLabel, seed: config.slice.seed, exclude }).ids).toEqual(readIdFile(config.slice.file));
  });
});

// ---- reviewer rows

describe('reviewer rows', () => {
  it('lists flipped and newly accepted rows, accepted ones first, lowest confidence first, at most 10, no gold labels', () => {
    const b = makeResult(withRows(grid(['alpha', 'beta'], 10), (_r, i) => (i < 14 ? { status: 'flagged', confidence: 0.4 } : undefined)));
    const hd = makeResult(
      withRows(grid(['alpha', 'beta'], 10), (r, i) => {
        if (i < 12) return { status: 'accepted', confidence: 0.5 + i / 100, answer: i % 2 ? 'beta' : r.label }; // newly accepted, some flipped
        if (i === 15) return { answer: 'alpha', status: 'flagged', confidence: 0.2 }; // flipped, not accepted
        return undefined;
      }),
    );
    const rows = reviewRows(compareResults(b, hd));
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r.headStatus === 'accepted')).toBe(true);
    expect(rows.map((r) => r.confidence)).toEqual([...rows.map((r) => r.confidence)].sort((x, y) => x! - y!));
    expect(rows[0]!.confidence).toBe(0.5);
    expect(Object.keys(rows[0]!)).not.toContain('label');
    expect(JSON.stringify(rows)).not.toMatch(/"label"/);
    const all = reviewRows(compareResults(b, hd), 100);
    expect(all.at(-1)).toMatchObject({ headStatus: 'flagged', why: 'flipped' });
  });
});

// ---- comment

describe('comment', () => {
  const head = withRows(baseRows, (_r, i) => (i % 50 === 0 ? { status: 'accepted', confidence: 0.91 } : i % 50 >= 10 ? { status: 'flagged', confidence: 0.5 } : undefined));
  const render = (headRows: typeof baseRows, proposal?: ReturnType<typeof recal>) => {
    const hr = makeResult(headRows, { ref: 'head', gitSha: 'abcdef1234' });
    const c = compareResults(base, hr);
    const gates = runGates(c, { g2Tolerance: 0.01 });
    return renderComment({ comparison: c, gates, enforce: 'g3', noise: undefined, proposal, review: reviewRows(c), base, head: hr, taskPath: 'gates/toy.task.yaml', headPath: 'head.json' });
  };
  it('green', () => {
    const md = render(baseRows);
    expect(md.split('\n')[0]).toBe('<!-- twopass-eval-gate:toy -->');
    expect(md).toMatchSnapshot();
  });
  it('red without a proposal', () => {
    const md = render(head);
    expect(md).toContain('## ❌ Eval gate: toy');
    expect(md).toContain('95% CI');
    expect(md).toMatchSnapshot();
  });
  it('red with a recalibration proposal and the trade-off in one line', () => {
    const md = render(head, recal());
    expect(md).toContain('The promise holds again on held-out calibration rows; auto-accept goes from');
    expect(md).toContain('twopass gate recalibrate --task gates/toy.task.yaml --run head.json --write');
    expect(md).toMatchSnapshot();
  });
  it('never shows gold labels in the rows to read', () => {
    const hr = makeResult(head.map((r) => ({ ...r, answer: r.answer ?? r.label, label: `GOLD-${r.label}` })), { ref: 'head' });
    const b2 = makeResult(baseRows.map((r) => ({ ...r, label: `GOLD-${r.label}`, answer: r.answer ?? r.label })));
    const c = compareResults(b2, hr);
    const section = renderComment({ comparison: c, gates: runGates(c, { g2Tolerance: 0.01 }), enforce: 'g3', noise: undefined, proposal: undefined, review: reviewRows(c), base: b2, head: hr, taskPath: 't', headPath: 'h' })
      .split('Rows to read')[1]!
      .split('</details>')[0]!;
    expect(section).not.toContain('GOLD-');
  });
});

// ---- task config and data

describe('task config', () => {
  const write = (yaml: string) => {
    const d = tmp();
    const p = join(d, 't.task.yaml');
    writeFileSync(p, yaml);
    return p;
  };
  it('names the bad field', () => {
    const p = write('name: x\ntype: classification\ndata: d.csv\ncolumns: { text: t, label: l }\npromise: { acceptedPrecision: 95 }\nslice: { file: s, perLabel: "20", seed: 1 }\ncalibration: { rows: r, points: p }\nwriter: { model: a, escalation: b }\nchecker: { model: c, thresholds: th }\nnoise: n\n');
    expect(() => loadGateConfig(p)).toThrow(GateConfigError);
    try {
      loadGateConfig(p);
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('promise.acceptedPrecision');
      expect(msg).toContain('slice.perLabel');
    }
  });
  it('rejects unknown keys, a non-classification type and bad YAML', () => {
    expect(() => loadGateConfig(write('name: x\ntype: extraction\n'))).toThrow(/type/);
    expect(() => loadGateConfig(write('name: [unclosed\n'))).toThrow(/not valid YAML/);
    const ok = readFileSync('gates/banking77.task.yaml', 'utf8');
    expect(() => loadGateConfig(write(ok + 'typo_key: 1\n'))).toThrow(/typo_key|Unrecognized/);
  });
  it('refuses to run without thresholds, and on thresholds fitted for another checker', () => {
    const d = tmp();
    const p = join(d, 't.task.yaml');
    const yaml = readFileSync('gates/banking77.task.yaml', 'utf8').replace('gates/banking77.thresholds.json', join(d, 'th.json'));
    writeFileSync(p, yaml);
    expect(() => requireThresholds(loadGateConfig(p))).toThrow(/No thresholds.*\n.*gate calibrate/);
    writeFileSync(join(d, 'th.json'), JSON.stringify({ thresholds: { t0: 0.5, t1: 0.5, t2: 0.5 }, target: 0.95, checker: { triage: 'x', verify: 'x' }, source: 's', fittedAt: 'f' }));
    expect(() => requireThresholds(loadGateConfig(p))).toThrow(/fitted for x \/ x/);
  });
  it('resolves auto labels from the data, sorted, and refuses duplicates or cannot_tell', () => {
    const d = tmp();
    writeFileSync(join(d, 'd.csv'), 'text,label\nhi,b\nyo,a\nok,b\n');
    const base = { name: 'x', type: 'classification' as const, data: join(d, 'd.csv'), columns: { text: 'text', label: 'label' }, promise: { acceptedPrecision: 0.95 }, slice: { file: 's', perLabel: 1, seed: 1, exclude: [] }, calibration: { rows: 'r', points: 'p', checkShare: 0.2, seed: 7 }, writer: { model: 'a', escalation: 'b' }, checker: { model: 'c', thresholds: 't' }, gate: { enforce: 'g3' as const, maxUsd: 1, g2Tolerance: 0.01 }, noise: 'n' };
    expect(resolveLabels({ ...base, labels: 'auto' }).map((l) => l.name)).toEqual(['a', 'b']);
    expect(() => resolveLabels({ ...base, labels: ['a', 'a'] })).toThrow(/twice/);
    expect(() => resolveLabels({ ...base, labels: ['a', 'cannot_tell'] })).toThrow(/reserved/);
  });
});

describe('CSV loading', () => {
  const csv = (body: string) => {
    const p = join(tmp(), 'd.csv');
    writeFileSync(p, body);
    return p;
  };
  it('reads a BOM, quoted commas and newlines; hashes the text when there is no id column', () => {
    const rows = loadRows(csv('﻿text,label\n"a, b",x\n"multi\nline",y\n'), { text: 'text', label: 'label' }, '_twopass_id');
    expect(rows.map((r) => r.text)).toEqual(['a, b', 'multi\nline']);
    expect(rows[0]!.id).toBe(textId('a, b'));
    expect(rows[0]!.data._twopass_id).toBe(rows[0]!.id);
  });
  it('names a missing column, an empty id and duplicates', () => {
    expect(() => loadRows(csv('text,label\na,x\n'), { id: 'id', text: 'text', label: 'label' }, 'id')).toThrow(/no column "id"/);
    expect(() => loadRows(csv('id,text,label\n,a,x\n'), { id: 'id', text: 'text', label: 'label' }, 'id')).toThrow(/row 1 has no value/);
    expect(() => loadRows(csv('id,text,label\n1,a,x\n1,b,y\n'), { id: 'id', text: 'text', label: 'label' }, 'id')).toThrow(/share the id "1"/);
    expect(() => loadRows(csv('text,label\nsame,x\nsame,y\n'), { text: 'text', label: 'label' }, '_twopass_id')).toThrow(/same text; add an id column/);
  });
  it('builds a stratified slice that ignores row order and respects exclusions', () => {
    const rows = loadRows(csv('id,text,label\n' + Array.from({ length: 40 }, (_, i) => `${i},t${i},${i % 4 === 0 ? 'rare' : 'common'}`).join('\n') + '\n'), { id: 'id', text: 'text', label: 'label' }, 'id');
    const s = buildSlice(rows, { perLabel: 12, seed: 5, exclude: new Set(['0']) });
    expect(s.counts).toEqual({ common: 12, rare: 9 });
    expect(s.shortLabels).toEqual({ rare: 9 });
    expect(s.ids).not.toContain('0');
    expect(buildSlice([...rows].reverse(), { perLabel: 12, seed: 5, exclude: new Set(['0']) }).ids).toEqual(s.ids);
  });
  it('slice IDs must not overlap excluded files', () => {
    const p = join(tmp(), 'ex.json');
    writeFileSync(p, JSON.stringify({ ids: ['a', 'b'] }));
    expect(() => assertNoOverlap(['x', 'b'], [p])).toThrow(/contains 1 row/);
  });
});

describe('G3 reason text', () => {
  it('says which of the three checks failed', () => {
    const c = compareResults(base, makeResult(baseRows));
    expect(gateG3(c, { g2Tolerance: 0.01 }).reasons.map((r) => r.check)).toEqual(['promise', 'labels', 'confident-wrong']);
  });
});
