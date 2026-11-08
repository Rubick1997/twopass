import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readOverrides } from '../src/overrides.ts';
import { BadRequestError, getReview, getRun, listRuns, NotFoundError, postOutputs, postOverride, topLabels } from '../src/ui/api.ts';
import { ESCALATION, lockRun, makeRoot, makeRun, MIN, results, reviewRun, submit, T0, triage, WRITER } from './ui-fixtures.ts';

const at = { now: () => T0 + 20 * MIN, pidAlive: () => false };

describe('GET /api/runs/:id/review', () => {
  it('lists the flagged rows with everything the pipeline knew', async () => {
    const root = makeRoot();
    reviewRun(root);
    const r = await getReview(root, 'run-review', null, at);
    expect(r).toMatchObject({
      runId: 'run-review',
      status: 'finished',
      running: false,
      filter: 'flagged',
      kind: 'closed',
      inputColumns: ['text'], // the prompt's column; not id or label
      labelColumn: 'label',
      counts: { rows: 4, flagged: 2, reviewed: 0, remaining: 2, reviewedOther: 0, overridden: 0 },
      accuracy: { noHuman: 0.75, withHuman: 0.75, of: 4 },
    });
    expect(r.labels).toHaveLength(77);
    expect(r.rows.map((x) => x.rowId)).toEqual(['r3', 'r4']);

    const r3 = r.rows[0]!;
    expect(r3).toMatchObject({
      status: 'flagged',
      pipelineStatus: 'flagged',
      input: { text: 'message 3' },
      expected: 'atm_support',
      answer: 'card_linking',
      acceptable: true,
      finalAnswer: 'card_linking',
      round: 2,
      review: null,
    });
    // round-0 top 3 from the triage answer's probabilities (cannot_tell and zeros left out)
    expect(r3.triage).toMatchObject({
      choice: 'card_arrival',
      probability: 0.5,
      cannotTell: 0.05,
      top: [
        { label: 'card_arrival', probability: 0.5 },
        { label: 'atm_support', probability: 0.3 },
        { label: 'card_linking', probability: 0.15 },
      ],
    });
    // each round: model, answer, cost, and the verify decision with all three probabilities
    expect(r3.rounds).toEqual([
      {
        round: 1,
        model: 'anthropic/claude-haiku-5.5:batch',
        answer: 'card_arrival',
        valid: true,
        error: null,
        inFlight: false,
        costUsd: 0.0005,
        verify: { verdict: 'unsupported', confidence: 0.8, probabilities: { supported: 0.1, unsupported: 0.85, cannot_tell: 0.05 }, model: 'typesafe/jev-1.14-x', costUsd: 0.001 },
      },
      {
        round: 2,
        model: 'anthropic/claude-sonnet-5.5:batch',
        answer: 'card_linking',
        valid: true,
        error: null,
        inFlight: false,
        costUsd: 0.0005,
        verify: { verdict: 'unsupported', confidence: 0.8, probabilities: { supported: 0.2, unsupported: 0.6, cannot_tell: 0.2 }, model: 'typesafe/jev-1.14-x', costUsd: 0.001 },
      },
    ]);
  });

  it('filters: flagged (default), reviewed, all; anything else is a 400', async () => {
    const root = makeRoot();
    reviewRun(root);
    await postOverride(root, 'run-review', { rowId: 'r1', action: 'override', answer: 'age_limit' }, at);
    await postOverride(root, 'run-review', { rowId: 'r4', action: 'accept' }, at);
    const ids = async (f: string | null) => (await getReview(root, 'run-review', f, at)).rows.map((x) => x.rowId);
    expect(await ids(null)).toEqual(['r3', 'r4']);
    expect(await ids('flagged')).toEqual(['r3', 'r4']);
    expect(await ids('reviewed')).toEqual(['r1', 'r4']);
    expect(await ids('all')).toEqual(['r1', 'r2', 'r3', 'r4']);
    await expect(getReview(root, 'run-review', 'everything', at)).rejects.toBeInstanceOf(BadRequestError);
  });

  it('says when the run is still running', async () => {
    const root = makeRoot();
    const { dir } = reviewRun(root);
    lockRun(dir, 20 * MIN - 5_000);
    expect(await getReview(root, 'run-review', null, { ...at, pidAlive: () => true })).toMatchObject({ running: true, status: 'running' });
  });

  it('marks an invalid pipeline answer as not acceptable, and the API refuses to accept it', async () => {
    const root = makeRoot();
    const { ledger } = makeRun(root, 'run-bad', { rows: 1 });
    triage(ledger, 'r1', 'card_arrival', 0.5, 0);
    submit(ledger, 'b1', 1, WRITER, ['r1'], MIN);
    results(ledger, 'b1', 1, WRITER, { r1: 'not a label' }, 2 * MIN);
    submit(ledger, 'b2', 2, ESCALATION, ['r1'], 3 * MIN);
    results(ledger, 'b2', 2, ESCALATION, { r1: 'still not a label' }, 4 * MIN);
    const r = (await getReview(root, 'run-bad', null, at)).rows[0]!;
    expect(r).toMatchObject({ verdict: 'invalid_output', acceptable: false });
    expect(r.rounds.map((x) => [x.valid, x.answer])).toEqual([
      [false, '{"label":"not a label"}'],
      [false, '{"label":"still not a label"}'],
    ]);
    await expect(postOverride(root, 'run-bad', { rowId: 'r1', action: 'accept' }, at)).rejects.toThrow(/override it instead/);
    expect((await postOverride(root, 'run-bad', { rowId: 'r1', action: 'override', answer: 'card_arrival' }, at)).row.finalAnswer).toBe('card_arrival');
  });

  it('topLabels sorts by probability, then name', () => {
    expect(topLabels({ b: 0.2, a: 0.2, c: 0.5, cannot_tell: 0.9, d: 0 })).toEqual([
      { label: 'c', probability: 0.5 },
      { label: 'a', probability: 0.2 },
      { label: 'b', probability: 0.2 },
    ]);
  });
});

