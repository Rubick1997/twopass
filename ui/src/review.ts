// Pure helpers for the review queue (tested in test/ui-review.test.ts). No DOM, no React.

import type { DecisionBody, ReviewAccuracy, ReviewCounts, ReviewFilter, ReviewInfo, ReviewRow } from '../../src/ui/api-types.ts';

export const FILTERS: readonly ReviewFilter[] = ['flagged', 'reviewed', 'all'];
export const FILTER_TEXT: Record<ReviewFilter, string> = { flagged: 'Flagged', reviewed: 'Reviewed', all: 'All rows' };

export const nextFilter = (f: ReviewFilter): ReviewFilter => FILTERS[(FILTERS.indexOf(f) + 1) % FILTERS.length]!;

export type ReviewKey =
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'accept' }
  | { type: 'override' }
  | { type: 'pick'; index: 0 | 1 | 2 }
  | { type: 'undo' }
  | { type: 'note' }
  | { type: 'filter' }
  | { type: 'label' }
  | { type: 'help' };

export interface KeyInput {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** The event target is a text field, select or contenteditable (see isTypingTarget). */
  typing?: boolean;
}

/** The single-key shortcuts. Nothing fires while typing or with Ctrl/Cmd/Alt held. */
export const SHORTCUTS: ReadonlyArray<[string, string]> = [
  ['j / ↓', 'Next row'],
  ['k / ↑', 'Previous row'],
  ['a', 'Accept the pipeline’s answer'],
  ['o', 'Override: pick another answer'],
  ['1 – 3', 'Pick one of the round-0 top 3'],
  ['u', 'Undo the decision on this row'],
  ['n', 'Add a note'],
  ['l', 'Show or hide the expected label'],
  ['f', 'Next filter (flagged, reviewed, all)'],
  ['?', 'This help'],
];

export function keyToAction(e: KeyInput): ReviewKey | null {
  if (e.typing || e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key) {
    case 'j':
    case 'ArrowDown':
      return { type: 'next' };
    case 'k':
    case 'ArrowUp':
      return { type: 'prev' };
    case 'a':
      return { type: 'accept' };
    case 'o':
      return { type: 'override' };
    case '1':
    case '2':
    case '3':
      return { type: 'pick', index: (Number(e.key) - 1) as 0 | 1 | 2 };
    case 'u':
      return { type: 'undo' };
    case 'n':
      return { type: 'note' };
    case 'f':
      return { type: 'filter' };
    case 'l':
      return { type: 'label' };
    case '?':
      return { type: 'help' };
    default:
      return null;
  }
}

/** Whether keystrokes on this element are someone typing (so shortcuts must not fire). */
export function isTypingTarget(el: { tagName?: string; isContentEditable?: boolean; type?: string } | null): boolean {
  if (!el?.tagName) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes((el.type ?? 'text').toLowerCase());
}

/** The next row after `from` with no decision, wrapping around; `from` itself when every row is decided. */
export function nextUnreviewed(rows: readonly ReviewRow[], from: number): number {
  for (let step = 1; step <= rows.length; step++) {
    const i = (from + step) % rows.length;
    if (!rows[i]!.review) return i;
  }
  return Math.min(Math.max(from, 0), Math.max(rows.length - 1, 0));
}

/**
 * Labels matching what was typed: exact first, then prefix, then substring. Spaces match underscores,
 * case is ignored. With an empty query, `first` (the round-0 top 3) comes before the rest.
 */
export function filterLabels(labels: readonly string[], query: string, first: readonly string[] = []): string[] {
  const canon = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '_');
  const q = canon(query.trim());
  if (!q) return [...first.filter((l) => labels.includes(l)), ...labels.filter((l) => !first.includes(l))];
  const scored = labels
    .map((l) => {
      const c = canon(l);
      const score = c === q ? 0 : c.startsWith(q) ? 1 : c.includes(q) ? 2 : -1;
      return { l, score };
    })
    .filter((x) => x.score >= 0);
  return scored.sort((a, b) => a.score - b.score).map((x) => x.l);
}

/** The body to send for a picked answer: picking the pipeline's own answer is an accept. */
export function decisionFor(row: ReviewRow, answer: string, note?: string): DecisionBody {
  const withNote = note?.trim() ? { note: note.trim() } : {};
  if (answer === row.answer) return { rowId: row.rowId, action: 'accept', ...withNote };
  return { rowId: row.rowId, action: 'override', answer, ...withNote };
}

/** What the row looks like once `d` is saved, for the optimistic update. */
export function applyDecision(row: ReviewRow, d: DecisionBody, nowIso: string): ReviewRow {
  if (d.action === 'clear') return { ...row, status: row.pipelineStatus, finalAnswer: row.answer, review: null };
  const answer = d.action === 'accept' ? row.answer : d.answer;
  const review: ReviewInfo = {
    action: d.action,
    answer,
    previous: row.answer,
    note: d.note ?? null,
    at: nowIso,
    pipelineStatus: row.pipelineStatus,
    stale: false,
  };
  return { ...row, status: 'reviewed', finalAnswer: answer, review };
}

const correct = (row: ReviewRow) => (row.expected !== null && row.expected.trim() !== '' && row.finalAnswer.trim().toLowerCase() === row.expected.trim().toLowerCase() ? 1 : 0);

/** Counts and accuracy after one row changes from `before` to `after` (optimistic update, or its rollback). */
export function adjustTotals(
  counts: ReviewCounts,
  accuracy: ReviewAccuracy | null,
  before: ReviewRow,
  after: ReviewRow,
): { counts: ReviewCounts; accuracy: ReviewAccuracy | null } {
  const c = { ...counts };
  const was = before.review !== null;
  const is = after.review !== null;
  if (was !== is) {
    const d = is ? 1 : -1;
    if (before.pipelineStatus === 'flagged') {
      c.reviewed += d;
      c.remaining -= d;
    } else c.reviewedOther += d;
  }
  const changed = (r: ReviewRow) => (r.review && r.review.answer !== r.review.previous ? 1 : 0);
  c.overridden += changed(after) - changed(before);
  if (!accuracy || !accuracy.of) return { counts: c, accuracy };
  const correctWithHuman = accuracy.correctWithHuman + correct(after) - correct(before);
  return { counts: c, accuracy: { ...accuracy, correctWithHuman, withHuman: correctWithHuman / accuracy.of } };
}

/** Plain-words announcement for screen readers after a decision. */
export function announce(d: DecisionBody, row: ReviewRow, counts: ReviewCounts): string {
  const progress = `${counts.reviewed} of ${counts.flagged} flagged rows reviewed.`;
  if (d.action === 'clear') return `Decision on row ${row.rowId} undone. ${progress}`;
  if (d.action === 'accept') return `Accepted ${row.answer || 'the answer'} for row ${row.rowId}. ${progress}`;
  return `Changed row ${row.rowId} to ${d.answer}. ${progress}`;
}
