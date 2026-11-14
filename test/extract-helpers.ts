import { join } from 'node:path';
import { z } from 'zod';
import { OpenRouterBatchProvider } from '../src/batch/openrouter.ts';
import { Budget } from '../src/budget.ts';
import { OpenRouterDecisionModel } from '../src/decide/openrouter.ts';
import { Ledger, replay } from '../src/ledger.ts';
import type { PipelineContext } from '../src/pipeline.ts';
import { defineTask } from '../src/task.ts';
import { chatResult, mockFetch, noSleep, type Call } from './helpers.ts';

export const FIELDS = ['a', 'b', 'c'] as const;
export type Values = Record<string, string | null>;

/** A toy extraction task: three fields; the checker's question text is `field=value`. */
export const toyTask = defineTask({
  name: 'toyx',
  idColumn: 'doc_id',
  inputColumns: ['text'],
  state: (row) => ({ document: row.text ?? '' }),
  writer: {
    promptTemplate: '{{text}}',
    maxTokens: 50,
    reasoning: { enabled: false },
    escalation: { maxTokens: 100, reasoning: { effort: 'minimal' } },
    outputSchema: z.object({ a: z.string().nullable(), b: z.string().nullable(), c: z.string().nullable() }),
  },
  extract: {
    fields: FIELDS,
    question: (field, value) => ({
      type: 'choice',
      instructions: `${field}=${value}`,
      criteria: { supported: 'right', unsupported: 'wrong', cannot_tell: '?' },
    }),
    isCorrect: (field, value, label) => {
      const gold = (JSON.parse(label) as Record<string, string[]>)[field] ?? [];
      return value === null ? gold.length === 0 : gold.includes(value);
    },
  },
  verify: { instructions: 'Check one field.', state: (row) => ({ document: row.text ?? '' }) },
  models: { writer: 'cheap:batch', escalation: 'strong:batch', decision: 'dec' },
});

/** What is really in each document. */
export const TRUTH: Record<string, Values> = {
  d1: { a: '1', b: '2', c: null },
  d2: { a: '1', b: '2', c: '3' },
  d3: { a: '1', b: '2', c: '3' },
};

const goldOf = (v: Values) => JSON.stringify(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === null ? [] : [x]])));

export const docs = ['d1', 'd2', 'd3'].map((id) => ({ id, data: { doc_id: id, text: id, gold: goldOf(TRUTH[id]!) } }));

/** The cheap model: d1 right, d2 gets b wrong, d3 returns garbage. The strong one: d2 also changes a (to prove it is ignored). */
export function writerReply(model: string, doc: string): string {
  if (model === 'strong:batch') return JSON.stringify(doc === 'd2' ? { ...TRUTH.d2, a: 'DIFFERENT' } : TRUTH[doc]);
  if (doc === 'd2') return JSON.stringify({ ...TRUTH.d2, b: 'WRONG' });
  if (doc === 'd3') return 'not json';
  return JSON.stringify(TRUTH[doc]);
}

let nextId = 1;

export function fakeServer(opts: { killWhen?: (call: Call) => boolean; failIds?: string[]; reply?: typeof writerReply } = {}) {
  const batches = new Map<string, { model: string; requests: Array<{ custom_id: string; body: { messages: Array<{ content: string }> } }> }>();
  const counts = { verify: 0, submit: 0, poll: 0 };
  /** Every decision call: the document and the fields asked. */
  const decisions: Array<{ doc: string; fields: string[] }> = [];
  const reply = opts.reply ?? writerReply;
  const m = mockFetch((call) => {
    if (opts.killWhen?.(call)) throw new Error('KILLED');
    const body = call.body as Record<string, any>;
    if (call.url.endsWith('/alpha/decisions')) {
      counts.verify++;
      const doc = body.state.document as string;
      decisions.push({ doc, fields: Object.keys(body.questions) });
      const answers = Object.fromEntries(
        Object.entries(body.questions as Record<string, { instructions: string }>).map(([f, q]) => {
          const ok = q.instructions === `${f}=${TRUTH[doc]![f]}`;
          return [f, { type: 'choice', choice: ok ? 'supported' : 'unsupported', probabilities: { supported: ok ? 0.97 : 0.05, unsupported: ok ? 0.02 : 0.9, cannot_tell: 0.01 }, confidence: 1 }];
        }),
      );
      return [200, { model: 'dec-v1', answers, usage: { cost: 0.001 } }];
    }
    if (call.method === 'POST' && call.url.endsWith('/batches')) {
      counts.submit++;
      const id = `xbatch-${nextId++}`;
      batches.set(id, { model: body.model, requests: body.requests });
      return [200, { id, status: 'validating' }];
    }
    if (call.method === 'GET' && call.url.includes('/batches/')) {
      counts.poll++;
      const id = call.url.split('/').pop()!;
      const b = batches.get(id)!;
      const results = [...b.requests].reverse().map((r) =>
        opts.failIds?.includes(r.custom_id)
          ? { custom_id: r.custom_id, response: null, error: { message: 'overloaded' } }
          : chatResult(r.custom_id, reply(b.model, r.body.messages.at(-1)!.content)),
      );
      return [200, { id, status: 'completed', usage: { cost: 0.002 }, results }];
    }
    return [404, {}];
  });
  return { ...m, counts, batches, decisions };
}

export function extractContext(dir: string, fetchFn: ReturnType<typeof mockFetch>['fetch'], over: Partial<PipelineContext> = {}): PipelineContext {
  const ledger = new Ledger(join(dir, 'ledger.jsonl'));
  const decider = new OpenRouterDecisionModel({ apiKey: 'k', model: 'dec', fetch: fetchFn, sleep: noSleep, maxRetries: 0 });
  return {
    task: toyTask,
    rows: docs,
    ledger,
    triageDecider: decider,
    verifyDecider: decider,
    batch: new OpenRouterBatchProvider({ apiKey: 'k', fetch: fetchFn, sleep: noSleep, maxRetries: 0 }),
    writerModel: 'cheap:batch',
    escalationModel: 'strong:batch',
    thresholds: { t0: 1.01, t1: 0.9, t2: 0.9 },
    budget: new Budget(undefined, replay(ledger.read()).spentUsd),
    prices: { 'cheap:batch': { inputPerToken: 1e-7, outputPerToken: 1e-6 }, 'strong:batch': { inputPerToken: 1e-6, outputPerToken: 5e-6 } },
    pollIntervalMs: 0,
    ...over,
  };
}
