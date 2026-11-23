import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeFieldOutcomes } from '../src/extract/outcomes.ts';
import { Ledger, replay } from '../src/ledger.ts';
import { computeOutcomes, executePipeline } from '../src/pipeline.ts';
import { tempDir } from './helpers.ts';
import { docs, extractContext, fakeServer, toyTask } from './extract-helpers.ts';

const one = (id: string) => docs.filter((d) => d.id === id);
const field = (outcomes: ReturnType<typeof computeFieldOutcomes>, id: string, f: string) => outcomes.find((o) => o.rowId === id && o.field === f)!;
const ledgerOf = (dir: string) => replay(new Ledger(join(dir, 'ledger.jsonl')).read());

describe('extract pipeline', () => {
  it('accepts every field at round 1 and never runs round 2', async () => {
    const api = fakeServer();
    const dir = tempDir();
    const outcomes = await executePipeline(extractContext(dir, api.fetch, { rows: one('d1') }));
    expect(api.counts.submit).toBe(1);
    expect(api.decisions).toEqual([{ doc: 'd1', fields: ['a', 'b', 'c'] }]);
    expect(outcomes[0]).toMatchObject({ status: 'accepted', round: 1, verdict: 'supported', answer: '{"a":"1","b":"2","c":null}' });
    expect(outcomes[0]!.confidence).toBeCloseTo(0.97);
    // the null proposal was asked as a null question
    const fields = computeFieldOutcomes(ledgerOf(dir), { task: toyTask, rows: one('d1'), thresholds: { t0: 1, t1: 0.9, t2: 0.9 } });
    expect(field(fields, 'd1', 'c')).toMatchObject({ status: 'accepted', value: null, round: 1 });
  });

  it('re-extracts the document when one field is rejected, but only that field takes the new value', async () => {
    const api = fakeServer();
    const dir = tempDir();
    const outcomes = await executePipeline(extractContext(dir, api.fetch, { rows: one('d2') }));
    // round 2 asked only about b
    expect(api.decisions).toEqual([
      { doc: 'd2', fields: ['a', 'b', 'c'] },
      { doc: 'd2', fields: ['b'] },
    ]);
    const round2 = [...api.batches.values()].find((b) => b.model === 'strong:batch')!;
    expect(round2.requests.map((r) => r.custom_id)).toEqual(['d2-r2']); // the whole document is re-extracted
    // the strong model also said a = DIFFERENT, which is ignored: a was accepted in round 1
    expect(outcomes[0]).toMatchObject({ status: 'accepted', round: 2, answer: '{"a":"1","b":"2","c":"3"}' });
    const f = computeFieldOutcomes(ledgerOf(dir), { task: toyTask, rows: one('d2'), thresholds: { t0: 1, t1: 0.9, t2: 0.9 } });
    expect(f.map((x) => [x.field, x.status, x.value, x.round])).toEqual([
      ['a', 'accepted', '1', 1],
      ['b', 'accepted', '2', 2],
      ['c', 'accepted', '3', 1],
    ]);
  });

  it('flags a field still rejected in round 2 with the round-2 value', async () => {
    const api = fakeServer();
    const dir = tempDir();
    const outcomes = await executePipeline(extractContext(dir, api.fetch, { rows: one('d2'), thresholds: { t0: 1.01, t1: 0.9, t2: 0.999 } }));
    expect(outcomes[0]).toMatchObject({ status: 'flagged', round: 2, verdict: 'supported', answer: '{"a":"1","b":"2","c":"3"}' });
    const f = computeFieldOutcomes(ledgerOf(dir), { task: toyTask, rows: one('d2'), thresholds: { t0: 1.01, t1: 0.9, t2: 0.999 } });
    expect(field(f, 'd2', 'b')).toMatchObject({ status: 'flagged', value: '2', round: 2 });
    expect(field(f, 'd2', 'a').status).toBe('accepted');
  });

  it('flags with the round-1 value when the round-2 writer fails', async () => {
    const api = fakeServer({ failIds: ['d2-r2'] });
    const dir = tempDir();
    const outcomes = await executePipeline(extractContext(dir, api.fetch, { rows: one('d2') }));
    expect(outcomes[0]).toMatchObject({ status: 'flagged', round: 1, verdict: 'unsupported' });
    const f = computeFieldOutcomes(ledgerOf(dir), { task: toyTask, rows: one('d2'), thresholds: { t0: 1.01, t1: 0.9, t2: 0.9 } });
    expect(field(f, 'd2', 'b')).toMatchObject({ status: 'flagged', value: 'WRONG', verdict: 'unsupported', round: 1 });
    expect(api.decisions.length).toBe(1); // no round-2 verify without a round-2 answer
  });

  it('sends a document with invalid round-1 JSON to round 2, asking every field there', async () => {
    const api = fakeServer();
    const outcomes = await executePipeline(extractContext(tempDir(), api.fetch, { rows: one('d3') }));
    expect(api.decisions).toEqual([{ doc: 'd3', fields: ['a', 'b', 'c'] }]); // none in round 1
    expect(outcomes[0]).toMatchObject({ status: 'accepted', round: 2 });
  });

  it('flags an unusable document with a null value and the reason', async () => {
    const api = fakeServer({ reply: () => 'nope' });
    const dir = tempDir();
    const ctx = extractContext(dir, api.fetch, { rows: one('d3') });
    const outcomes = await executePipeline(ctx);
    expect(outcomes[0]).toMatchObject({ status: 'flagged', verdict: 'invalid_output', round: 2 });
    const f = computeFieldOutcomes(ledgerOf(dir), ctx);
    expect(f.every((x) => x.status === 'flagged' && x.value === null)).toBe(true);
  });

  it('collect mode asks every field in both rounds', async () => {
    const api = fakeServer();
    const dir = tempDir();
    await executePipeline(extractContext(dir, api.fetch, { mode: 'collect' }));
    expect(api.decisions.filter((d) => d.doc === 'd1').map((d) => d.fields.length)).toEqual([3, 3]);
    expect(api.decisions.filter((d) => d.doc === 'd2').map((d) => d.fields.length)).toEqual([3, 3]);
    expect(api.decisions.filter((d) => d.doc === 'd3').map((d) => d.fields.length)).toEqual([3]); // round 1 unusable
  });

  it('baseline mode takes every valid field as is, with no checker', async () => {
    const api = fakeServer();
    const outcomes = await executePipeline(extractContext(tempDir(), api.fetch, { mode: 'baseline', writerModel: 'strong:batch' }));
    expect(api.counts.verify).toBe(0);
    expect(outcomes.map((o) => [o.status, o.verdict, o.round])).toEqual(Array(3).fill(['accepted', 'baseline', 1]));
    expect(outcomes[1]!.answer).toBe('{"a":"DIFFERENT","b":"2","c":"3"}');
  });

  it('treats a round-2 decision that lacks an answer for a field as cannot_tell with probability 0', async () => {
    const dir = tempDir();
    const api = fakeServer();
    const ctx = extractContext(dir, api.fetch, { rows: one('d2') });
    await executePipeline(ctx);
    // strip b's answer from the round-2 decision event
    const path = join(dir, 'ledger.jsonl');
    const events = new Ledger(path).read().map((e) => (e.t === 'decision' && e.round === 2 ? { ...e, answers: {} } : e));
    const st = replay(events);
    const f = computeFieldOutcomes(st, ctx);
    expect(field(f, 'd2', 'b')).toMatchObject({ status: 'flagged', verdict: 'cannot_tell', confidence: 0, round: 2 });
  });
});