describe('POST /api/runs/:id/overrides', () => {
  it('appends a decision and returns the row and the new counts', async () => {
    const root = makeRoot();
    const { dir } = reviewRun(root);
    const res = await postOverride(root, 'run-review', { rowId: 'r3', action: 'override', answer: 'atm_support', note: 'obvious' }, at);
    expect(res.row).toMatchObject({
      rowId: 'r3',
      status: 'reviewed',
      pipelineStatus: 'flagged',
      answer: 'card_linking',
      finalAnswer: 'atm_support',
      review: { action: 'override', answer: 'atm_support', previous: 'card_linking', note: 'obvious', pipelineStatus: 'flagged', stale: false },
    });
    expect(res.counts).toMatchObject({ flagged: 2, reviewed: 1, remaining: 1, overridden: 1 });
    expect(res.accuracy).toMatchObject({ noHuman: 0.75, withHuman: 1 });
    expect(readOverrides(dir)).toEqual([
      { rowId: 'r3', action: 'override', answer: 'atm_support', previous: 'card_linking', note: 'obvious', at: new Date(T0 + 20 * MIN).toISOString(), pipelineStatus: 'flagged' },
    ]);

    // undo
    const undone = await postOverride(root, 'run-review', { rowId: 'r3', action: 'clear' }, at);
    expect(undone.row).toMatchObject({ status: 'flagged', review: null, finalAnswer: 'card_linking' });
    expect(undone.counts).toMatchObject({ reviewed: 0, remaining: 2 });
    expect(readOverrides(dir)).toHaveLength(2);

    // the run list and run page carry the count
    expect((await listRuns(root, at)).runs[0]!.review).toEqual({ flagged: 2, reviewed: 0, remaining: 2 });
    expect((await getRun(root, 'run-review', at)).review).toEqual({ flagged: 2, reviewed: 0, remaining: 2 });
  });

  it('refuses unknown rows, labels outside the set, bad bodies and bad run IDs, writing nothing', async () => {
    const root = makeRoot();
    const { dir } = reviewRun(root);
    await expect(postOverride(root, 'run-review', { rowId: 'r99', action: 'accept' }, at)).rejects.toBeInstanceOf(NotFoundError);
    await expect(postOverride(root, 'run-review', { rowId: 'r3', action: 'override', answer: 'card arrival' }, at)).rejects.toThrow(/not one of the task's labels/);
    await expect(postOverride(root, 'run-review', { rowId: 'r3', action: 'override' }, at)).rejects.toBeInstanceOf(BadRequestError);
    await expect(postOverride(root, 'run-review', { rowId: 'r3', action: 'delete' }, at)).rejects.toBeInstanceOf(BadRequestError);
    await expect(postOverride(root, 'run-review', [1, 2], at)).rejects.toBeInstanceOf(BadRequestError);
    await expect(postOverride(root, '../run-review', { rowId: 'r3', action: 'accept' }, at)).rejects.toBeInstanceOf(BadRequestError);
    await expect(postOverride(root, 'nope', { rowId: 'r3', action: 'accept' }, at)).rejects.toBeInstanceOf(NotFoundError);
    expect(existsSync(join(dir, 'overrides.jsonl'))).toBe(false);
  });
});

describe('POST /api/runs/:id/outputs', () => {
  it('rewrites enriched.csv and review.csv and touches nothing else', async () => {
    const root = makeRoot();
    const { dir } = reviewRun(root);
    await postOverride(root, 'run-review', { rowId: 'r4', action: 'accept' }, at);
    const before = new Map(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
    const res = await postOutputs(root, 'run-review', at);
    expect(res).toMatchObject({ written: ['enriched.csv', 'review.csv'], counts: { reviewed: 1, remaining: 1 } });
    const after = readdirSync(dir).sort();
    expect(after).toEqual([...before.keys(), 'enriched.csv', 'review.csv'].sort());
    for (const [f, text] of before) expect(readFileSync(join(dir, f), 'utf8'), f).toBe(text);
    expect(readFileSync(join(dir, 'review.csv'), 'utf8')).toContain('r3');
    expect(readFileSync(join(dir, 'review.csv'), 'utf8')).not.toContain('r4,');
  });

  it('works on a run with nothing flagged', async () => {
    const root = makeRoot();
    makeRun(root, 'empty-run', { rows: 0 });
    expect((await postOutputs(root, 'empty-run', at)).counts).toMatchObject({ flagged: 0, rows: 0 });
  });
});
