import type { VrduField } from '../datasets/vrdu.ts';
import { normaliseField, normaliseText } from './normalise.ts';

export interface SlotScore {
  correct: boolean;
  exact: boolean;
  goldPresent: boolean;
  goldUnparseable: boolean;
}

/**
 * Scores one (document, field) slot. A null or blank prediction means "no value", which is right exactly
 * when the field is absent from the document.
 */
export function scoreSlot(field: VrduField, predicted: string | null, gold: string[]): SlotScore {
  const value = predicted === null || predicted.trim() === '' ? null : predicted.trim();
  const goldValues = gold.map((g) => g.trim()).filter((g) => g !== '');
  const goldPresent = goldValues.length > 0;
  if (!goldPresent) return { correct: value === null, exact: value === null, goldPresent, goldUnparseable: false };
  if (value === null) return { correct: false, exact: false, goldPresent, goldUnparseable: false };

  const exact = goldValues.includes(value);
  const p = normaliseField(field, value);
  let goldUnparseable = false;
  let correct = false;
  for (const g of goldValues) {
    const ng = normaliseField(field, g);
    if (ng === null) {
      // Only a date can fail on gold with text present (OCR noise): compare as plain text for that value.
      if (field === 'file_date') {
        goldUnparseable = true;
        const a = normaliseText(value);
        if (a !== '' && a === normaliseText(g)) correct = true;
      }
      continue;
    }
    if (p !== null && p === ng) correct = true;
  }
  return { correct, exact, goldPresent, goldUnparseable };
}

export interface SlotCounts {
  total: number;
  correct: number;
  exact: number;
}

export interface SlotSummary extends SlotCounts {
  byField: Partial<Record<VrduField, SlotCounts>>;
  present: SlotCounts;
  absent: SlotCounts;
}

const zero = (): SlotCounts => ({ total: 0, correct: 0, exact: 0 });
const add = (c: SlotCounts, s: SlotScore) => {
  c.total++;
  if (s.correct) c.correct++;
  if (s.exact) c.exact++;
};

export function summariseSlots(slots: Array<{ field: VrduField } & SlotScore>): SlotSummary {
  const out: SlotSummary = { ...zero(), byField: {}, present: zero(), absent: zero() };
  for (const s of slots) {
    add(out, s);
    add((out.byField[s.field] ??= zero()), s);
    add(s.goldPresent ? out.present : out.absent, s);
  }
  return out;
}
