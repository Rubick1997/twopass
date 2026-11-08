import { describe, expect, it } from 'vitest';
import type { ReviewCounts, ReviewRow } from '../src/ui/api-types.ts';
import { parseHash, reviewHref } from '../ui/src/hooks.ts';
import {
  adjustTotals,
  announce,
  applyDecision,
  decisionFor,
  filterLabels,
  isTypingTarget,
  keyToAction,
  nextFilter,
  nextUnreviewed,
} from '../ui/src/review.ts';

const row = (rowId: string, o: Partial<ReviewRow> = {}): ReviewRow => ({
  rowId,
  status: 'flagged',
  pipelineStatus: 'flagged',
  input: { text: 'x' },
  expected: 'b',
  answer: 'a',
  acceptable: true,
  finalAnswer: 'a',
  verdict: 'cannot_tell',
  round: 2,
  model: 'm',
  confidence: 0.4,
  costUsd: 0,
  rounds: [],
  triage: null,
  review: null,
  ...o,
});
const NOW = '2026-11-08T10:00:00.000Z';

describe('review keyboard', () => {
  it('maps single keys to actions', () => {
    const k = (key: string) => keyToAction({ key })?.type ?? null;
    expect(['j', 'ArrowDown', 'k', 'ArrowUp', 'a', 'o', 'u', 'n', 'f', 'l', '?', 'x', 'Enter'].map(k)).toEqual([
      'next', 'next', 'prev', 'prev', 'accept', 'override', 'undo', 'note', 'filter', 'label', 'help', null, null,
    ]);
    expect(keyToAction({ key: '2' })).toEqual({ type: 'pick', index: 1 });
    expect(keyToAction({ key: '4' })).toBeNull();
  });

  it('does nothing while typing or with a modifier held', () => {
    expect(keyToAction({ key: 'a', typing: true })).toBeNull();
    expect(keyToAction({ key: 'a', metaKey: true })).toBeNull(); // Cmd-A selects all
    expect(keyToAction({ key: 'j', ctrlKey: true })).toBeNull();
    expect(keyToAction({ key: 'o', altKey: true })).toBeNull();
  });

  it('knows which elements take typing', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'input', type: 'search' })).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'radio' })).toBe(false);
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it('cycles the filters', () => {
    expect([nextFilter('flagged'), nextFilter('reviewed'), nextFilter('all')]).toEqual(['reviewed', 'all', 'flagged']);
  });
});

describe('review queue helpers', () => {
  const done = { action: 'accept' as const, answer: 'a', previous: 'a', note: null, at: NOW, pipelineStatus: 'flagged' as const, stale: false };

  it('moves to the next row still to review, wrapping around', () => {
    const rows = [row('r1'), row('r2', { review: done }), row('r3'), row('r4', { review: done })];
    expect(nextUnreviewed(rows, 0)).toBe(2);
    expect(nextUnreviewed(rows, 2)).toBe(0);
    expect(nextUnreviewed(rows, -1)).toBe(0);
    expect(nextUnreviewed([row('r1', { review: done }), row('r2', { review: done })], 1)).toBe(1); // all done: stay
    expect(nextUnreviewed([], -1)).toBe(0);
  });

  it('filters labels: exact, then prefix, then substring; spaces match underscores', () => {
    const labels = ['card_arrival', 'card_linking', 'lost_or_stolen_card', 'atm_support', 'card'];
    expect(filterLabels(labels, 'card')).toEqual(['card', 'card_arrival', 'card_linking', 'lost_or_stolen_card']);
    expect(filterLabels(labels, 'Card Arr')).toEqual(['card_arrival']);
    expect(filterLabels(labels, 'zzz')).toEqual([]);
    expect(filterLabels(labels, '', ['atm_support', 'not_a_label'])).toEqual(['atm_support', 'card_arrival', 'card_linking', 'lost_or_stolen_card', 'card']);
  });

  it('picking the pipeline answer is an accept; anything else an override', () => {
    expect(decisionFor(row('r1'), 'a')).toEqual({ rowId: 'r1', action: 'accept' });
    expect(decisionFor(row('r1'), 'b', '  hmm ')).toEqual({ rowId: 'r1', action: 'override', answer: 'b', note: 'hmm' });
  });

  it('optimistic update and its rollback keep counts and accuracy consistent', () => {
    const counts: ReviewCounts = { rows: 10, flagged: 4, reviewed: 1, remaining: 3, reviewedOther: 0, overridden: 0 };
    const accuracy = { noHuman: 0.5, withHuman: 0.5, correctNoHuman: 5, correctWithHuman: 5, of: 10 };
    const before = row('r1');
    const after = applyDecision(before, { rowId: 'r1', action: 'override', answer: 'b' }, NOW);
    expect(after).toMatchObject({ status: 'reviewed', finalAnswer: 'b', review: { action: 'override', answer: 'b', previous: 'a' } });

    const up = adjustTotals(counts, accuracy, before, after);
    expect(up.counts).toMatchObject({ reviewed: 2, remaining: 2, overridden: 1 });
    expect(up.accuracy).toMatchObject({ correctWithHuman: 6, withHuman: 0.6, noHuman: 0.5 });
    const back = adjustTotals(up.counts, up.accuracy, after, before);
    expect(back).toEqual({ counts, accuracy });

    // undo on a row the pipeline accepted counts against "other rows"
    const acc = row('r2', { pipelineStatus: 'accepted', status: 'reviewed', review: { ...done, pipelineStatus: 'accepted' } });
    const cleared = applyDecision(acc, { rowId: 'r2', action: 'clear' }, NOW);
    expect(cleared).toMatchObject({ status: 'accepted', review: null, finalAnswer: 'a' });
    expect(adjustTotals({ ...counts, reviewedOther: 1 }, null, acc, cleared)).toEqual({ counts: { ...counts, reviewedOther: 0 }, accuracy: null });
  });

  it('announces decisions in plain words', () => {
    const counts: ReviewCounts = { rows: 10, flagged: 4, reviewed: 2, remaining: 2, reviewedOther: 0, overridden: 1 };
    expect(announce({ rowId: 'r1', action: 'accept' }, row('r1'), counts)).toBe('Accepted a for row r1. 2 of 4 flagged rows reviewed.');
    expect(announce({ rowId: 'r1', action: 'override', answer: 'b' }, row('r1'), counts)).toBe('Changed row r1 to b. 2 of 4 flagged rows reviewed.');
    expect(announce({ rowId: 'r1', action: 'clear' }, row('r1'), counts)).toMatch(/^Decision on row r1 undone/);
  });

  it('routes #/runs/:id/review', () => {
    expect(parseHash('#/runs/run-a/review')).toEqual({ page: 'review', id: 'run-a' });
    expect(parseHash(reviewHref('a b'))).toEqual({ page: 'review', id: 'a b' });
    expect(parseHash('#/runs/run-a')).toEqual({ page: 'run', id: 'run-a' });
    expect(parseHash('#/benches/b/review').page).toBe('notfound');
  });
});
