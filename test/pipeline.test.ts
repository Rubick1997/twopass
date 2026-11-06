import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OpenRouterBatchProvider } from '../src/batch/openrouter.ts';
import { Budget, BudgetExceededError } from '../src/budget.ts';
import { OpenRouterDecisionModel } from '../src/decide/openrouter.ts';
import { Ledger, replay } from '../src/ledger.ts';
import { computeOutcomes, executePipeline, TruncatedOutputError, type PipelineContext } from '../src/pipeline.ts';
import { defineTask } from '../src/task.ts';
import { chatResult, mockFetch, noSleep, tempDir, type Call } from './helpers.ts';

// A tiny closed-choice task. Ground truth: every row's answer is "a".
const task = defineTask({
  name: 'toy',
  state: (row) => row.text ?? '',
  triage: { question: { type: 'choice', criteria: { a: 'A', b: 'B', cannot_tell: '?' } } },
  writer: {
    promptTemplate: '{{text}}',
    maxTokens: 5,
    reasoning: { enabled: false },
    escalation: { template: '{{text}} (was {{previous_answer}})', maxTokens: 50, reasoning: { effort: 'minimal' } },
    outputSchema: z.enum(['a', 'b']),
  },
  verify: { instructions: 'Is it right?', state: (row, answer) => ({ text: row.text ?? '', answer }) },
  models: { writer: 'cheap:batch', escalation: 'strong:batch', decision: 'dec' },
});

const rows = ['sure', 'unsure-right', 'unsure-wrong', 'unsure-garbage'].map((text, i) => ({ id: `r${i + 1}`, data: { text } }));

// Shared across fake servers so a "restarted" process never sees a reused batch ID.
let nextId = 1;

/** Fake OpenRouter: decisions + batches, with a hook to "kill" the process at a chosen request. */
function fakeOpenRouter(opts: { killWhen?: (call: Call) => boolean; jsonReplies?: boolean } = {}) {
  const batches = new Map<string, { model: string; requests: Array<{ custom_id: string; body: { messages: Array<{ content: string }> } }> }>();
  const counts = { triage: 0, verify: 0, submit: 0, poll: 0 };

  const writer = (model: string, text: string) => {
    if (model === 'strong:batch') return 'a';
    if (text === 'unsure-right') return 'a';
    if (text === 'unsure-wrong') return 'b';
    return 'zzz'; // invalid output
  };

  const m = mockFetch((call) => {
    if (opts.killWhen?.(call)) throw new Error('KILLED');
    const body = call.body as Record<string, any>;
    if (call.url.endsWith('/alpha/decisions')) {
      if (body.questions.answer) {
        counts.triage++;
        const sure = body.state === 'sure';
        return [200, { model: 'dec-v1', answers: { answer: { type: 'choice', choice: 'a', probabilities: { a: sure ? 0.99 : 0.5, b: 0.3, cannot_tell: 0.2 }, confidence: 1 } }, usage: { cost: 0.001 } }];
      }
      counts.verify++;
      const good = body.state.answer === 'a';
      return [200, { model: 'dec-v1', answers: { verdict: { type: 'choice', choice: good ? 'supported' : 'unsupported', probabilities: { supported: good ? 0.97 : 0.05, unsupported: good ? 0.02 : 0.9, cannot_tell: 0.01 }, confidence: 1 } }, usage: { cost: 0.001 } }];
    }
    if (call.method === 'POST' && call.url.endsWith('/batches')) {
      counts.submit++;
      const id = `batch-${nextId++}`;
      batches.set(id, { model: body.model, requests: body.requests });
      return [200, { id, status: 'validating' }];
    }
    if (call.method === 'GET' && call.url.includes('/batches/')) {
      counts.poll++;
      const id = call.url.split('/').pop()!;
      const b = batches.get(id)!;
      // results come back out of order, as observed in Phase 0
      const reply = (label: string) => (opts.jsonReplies ? JSON.stringify({ label }) : label);
      const results = [...b.requests].reverse().map((r) => chatResult(r.custom_id, reply(writer(b.model, r.body.messages.at(-1)!.content.split(' ')[0]!))));
      return [200, { id, status: 'completed', usage: { cost: 0.002 }, results }];
    }
    return [404, {}];
  });
  return { ...m, counts, batches };
}