describe('computeFieldOutcomes', () => {
  it('replays one collect ledger under different thresholds without touching it', async () => {
    const dir = tempDir();
    const api = fakeServer();
    const ctx = extractContext(dir, api.fetch, { mode: 'collect' });
    await executePipeline(ctx);
    const st = ledgerOf(dir);
    const before = JSON.stringify([...st.verify.values()]);
    const loose = computeFieldOutcomes(st, { ...ctx, mode: 'normal', thresholds: { t0: 1.01, t1: 0.9, t2: 0.9 } });
    const strict = computeFieldOutcomes(st, { ...ctx, mode: 'normal', thresholds: { t0: 1.01, t1: 1.01, t2: 1.01 } });
    expect(loose.filter((x) => x.status === 'accepted').length).toBe(9);
    expect(strict.every((x) => x.status === 'flagged')).toBe(true);
    expect(JSON.stringify([...st.verify.values()])).toBe(before);
    // same ledger, same thresholds, same answer
    expect(computeFieldOutcomes(st, { ...ctx, mode: 'normal' })).toEqual(computeFieldOutcomes(st, { ...ctx, mode: 'normal' }));
    // document level follows from the fields
    const docsOut = computeOutcomes(st, { ...ctx, mode: 'normal', thresholds: { t0: 1.01, t1: 1.01, t2: 1.01 } });
    expect(docsOut.every((o) => o.status === 'flagged')).toBe(true);
  });

  it('maxRound 1 is the simple pipeline: unaccepted fields are flagged with the round-1 value, round 2 ignored', async () => {
    const dir = tempDir();
    const api = fakeServer();
    const ctx = extractContext(dir, api.fetch);
    await executePipeline(ctx);
    const st = ledgerOf(dir);
    const simple = computeFieldOutcomes(st, ctx, { maxRound: 1 });
    expect(field(simple, 'd2', 'b')).toMatchObject({ status: 'flagged', value: 'WRONG', round: 1 });
    expect(field(simple, 'd2', 'a')).toMatchObject({ status: 'accepted', round: 1 });
    // d3's round-1 reply was unusable: flagged, no value
    expect(field(simple, 'd3', 'a')).toMatchObject({ status: 'flagged', value: null, verdict: 'invalid_output' });
    const full = computeFieldOutcomes(st, ctx);
    expect(field(full, 'd2', 'b')).toMatchObject({ status: 'accepted', value: '2', round: 2 });
  });

  it('is pending while a result or verdict is missing', async () => {
    const dir = tempDir();
    const api = fakeServer({ killWhen: (c) => c.method === 'GET' });
    const ctx = extractContext(dir, api.fetch);
    await expect(executePipeline(ctx)).rejects.toThrow('KILLED');
    const f = computeFieldOutcomes(ledgerOf(dir), ctx);
    expect(f.every((x) => x.status === 'pending')).toBe(true);
    expect(computeOutcomes(ledgerOf(dir), ctx).every((o) => o.status === 'pending')).toBe(true);
  });

  it('document outcome: min confidence, lowest-confidence verdict, latest round', async () => {
    const dir = tempDir();
    const api = fakeServer();
    const ctx = extractContext(dir, api.fetch, { rows: one('d2'), thresholds: { t0: 1.01, t1: 0.9, t2: 0.999 } });
    const [o] = await executePipeline(ctx);
    expect(o!.confidence).toBeCloseTo(0.97);
    expect(o).toMatchObject({ round: 2, model: 'strong:batch', verdict: 'supported' });
  });
});

