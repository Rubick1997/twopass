import { describe, expect, it } from 'vitest';
import { normaliseDate, normaliseDigits, normaliseField, normaliseText, TWO_DIGIT_YEAR_PIVOT } from '../src/extract/normalise.ts';

describe('normaliseDate', () => {
  it.each([
    ['July 16, 2008'],
    ['July 16 2008'],
    ['Jul. 16, 2008'],
    ['16 July 2008'],
    ['16-Jul-2008'],
    ['7/16/08'],
    ['07/16/2008'],
    ['7-16-08'],
    ['7.16.08'],
    ['2008-07-16'],
    ['July 16th, 2008'],
    ['  JULY   16,  2008. '],
    ['july 16, 2008,'],
    ['(July 16, 2008)'],
    ['JuLy 16th 2008'],
  ])('parses %s', (s) => expect(normaliseDate(s)).toBe('2008-07-16'));

  it('handles Sept and other short month spellings', () => {
    expect(normaliseDate('Sept 3, 1999')).toBe('1999-09-03');
    expect(normaliseDate('Sep. 3, 1999')).toBe('1999-09-03');
    expect(normaliseDate('3rd December 1987')).toBe('1987-12-03');
  });

  it.each([['13/45/08'], ['February 30, 2008'], [''], ['n/a'], ['   '], ['2007-02-29'], ['Foo 3, 2008'], ['July 2008']])(
    'rejects %j',
    (s) => expect(normaliseDate(s)).toBeNull(),
  );

  it('knows leap years', () => {
    expect(normaliseDate('February 29, 2008')).toBe('2008-02-29');
    expect(normaliseDate('February 29, 1900')).toBeNull();
  });

  it('puts two-digit years on the right side of the pivot', () => {
    expect(TWO_DIGIT_YEAR_PIVOT).toBe(30);
    expect(normaliseDate('1/2/29')).toBe('2029-01-02');
    expect(normaliseDate('1/2/30')).toBe('1930-01-02');
    expect(normaliseDate('1/2/00')).toBe('2000-01-02');
    expect(normaliseDate('1/2/99')).toBe('1999-01-02');
  });

  it('handles formats found in the dev split', () => {
    expect(normaliseDate('Dec 23,09')).toBe('2009-12-23');
    expect(normaliseDate('May\n13.2015\n(Date of signature)')).toBe('2015-05-13');
    expect(normaliseDate('12/14/17\n(Date of')).toBe('2017-12-14');
    expect(normaliseDate("7th day of _\nOctober\n.1987")).toBe('1987-10-07');
    expect(normaliseDate('15th day of June, 1996')).toBe('1996-06-15');
  });

  it('still rejects OCR garbage and typos', () => {
    expect(normaliseDate("15th day of JANUARY 19 RU\n'")).toBeNull();
    expect(normaliseDate('Apil 14, 2017')).toBeNull();
  });

  it('reads numeric dates in US order', () => {
    expect(normaliseDate('3/4/2010')).toBe('2010-03-04');
  });
});

describe('normaliseDigits', () => {
  it('keeps digits only, folding full-width digits', () => {
    expect(normaliseDigits('No. 3712\n')).toBe('3712');
    expect(normaliseDigits('３７１２')).toBe('3712');
    expect(normaliseDigits('abc')).toBe('');
  });
});

describe('normaliseText', () => {
  it('collapses whitespace, including non-breaking spaces, and lower-cases', () => {
    expect(normaliseText('  DLA Piper\n\tUS   LLP ')).toBe('dla piper us llp');
  });
  it('strips punctuation at the edges until stable, keeps inner punctuation', () => {
    expect(normaliseText('“Smith & Co., Inc.”')).toBe('smith & co., inc');
    expect(normaliseText(' ., "(x)" ;')).toBe('x');
    expect(normaliseText('--- ...')).toBe('');
  });
  it('applies NFKC', () => {
    expect(normaliseText('ＡＢＣ １２３')).toBe('abc 123');
    expect(normaliseText('ﬁle')).toBe('file');
  });
  it('keeps non-latin letters', () => {
    expect(normaliseText('«Ünïcode»')).toBe('ünïcode');
  });
});

describe('normaliseField', () => {
  it('dispatches by field', () => {
    expect(normaliseField('file_date', 'July 16, 2008')).toBe('2008-07-16');
    expect(normaliseField('file_date', 'n/a')).toBeNull();
    expect(normaliseField('registration_num', '#3712 ')).toBe('3712');
    expect(normaliseField('registration_num', 'none')).toBeNull();
    expect(normaliseField('signer_name', ' John  Doe. ')).toBe('john doe');
    expect(normaliseField('signer_title', ' . ')).toBeNull();
  });
});
