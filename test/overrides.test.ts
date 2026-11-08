import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  activeDecisions,
  allowedAnswers,
  appendOverride,
  decisionInputSchema,
  foldOverrides,
  makeOverride,
  MAX_ANSWER_CHARS,
  overridesPath,
  readOverrides,
  type OverrideRecord,
} from '../src/overrides.ts';
import type { RowOutcome } from '../src/pipeline.ts';
import { defineTask, loadTask } from '../src/task.ts';
import { tempDir } from './helpers.ts';
import { TASK } from './ui-fixtures.ts';

const AT = '2026-11-08T10:00:00.000Z';
const outcome = (rowId: string, status: RowOutcome['status'], answer: string): RowOutcome => ({
  rowId,
  data: { text: `message ${rowId}` },
  status,
  answer,
  confidence: 0.5,
  verdict: status === 'accepted' ? 'supported' : 'cannot_tell',
  model: 'm',
  round: 2,
  costUsd: 0.001,
});
const accept = (rowId: string, answer: string): OverrideRecord => ({ rowId, action: 'accept', answer, previous: answer, at: AT });
const override = (rowId: string, answer: string, previous = 'x'): OverrideRecord => ({ rowId, action: 'override', answer, previous, at: AT });
const clear = (rowId: string): OverrideRecord => ({ rowId, action: 'clear', at: AT });

const openTask = defineTask({
  name: 'summaries',
  state: (row) => row.text ?? '',
  writer: { promptTemplate: '{{text}}', maxTokens: 100, outputSchema: z.string() },
  verify: { instructions: 'Is the summary faithful?' },
  models: { writer: 'w:batch', escalation: 'e:batch', decision: 'd' },
});

