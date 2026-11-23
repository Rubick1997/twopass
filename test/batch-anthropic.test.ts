import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AnthropicBatchProvider, decodeAnthropicResult, isAnthropicDirect, toMessagesParams } from '../src/batch/anthropic.ts';
import { OpenRouterBatchProvider } from '../src/batch/openrouter.ts';
import type { BatchHandle, BatchProvider } from '../src/batch/provider.ts';
import { RoutingBatchProvider } from '../src/batch/router.ts';
import { Budget } from '../src/budget.ts';
import { checkCsv } from '../src/check.ts';
import { priceUsage } from '../src/cost/price.ts';
import { bucketsFromAnthropic, bucketsFromOpenRouter } from '../src/cost/usage.ts';
import { OpenRouterDecisionModel } from '../src/decide/openrouter.ts';
import { Ledger, replay } from '../src/ledger.ts';
import { computedRowCost, executePipeline, writerBody, type PipelineContext } from '../src/pipeline.ts';
import { ANTHROPIC_BATCH_PRICES } from '../src/prices-anthropic.ts';
import { pricesFrom } from '../src/prices.ts';
import { defineTask, validateTask, type TaskDefinition } from '../src/task.ts';
import { anthropicBatch, anthropicMessage, anthropicSucceeded, jsonl, mockFetch, noSleep, tempDir, type Call } from './helpers.ts';

const reqs = (n: number) => Array.from({ length: n }, (_, i) => ({ custom_id: `r${i}-r1`, body: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 } }));

describe('isAnthropicDirect', () => {
  it('tells Anthropic IDs from OpenRouter IDs', () => {
    expect(isAnthropicDirect('claude-haiku-5-5')).toBe(true);
    expect(isAnthropicDirect('anthropic/claude-haiku-5.5:batch')).toBe(false);
    expect(isAnthropicDirect('typesafe/jev-1.14')).toBe(false);
    expect(isAnthropicDirect('cheap:batch')).toBe(false);
  });
});

describe('toMessagesParams', () => {
  const user = { role: 'user', content: 'Q' };
  it('moves system messages to the top-level system string and drops cache_control', () => {
    const p = toMessagesParams('claude-haiku-5-5', {
      messages: [{ role: 'system', content: [{ type: 'text', text: 'be brief', cache_control: { type: 'ephemeral', ttl: '1h' } }] }, user],
      max_tokens: 20,
    });
    expect(p).toEqual({ model: 'claude-haiku-5-5', max_tokens: 20, system: 'be brief', messages: [user] });
    expect(JSON.stringify(p)).not.toContain('cache_control');
    expect(toMessagesParams('m', { messages: [{ role: 'system', content: 'plain' }, user], max_tokens: 1 }).system).toBe('plain');
    expect(toMessagesParams('m', { messages: [user], max_tokens: 1 })).not.toHaveProperty('system');
  });
  it('maps reasoning disabled to thinking disabled', () => {
    const p = toMessagesParams('m', { messages: [user], max_tokens: 5, reasoning: { enabled: false } });
    expect(p.thinking).toEqual({ type: 'disabled' });
    expect(p).not.toHaveProperty('output_config');
  });
  it('maps reasoning effort to output_config.effort, minimal becoming low, and sets no thinking', () => {
    const p = toMessagesParams('m', { messages: [user], max_tokens: 5, reasoning: { effort: 'minimal' } });
    expect(p.output_config).toEqual({ effort: 'low' });
    expect(p).not.toHaveProperty('thinking');
    for (const e of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(toMessagesParams('m', { messages: [user], max_tokens: 5, reasoning: { effort: e } }).output_config).toEqual({ effort: e });
    }
    expect(() => toMessagesParams('m', { messages: [user], max_tokens: 5, reasoning: { effort: 'extreme' } })).toThrow(/effort/);
  });
  it('sends neither field without reasoning', () => {
    const p = toMessagesParams('m', { messages: [user], max_tokens: 5 });
    expect(p).not.toHaveProperty('thinking');
    expect(p).not.toHaveProperty('output_config');
  });
  it('maps a json_schema response_format into output_config.format next to effort', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    const p = toMessagesParams('m', {
      messages: [user],
      max_tokens: 5,
      reasoning: { effort: 'high' },
      response_format: { type: 'json_schema', json_schema: { name: 'x', strict: true, schema } },
    });
    expect(p.output_config).toEqual({ effort: 'high', format: { type: 'json_schema', schema } });
    expect(() => toMessagesParams('m', { messages: [user], max_tokens: 5, response_format: { type: 'json_object' } })).toThrow(/json_schema/);
  });
  it('never sends sampling or streaming fields, and throws on an unknown key instead of dropping it', () => {
    for (const k of ['temperature', 'top_p', 'top_k', 'stream', 'seed']) {
      expect(() => toMessagesParams('m', { messages: [user], max_tokens: 5, [k]: 1 })).toThrow(new RegExp(`"${k}"`));
    }
  });
  it('rejects unknown roles and reasoning fields', () => {
    expect(() => toMessagesParams('m', { messages: [{ role: 'tool', content: 'x' }], max_tokens: 5 })).toThrow(/role/);
    expect(() => toMessagesParams('m', { messages: [user], max_tokens: 5, reasoning: { max_tokens: 10 } })).toThrow(/reasoning/);
  });
  it('translates what writerBody produces, caching marker included', () => {
    const task = defineTask({ ...toyTask(), writer: { ...toyTask().writer, system: 'SYS', cacheSystem: '1h' } });
    const body = writerBody(task, { text: 'hello' }, 1, replay([]), 'r1', 'normal');
    const p = toMessagesParams('claude-haiku-5-5', body);
    expect(p).toMatchObject({ system: 'SYS', messages: [{ role: 'user', content: 'hello' }], max_tokens: 5, thinking: { type: 'disabled' } });
    expect(JSON.stringify(p)).not.toContain('cache_control');
  });
});