describe('resume on the extract path', () => {
  const snapshot = (dir: string, outcomes: ReturnType<typeof computeOutcomes>) => {
    const st = ledgerOf(dir);
    return { outcomes: outcomes.map((o) => [o.rowId, o.status, o.answer, o.round, o.costUsd]), results: st.results.size, verifies: st.verify.size, spent: st.spentUsd };
  };

  it('a kill mid-batch loses nothing and repeats nothing', async () => {
    const clean = tempDir();
    const cleanOut = await executePipeline(extractContext(clean, fakeServer().fetch));

    const dir = tempDir();
    const first = fakeServer({ killWhen: (c) => c.method === 'GET' });
    await expect(executePipeline(extractContext(dir, first.fetch))).rejects.toThrow('KILLED');
    expect(first.counts.submit).toBe(1);
    const second = fakeServer();
    for (const [id, b] of first.batches) second.batches.set(id, b);
    const out = await executePipeline(extractContext(dir, second.fetch));
    expect(second.counts.submit).toBe(1); // round 2 only
    expect(snapshot(dir, out)).toEqual(snapshot(clean, cleanOut));
  });

  it('a crash mid-verify repeats no finished decision and counts no cost twice', async () => {
    const clean = tempDir();
    const cleanOut = await executePipeline(extractContext(clean, fakeServer().fetch));

    const dir = tempDir();
    let n = 0;
    const first = fakeServer({ killWhen: (c) => c.url.endsWith('/alpha/decisions') && ++n === 2 });
    await expect(executePipeline(extractContext(dir, first.fetch))).rejects.toThrow(/decision calls failed/);
    const done = first.decisions.length; // calls that completed before the crash
    const second = fakeServer();
    for (const [id, b] of first.batches) second.batches.set(id, b);
    const out = await executePipeline(extractContext(dir, second.fetch));
    // each (doc, round) is decided once overall
    const seen = [...first.decisions.slice(0, done), ...second.decisions].map((d) => `${d.doc}:${d.fields.join('')}`);
    expect(new Set(seen).size).toBe(seen.length);
    expect(snapshot(dir, out)).toEqual(snapshot(clean, cleanOut));
  });
});