describe('overrides.jsonl', () => {
  it('appends one line per decision and reads them back in order', () => {
    const dir = tempDir();
    expect(readOverrides(dir)).toEqual([]);
    appendOverride(dir, accept('r1', 'card_arrival'));
    appendOverride(dir, override('r2', 'age_limit'));
    expect(readFileSync(overridesPath(dir), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(readOverrides(dir).map((r) => [r.rowId, r.action])).toEqual([
      ['r1', 'accept'],
      ['r2', 'override'],
    ]);
  });

  it('last line wins, and clear removes the decision', () => {
    const active = activeDecisions([accept('r1', 'a'), override('r1', 'b'), override('r2', 'c'), clear('r2'), clear('r3')]);
    expect([...active.keys()]).toEqual(['r1']);
    expect(active.get('r1')).toMatchObject({ action: 'override', answer: 'b' });
    // a decision after a clear counts again
    expect(activeDecisions([accept('r1', 'a'), clear('r1'), accept('r1', 'a')]).get('r1')?.action).toBe('accept');
  });

  it('skips a torn last line on read and repairs it before the next append', () => {
    const dir = tempDir();
    appendOverride(dir, accept('r1', 'a'));
    appendFileSync(overridesPath(dir), '{"rowId":"r2","action":"over'); // killed mid-write
    expect(readOverrides(dir).map((r) => r.rowId)).toEqual(['r1']);
    appendOverride(dir, accept('r3', 'a'));
    expect(readOverrides(dir).map((r) => r.rowId)).toEqual(['r1', 'r3']);
    expect(readFileSync(overridesPath(dir), 'utf8').endsWith('\n')).toBe(true);
  });

  it('refuses corruption in the middle, and lines that are not overrides', () => {
    const dir = tempDir();
    writeFileSync(overridesPath(dir), `${JSON.stringify(accept('r1', 'a'))}\nnot json\n${JSON.stringify(accept('r2', 'a'))}\n`);
    expect(() => readOverrides(dir)).toThrow(/line 2/);
    writeFileSync(overridesPath(dir), `${JSON.stringify({ rowId: 'r1', action: 'delete', at: AT })}\n`);
    expect(() => readOverrides(dir)).toThrow(/entry 1 is not a valid override/);
  });
});

describe('foldOverrides', () => {
  const outcomes = [outcome('r1', 'accepted', 'a'), outcome('r2', 'flagged', 'b'), outcome('r3', 'flagged', ''), outcome('r4', 'pending', '')];

  it('gives reviewed rows their own status and keeps the pipeline answer next to the final one', () => {
    const folded = foldOverrides(outcomes, [override('r2', 'c', 'b'), accept('r1', 'a'), override('ghost', 'z')]);
    expect(folded.map((f) => [f.rowId, f.status, f.pipelineStatus, f.answer, f.finalAnswer])).toEqual([
      ['r1', 'reviewed', 'accepted', 'a', 'a'],
      ['r2', 'reviewed', 'flagged', 'b', 'c'],
      ['r3', 'flagged', 'flagged', '', ''],
      ['r4', 'pending', 'pending', '', ''],
    ]);
    expect(folded[1]!.review).toMatchObject({ action: 'override', previous: 'b' });
    expect(folded[2]!.review).toBeNull();
  });

  it('is pure: same inputs, same output, inputs untouched', () => {
    const records = [override('r2', 'c', 'b'), clear('r2'), accept('r1', 'a')];
    const frozen = Object.freeze(outcomes.map((o) => Object.freeze({ ...o, data: Object.freeze({ ...o.data }) })));
    const before = structuredClone([outcomes, records]);
    const a = foldOverrides(frozen, Object.freeze(records.map((r) => Object.freeze(r))));
    const b = foldOverrides(frozen, records);
    expect(a).toEqual(b);
    expect([outcomes, records]).toEqual(before);
    expect(a[1]!.status).toBe('flagged'); // cleared
    expect(a[0]).not.toBe(frozen[0]);
  });
});

describe('makeOverride: validation against the task', () => {
  it('a closed-choice override must be one of the output schema labels', async () => {
    const task = await loadTask(TASK);
    expect(allowedAnswers(task)).toHaveLength(77);
    const row = outcome('r2', 'flagged', 'card_arrival');
    expect(makeOverride({ rowId: 'r2', action: 'override', answer: 'age_limit', note: '  checked  ' }, row, task, new Date(AT))).toEqual({
      rowId: 'r2',
      action: 'override',
      answer: 'age_limit',
      previous: 'card_arrival',
      note: 'checked',
      at: AT,
      pipelineStatus: 'flagged',
    });
    for (const answer of ['not_a_label', 'Age_Limit', ' age_limit', '']) {
      expect(() => makeOverride({ rowId: 'r2', action: 'override', answer }, row, task), answer).toThrow(/not one of the task's labels/);
    }
  });

  it('accept takes the pipeline answer, and needs a valid one', async () => {
    const task = await loadTask(TASK);
    expect(makeOverride({ rowId: 'r2', action: 'accept' }, outcome('r2', 'flagged', 'atm_support'), task)).toMatchObject({
      action: 'accept',
      answer: 'atm_support',
      previous: 'atm_support',
    });
    expect(() => makeOverride({ rowId: 'r3', action: 'accept' }, outcome('r3', 'flagged', ''), task)).toThrow(/no answer/);
    expect(() => makeOverride({ rowId: 'r3', action: 'accept' }, outcome('r3', 'flagged', 'I think atm'), task)).toThrow(/override it instead/);
  });

  it('records the pipeline status, so a decision on an accepted row is visible as such', async () => {
    const task = await loadTask(TASK);
    expect(makeOverride({ rowId: 'r1', action: 'override', answer: 'age_limit' }, outcome('r1', 'accepted', 'card_arrival'), task)).toMatchObject({
      pipelineStatus: 'accepted',
      previous: 'card_arrival',
    });
  });

  it('refuses unknown rows', async () => {
    const task = await loadTask(TASK);
    expect(() => makeOverride({ rowId: 'nope', action: 'clear' }, undefined, task)).toThrow(expect.objectContaining({ code: 'unknown_row' }));
  });

  it('an open-ended override is any non-empty text up to the limit', () => {
    expect(allowedAnswers(openTask)).toBeNull();
    const row = outcome('r1', 'flagged', 'old summary');
    expect(makeOverride({ rowId: 'r1', action: 'override', answer: '  A better summary. ' }, row, openTask)).toMatchObject({ answer: 'A better summary.' });
    expect(() => makeOverride({ rowId: 'r1', action: 'override', answer: '   ' }, row, openTask)).toThrow(/empty/);
    expect(() => makeOverride({ rowId: 'r1', action: 'override', answer: 'x'.repeat(MAX_ANSWER_CHARS + 1) }, row, openTask)).toThrow(/longer than/);
  });

  it('the request body schema refuses extra keys and missing answers', () => {
    expect(decisionInputSchema.safeParse({ rowId: 'r1', action: 'override' }).success).toBe(false);
    expect(decisionInputSchema.safeParse({ rowId: 'r1', action: 'accept', answer: 'x' }).success).toBe(false);
    expect(decisionInputSchema.safeParse({ rowId: 'r1', action: 'clear', note: 'x' }).success).toBe(false);
    expect(decisionInputSchema.safeParse({ rowId: '', action: 'clear' }).success).toBe(false);
    expect(decisionInputSchema.safeParse({ rowId: 'r1', action: 'accept', note: 'fine' }).success).toBe(true);
  });
});