describe('decodeAnthropicResult', () => {
  const dec = (r: unknown) => decodeAnthropicResult(r as never);
  it('joins text blocks and ignores thinking, filling tokens, usage and buckets', () => {
    const line = anthropicSucceeded('a-r1', null, { content: [{ type: 'thinking', thinking: 'hm', signature: 's' }, { type: 'text', text: 'foo' }, { type: 'text', text: 'bar' }] }, { input_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 5, output_tokens: 7 });
    expect(dec(line)).toMatchObject({
      custom_id: 'a-r1',
      ok: true,
      text: 'foobar',
      inputTokens: 45,
      outputTokens: 7,
      buckets: { uncachedInput: 10, cacheRead: 30, cacheWrite: 5, output: 7, reasoning: 0 },
      usage: { input_tokens: 10, cache_read_input_tokens: 30 },
    });
  });
  it('marks max_tokens as truncated', () => {
    expect(dec(anthropicSucceeded('a', 'part', { stop_reason: 'max_tokens' }, { output_tokens: 20 }))).toMatchObject({ ok: false, truncated: true, error: expect.stringMatching(/^cut off at max_tokens/), outputTokens: 20 });
  });
  it('marks a refusal, with its category when there is one', () => {
    expect(dec(anthropicSucceeded('a', null, { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null } }))).toMatchObject({ ok: false, error: 'refusal (cyber)', inputTokens: 40 });
    expect(dec(anthropicSucceeded('a', null, { stop_reason: 'refusal' }))).toMatchObject({ ok: false, error: 'refusal' });
  });
  it('marks empty content', () => {
    expect(dec(anthropicSucceeded('a', '  '))).toMatchObject({ ok: false, error: 'empty content' });
    expect(dec(anthropicSucceeded('a', null))).toMatchObject({ ok: false, error: 'empty content', outputTokens: 5 });
  });
  it('marks errored, canceled and expired lines', () => {
    expect(dec({ custom_id: 'e', result: { type: 'errored', error: { type: 'error', request_id: null, error: { type: 'invalid_request_error', message: 'bad schema' } } } })).toMatchObject({ ok: false, error: 'invalid_request_error: bad schema', inputTokens: 0 });
    expect(dec({ custom_id: 'c', result: { type: 'canceled' } })).toMatchObject({ ok: false, error: 'canceled' });
    expect(dec({ custom_id: 'x', result: { type: 'expired' } })).toMatchObject({ ok: false, error: 'expired' });
  });
});

