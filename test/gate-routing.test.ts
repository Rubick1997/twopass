import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { anthropicSyncCaller } from '../src/batch/anthropic.ts';
import { openRouterSyncCaller } from '../src/batch/openrouter.ts';
import { activeProvidersLine, isClaude, resolveRoute, routingKey, toAnthropicId, toOpenRouterId } from '../src/batch/route.ts';
import { SyncBatchProvider } from '../src/batch/sync.ts';
import { Budget } from '../src/budget.ts';
import { priceUsage } from '../src/cost/price.ts';
import { bucketsFromAnthropic } from '../src/cost/usage.ts';
import { OpenRouterDecisionModel } from '../src/decide/openrouter.ts';
import { Ledger, replay } from '../src/ledger.ts';
import { executePipeline, type PipelineContext } from '../src/pipeline.ts';
import { ANTHROPIC_LIST_PRICES, anthropicPrices } from '../src/prices-anthropic.ts';
import { pricesFrom } from '../src/prices.ts';
import { defineTask } from '../src/task.ts';
import { anthropicMessage, mockFetch, noSleep, tempDir } from './helpers.ts';

describe('routing rule', () => {
  it('maps Claude IDs between Anthropic and OpenRouter names', () => {
    expect(toAnthropicId('anthropic/claude-haiku-5.5:batch')).toBe('claude-haiku-5-5');
    expect(toAnthropicId('anthropic/claude-opus-4.8')).toBe('claude-opus-4-8');
    expect(toAnthropicId('claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
    expect(toOpenRouterId('claude-haiku-5-5', 'sync')).toBe('anthropic/claude-haiku-5.5');
    expect(toOpenRouterId('claude-haiku-5-5', 'batch')).toBe('anthropic/claude-haiku-5.5:batch');
    expect(toOpenRouterId('anthropic/claude-sonnet-5.5:batch', 'sync')).toBe('anthropic/claude-sonnet-5.5');
    expect(toOpenRouterId('openai/gpt-6-luna', 'batch')).toBe('openai/gpt-6-luna:batch');
    expect(isClaude('anthropic/claude-haiku-5.5:batch')).toBe(true);
    expect(isClaude('openai/gpt-6-luna:batch')).toBe(false);
  });

  it('sends Claude to Anthropic when the key is set, else to OpenRouter; other models always to OpenRouter', () => {
    const withKey = { transport: 'sync' as const, anthropicKey: true };
    const noKey = { transport: 'sync' as const, anthropicKey: false };
    expect(resolveRoute('anthropic/claude-haiku-5.5:batch', withKey)).toMatchObject({ provider: 'anthropic', callId: 'claude-haiku-5-5' });
    expect(resolveRoute('claude-haiku-5-5', noKey)).toMatchObject({ provider: 'openrouter', callId: 'anthropic/claude-haiku-5.5' });
    expect(resolveRoute('openai/gpt-6-luna:batch', withKey)).toMatchObject({ provider: 'openrouter', callId: 'openai/gpt-6-luna' });
    expect(resolveRoute('claude-haiku-5-5', { transport: 'batch', anthropicKey: false })).toMatchObject({ callId: 'anthropic/claude-haiku-5.5:batch' });
  });

  it('lets the task override win, and refuses an Anthropic override without a key', () => {
    expect(resolveRoute('claude-haiku-5-5', { transport: 'sync', anthropicKey: true, claude: 'openrouter' })).toMatchObject({ provider: 'openrouter' });
    expect(() => resolveRoute('claude-haiku-5-5', { transport: 'sync', anthropicKey: false, claude: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY is not set/);
  });

  it('gives the same routing key for the same routes regardless of order', () => {
    const a = resolveRoute('claude-haiku-5-5', { transport: 'sync', anthropicKey: true });
    const b = resolveRoute('claude-sonnet-5-5', { transport: 'sync', anthropicKey: true });
    const c = resolveRoute('claude-sonnet-5-5', { transport: 'sync', anthropicKey: false });
    expect(routingKey([a, b])).toBe(routingKey([b, a]));
    expect(routingKey([a, b])).not.toBe(routingKey([a, c]));
  });

  it('names keys only by variable in the startup line', () => {
    const line = activeProvidersLine({ openrouter: true, anthropic: false });
    expect(line).toContain('ANTHROPIC_API_KEY not set');
    expect(line).toContain('falling back to OpenRouter');
  });
});

describe('list prices', () => {
  it('prices direct Claude at list for sync and at half for batch, cache buckets included', () => {
    expect(anthropicPrices(['claude-haiku-5-5'], 'sync')['claude-haiku-5-5']).toEqual(ANTHROPIC_LIST_PRICES['claude-haiku-5-5']);
    expect(anthropicPrices(['claude-sonnet-5-5'], 'batch')['claude-sonnet-5-5']!.cacheReadPerToken).toBeCloseTo(5e-8, 15);
    const models = [{ id: 'anthropic/claude-haiku-5.5', pricing: { prompt: '0.0000001', completion: '0.0000005', input_cache_read: '0.00000001' } }] as never;
    expect(pricesFrom(models, ['anthropic/claude-haiku-5.5', 'claude-haiku-5-5'], 'sync')).toMatchObject({
      'anthropic/claude-haiku-5.5': { inputPerToken: 1e-7, cacheReadPerToken: 1e-8 },
      'claude-haiku-5-5': { inputPerToken: 1e-7, cacheReadPerToken: 1e-8 },
    });
  });

  it('prices a cached sync Haiku call at list (the Phase 0 probe shape: 30 uncached, 1,941 read, 14 out)', () => {
    const b = bucketsFromAnthropic({ input_tokens: 30, cache_read_input_tokens: 1941, cache_creation_input_tokens: 0, output_tokens: 14 });
    const usd = priceUsage(b, ANTHROPIC_LIST_PRICES['claude-haiku-5-5']!, '1h');
    expect(usd).toBeCloseTo(30 * 1e-7 + 1941 * 1e-8 + 14 * 5e-7, 12);
    const write = bucketsFromAnthropic({ input_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 1941, output_tokens: 14 });
    expect(priceUsage(write, ANTHROPIC_LIST_PRICES['claude-haiku-5-5']!, '1h')).toBeCloseTo(30 * 1e-7 + 1941 * 2e-7 + 14 * 5e-7, 12);
  });
});

describe('sync callers', () => {
  it('Anthropic: sends the cache marker, records provider and the served model, and keeps usage for pricing', async () => {
    const api = mockFetch(() => [200, anthropicMessage('{"label":"a"}', { model: 'claude-haiku-5-5-20261007' }, { cache_read_input_tokens: 100 })]);
    const call = anthropicSyncCaller({ apiKey: 'sk-ant-test', fetch: api.fetch, maxRetries: 0 });
    const line = await call('claude-haiku-5-5', {
      custom_id: 'r1-r1',
      body: { messages: [{ role: 'system', content: [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral', ttl: '1h' } }] }, { role: 'user', content: 'x' }], max_tokens: 5 },
    });
    expect(line).toMatchObject({ ok: true, text: '{"label":"a"}', provider: 'anthropic', servedModel: 'claude-haiku-5-5-20261007' });
    expect(line.buckets).toMatchObject({ cacheRead: 100, uncachedInput: 40 });
    expect((api.calls[0]!.body as any).system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(JSON.stringify(api.calls[0]!.body)).not.toContain('temperature');
  });

  it('Anthropic: a 400 stops the run, a 5xx becomes a failed row the pipeline retries', async () => {
    const bad = anthropicSyncCaller({ apiKey: 'k', fetch: mockFetch(() => [400, { type: 'error', error: { type: 'invalid_request_error', message: 'no' } }]).fetch, maxRetries: 0 });
    await expect(bad('claude-haiku-5-5', { custom_id: 'x', body: { messages: [], max_tokens: 1 } })).rejects.toThrow();
    const flaky = anthropicSyncCaller({ apiKey: 'k', fetch: mockFetch(() => [529, { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }]).fetch, maxRetries: 0 });
    expect(await flaky('claude-haiku-5-5', { custom_id: 'x', body: { messages: [], max_tokens: 1 } })).toMatchObject({ ok: false, provider: 'anthropic' });
  });

  it('OpenRouter: posts a non-batch model, records served model and upstream, refuses :batch IDs', async () => {
    const api = mockFetch(() => [
      200,
      { model: 'anthropic/claude-4.5-haiku-20261007', provider: 'Amazon Bedrock', choices: [{ finish_reason: 'stop', message: { content: 'a' } }], usage: { prompt_tokens: 10, completion_tokens: 1 } },
    ]);
    const call = openRouterSyncCaller({ apiKey: 'k', fetch: api.fetch, maxRetries: 0, sleep: noSleep });
    expect(await call('anthropic/claude-haiku-5.5', { custom_id: 'c', body: { messages: [], max_tokens: 5 } })).toMatchObject({
      ok: true,
      text: 'a',
      provider: 'openrouter',
      servedModel: 'anthropic/claude-4.5-haiku-20261007',
      upstream: 'Amazon Bedrock',
      inputTokens: 10,
    });
    expect((api.calls[0]!.body as any).model).toBe('anthropic/claude-haiku-5.5');
    await expect(call('x/y:batch', { custom_id: 'c', body: {} })).rejects.toThrow(/non-batch/);
  });

  it('OpenRouter: 400 throws, 5xx after retries is a failed row', async () => {
    const bad = openRouterSyncCaller({ apiKey: 'k', fetch: mockFetch(() => [400, { error: 'no' }]).fetch, maxRetries: 0, sleep: noSleep });
    await expect(bad('a/b', { custom_id: 'c', body: {} })).rejects.toThrow(/400/);
    const down = openRouterSyncCaller({ apiKey: 'k', fetch: mockFetch(() => [502, {}]).fetch, maxRetries: 1, sleep: noSleep });
    expect(await down('a/b', { custom_id: 'c', body: {} })).toMatchObject({ ok: false, provider: 'openrouter' });
  });
});

// ---- the sync provider inside the real pipeline

const task = defineTask({
  name: 'toy',
  state: (row) => row.text ?? '',
  writer: { promptTemplate: '{{text}}', maxTokens: 5, outputSchema: z.enum(['a', 'b']), escalation: { maxTokens: 9 } },
  verify: { instructions: 'Is it right?' },
  models: { writer: 'cheap:batch', escalation: 'strong:batch', decision: 'dec' },
});
const rows = ['x', 'y', 'z'].map((text, i) => ({ id: `r${i + 1}`, data: { text } }));

function ctx(dir: string, provider: SyncBatchProvider): PipelineContext {
  const decisions = mockFetch(() => [
    200,
    { model: 'dec-v1', answers: { verdict: { type: 'choice', choice: 'supported', probabilities: { supported: 0.99, unsupported: 0, cannot_tell: 0.01 }, confidence: 1 } }, usage: { cost: 0.001 } },
  ]);
  const decider = new OpenRouterDecisionModel({ apiKey: 'k', model: 'dec', fetch: decisions.fetch, sleep: noSleep, maxRetries: 0 });
  const ledger = new Ledger(join(dir, 'ledger.jsonl'));
  return {
    task,
    rows,
    ledger,
    triageDecider: decider,
    verifyDecider: decider,
    batch: provider,
    writerModel: 'cheap',
    escalationModel: 'strong',
    thresholds: { t0: 0.9, t1: 0.9, t2: 0.9 },
    budget: new Budget(1, replay(ledger.read()).spentUsd),
    prices: { cheap: { inputPerToken: 1e-6, outputPerToken: 1e-6 }, strong: { inputPerToken: 1e-6, outputPerToken: 1e-6 } },
    pollIntervalMs: 0,
  };
}

describe('SyncBatchProvider in the pipeline', () => {
  it('records the batch before calling, saves provider fields per row, and charges the computed list-price sum', async () => {
    const order: string[] = [];
    const provider = new SyncBatchProvider({
      chunkSize: 2,
      callerFor: () => async (_m, req) => {
        order.push(`call ${req.custom_id}`);
        return { custom_id: req.custom_id, ok: true, text: 'a', inputTokens: 100, outputTokens: 1, usage: { prompt_tokens: 100, completion_tokens: 1 }, provider: 'openrouter', servedModel: 'cheap-v2', upstream: 'Up' };
      },
    });
    const dir = tempDir();
    const c = ctx(dir, provider);
    const outcomes = await executePipeline(c);
    expect(outcomes.map((o) => o.status)).toEqual(['accepted', 'accepted', 'accepted']);
    const events = c.ledger.read();
    const firstSubmit = events.findIndex((e) => e.t === 'batch_submitted');
    expect(firstSubmit).toBeGreaterThanOrEqual(0);
    expect(events.filter((e) => e.t === 'batch_submitted')).toHaveLength(2); // 3 rows, chunks of 2
    const result = events.find((e) => e.t === 'batch_result') as any;
    expect(result).toMatchObject({ provider: 'openrouter', servedModel: 'cheap-v2', upstream: 'Up' });
    expect(result.costUsd).toBeCloseTo(101e-6, 12);
    const st = replay(events);
    expect(st.spentUsd).toBeCloseTo(3 * 101e-6 + 3 * 0.001, 9);
  });

  it('after a crash, an unknown sync batch reports expired and its rows are retried, not lost', async () => {
    const dir = tempDir();
    let calls = 0;
    const ok = () => async (_m: string, req: { custom_id: string }) => {
      calls++;
      return { custom_id: req.custom_id, ok: true, text: 'a', inputTokens: 1, outputTokens: 1 };
    };
    // First process: records the batch, then dies before any result is saved.
    const dying = new SyncBatchProvider({ callerFor: () => async () => { throw new Error('KILLED'); } });
    await expect(executePipeline(ctx(dir, dying))).rejects.toThrow(/KILLED/);
    expect(replay(new Ledger(join(dir, 'ledger.jsonl')).read()).inFlight.size).toBe(3);
    // Second process: a fresh provider has never seen that batch.
    const outcomes = await executePipeline(ctx(dir, new SyncBatchProvider({ callerFor: ok })));
    expect(outcomes.map((o) => o.status)).toEqual(['accepted', 'accepted', 'accepted']);
    expect(calls).toBe(3);
  });
});