function context(dir: string, fetchFn: ReturnType<typeof mockFetch>['fetch'], maxUsd?: number): PipelineContext {
  const ledger = new Ledger(join(dir, 'ledger.jsonl'));
  const decider = new OpenRouterDecisionModel({ apiKey: 'k', model: 'dec', fetch: fetchFn, sleep: noSleep, maxRetries: 0 });
  return {
    task,
    rows,
    ledger,
    triageDecider: decider,
    verifyDecider: decider,
    batch: new OpenRouterBatchProvider({ apiKey: 'k', fetch: fetchFn, sleep: noSleep, maxRetries: 0 }),
    writerModel: 'cheap:batch',
    escalationModel: 'strong:batch',
    thresholds: { t0: 0.9, t1: 0.9, t2: 0.9 },
    budget: new Budget(maxUsd, replay(ledger.read()).spentUsd),
    prices: { 'cheap:batch': { inputPerToken: 1e-7, outputPerToken: 1e-6 }, 'strong:batch': { inputPerToken: 1e-6, outputPerToken: 5e-6 } },
    pollIntervalMs: 0,
  };
}

describe('pipeline', () => {
  it('routes rows through triage, write, verify and escalation', async () => {
    const api = fakeOpenRouter();
    const outcomes = await executePipeline(context(tempDir(), api.fetch));

    expect(outcomes.map((o) => [o.rowId, o.status, o.round, o.answer, o.verdict])).toEqual([
      ['r1', 'accepted', 0, 'a', 'triage'],
      ['r2', 'accepted', 1, 'a', 'supported'],
      ['r3', 'accepted', 2, 'a', 'supported'], // writer said b, verify rejected, escalation fixed it
      ['r4', 'accepted', 2, 'a', 'supported'], // writer output invalid, skipped verify, escalated
    ]);
    expect(api.counts).toMatchObject({ triage: 4, submit: 2 });
    expect(api.counts.verify).toBe(4); // r2, r3 in round 1; r3, r4 in round 2
    // escalation prompt received the earlier answer
    const round2 = [...api.batches.values()].find((b) => b.model === 'strong:batch')!;
    expect(round2.requests.find((r) => r.custom_id === 'r3-r2')!.body.messages[0]!.content).toBe('unsure-wrong (was b)');
  });

  it('sends each round its own max_tokens and reasoning setting', async () => {
    const api = fakeOpenRouter();
    await executePipeline(context(tempDir(), api.fetch));
    const [r1, r2] = [...api.batches.values()];
    expect(r1!.requests[0]!.body).toMatchObject({ max_tokens: 5, reasoning: { enabled: false } });
    expect(r1!.requests[0]!.body).not.toHaveProperty('response_format');
    expect(r2!.requests[0]!.body).toMatchObject({ max_tokens: 50, reasoning: { effort: 'minimal' } });
  });

  it('shows the escalation model the earlier answer, not the raw JSON reply', async () => {
    const api = fakeOpenRouter({ jsonReplies: true });
    const json = { ...task, writer: { ...task.writer, answerField: 'label', responseFormat: { type: 'json_object' } } };
    const outcomes = await executePipeline({ ...context(tempDir(), api.fetch), task: json });
    const round2 = [...api.batches.values()].find((b) => b.model === 'strong:batch')!;
    expect(round2.requests[0]!.body).toMatchObject({ response_format: { type: 'json_object' } });
    expect(round2.requests.find((r) => r.custom_id === 'r3-r2')!.body.messages[0]!.content).toBe('unsure-wrong (was b)');
    expect(outcomes.find((o) => o.rowId === 'r3')).toMatchObject({ status: 'accepted', answer: 'a' });
  });

  it('stops with a clear error when answers are cut off, keeping what it saved', async () => {
    const dir = tempDir();
    const api = fakeOpenRouter();
    const cutting = mockFetch(async (call) => {
      const res = await api.fetch(call.url, { method: call.method, ...(call.body ? { body: JSON.stringify(call.body) } : {}) });
      const json = await res.json();
      if (call.method === 'GET' && json.results) {
        for (const r of json.results) if (r.custom_id === 'r2-r1') r.response.body.choices[0].finish_reason = 'length';
      }
      return [res.status, json];
    });
    await expect(executePipeline({ ...context(dir, cutting.fetch), truncationTolerance: 0 })).rejects.toBeInstanceOf(
      TruncatedOutputError,
    );
    const st = replay(new Ledger(join(dir, 'ledger.jsonl')).read());
    expect(st.results.get('r3-r1')?.ok).toBe(true); // the other rows' answers were saved first
    expect(st.results.get('r2-r1')).toMatchObject({ ok: false, error: expect.stringMatching(/cut off/) });
  });

  it('lets an occasional cut-off answer through as a failed row', async () => {
    const api = fakeOpenRouter();
    const cutting = mockFetch(async (call) => {
      const res = await api.fetch(call.url, { method: call.method, ...(call.body ? { body: JSON.stringify(call.body) } : {}) });
      const json = await res.json();
      if (call.method === 'GET' && json.results) {
        for (const r of json.results) if (r.custom_id === 'r2-r1') r.response.body.choices[0].finish_reason = 'length';
      }
      return [res.status, json];
    });
    const outcomes = await executePipeline(context(tempDir(), cutting.fetch)); // 1 of 3 rows, at most 1 allowed
    expect(outcomes.find((o) => o.rowId === 'r2')).toMatchObject({ status: 'accepted', round: 2 });
  });

  it('collect mode sends every row through every stage, and can be replayed under any thresholds', async () => {
    const dir = tempDir();
    const api = fakeOpenRouter();
    await executePipeline({ ...context(dir, api.fetch), mode: 'collect' });
    const [r1, r2] = [...api.batches.values()];
    expect(r1!.requests.map((r) => r.custom_id)).toEqual(['r1-r1', 'r2-r1', 'r3-r1', 'r4-r1']);
    expect(r2!.requests).toHaveLength(4);
    expect(api.counts.verify).toBe(4 + 4 - 2); // r1's and r4's round-1 answers are invalid, so not verified

    // Replaying the collected ledger with normal routing gives the same answers as a normal run.
    const st = replay(new Ledger(join(dir, 'ledger.jsonl')).read());
    const replayed = computeOutcomes(st, { task, rows, thresholds: { t0: 0.9, t1: 0.9, t2: 0.9 } });
    expect(replayed.map((o) => [o.rowId, o.status, o.round])).toEqual([
      ['r1', 'accepted', 0],
      ['r2', 'accepted', 1],
      ['r3', 'accepted', 2],
      ['r4', 'accepted', 2],
    ]);
    const strict = computeOutcomes(st, { task, rows, thresholds: { t0: 1.01, t1: 1.01, t2: 1.01 } });
    expect(strict.every((o) => o.status === 'flagged')).toBe(true);
  });

  it('baseline mode answers every row with one model and accepts every valid answer', async () => {
    const api = fakeOpenRouter();
    const outcomes = await executePipeline({ ...context(tempDir(), api.fetch), mode: 'baseline', writerModel: 'strong:batch' });
    expect(api.counts).toMatchObject({ triage: 0, verify: 0, submit: 1 });
    // round-1 prompt, but the strong model's settings (Opus cannot turn reasoning off)
    const [b] = [...api.batches.values()];
    expect(b!.requests[0]!.body).toMatchObject({ max_tokens: 50, reasoning: { effort: 'minimal' } });
    expect(b!.requests[0]!.body.messages[0]!.content).toBe('sure');
    expect(outcomes.map((o) => [o.status, o.answer, o.verdict])).toEqual(Array(4).fill(['accepted', 'a', 'baseline']));
  });

  it('stops instead of retrying when the provider fails the whole batch', async () => {
    const dir = tempDir();
    const api = fakeOpenRouter();
    const failing = mockFetch(async (call) => {
      const res = await api.fetch(call.url, { method: call.method, ...(call.body ? { body: JSON.stringify(call.body) } : {}) });
      const json = await res.json();
      if (call.method === 'GET') return [200, { id: json.id, status: 'failed', results: null, error: { message: 'Reasoning is mandatory' } }];
      return [res.status, json];
    });
    await expect(executePipeline(context(dir, failing.fetch))).rejects.toThrow(/failed as a whole: Reasoning is mandatory/);
    expect(api.counts.submit).toBe(1);
    // the rows are recorded as failed once, so a resume after fixing the task still retries them
    expect(replay(new Ledger(join(dir, 'ledger.jsonl')).read()).attempts.get('r2-r1')).toBe(1);
  });

  it('with a row limit, submits batches one at a time and waits for each', async () => {
    const api = fakeOpenRouter();
    const outcomes = await executePipeline({ ...context(tempDir(), api.fetch), maxRowsPerBatch: 2, mode: 'collect' });
    const sizes = [...api.batches.values()].map((b) => b.requests.length);
    expect(sizes).toEqual([2, 2, 2, 2]); // round 1: 4 rows in 2 batches, round 2 likewise
    expect(api.counts.poll).toBe(4); // each batch polled to completion before the next was sent
    expect(outcomes.every((o) => o.status === 'accepted')).toBe(true);
  });

  it('flags rows that are still rejected after round 2', async () => {
    const api = fakeOpenRouter();
    const ctx = context(tempDir(), api.fetch);
    const outcomes = await executePipeline({ ...ctx, thresholds: { t0: 0.9, t1: 0.9, t2: 0.999 } });
    expect(outcomes.filter((o) => o.status === 'flagged').map((o) => o.rowId)).toEqual(['r3', 'r4']);
  });

  it('loses nothing and repeats nothing when killed while a batch is running', async () => {
    const dir = tempDir();
    const first = fakeOpenRouter({ killWhen: (c) => c.method === 'GET' }); // dies on first poll of round 1
    await expect(executePipeline(context(dir, first.fetch))).rejects.toThrow('KILLED');
    expect(first.counts).toMatchObject({ triage: 4, submit: 1 });

    // A new process. The fake server still knows the batch submitted before the kill.
    const second = fakeOpenRouter();
    for (const [id, b] of first.batches) second.batches.set(id, b);
    const outcomes = await executePipeline(context(dir, second.fetch));

    expect(second.counts.triage).toBe(0); // triage answers came from the ledger
    expect(second.counts.submit).toBe(1); // only the round-2 batch; round 1 was not resubmitted
    expect(outcomes.every((o) => o.status === 'accepted')).toBe(true);
    const st = replay(new Ledger(join(dir, 'ledger.jsonl')).read());
    expect(st.batches.size).toBe(2);
  });

  it('resumes after a crash in the middle of verification', async () => {
    const dir = tempDir();
    let verifies = 0;
    const first = fakeOpenRouter({
      killWhen: (c) => c.url.endsWith('/alpha/decisions') && !(c.body as any).questions.answer && ++verifies === 2,
    });
    await expect(executePipeline(context(dir, first.fetch))).rejects.toThrow(/decision calls failed/);

    const second = fakeOpenRouter();
    for (const [id, b] of first.batches) second.batches.set(id, b);
    const outcomes = await executePipeline(context(dir, second.fetch));
    expect(second.counts.triage).toBe(0);
    expect(second.counts.submit).toBe(1); // round 2 only
    expect(second.counts.verify).toBe(1 + 2); // the one that failed, then round 2
    expect(outcomes.every((o) => o.status === 'accepted')).toBe(true);
  });

  it('stops at the cost cap and resumes when it is raised', async () => {
    const dir = tempDir();
    const api = fakeOpenRouter();
    await expect(executePipeline(context(dir, api.fetch, 0.002))).rejects.toBeInstanceOf(BudgetExceededError);
    const outcomes = await executePipeline(context(dir, api.fetch, 1));
    expect(outcomes.every((o) => o.status === 'accepted')).toBe(true);
    expect(api.counts.triage).toBe(4);
  });

  it('retries failed rows by custom_id only, then flags them', async () => {
    const dir = tempDir();
    const api = fakeOpenRouter();
    const failing = mockFetch(async (call) => {
      const res = await api.fetch(call.url, { method: call.method, ...(call.body ? { body: JSON.stringify(call.body) } : {}) });
      const json = await res.json();
      if (call.method === 'GET' && json.results) {
        json.results = json.results.map((r: any) =>
          r.custom_id.startsWith('r4-') ? { custom_id: r.custom_id, response: null, error: { message: 'overloaded' } } : r,
        );
      }
      return [res.status, json];
    });
    const outcomes = await executePipeline(context(dir, failing.fetch));
    const r4 = outcomes.find((o) => o.rowId === 'r4')!;
    expect(r4).toMatchObject({ status: 'flagged', verdict: 'writer_failed', round: 2 });

    const submitted = [...api.batches.values()].map((b) => b.requests.map((r) => r.custom_id));
    expect(submitted).toEqual([
      ['r2-r1', 'r3-r1', 'r4-r1'],
      ['r4-r1'], // retry contains only the failed row
      ['r3-r2', 'r4-r2'],
      ['r4-r2'],
    ]);
  });
});