/** A fake Anthropic server: creates batches, reports a status per batch, serves JSONL results. */
function fakeAnthropic(opts: { status?: (id: string, polls: number) => 'in_progress' | 'canceling' | 'ended'; results?: (id: string, requests: Array<{ custom_id: string; params: any }>) => unknown[]; killWhen?: (c: Call) => boolean } = {}) {
  const batches = new Map<string, Array<{ custom_id: string; params: any }>>();
  const polls = new Map<string, number>();
  const m = mockFetch((call) => {
    if (opts.killWhen?.(call)) throw new Error('KILLED');
    const u = new URL(call.url);
    if (call.method === 'POST' && u.pathname === '/v1/messages/batches') {
      const id = `msgbatch_${++n}`;
      batches.set(id, (call.body as any).requests);
      return [200, anthropicBatch(id, 'in_progress')];
    }
    const results = u.pathname.match(/^\/v1\/messages\/batches\/([^/]+)\/results$/);
    if (results) {
      const id = results[1]!;
      const reqs = batches.get(id);
      if (!reqs) return [404, notFound()];
      const lines = opts.results ? opts.results(id, reqs) : [...reqs].reverse().map((r) => anthropicSucceeded(r.custom_id, 'ok'));
      return [200, jsonl(lines)];
    }
    const one = u.pathname.match(/^\/v1\/messages\/batches\/([^/]+)$/);
    if (call.method === 'GET' && one) {
      const id = one[1]!;
      if (!batches.has(id)) return [404, notFound()];
      const count = (polls.get(id) ?? 0) + 1;
      polls.set(id, count);
      return [200, anthropicBatch(id, opts.status ? opts.status(id, count) : 'ended')];
    }
    return [404, notFound()];
  });
  return { ...m, batches };
}
// Shared across fake servers so a "restarted" process never sees a reused batch ID.
let n = 0;
const notFound = () => ({ type: 'error', error: { type: 'not_found_error', message: 'not found' } });
const provider = (fetch: any, extra: Record<string, unknown> = {}) => new AnthropicBatchProvider({ apiKey: 'sk-ant-test', fetch, maxRetries: 0, sleep: noSleep, ...extra });

