import { describe, expect, it } from 'vitest';
import { scoreSlot, summariseSlots } from '../src/extract/score.ts';

describe('scoreSlot', () => {
  it('null against absent gold is right', () => {
    expect(scoreSlot('signer_name', null, [])).toEqual({ correct: true, exact: true, goldPresent: false, goldUnparseable: false });
    expect(scoreSlot('signer_name', '  ', [])).toMatchObject({ correct: true, goldPresent: false });
  });
  it('a value against absent gold is wrong', () => {
    expect(scoreSlot('signer_name', 'John', [])).toMatchObject({ correct: false, exact: false, goldPresent: false });
  });
  it('null against present gold is wrong', () => {
    expect(scoreSlot('signer_name', null, ['John Doe'])).toMatchObject({ correct: false, exact: false, goldPresent: true });
    expect(scoreSlot('signer_name', '', ['John Doe'])).toMatchObject({ correct: false });
  });
  it('separates exact from normalised matches', () => {
    expect(scoreSlot('signer_name', ' John Doe ', ['John Doe'])).toMatchObject({ correct: true, exact: true });
    expect(scoreSlot('signer_name', 'john doe.', ['John Doe'])).toMatchObject({ correct: true, exact: false });
    expect(scoreSlot('signer_name', 'Jane Doe', ['John Doe'])).toMatchObject({ correct: false, exact: false });
  });
  it('matches any of several gold values', () => {
    const gold = ['Acme Inc', 'ACME, Inc.'];
    expect(scoreSlot('registrant_name', 'acme inc', gold).correct).toBe(true);
    expect(scoreSlot('registrant_name', 'ACME, Inc.', gold).exact).toBe(true);
    expect(scoreSlot('registrant_name', 'Other', gold).correct).toBe(false);
  });
  it('compares dates after parsing', () => {
    expect(scoreSlot('file_date', '2008-07-16', ['July 16, 2008'])).toMatchObject({ correct: true, exact: false, goldUnparseable: false });
    expect(scoreSlot('file_date', '2008-07-17', ['July 16, 2008']).correct).toBe(false);
  });
  it('an unparseable predicted date is wrong when the gold parses', () => {
    expect(scoreSlot('file_date', 'sometime in July', ['July 16, 2008']).correct).toBe(false);
  });
  it('falls back to text for an unparseable gold date and flags it', () => {
    const r = scoreSlot('file_date', 'Juy 16, 2OO8', ['Juy 16, 2OO8.']);
    expect(r).toMatchObject({ correct: true, exact: false, goldUnparseable: true });
    expect(scoreSlot('file_date', 'July 16, 2008', ['Juy 16, 2OO8'])).toMatchObject({ correct: false, goldUnparseable: true });
  });
  it('registration numbers compare by digits', () => {
    expect(scoreSlot('registration_num', 'No. 3712', ['3712\n'])).toMatchObject({ correct: true, exact: false });
    expect(scoreSlot('registration_num', 'abc', ['3712']).correct).toBe(false);
  });
});

describe('summariseSlots', () => {
  it('counts by field and by present/absent', () => {
    const s = summariseSlots([
      { field: 'signer_name', ...scoreSlot('signer_name', 'a', ['a']) },
      { field: 'signer_name', ...scoreSlot('signer_name', 'x', ['a']) },
      { field: 'signer_title', ...scoreSlot('signer_title', null, []) },
      { field: 'signer_title', ...scoreSlot('signer_title', 'x', []) },
    ]);
    expect(s).toMatchObject({ total: 4, correct: 2, exact: 2 });
    expect(s.present).toEqual({ total: 2, correct: 1, exact: 1 });
    expect(s.absent).toEqual({ total: 2, correct: 1, exact: 1 });
    expect(s.byField.signer_name).toEqual({ total: 2, correct: 1, exact: 1 });
  });
});
