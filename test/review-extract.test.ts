import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'csv-parse/sync';
import {
  activeDecisions,
  activeFieldDecisions,
  appendOverride,
  decisionInputSchema,
  makeFieldOverride,
  makeOverride,
  MAX_ANSWER_CHARS,
  OverrideError,
  readOverrides,
  type FieldPipelineState,
  type OverrideRecord,
} from '../src/overrides.ts';
import { fieldReviewLine, fieldReviewSummary, findSpans, foldFieldOverrides, MAX_SPANS, writeFieldOutputs } from '../src/extract/review.ts';
import type { FieldOutcome } from '../src/extract/outcomes.ts';
import { loadTask } from '../src/task.ts';
import { toyTask } from './extract-helpers.ts';
import { tempDir } from './helpers.ts';
import { TASK } from './ui-fixtures.ts';

const at = '2026-11-17T10:00:00.000Z';
const flagged: FieldPipelineState = { status: 'flagged', value: 'A1', unusable: false };
const input = (o: Record<string, unknown>) => decisionInputSchema.parse(o);
const fails = (fn: () => unknown, re: RegExp) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(OverrideError);
    expect((e as Error).message).toMatch(re);
    return;
  }
  throw new Error('did not throw');
};

describe('extraction override validation', () => {
  it('needs a field, and the field must be one of the task’s', () => {
    fails(() => makeFieldOverride(input({ rowId: 'd1', action: 'accept' }), flagged, toyTask), /which field/);
    fails(() => makeFieldOverride(input({ rowId: 'd1', field: 'zzz', action: 'accept' }), flagged, toyTask), /not a field/);
    expect(makeFieldOverride(input({ rowId: 'd1', field: 'a', action: 'accept' }), flagged, toyTask)).toMatchObject({ rowId: 'd1', field: 'a', action: 'accept', answer: 'A1', previous: 'A1', pipelineStatus: 'flagged' });
  });

  it('an unknown document is a 404-class error', () => {
    try {
      makeFieldOverride(input({ rowId: 'nope', field: 'a', action: 'accept' }), undefined, toyTask);
      throw new Error('did not throw');
    } catch (e) {
      expect((e as OverrideError).code).toBe('unknown_row');
    }
  });

  it('accepts null as "not in this document", trims text, refuses empty and too-long text', () => {
    expect(makeFieldOverride(input({ rowId: 'd1', field: 'a', action: 'override', answer: null }), flagged, toyTask)).toMatchObject({ answer: null, previous: 'A1' });
    expect(makeFieldOverride(input({ rowId: 'd1', field: 'a', action: 'override', answer: '  X 9  ', note: ' n ' }), flagged, toyTask)).toMatchObject({ answer: 'X 9', note: 'n' });
    fails(() => makeFieldOverride(input({ rowId: 'd1', field: 'a', action: 'override', answer: '   ' }), flagged, toyTask), /empty/);
    expect(() => input({ rowId: 'd1', field: 'a', action: 'override', answer: 'x'.repeat(MAX_ANSWER_CHARS + 1) })).toThrow();
    expect(input({ rowId: 'd1', field: 'a', action: 'override', answer: 'x'.repeat(MAX_ANSWER_CHARS) })).toBeTruthy();
  });

  it('cannot accept a field with no usable value; null is a value the writer can stand behind', () => {
    fails(() => makeFieldOverride(input({ rowId: 'd1', field: 'a', action: 'accept' }), { status: 'flagged', value: null, unusable: true }, toyTask), /no value/);
    fails(() => makeFieldOverride(input({ rowId: 'd1', field: 'a', action: 'accept' }), { status: 'pending', value: null, unusable: false }, toyTask), /no value/);
    expect(makeFieldOverride(input({ rowId: 'd1', field: 'c', action: 'accept' }), { status: 'flagged', value: null, unusable: false }, toyTask)).toMatchObject({ answer: null });
  });

  it('keeps the body strict: unknown keys are refused', () => {
    expect(() => input({ rowId: 'd1', field: 'a', action: 'accept', extra: 1 })).toThrow();
    expect(() => input({ rowId: 'd1', field: 'a', action: 'clear', note: 'x' })).toThrow();
  });

  it('classify runs: a field and a null answer are refused, everything else is as before', async () => {
    const task = await loadTask(TASK);
    const outcome = { rowId: 'r1', data: {}, status: 'flagged' as const, answer: 'card_linking', confidence: 0.5, verdict: 'unsupported' as const, model: 'm', round: 2 as const, costUsd: 0 };
    fails(() => makeOverride(input({ rowId: 'r1', field: 'a', action: 'accept' }), outcome, task), /only for extraction/);
    fails(() => makeOverride(input({ rowId: 'r1', action: 'override', answer: null }), outcome, task), /null/);
    expect(makeOverride(input({ rowId: 'r1', action: 'override', answer: 'age_limit' }), outcome, task)).toMatchObject({ rowId: 'r1', answer: 'age_limit', previous: 'card_linking' });
    expect(makeOverride(input({ rowId: 'r1', action: 'accept' }), outcome, task)).not.toHaveProperty('field');
    // and an extraction task refuses the row-level form
    fails(() => makeOverride(input({ rowId: 'd1', action: 'accept' }), outcome, toyTask), /per field/);
  });
});