describe('AnthropicBatchProvider', () => {
  it('sends the key, translated params and no cache markers', async () => {
    const api = fakeAnthropic();
    const seen: Record<string, string> = {};
    const fetch: typeof globalThis.fetch = async (input, init) => {
      Object.assign(seen, Object.fromEntries(new Headers(init?.headers as any)));
      return api.fetch(input, init);
    };
    await provider(fetch).submit('claude-haiku-5-5', reqs(1), () => {});
    // The installed SDK (1.8) puts the key in `authorization: Bearer`; older ones used x-api-key. Either way it carries the key.
    expect(seen['x-api-key'] ?? seen.authorization).toMatch(/sk-ant-test$/);
    expect(api.calls[0]!.url).toBe('https://api.anthropic.com/v1/messages/batches');
    expect((api.calls[0]!.body as any).requests[0]).toEqual({ custom_id: 'r0-r1', params: { model: 'claude-haiku-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] } });
  });

  it('splits at maxRequestsPerBatch and calls onSubmitted per batch', async () => {
    const api = fakeAnthropic();
    const recorded: BatchHandle[] = [];
    const handles = await provider(api.fetch, { maxRequestsPerBatch: 3 }).submit('claude-haiku-5-5', reqs(7), (h) => recorded.push(h));
    expect(handles).toEqual(recorded);
    expect(handles.map((h) => h.customIds.length)).toEqual([3, 3, 1]);
    expect(handles.every((h) => h.id.startsWith('msgbatch_'))).toBe(true);
    expect(handles.flatMap((h) => h.customIds)).toEqual(reqs(7).map((r) => r.custom_id));
  });

  it('records the first batch before a later one fails, and rejects a bad body before sending', async () => {
    let n = 0;
    const m = mockFetch(() => (++n === 1 ? [200, anthropicBatch('msgbatch_a', 'in_progress')] : [400, { type: 'error', error: { type: 'invalid_request_error', message: 'boom' } }]));
    const recorded: BatchHandle[] = [];
    await expect(provider(m.fetch, { maxRequestsPerBatch: 2 }).submit('claude-haiku-5-5', reqs(4), (h) => recorded.push(h))).rejects.toThrow(/boom/);
    expect(recorded.map((h) => h.id)).toEqual(['msgbatch_a']);

    const none = mockFetch(() => [200, {}]);
    await expect(provider(none.fetch).submit('claude-haiku-5-5', [{ custom_id: 'x', body: { messages: [], max_tokens: 1, temperature: 0 } }], () => {})).rejects.toThrow(/temperature/);
    expect(none.calls).toHaveLength(0);
  });

  it('reports a running batch without reading results', async () => {
    const api = fakeAnthropic({ status: () => 'in_progress' });
    const [h] = await provider(api.fetch).submit('claude-haiku-5-5', reqs(2), () => {});
    const s = await provider(api.fetch).poll(h!.id);
    expect(s).toEqual({ id: h!.id, status: 'in_progress', terminal: false, costUsd: null, results: [], undecodable: 0 });
    expect(api.calls.some((c) => c.url.endsWith('/results'))).toBe(false);
  });

  it('reads an ended batch as completed, whatever order the lines come in, with every line kind decoded', async () => {
    const api = fakeAnthropic({
      results: () => [
        { custom_id: 'r5-r1', result: { type: 'expired' } },
        anthropicSucceeded('r4-r1', null, { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'bio', explanation: null } }),
        anthropicSucceeded('r3-r1', '   '),
        anthropicSucceeded('r2-r1', 'cut', { stop_reason: 'max_tokens' }),
        { custom_id: 'r1-r1', result: { type: 'errored', error: { type: 'error', request_id: null, error: { type: 'api_error', message: 'oops' } } } },
        anthropicSucceeded('r0-r1', 'fine'),
      ],
    });
    const [h] = await provider(api.fetch).submit('claude-haiku-5-5', reqs(6), () => {});
    const s = await provider(api.fetch).poll(h!.id);
    expect(s).toMatchObject({ status: 'completed', terminal: true, costUsd: null, undecodable: 0 });
    const by = Object.fromEntries(s.results.map((r) => [r.custom_id, r]));
    expect(by['r0-r1']).toMatchObject({ ok: true, text: 'fine' });
    expect(by['r1-r1']).toMatchObject({ ok: false, error: 'api_error: oops' });
    expect(by['r2-r1']).toMatchObject({ ok: false, truncated: true });
    expect(by['r3-r1']).toMatchObject({ ok: false, error: 'empty content' });
    expect(by['r4-r1']).toMatchObject({ ok: false, error: 'refusal (bio)' });
    expect(by['r5-r1']).toMatchObject({ ok: false, error: 'expired' });
  });

  it('waitForTerminal polls until ended and reports each status once', async () => {
    const api = fakeAnthropic({ status: (_id, n) => (n < 3 ? 'in_progress' : 'ended') });
    const p = provider(api.fetch);
    const [h] = await p.submit('claude-haiku-5-5', reqs(1), () => {});
    const seen: string[] = [];
    const final = await p.waitForTerminal(h!.id, { onStatus: (s) => seen.push(s) });
    expect(final.status).toBe('completed');
    expect(seen).toEqual(['in_progress', 'completed']);
  });

  it('tolerates 404 right after creation, but not forever', async () => {
    const seq: Array<[number, unknown]> = [[404, notFound()], [404, notFound()], [200, anthropicBatch('msgbatch_1', 'ended')], [200, anthropicBatch('msgbatch_1', 'ended')], [200, jsonl([anthropicSucceeded('a', 'x')])]];
    const m = mockFetch(() => seq.shift()!);
    await expect(provider(m.fetch).waitForTerminal('msgbatch_1')).resolves.toMatchObject({ status: 'completed' });

    let t = 0;
    const gone = mockFetch(() => [404, notFound()]);
    const p2 = provider(gone.fetch, { sleep: async (ms: number) => void (t += ms), now: () => t, notFoundGraceMs: 60_000 });
    await expect(p2.waitForTerminal('msgbatch_1')).rejects.toThrow(/not found/);
  });

  it('does not treat other errors as a missing batch', async () => {
    const m = mockFetch(() => [401, { type: 'error', error: { type: 'authentication_error', message: 'bad key' } }]);
    await expect(provider(m.fetch).waitForTerminal('msgbatch_1')).rejects.toThrow(/bad key/);
    expect(m.calls).toHaveLength(1);
  });
});

describe('cost buckets', () => {
  it('bucketsFromAnthropic keeps cache tokens outside input_tokens', () => {
    expect(bucketsFromAnthropic({ input_tokens: 100, cache_read_input_tokens: 400, cache_creation_input_tokens: 50, output_tokens: 20 })).toEqual({ uncachedInput: 100, cacheRead: 400, cacheWrite: 50, output: 20, reasoning: 0 });
    expect(bucketsFromAnthropic({ input_tokens: 5, output_tokens: 9, cache_read_input_tokens: null, output_tokens_details: { thinking_tokens: 4 } })).toEqual({ uncachedInput: 5, cacheRead: 0, cacheWrite: 0, output: 9, reasoning: 4 });
    expect(bucketsFromAnthropic(undefined).uncachedInput).toBe(0);
  });

  it('computedRowCost prices line.buckets, and leaves the OpenRouter path unchanged', () => {
    const price = { inputPerToken: 1e-6, outputPerToken: 5e-6, cacheReadPerToken: 1e-7 };
    const buckets = { uncachedInput: 100, cacheRead: 1000, cacheWrite: 0, output: 10, reasoning: 0 };
    expect(computedRowCost({ inputTokens: 1100, outputTokens: 10, buckets }, price, '5m')).toBeCloseTo(100e-6 + 1000 * 1e-7 + 10 * 5e-6, 12);
    // the same usage read the OpenRouter way (prompt_tokens includes the cache read) gives the same cost
    const usage = { prompt_tokens: 1100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 1000 } };
    expect(computedRowCost({ inputTokens: 1100, outputTokens: 10, usage }, price, '5m')).toBeCloseTo(priceUsage(bucketsFromOpenRouter(usage), price), 12);
    expect(computedRowCost({ inputTokens: 1100, outputTokens: 10, usage }, price, '5m')).toBeCloseTo(computedRowCost({ inputTokens: 1100, outputTokens: 10, buckets }, price, '5m'), 12);
    // no usage, no buckets: plain token math
    expect(computedRowCost({ inputTokens: 10, outputTokens: 2 }, price, '5m')).toBeCloseTo(10e-6 + 2 * 5e-6, 12);
  });
});

describe('RoutingBatchProvider', () => {
  const stub = (name: string, log: string[]): BatchProvider => ({
    submit: async (model, _r, onSubmitted) => {
      log.push(`${name}.submit ${model}`);
      const h = { id: name === 'a' ? 'msgbatch_x' : 'or-1', customIds: [] };
      onSubmitted(h);
      return [h];
    },
    poll: async (id) => (log.push(`${name}.poll ${id}`), { id, status: 's', terminal: true, costUsd: null, results: [], undecodable: 0 }),
    waitForTerminal: async (id) => (log.push(`${name}.wait ${id}`), { id, status: 's', terminal: true, costUsd: null, results: [], undecodable: 0 }),
  });

  it('routes submit by model and poll/wait by batch ID', async () => {
    const log: string[] = [];
    const r = new RoutingBatchProvider(stub('o', log), stub('a', log));
    await r.submit('claude-haiku-5-5', [], () => {});
    await r.submit('anthropic/claude-haiku-5.5:batch', [], () => {});
    await r.poll('msgbatch_abc');
    await r.poll('batch_123');
    await r.waitForTerminal('msgbatch_abc');
    await r.waitForTerminal('batch_123');
    expect(log).toEqual(['a.submit claude-haiku-5-5', 'o.submit anthropic/claude-haiku-5.5:batch', 'a.poll msgbatch_abc', 'o.poll batch_123', 'a.wait msgbatch_abc', 'o.wait batch_123']);
  });

  it('says to set ANTHROPIC_API_KEY when the Anthropic provider is missing, and still serves OpenRouter', async () => {
    const log: string[] = [];
    const r = new RoutingBatchProvider(stub('o', log));
    expect(() => r.submit('claude-haiku-5-5', [], () => {})).toThrow(/set ANTHROPIC_API_KEY/);
    expect(() => r.poll('msgbatch_abc')).toThrow(/set ANTHROPIC_API_KEY/);
    await r.submit('a/b:batch', [], () => {});
    expect(log).toEqual(['o.submit a/b:batch']);
  });
});

describe('prices, task validation and the context check', () => {
  it('prices Anthropic-direct IDs from the pinned batch table and others from OpenRouter', () => {
    const models = [{ id: 'a/b:batch', pricing: { prompt: '0.000001', completion: '0.000005' } }] as never;
    const p = pricesFrom(models, ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'a/b:batch']);
    expect(p['claude-haiku-5-5']).toEqual({ inputPerToken: 5e-8, outputPerToken: 2.5e-7 });
    expect(p['claude-sonnet-5-5']).toEqual({ inputPerToken: 1e-6, outputPerToken: 5e-6 });
    expect(p['claude-opus-5-5']).toEqual({ inputPerToken: 2e-6, outputPerToken: 10e-6 });
    expect(p['a/b:batch']).toEqual({ inputPerToken: 0.000001, outputPerToken: 0.000005 });
    expect(Object.keys(ANTHROPIC_BATCH_PRICES)).toHaveLength(3);
  });
  it('fails clearly on an unknown claude ID, and on an unlisted OpenRouter one as before', () => {
    expect(() => pricesFrom([], ['claude-haiku-9-9'])).toThrow(/No pinned price for Anthropic model claude-haiku-9-9/);
    expect(() => pricesFrom([], ['x/y:batch'])).toThrow(/not listed on OpenRouter/);
  });

  it('validateTask accepts Anthropic IDs and still rejects OpenRouter IDs without :batch', () => {
    const t = toyTask();
    expect(() => validateTask({ ...t, models: { ...t.models, writer: 'claude-haiku-5-5', escalation: 'claude-sonnet-5-5' } })).not.toThrow();
    expect(() => validateTask({ ...t, models: { ...t.models, writer: 'claude-haiku-5-5', escalation: 'strong:batch' } })).not.toThrow();
    expect(() => validateTask({ ...t, models: { ...t.models, writer: 'anthropic/claude-haiku-5.5' } })).toThrow(/:batch/);
  });

  it('check uses 1,000,000 tokens for pinned Anthropic models instead of "not listed"', async () => {
    const dir = tempDir();
    const csv = join(dir, 'in.csv');
    writeFileSync(csv, 'text\nshort\n');
    const t = { ...toyTask(), writer: { ...toyTask().writer, maxTokens: 1_100_000 }, models: { writer: 'claude-haiku-5-5', escalation: 'claude-sonnet-5-5', decision: 'd' } };
    const r = await checkCsv(csv, t, { models: { writer: 'claude-haiku-5-5', escalation: 'claude-sonnet-5-5' }, loadModels: async () => [] });
    expect(r.report.errors.map((e) => e.code)).toContain('context_too_long');
    expect(r.report.errors[0]!.message).toContain('claude-haiku-5-5: 1,000,000 tokens');
    expect(r.report.info.map((i) => i.code)).not.toContain('context_length_unknown');
  });
});

