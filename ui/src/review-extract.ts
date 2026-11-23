// Pure helpers for the extraction review page (tested in test/ui-review-extract.test.ts). No DOM, no React.

import type { ExtractReviewCounts, FieldDecisionBody, FieldItem, ReviewFilter } from '../../src/ui/api-types.ts';
import { isTypingTarget, type KeyInput } from './review.ts';

export { isTypingTarget };

export const itemKey = (i: Pick<FieldItem, 'docId' | 'field'>): string => `${i.docId}\u0000${i.field}`;

export type ExtractKey =
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'accept' }
  | { type: 'override' }
  | { type: 'absent' }
  | { type: 'selection' }
  | { type: 'undo' }
  | { type: 'note' }
  | { type: 'filter' }
  | { type: 'label' }
  | { type: 'help' };

export const EXTRACT_SHORTCUTS: ReadonlyArray<[string, string]> = [
  ['j / ↓', 'Next field'],
  ['k / ↑', 'Previous field'],
  ['a', 'Accept the pipeline’s value'],
  ['o', 'Override: type the right value'],
  ['x', 'Override with “not in this document”'],
  ['s', 'Override with the text selected in the document'],
  ['u', 'Undo the decision on this field'],
  ['n', 'Add a note'],
  ['l', 'Show or hide the gold label'],
  ['f', 'Next filter (flagged, reviewed, all)'],
  ['?', 'This help'],
];

/** The single-key shortcuts. Nothing fires while typing or with Ctrl/Cmd/Alt held. */
export function keyToExtractAction(e: KeyInput): ExtractKey | null {
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
    case 'x':
      return { type: 'absent' };
    case 's':
      return { type: 'selection' };
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

/** The next item after `from` with no decision, wrapping around; `from` itself when every item is decided. */
export function nextUnreviewedItem(items: readonly FieldItem[], from: number): number {
  for (let step = 1; step <= items.length; step++) {
    const i = (from + step) % items.length;
    if (!items[i]!.review) return i;
  }
  return Math.min(Math.max(from, 0), Math.max(items.length - 1, 0));
}

/** Selected text as a one-line value: runs of whitespace (line breaks in OCR text) become one space. */
export const normaliseSelection = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The body for a chosen value: picking the pipeline's own value is an accept, when it can be accepted. */
export function decisionForItem(item: FieldItem, value: string | null, note?: string): FieldDecisionBody {
  const withNote = note?.trim() ? { note: note.trim() } : {};
  const base = { rowId: item.docId, field: item.field };
  if (item.acceptable && value === item.value) return { ...base, action: 'accept', ...withNote };
  return { ...base, action: 'override', answer: value, ...withNote };
}

/** What the item looks like once `d` is saved, for the optimistic update. Whether the new value is right comes back from the server. */
export function applyFieldDecision(item: FieldItem, d: FieldDecisionBody, nowIso: string): FieldItem {
  if (d.action === 'clear') return { ...item, status: item.pipelineStatus, finalValue: item.value, finalCorrect: item.valueCorrect, review: null };
  const value = d.action === 'accept' ? item.value : d.answer;
  return {
    ...item,
    status: 'reviewed',
    finalValue: value,
    finalCorrect: d.action === 'accept' ? item.valueCorrect : null,
    review: { action: d.action, value, previous: item.value, note: d.note ?? null, at: nowIso, pipelineStatus: item.pipelineStatus, stale: false },
  };
}

/** Counts after one item changes from `before` to `after` (optimistic update, or its rollback). */
export function adjustExtractCounts(counts: ExtractReviewCounts, before: FieldItem, after: FieldItem): ExtractReviewCounts {
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
  const changed = (i: FieldItem) => (i.review && i.review.value !== i.review.previous ? 1 : 0);
  c.overridden += changed(after) - changed(before);
  return c;
}

export function announceField(d: FieldDecisionBody, item: FieldItem, counts: ExtractReviewCounts): string {
  const progress = `${counts.reviewed} of ${counts.flagged} flagged fields reviewed.`;
  const what = `${item.field} of document ${item.docId}`;
  if (d.action === 'clear') return `Decision on ${what} undone. ${progress}`;
  if (d.action === 'accept') return `Accepted ${item.value ?? 'not in this document'} for ${what}. ${progress}`;
  return `Changed ${what} to ${d.answer ?? 'not in this document'}. ${progress}`;
}

export const FIELD_FILTER_TEXT: Record<ReviewFilter, string> = { flagged: 'Flagged fields', reviewed: 'Reviewed fields', all: 'All fields' };

// ---------------------------------------------------------------- highlighting

export type HighlightKind = 'plain' | 'r1' | 'r2' | 'both';

export interface Segment {
  text: string;
  kind: HighlightKind;
}

/**
 * Cuts `text` into runs for display: plain text, text only the round-1 value matches, only the round-2 value, or both.
 * Spans are [start, end) offsets; they may overlap each other and are clamped to the text.
 */
export function highlightSegments(text: string, spans1: ReadonlyArray<readonly [number, number]>, spans2: ReadonlyArray<readonly [number, number]>): Segment[] {
  const clamp = (n: number) => Math.min(Math.max(n, 0), text.length);
  const cuts = new Set<number>([0, text.length]);
  for (const [a, b] of [...spans1, ...spans2]) {
    cuts.add(clamp(a));
    cuts.add(clamp(b));
  }
  const points = [...cuts].sort((x, y) => x - y);
  const inside = (spans: ReadonlyArray<readonly [number, number]>, a: number, b: number) => spans.some(([s, e]) => s <= a && b <= e);
  const out: Segment[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const in1 = inside(spans1, a, b);
    const in2 = inside(spans2, a, b);
    const kind: HighlightKind = in1 && in2 ? 'both' : in1 ? 'r1' : in2 ? 'r2' : 'plain';
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text.slice(a, b);
    else out.push({ text: text.slice(a, b), kind });
  }
  return out;
}
