import { describe, expect, it } from 'vitest';
import type { Answer } from '../src/decide/model.ts';
import { buildExtractReport, fieldCsvRecords, headline, renderExtractReport } from '../src/extract/report.ts';
import { computeFieldOutcomes } from '../src/extract/outcomes.ts';
import { customId, replay, type LedgerEvent } from '../src/ledger.ts';
import { toyTask } from './extract-helpers.ts';

// A hand-built ledger. Gold (a / b / c):
//   D1  x1 / x2 / -        D2  y1 / y2 / y3        D3  z1 / - / z3        D4  w1 / w2 / w3
// Round 1 (cheap writer): D1 all right; D2 b wrong (BAD); D3 b = junk (gold absent) and c = null (gold present);
//   D4 reply is not JSON.
// Round-1 verdicts, p(supported): D1 .95 .95 .95 | D2 .95 .95(wrong, confident) .5 | D3 .95 .2 .3 (cannot_tell)
// Round 2 (strong writer) for D2, D3, D4, every field right; verdicts only for the fields asked:
//   D2 c .95 | D3 b .95, c .5 | D4 a .95, b .95, c .1 (unsupported)
const at = '2026-11-14T10:00:00.000Z';
const gold = (a: string[], b: string[], c: string[]) => JSON.stringify({ a, b, c });
const rows = [
  { id: 'D1', data: { doc_id: 'D1', text: 'D1', gold: gold(['x1'], ['x2'], []) } },
  { id: 'D2', data: { doc_id: 'D2', text: 'D2', gold: gold(['y1'], ['y2'], ['y3']) } },
  { id: 'D3', data: { doc_id: 'D3', text: 'D3', gold: gold(['z1'], [], ['z3']) } },
  { id: 'D4', data: { doc_id: 'D4', text: 'D4', gold: gold(['w1'], ['w2'], ['w3']) } },
];

const ans = (choice: string, pSupported: number): Answer => ({
  type: 'choice',
  choice,
  probabilities: { supported: pSupported, unsupported: 1 - pSupported, cannot_tell: 0 },
  confidence: 1,
});
const S = (p: number) => ans('supported', p);

const submitted = (round: 1 | 2, batchId: string, model: string, ids: string[]): LedgerEvent => ({ t: 'batch_submitted', round, batchId, model, customIds: ids.map((i) => customId(i, round)), at });
const result = (round: 1 | 2, batchId: string, model: string, rowId: string, text: string): LedgerEvent => ({
  t: 'batch_result', batchId, round, model, customId: customId(rowId, round), rowId, ok: true, text, inputTokens: 1, outputTokens: 1, costUsd: 0, at,
});
const finished = (batchId: string, costUsd: number): LedgerEvent => ({ t: 'batch_finished', batchId, status: 'completed', costUsd, undecodable: 0, at });
const decision = (rowId: string, round: 1 | 2, answers: Record<string, Answer>, costUsd: number): LedgerEvent => ({
  t: 'decision', rowId, round, stage: 'verify', model: 'dec', answers, costUsd, latencyMs: 1, at,
});
const j = (a: string | null, b: string | null, c: string | null) => JSON.stringify({ a, b, c });

const normalEvents: LedgerEvent[] = [
  submitted(1, 'b1', 'cheap', ['D1', 'D2', 'D3', 'D4']),
  result(1, 'b1', 'cheap', 'D1', j('x1', 'x2', null)),
  result(1, 'b1', 'cheap', 'D2', j('y1', 'BAD', 'y3')),
  result(1, 'b1', 'cheap', 'D3', j('z1', 'junk', null)),
  result(1, 'b1', 'cheap', 'D4', 'oops'),
  finished('b1', 0.04),
  decision('D1', 1, { a: S(0.95), b: S(0.95), c: S(0.95) }, 0.01),
  decision('D2', 1, { a: S(0.95), b: S(0.95), c: S(0.5) }, 0.01),
  decision('D3', 1, { a: S(0.95), b: ans('unsupported', 0.2), c: ans('cannot_tell', 0.3) }, 0.01),
  submitted(2, 'b2', 'strong', ['D2', 'D3', 'D4']),
  result(2, 'b2', 'strong', 'D2', j('y1', 'y2', 'y3')),
  result(2, 'b2', 'strong', 'D3', j('z1', null, 'z3')),
  result(2, 'b2', 'strong', 'D4', j('w1', 'w2', 'w3')),
  finished('b2', 0.12),
  decision('D2', 2, { c: S(0.95) }, 0.02),
  decision('D3', 2, { b: S(0.95), c: S(0.5) }, 0.02),
  decision('D4', 2, { a: S(0.95), b: S(0.95), c: ans('unsupported', 0.1) }, 0.02),
];
const baselineEvents: LedgerEvent[] = [
  submitted(1, 'bb', 'opus', ['D1', 'D2', 'D3', 'D4']),
  result(1, 'bb', 'opus', 'D1', j('X1', 'x2', null)), // right when normalised, not exact
  result(1, 'bb', 'opus', 'D2', j('y1', 'y2', 'y3')),
  result(1, 'bb', 'opus', 'D3', j('z1', 'junk', 'z3')), // junk where the gold is blank
  result(1, 'bb', 'opus', 'D4', j('w1', 'w2', 'w3')),
  finished('bb', 0.4),
];

