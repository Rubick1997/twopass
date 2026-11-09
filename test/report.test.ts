import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';
import { describe, expect, it } from 'vitest';
import { appendOverride, type ReviewDecision } from '../src/overrides.ts';
import { loadReport, reviewLine, rewriteOutputs, summarize } from '../src/report.ts';
import { makeRoot, reviewRun } from './ui-fixtures.ts';

const AT = '2026-11-08T10:00:00.000Z';
const decide = (dir: string, r: Omit<ReviewDecision, 'at'>) => appendOverride(dir, { ...r, at: AT });

describe('report with a reviewer', () => {
  it('accuracy without and with a human, and review progress', async () => {
    const root = makeRoot();
    const { dir } = reviewRun(root);

    let { outcomes, st, overrides } = await loadReport(dir);
    expect(outcomes.map((o) => [o.rowId, o.status, o.answer])).toEqual([
      ['r1', 'accepted', 'card_arrival'],
      ['r2', 'accepted', 'age_limit'],
      ['r3', 'flagged', 'card_linking'],
      ['r4', 'flagged', 'card_linking'],
    ]);
    let s = summarize(outcomes, st, 'label', overrides);
    expect(s.review).toEqual({
      flagged: 2,
      reviewed: 0,
      remaining: 2,
      reviewedOther: 0,
      overridden: 0,
      accuracy: { noHuman: 0.75, withHuman: 0.75, correctNoHuman: 3, correctWithHuman: 3, of: 4 },
    });

    decide(dir, { rowId: 'r3', action: 'override', answer: 'atm_support', previous: 'card_linking', pipelineStatus: 'flagged' });
    decide(dir, { rowId: 'r4', action: 'accept', answer: 'card_linking', previous: 'card_linking', pipelineStatus: 'flagged' });
    ({ outcomes, st, overrides } = await loadReport(dir));
    s = summarize(outcomes, st, 'label', overrides);
    expect(s.review).toMatchObject({ reviewed: 2, remaining: 0, overridden: 1, accuracy: { noHuman: 0.75, withHuman: 1 } });
    expect(s.flagged).toBe(2); // the pipeline's numbers don't change
    expect(s.precision).toEqual({ correct: 2, of: 2 });

    // a reviewer can also change a row the pipeline accepted (here, wrongly)
    decide(dir, { rowId: 'r2', action: 'override', answer: 'atm_support', previous: 'age_limit', pipelineStatus: 'accepted' });
    ({ outcomes, st, overrides } = await loadReport(dir));
    s = summarize(outcomes, st, 'label', overrides);
    expect(s.review).toMatchObject({ reviewed: 2, reviewedOther: 1, overridden: 2, accuracy: { withHuman: 0.75 } });
    expect(reviewLine(s.review)).toBe(
      '2 of 2 flagged rows reviewed, 0 to review · 1 other row reviewed · 2 answers changed · accuracy, no human 75.0% → with a human 75.0%',
    );
  });

  it('--write: enriched.csv gains reviewed_by_human and final_answer; review.csv keeps only unreviewed rows', async () => {
    const root = makeRoot();
    const { dir } = reviewRun(root);
    const read = (f: string) => parse(readFileSync(join(dir, f), 'utf8'), { columns: true }) as Record<string, string>[];

    await rewriteOutputs(dir);
    expect(read('review.csv').map((r) => r.id)).toEqual(['r3', 'r4']);

    decide(dir, { rowId: 'r3', action: 'override', answer: 'atm_support', previous: 'card_linking', note: '=ask ops', pipelineStatus: 'flagged' });
    await rewriteOutputs(dir);
    const enriched = read('enriched.csv');
    expect(Object.keys(enriched[0]!)).toEqual([
      'id', 'text', 'label', 'answer', 'confidence', 'verdict', 'model', 'round', 'cost_usd', 'status', 'reviewed_by_human', 'final_answer', 'review_note',
    ]);
    expect(enriched.map((r) => [r.id, r.status, r.answer, r.final_answer, r.reviewed_by_human])).toEqual([
      ['r1', 'accepted', 'card_arrival', 'card_arrival', ''],
      ['r2', 'accepted', 'age_limit', 'age_limit', ''],
      ['r3', 'reviewed', 'card_linking', 'atm_support', 'overridden'],
      ['r4', 'flagged', 'card_linking', 'card_linking', ''],
    ]);
    expect(enriched[2]!.review_note).toBe("'=ask ops"); // escapeCell still applies
    expect(read('review.csv').map((r) => r.id)).toEqual(['r4']);
  });

  it('the CLI prints the review line and rewrites the files without a key', () => {
    const root = makeRoot();
    const { dir } = reviewRun(root, 'run-cli');
    decide(dir, { rowId: 'r3', action: 'override', answer: 'atm_support', previous: 'card_linking', pipelineStatus: 'flagged' });
    const env = { ...process.env, OPENROUTER_API_KEY: '' };
    const out = execFileSync('node', ['src/cli.ts', 'report', 'run-cli', '--runs', root, '--write'], { encoding: 'utf8', env });
    expect(out).toContain('review: 1 of 2 flagged rows reviewed, 1 to review · 1 answer changed · accuracy, no human 75.0% → with a human 100.0%');
    // the cost check (billed batches) and the review line appear together
    expect(out).toMatch(/cost check: per-row cost \$[\d.]+ vs billed \$[\d.]+ over \d+ batch\(es\)/);
    expect(out.indexOf('review: ')).toBeLessThan(out.indexOf('cost check: '));
    expect(out).toContain('wrote ');
    expect(readFileSync(join(dir, 'review.csv'), 'utf8').trim().split('\n')).toHaveLength(2);
  });
});
