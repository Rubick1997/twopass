import { describe, expect, it } from 'vitest';
import type { ExtractReviewCounts, FieldItem } from '../src/ui/api-types.ts';
import {
  adjustExtractCounts,
  applyFieldDecision,
  decisionForItem,
  highlightSegments,
  keyToExtractAction,
  nextUnreviewedItem,
  normaliseSelection,
} from '../ui/src/review-extract.ts';

const item = (over: Partial<FieldItem> = {}): FieldItem => ({
  docId: 'd1', field: 'a', status: 'flagged', pipelineStatus: 'flagged', value: 'A1', finalValue: 'A1', round: 2, verdict: 'unsupported',
  acceptable: true, round1: null, round2: null, expected: ['A1'], valueCorrect: true, finalCorrect: true, review: null, ...over,
});
const counts: ExtractReviewCounts = { fields: 10, documents: 3, flagged: 4, reviewed: 0, remaining: 4, reviewedOther: 0, overridden: 0 };

describe('highlightSegments', () => {
  it('marks round 1, round 2 and both, and merges neighbours', () => {
    const text = 'abcdefghij';
    expect(highlightSegments(text, [[1, 4]], [[3, 6]])).toEqual([
      { text: 'a', kind: 'plain' },
      { text: 'bc', kind: 'r1' },
      { text: 'd', kind: 'both' },
      { text: 'ef', kind: 'r2' },
      { text: 'ghij', kind: 'plain' },
    ]);
    expect(highlightSegments(text, [], [])).toEqual([{ text, kind: 'plain' }]);
    expect(highlightSegments('', [], [])).toEqual([]);
    expect(highlightSegments(text, [[0, 2], [2, 4]], [])).toEqual([{ text: 'abcd', kind: 'r1' }, { text: 'efghij', kind: 'plain' }]);
    expect(highlightSegments('abc', [[2, 99]], []).map((s) => s.text).join('')).toBe('abc'); // clamped
  });
});

describe('keys and decisions', () => {
  it('maps the extraction keys, and nothing while typing or with a modifier', () => {
    expect(['j', 'k', 'a', 'o', 'x', 's', 'u', 'n', 'f', 'l', '?'].map((key) => keyToExtractAction({ key })?.type)).toEqual([
      'next', 'prev', 'accept', 'override', 'absent', 'selection', 'undo', 'note', 'filter', 'label', 'help',
    ]);
    expect(keyToExtractAction({ key: '1' })).toBeNull();
    expect(keyToExtractAction({ key: 'a', typing: true })).toBeNull();
    expect(keyToExtractAction({ key: 'a', metaKey: true })).toBeNull();
  });

  it('picking the pipeline’s own value is an accept; null and text are overrides', () => {
    expect(decisionForItem(item(), 'A1', ' n ')).toEqual({ rowId: 'd1', field: 'a', action: 'accept', note: 'n' });
    expect(decisionForItem(item(), 'B')).toEqual({ rowId: 'd1', field: 'a', action: 'override', answer: 'B' });
    expect(decisionForItem(item(), null)).toEqual({ rowId: 'd1', field: 'a', action: 'override', answer: null });
    expect(decisionForItem(item({ value: null }), null)).toMatchObject({ action: 'accept' });
    expect(decisionForItem(item({ acceptable: false, value: null }), null)).toMatchObject({ action: 'override', answer: null });
  });

  it('normalises a selection to one line', () => {
    expect(normaliseSelection('  John\n  Smith \t Jr ')).toBe('John Smith Jr');
  });

  it('applies a decision optimistically and moves the counts, and the rollback restores them', () => {
    const before = item();
    const after = applyFieldDecision(before, { rowId: 'd1', field: 'a', action: 'override', answer: null }, 'now');
    expect(after).toMatchObject({ status: 'reviewed', finalValue: null, finalCorrect: null, review: { action: 'override', value: null, previous: 'A1' } });
    const c = adjustExtractCounts(counts, before, after);
    expect(c).toMatchObject({ reviewed: 1, remaining: 3, overridden: 1 });
    expect(adjustExtractCounts(c, after, before)).toEqual(counts);
    const undone = applyFieldDecision(after, { rowId: 'd1', field: 'a', action: 'clear' }, 'now');
    expect(undone).toMatchObject({ status: 'flagged', finalValue: 'A1', review: null });
    const accepted = applyFieldDecision(before, { rowId: 'd1', field: 'a', action: 'accept' }, 'now');
    expect(adjustExtractCounts(counts, before, accepted)).toMatchObject({ reviewed: 1, overridden: 0 });
    const other = item({ pipelineStatus: 'accepted', status: 'accepted' });
    expect(adjustExtractCounts(counts, other, applyFieldDecision(other, { rowId: 'd1', field: 'a', action: 'accept' }, 'now'))).toMatchObject({ reviewedOther: 1, reviewed: 0 });
  });

  it('after a decision the next unreviewed field opens, wrapping around', () => {
    const decided = applyFieldDecision(item(), { rowId: 'd1', field: 'a', action: 'accept' }, 'now');
    const items = [item({ field: 'a' }), decided, item({ field: 'c' })];
    expect(nextUnreviewedItem(items, 0)).toBe(2);
    expect(nextUnreviewedItem(items, 2)).toBe(0);
    expect(nextUnreviewedItem([decided], 0)).toBe(0);
  });
});