const normal = replay(normalEvents);
const baseline = replay(baselineEvents);
const thresholds = { t0: 1.01, t1: 0.9, t2: 0.9 };
const r1Answers = new Map(normalEvents.flatMap((e) => (e.t === 'decision' && e.round === 1 ? [[e.rowId, e.answers] as const] : [])));

const report = buildExtractReport({
  benchId: 'b',
  createdAt: at,
  split: 'test',
  task: toyTask,
  rows,
  normal,
  baseline,
  thresholds,
  thresholdsSource: 'calibration c',
  decisionModel: 'dec',
  baselineModel: 'opus',
  checkers: [{ model: 'dec', threshold: 0.9, answers: r1Answers }],
  calibration: { runId: 'c', documents: 300, models: { dec: { verify1: { slots: 1800, wrong: 90 } } } },
  target: 0.95,
});

describe('extract report maths', () => {
  it('full: 10 of 12 accepted, one confident wrong, two flagged and both right', () => {
    const f = report.configs.full;
    expect(f.fields).toBe(12);
    expect(f.accepted).toBe(10);
    expect(f.acceptedShare).toBeCloseTo(10 / 12);
    expect(f.precision).toBeCloseTo(9 / 10);
    expect(f.confidentWrong).toBe(1); // D2 b: wrong, accepted at .95
    expect(f.confidentWrongShare).toBeCloseTo(1 / 12);
    expect(f.flagged).toBe(2);
    expect(f.flaggedOwnRight).toBe(1); // D3 c = z3 and D4 c = w3 are both right
    expect(f.accuracy).toBeCloseTo(11 / 12);
  });

  it('simple: round 2 ignored, unaccepted fields flagged with the round-1 value', () => {
    const s = report.configs.simple;
    expect(s.accepted).toBe(6); // D1 x3, D2 a b, D3 a
    expect(s.precision).toBeCloseTo(5 / 6);
    expect(s.confidentWrong).toBe(1);
    expect(s.flagged).toBe(6); // D2 c, D3 b c, D4 a b c
    expect(s.flaggedShare).toBeCloseTo(0.5);
    expect(s.flaggedOwnRight).toBeCloseTo(1 / 6); // only D2 c = y3
    expect(s.accuracy).toBeCloseTo(6 / 12);
  });

  it('writer alone: round-1 values; an unusable reply counts as wrong', () => {
    const w = report.configs.writerAlone;
    expect(w.unusableDocuments).toBe(1);
    expect(w.accuracy).toBeCloseTo(6 / 12); // D1 3, D2 2, D3 1, D4 0
    expect(w.exactAccuracy).toBeCloseTo(6 / 12);
  });

  it('baseline: every field accepted; normalised and exact match differ by one case-only value', () => {
    const b = report.configs.baseline;
    expect(b.accepted).toBe(12);
    expect(b.confidentWrong).toBe(1); // D3 b = junk
    expect(b.precision).toBeCloseTo(11 / 12);
    expect(b.accuracy).toBeCloseTo(11 / 12);
    expect(b.exactAccuracy).toBeCloseTo(10 / 12); // 'X1' is not exactly 'x1'
  });

  it('cost per 1,000 documents by stage; simple counts only round-1 stages', () => {
    const full = report.configs.full.costPer1kDocuments;
    expect(full.write1).toBeCloseTo(10); // $0.04 over 4 documents
    expect(full.verify1).toBeCloseTo(7.5);
    expect(full.write2).toBeCloseTo(30);
    expect(full.verify2).toBeCloseTo(15);
    expect(full.total).toBeCloseTo(62.5);
    expect(report.configs.full.costPer1kFields.total).toBeCloseTo(250 / 12);
    const simple = report.configs.simple;
    expect(simple.costPer1kDocuments).toMatchObject({ write2: 0, verify2: 0 });
    expect(simple.costPer1kDocuments.total).toBeCloseTo(17.5);
    expect(simple.costPer1kFields.total).toBeCloseTo(70 / 12);
    expect(report.configs.baseline.costPer1kDocuments.total).toBeCloseTo(100);
    expect(report.configs.writerAlone.costPer1kDocuments.total).toBeCloseTo(10);
  });

  it('splits full by gold present vs absent', () => {
    // absent slots: D1 c, D3 b. present: the other 10.
    const { present, absent } = report.presence.full;
    expect(absent.fields).toBe(2);
    expect(absent.accepted).toBe(2);
    expect(absent.precision).toBe(1);
    expect(present.fields).toBe(10);
    expect(present.accepted).toBe(8);
    expect(present.confidentWrong).toBe(1);
    expect(present.flagged).toBe(2);
    // simple: D1 c (acc, right), D3 b flagged with junk
    expect(report.presence.simple.absent).toMatchObject({ fields: 2, accepted: 1, flagged: 1, flaggedOwnRight: 0 });
  });

  it('splits by field', () => {
    expect(report.perField.full.a).toMatchObject({ fields: 4, accepted: 4, confidentWrong: 0 });
    expect(report.perField.full.b).toMatchObject({ fields: 4, accepted: 4, confidentWrong: 1 });
    expect(report.perField.full.c).toMatchObject({ fields: 4, accepted: 2, flagged: 2 });
    expect(report.perField.simple.a).toMatchObject({ accepted: 3, flagged: 1 });
  });

  it('per checker, round 1 only: acceptance, precision, confident wrong and cannot_tell by proposal kind', () => {
    const [c] = report.checkers;
    expect(c).toMatchObject({ model: 'dec', slots: 9, accepted: 6, confidentWrong: 1 });
    expect(c!.precision).toBeCloseTo(5 / 6);
    expect(c!.cannotTell.value).toMatchObject({ proposals: 7, cannotTell: 0 });
    expect(c!.cannotTell.null).toMatchObject({ proposals: 2, cannotTell: 1 });
    expect(c!.cannotTell.null.share).toBeCloseTo(0.5);
  });

  it('writes the headline in the part-1 shape, and flags a dev report', () => {
    expect(headline(report)).toBe('**12 fields · 83% accepted at 90% precision · 2 sent to a person · $20.83 per 1,000 fields**');
    const md = renderExtractReport(report);
    expect(md.split('\n')[0]).toBe(headline(report));
    expect(md).toContain('1,800');
    expect(md).toContain('| dec | verify1 | 1,800 | 90 |');
    const dev = buildExtractReport({ ...{ benchId: 'b', createdAt: at, split: 'dev' as const, task: toyTask, rows, normal, baseline, thresholds, thresholdsSource: 's', decisionModel: 'dec', baselineModel: 'opus', checkers: [], calibration: { runId: 'c', documents: 15, models: {} }, target: 0.95 } });
    expect(renderExtractReport(dev).split('\n')[0]).toContain('for debugging only');
  });

  it('is pure: the same ledgers give the same report, and other thresholds change it without touching the ledgers', () => {
    const before = JSON.stringify(normalEvents);
    const strict = computeFieldOutcomes(normal, { task: toyTask, rows, thresholds: { t0: 1.01, t1: 1.01, t2: 1.01 } });
    expect(strict.some((f) => f.status === 'accepted' && f.round === 1)).toBe(false);
    expect(JSON.stringify(normalEvents)).toBe(before);
    expect(JSON.stringify(buildExtractReport({ benchId: 'b', createdAt: at, split: 'test', task: toyTask, rows, normal, baseline, thresholds, thresholdsSource: 'calibration c', decisionModel: 'dec', baselineModel: 'opus', checkers: [{ model: 'dec', threshold: 0.9, answers: r1Answers }], calibration: report.calibration, target: 0.95 }))).toBe(JSON.stringify(report));
  });
});