describe('overrides.jsonl for extraction', () => {
  const field = (rowId: string, f: string, answer: string | null, extra: Partial<OverrideRecord> = {}) =>
    ({ rowId, field: f, action: 'override', answer, previous: 'old', at, ...extra }) as OverrideRecord;

  it('folds per (rowId, field): the last line wins and clear undoes', () => {
    const records: OverrideRecord[] = [
      field('d1', 'a', 'one'),
      field('d1', 'b', 'bee'),
      field('d1', 'a', 'two'),
      { rowId: 'd1', field: 'b', action: 'clear', at },
      field('d2', 'a', null),
    ];
    const active = activeFieldDecisions(records);
    expect([...active.values()].map((d) => [d.rowId, d.field, d.answer])).toEqual([['d1', 'a', 'two'], ['d2', 'a', null]]);
    expect(activeDecisions(records).size).toBe(0); // classify folding ignores field records
  });

  it('round-trips through the file, including a null answer and the clear record', () => {
    const dir = tempDir();
    appendOverride(dir, field('d1', 'a', null));
    appendOverride(dir, { rowId: 'd1', field: 'a', action: 'clear', at });
    appendOverride(dir, { rowId: 'd1', action: 'accept', answer: 'x', previous: 'x', at } as OverrideRecord); // a classify-shaped line
    const back = readOverrides(dir);
    expect(back).toHaveLength(3);
    expect(back[0]).toMatchObject({ field: 'a', answer: null });
    expect(back[2]).not.toHaveProperty('field');
  });

  const outcome = (rowId: string, f: string, value: string | null, status: FieldOutcome['status'] = 'flagged'): FieldOutcome => ({
    rowId, field: f, status, value, confidence: 0.4, verdict: 'unsupported', model: 'm', round: 2, costUsd: 0,
  });
  const gold = (o: Record<string, string[]>) => JSON.stringify(o);
  const outs = [outcome('d1', 'a', 'A1'), outcome('d1', 'b', 'WRONG'), outcome('d2', 'a', 'A1', 'accepted')];
  const labels: Record<string, string> = { d1: gold({ a: ['A1'], b: ['B1'], c: [] }), d2: gold({ a: ['A2'], b: [], c: [] }) };

  it('counts flagged / reviewed / remaining and field accuracy without and with the human', () => {
    const folded = foldFieldOverrides(outs, [field('d1', 'b', 'B1', { previous: 'WRONG' }), field('d2', 'a', 'A2', { previous: 'A1', pipelineStatus: 'accepted' })]);
    expect(folded.map((f) => [f.status, f.finalValue])).toEqual([['flagged', 'A1'], ['reviewed', 'B1'], ['reviewed', 'A2']]);
    const s = fieldReviewSummary(folded, toyTask, (id) => labels[id]);
    expect(s).toMatchObject({ fields: 3, flagged: 2, reviewed: 1, remaining: 1, reviewedOther: 1, overridden: 2 });
    expect(s.accuracy).toMatchObject({ of: 3, correctNoHuman: 1, correctWithHuman: 3 });
    expect(fieldReviewLine(s)).toBe('1 of 2 flagged fields reviewed, 1 to review · 1 other field reviewed · 2 values changed · field accuracy, no human 33.3% → with a human 100.0%');
  });

  it('--write adds reviewed_by_human, final_value and review_note, formula-escaped', () => {
    const dir = tempDir();
    const records = [
      { id: 'd1', data: { doc_id: 'd1', text: 't', gold: labels.d1! } },
      { id: 'd2', data: { doc_id: 'd2', text: 't', gold: labels.d2! } },
    ];
    const folded = foldFieldOverrides(outs, [field('d1', 'b', '=SUM(1)', { previous: 'WRONG', note: '+note' }), { ...field('d1', 'a', 'A1'), action: 'accept', previous: 'A1' } as OverrideRecord]);
    writeFieldOutputs(dir, { outcomes: outs, folded, records });
    const rows = parse(readFileSync(join(dir, 'enriched-fields.csv'), 'utf8'), { columns: true }) as Array<Record<string, string>>;
    expect(Object.keys(rows[0]!).slice(-3)).toEqual(['reviewed_by_human', 'final_value', 'review_note']);
    expect(rows.map((r) => r.reviewed_by_human)).toEqual(['accepted', 'overridden', '']);
    expect(rows[1]).toMatchObject({ value: 'WRONG', final_value: "'=SUM(1)", review_note: "'+note" });
    expect(rows[2]).toMatchObject({ final_value: 'A1', review_note: '' });
  });
});

describe('findSpans', () => {
  const text = 'Registrant: Acme  Corp.\nSigned by ACME CORP and acme\ncorp again';
  it('is case-insensitive and lets any run of whitespace match', () => {
    const spans = findSpans(text, 'Acme Corp');
    expect(spans.map(([a, b]) => text.slice(a, b))).toEqual(['Acme  Corp', 'ACME CORP', 'acme\ncorp']);
  });
  it('finds every occurrence, treats regex characters literally, and ignores null and blank values', () => {
    expect(findSpans('a.b a.b axb', 'a.b')).toEqual([[0, 3], [4, 7]]);
    expect(findSpans('x (1) y', '(1)')).toEqual([[2, 5]]);
    expect(findSpans(text, null)).toEqual([]);
    expect(findSpans(text, '  ')).toEqual([]);
    expect(findSpans(text, 'absent')).toEqual([]);
  });
  it('trims the value and caps the count', () => {
    expect(findSpans('ab', '  ab  ')).toEqual([[0, 2]]);
    const many = findSpans('x '.repeat(50), 'x');
    expect(many).toHaveLength(MAX_SPANS);
    expect(findSpans('x '.repeat(50), 'x', 3)).toHaveLength(3);
  });
});
