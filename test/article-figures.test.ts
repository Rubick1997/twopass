import { describe, expect, it } from 'vitest';
import {
  acceptedAfterRewrite,
  costRatio,
  disagreement,
  flaggedRight,
  flaggedShare,
  pairwise,
  paraphraseDrop,
  pipelineAccuracy,
  ratio,
  triageTop1,
  computeFigures,
  type EnrichedRow,
} from '../scripts/article-figures.ts';

const row = (id: string, label: string, answer: string, status = 'accepted', round = '0'): EnrichedRow => ({ id, label, answer, status, round });

describe('flagged / rewrite counts', () => {
  const rows = [
    row('1', 'a', 'a', 'flagged', '2'),
    row('2', 'a', 'b', 'flagged', '2'),
    row('3', 'a', 'A ', 'accepted', '1'),
    row('4', 'a', 'b', 'accepted', '2'),
    row('5', 'a', 'a', 'accepted', '0'),
    row('6', 'a', 'b', 'accepted', '0'),
  ];
  it('counts flagged rows and those where the own answer is right', () => {
    const r = flaggedRight(rows);
    expect(r.flagged).toBe(2);
    expect(r.right).toMatchObject({ count: 1, of: 2, fraction: 0.5 });
  });
  it('counts rows accepted in round 1 or 2, not round-0 or flagged ones', () => {
    const r = acceptedAfterRewrite(rows);
    expect(r.accepted).toBe(2);
    expect(r.right.count).toBe(1);
  });
  it('pipeline accuracy and flagged share use every row', () => {
    expect(pipelineAccuracy(rows)).toMatchObject({ count: 3, of: 6 });
    expect(flaggedShare(rows)).toMatchObject({ count: 2, of: 6 });
  });
});

describe('triageTop1', () => {
  it('ignores thresholds; cannot_tell and missing count as wrong', () => {
    const ev = (choice: string) => ({ answers: { answer: { type: 'choice', choice, probabilities: { [choice]: 0.1 } } } });
    const st = { triage: new Map([['1', ev('a')], ['2', ev('b')], ['3', ev('cannot_tell')]]) } as never;
    const r = triageTop1(st, [row('1', 'a', ''), row('2', 'a', ''), row('3', 'a', ''), row('4', 'a', '')]);
    expect(r).toMatchObject({ count: 1, of: 4, missing: 1 });
  });
});

describe('pairwise and disagreement on shared ids', () => {
  const a = [row('1', 'x', 'x'), row('2', 'x', 'x'), row('3', 'x', 'y'), row('4', 'x', 'y'), row('9', 'x', 'x')];
  const b = [row('1', 'x', 'x'), row('2', 'x', 'y'), row('3', 'x', 'x'), row('4', 'x', 'z'), row('8', 'x', 'x')];
  it('counts wins and losses on shared ids only', () => {
    const p = pairwise(a, b);
    expect(p).toMatchObject({ shared: 4, onlyA: 1, onlyB: 1, aWins: 1, bWins: 1, bothRight: 1, bothWrong: 1 });
    expect(p.aRight.count).toBe(2);
    expect(p.bRight.count).toBe(2);
  });
  it('disagreement compares shared ids and reports the shared count', () => {
    const d = disagreement(a, b);
    expect(d).toMatchObject({ count: 3, of: 4, onlyA: 1, onlyB: 1 });
    expect(d.fraction).toBe(0.75);
  });
  it('ignores case and whitespace; two empty answers agree', () => {
    expect(disagreement([row('1', 'x', ' X'), row('2', 'x', '')], [row('1', 'x', 'x'), row('2', 'x', '')]).count).toBe(0);
  });
  it('rejects duplicate ids', () => {
    expect(() => pairwise([row('1', 'x', 'x'), row('1', 'x', 'x')], [])).toThrow(/duplicate/);
  });
});

describe('costRatio', () => {
  it('differs when computed from cents', () => {
    const r = costRatio(4.12959, 0.475952210389609);
    expect(r.unrounded).toBeCloseTo(8.6765, 3);
    expect(r.rounded).toBeCloseTo(4.13 / 0.48, 10);
    expect(r.dearCents).toBe(4.13);
    expect(r.cheapCents).toBe(0.48);
  });
});

describe('paraphraseDrop', () => {
  it('scores original from given choices and paraphrase from answers', () => {
    const ans = (id: string, choice: string) => ({ model: 'm', id, variant: 'paraphrase', answer: { type: 'choice', choice, probabilities: { [choice]: 1 } } });
    const r = paraphraseDrop(
      new Map([['1', 'a'], ['2', 'a']]),
      [ans('1', 'a'), ans('2', 'b'), { model: 'other', id: '3', variant: 'paraphrase', answer: undefined }],
      new Map([['1', 'a'], ['2', 'a'], ['3', 'a']]),
      'm',
    );
    expect(r).toMatchObject({ ids: 2, drop: 0.5 });
  });
});

describe('ratio / missing inputs', () => {
  it('handles zero denominators', () => expect(Number.isNaN(ratio(0, 0).fraction)).toBe(true));
  it('fails loudly when the runs folder is missing', () => {
    expect(() => computeFigures('/nonexistent-runs-dir')).toThrow(/missing bench folder/);
  });
});