describe('enriched-fields.csv records', () => {
  it('one record per field slot, gold joined with " | ", formulas escaped', () => {
    const outcomes = computeFieldOutcomes(normal, { task: toyTask, rows, thresholds });
    const recs = fieldCsvRecords(outcomes, rows);
    expect(recs).toHaveLength(12);
    expect(recs[0]).toMatchObject({ doc_id: 'D1', field: 'a', value: 'x1', gold: 'x1', correct: 'true', verdict: 'supported', confidence: '0.9500', round: '1' });
    expect(recs.find((r) => r.doc_id === 'D1' && r.field === 'c')).toMatchObject({ value: '', gold: '', correct: 'true' });
    expect(recs.find((r) => r.doc_id === 'D2' && r.field === 'b')).toMatchObject({ value: 'BAD', correct: 'false' });
    const multi = [{ id: 'D9', data: { doc_id: 'D9', text: '', gold: JSON.stringify({ a: ['=SUM(1)', 'p'], b: [], c: [] }) } }];
    const out = fieldCsvRecords(
      [{ rowId: 'D9', field: 'a', value: '=SUM(1)', status: 'accepted', confidence: 1, verdict: 'supported', model: 'm', round: 1, costUsd: 0 }],
      multi,
    );
    expect(out[0]).toMatchObject({ value: "'=SUM(1)", gold: "'=SUM(1) | p", correct: 'true' });
  });
});