// ---------------------------------------------------------------- the pipeline through the router

function toyTask(): TaskDefinition {
  return {
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
    models: { writer: 'claude-haiku-5-5', escalation: 'claude-sonnet-5-5', decision: 'dec' },
  };
}

const rows = ['sure', 'unsure-right', 'unsure-wrong'].map((text, i) => ({ id: `r${i + 1}`, data: { text } }));

/** One fetch for both providers: OpenRouter decisions (by URL) and the Anthropic Batches API. */
function fakeWorld(opts: { killWhen?: (c: Call) => boolean } = {}) {
  const counts = { triage: 0, verify: 0, submit: 0 };
  const anth = fakeAnthropic({
    killWhen: opts.killWhen,
    results: (_id, requests) =>
      [...requests].reverse().map((r) => {
        const model = r.params.model as string;
        const text = r.params.messages.at(-1).content.split(' ')[0] as string;
        const answer = model === 'claude-sonnet-5-5' ? 'a' : text === 'unsure-right' ? 'a' : 'b';
        return anthropicSucceeded(r.custom_id, answer, { model }, { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 2 });
      }),
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/alpha/decisions')) {
      const body = JSON.parse(String(init?.body));
      const json = body.questions.answer
        ? (counts.triage++, { model: 'dec-v1', answers: { answer: { type: 'choice', choice: 'a', probabilities: { a: body.state === 'sure' ? 0.99 : 0.5, b: 0.3, cannot_tell: 0.2 }, confidence: 1 } }, usage: { cost: 0.001 } })
        : (counts.verify++, { model: 'dec-v1', answers: { verdict: { type: 'choice', choice: body.state.answer === 'a' ? 'supported' : 'unsupported', probabilities: { supported: body.state.answer === 'a' ? 0.97 : 0.05, unsupported: 0.02, cannot_tell: 0.01 }, confidence: 1 } }, usage: { cost: 0.001 } });
      return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (init?.method === 'POST') counts.submit++;
    return anth.fetch(input, init);
  };
  return { fetch, counts, anth };
}

function context(dir: string, w: ReturnType<typeof fakeWorld>): PipelineContext {
  const ledger = new Ledger(join(dir, 'ledger.jsonl'));
  const decider = new OpenRouterDecisionModel({ apiKey: 'k', model: 'dec', fetch: w.fetch, sleep: noSleep, maxRetries: 0 });
  return {
    task: toyTask(),
    rows,
    ledger,
    triageDecider: decider,
    verifyDecider: decider,
    batch: new RoutingBatchProvider(
      new OpenRouterBatchProvider({ apiKey: 'k', fetch: w.fetch, sleep: noSleep, maxRetries: 0 }),
      new AnthropicBatchProvider({ apiKey: 'sk-ant', fetch: w.fetch, sleep: noSleep, maxRetries: 0 }),
    ),
    writerModel: 'claude-haiku-5-5',
    escalationModel: 'claude-sonnet-5-5',
    thresholds: { t0: 0.9, t1: 0.9, t2: 0.9 },
    budget: new Budget(undefined, replay(ledger.read()).spentUsd),
    prices: { 'claude-haiku-5-5': ANTHROPIC_BATCH_PRICES['claude-haiku-5-5']!, 'claude-sonnet-5-5': ANTHROPIC_BATCH_PRICES['claude-sonnet-5-5']! },
    pollIntervalMs: 0,
  };
}

describe('pipeline with an Anthropic-direct writer', () => {
  it('runs end to end: triage and verify on OpenRouter, writer rounds on Anthropic', async () => {
    const w = fakeWorld();
    const dir = tempDir();
    const outcomes = await executePipeline(context(dir, w));
    expect(outcomes.map((o) => [o.rowId, o.status, o.round, o.answer])).toEqual([
      ['r1', 'accepted', 0, 'a'],
      ['r2', 'accepted', 1, 'a'],
      ['r3', 'accepted', 2, 'a'],
    ]);
    const models = [...w.anth.batches.values()].map((b) => b[0]!.params.model);
    expect(models).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
    // Round 2 carries the effort mapping and the earlier answer; round 1 disables thinking.
    const [r1, r2] = [...w.anth.batches.values()];
    expect(r1![0]!.params).toMatchObject({ thinking: { type: 'disabled' }, max_tokens: 5 });
    expect(r2![0]!.params).toMatchObject({ output_config: { effort: 'low' }, max_tokens: 50 });
    expect(r2!.find((r) => r.custom_id === 'r3-r2')!.params.messages[0].content).toBe('unsure-wrong (was b)');

    const st = replay(new Ledger(join(dir, 'ledger.jsonl')).read());
    const res = st.results.get('r2-r1')!;
    expect(res.costUsd).toBeCloseTo(100 * 0.05e-6 + 2 * 0.25e-6, 12);
    // No batch-level cost: the budget charged the computed per-row costs.
    expect(st.spentUsd).toBeGreaterThan(0);
    expect([...st.batches.values()].every((b) => b.finished)).toBe(true);
  });

  it('loses nothing and repeats nothing when killed while a batch runs', async () => {
    const dir = tempDir();
    const first = fakeWorld({ killWhen: (c) => c.method === 'GET' && c.url.includes('/v1/messages/batches/') });
    await expect(executePipeline(context(dir, first))).rejects.toThrow();
    expect(first.counts).toMatchObject({ triage: 3, submit: 1 });

    const second = fakeWorld();
    for (const [id, b] of first.anth.batches) second.anth.batches.set(id, b);
    const outcomes = await executePipeline(context(dir, second));
    expect(second.counts.triage).toBe(0);
    expect(second.counts.submit).toBe(1); // only round 2; the round-1 batch was collected, not resubmitted
    expect(outcomes.every((o) => o.status === 'accepted')).toBe(true);
    expect(replay(new Ledger(join(dir, 'ledger.jsonl')).read()).batches.size).toBe(2);
  });
});
