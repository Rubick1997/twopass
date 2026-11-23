import type { VrduField } from '../datasets/vrdu.ts';

/** Two-digit years: 00–29 → 20xx, 30–99 → 19xx (the filings run from the 1960s to the 2010s). */
export const TWO_DIGIT_YEAR_PIVOT = 30;

const EDGE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/** NFKC, lower-case, whitespace collapsed, leading/trailing punctuation stripped until stable. */
export function normaliseText(s: string): string {
  let cur = s.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
  for (;;) {
    const next = cur.replace(EDGE, '').trim();
    if (next === cur) return cur;
    cur = next;
  }
}

/** Digits only (full-width digits are folded by NFKC first). */
export function normaliseDigits(s: string): string {
  return s.normalize('NFKC').replace(/\D/gu, '');
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1) return null;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > dim) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function fullYear(s: string): number {
  const n = Number(s);
  if (s.length === 2) return n < TWO_DIGIT_YEAR_PIVOT ? 2000 + n : 1900 + n;
  return n;
}

/** ISO `YYYY-MM-DD`, or null when the text is not a real calendar date in a supported format. */
export function normaliseDate(input: string): string | null {
  const s = input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    // The form's caption under the signature line often rides along: "5/1/08 (Date of signature)".
    .replace(/\s*\(\s*date\b.*$/u, '')
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (!s) return null;
  const ord = '(?:st|nd|rd|th)?';
  const sep = '[\\s.,/-]+';
  let m: RegExpMatchArray | null;

  // 2008-07-16
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/u))) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  // 7/16/08, 07/16/2008, 7-16-08, 7.16.08 (US order)
  if ((m = s.match(/^(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})$/u))) return iso(fullYear(m[4]!), Number(m[1]), Number(m[3]));
  // July 16, 2008 / Jul. 16 2008 / July 16th, 2008
  if ((m = s.match(new RegExp(`^([a-z]+)\\.?${sep}(\\d{1,2})${ord}${sep}(\\d{4}|\\d{2})$`, 'u')))) {
    const mo = MONTHS[m[1]!];
    return mo ? iso(fullYear(m[3]!), mo, Number(m[2])) : null;
  }
  // "7th day of October 1987" (stray punctuation between the parts is ignored)
  if ((m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[^\p{L}\p{N}]*day of[^\p{L}\p{N}]*([a-z]+)[^\p{L}\p{N}]*(\d{4})$/u))) {
    const mo = MONTHS[m[2]!];
    return mo ? iso(Number(m[3]), mo, Number(m[1])) : null;
  }
  // 16 July 2008 / 16-Jul-2008
  if ((m = s.match(new RegExp(`^(\\d{1,2})${ord}${sep}([a-z]+)\\.?${sep}(\\d{4})$`, 'u')))) {
    const mo = MONTHS[m[2]!];
    return mo ? iso(Number(m[3]), mo, Number(m[1])) : null;
  }
  return null;
}

/** The comparison form of a value for a field, or null when nothing usable is left. */
export function normaliseField(field: VrduField, s: string): string | null {
  if (field === 'file_date') return normaliseDate(s);
  if (field === 'registration_num') {
    const d = normaliseDigits(s);
    return d === '' ? null : d;
  }
  const t = normaliseText(s);
  return t === '' ? null : t;
}
