import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { priceUsage, tierFor, type ModelPrice } from '../src/cost/price.ts';
import { bucketsFromOpenRouter } from '../src/cost/usage.ts';
import { replay, type LedgerEvent } from '../src/ledger.ts';
import { computedRowCost, writerBody } from '../src/pipeline.ts';
import { defineTask } from '../src/task.ts';
import { pricesFrom, type OpenRouterModel } from '../src/prices.ts';
import { costCheck, costCheckLine } from '../src/report.ts';

// Live OpenRouter pricing for anthropic/claude-haiku-5.5 (sync), 2026-11-06.
const haikuListing = {
  id: 'anthropic/claude-haiku-5.5',
  pricing: {
    prompt: '0.0000001',
    completion: '0.0000005',
    input_cache_read: '0.00000001',
    input_cache_write: '0.000000125',
    input_cache_write_1h: '0.0000002',
    overrides: [{ min_prompt_tokens: 100000, prompt: '0.0000005', completion: '0.0000025', input_cache_read: '0.00000005', input_cache_write: '0.000000625', input_cache_write_1h: '0.000001' }],
  },
} as unknown as OpenRouterModel;
const haiku: ModelPrice = pricesFrom([haikuListing], ['anthropic/claude-haiku-5.5'])['anthropic/claude-haiku-5.5']!;

// Two real calls with the Banking77 label list marked cacheable (ttl 1h), with what OpenRouter billed.
const cacheWriteCall = {
  usage: { prompt_tokens: 801, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 783 }, completion_tokens_details: { reasoning_tokens: 0 } },
  billed: 0.0001619,
};
const cacheHitCall = {
  usage: { prompt_tokens: 801, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 783, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } },
  billed: 0.00001313,
};

describe('usage buckets', () => {
  it('splits OpenRouter prompt_tokens into uncached, cache read and cache write', () => {
    expect(bucketsFromOpenRouter(cacheWriteCall.usage)).toEqual({ uncachedInput: 18, cacheRead: 0, cacheWrite: 783, output: 7, reasoning: 0 });
    expect(bucketsFromOpenRouter(cacheHitCall.usage)).toEqual({ uncachedInput: 18, cacheRead: 783, cacheWrite: 0, output: 7, reasoning: 0 });
  });

  it('refuses usage where the cache counts exceed the prompt', () => {
    expect(() => bucketsFromOpenRouter({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 11 } })).toThrow(/does not add up/);
  });
});

describe('pricing', () => {
  it('parses cache prices and long-context overrides from the model list', () => {
    expect(haiku).toMatchObject({ inputPerToken: 1e-7, cacheReadPerToken: 1e-8, cacheWritePerToken: 1.25e-7, cacheWrite1hPerToken: 2e-7 });
    expect(tierFor(haiku, 99_999).inputPerToken).toBe(1e-7);
    expect(tierFor(haiku, 100_000).inputPerToken).toBe(5e-7);
  });

  it('matches what OpenRouter billed for a cache write and a cache hit', () => {
    for (const call of [cacheWriteCall, cacheHitCall]) {
      expect(priceUsage(bucketsFromOpenRouter(call.usage), haiku, '1h')).toBeCloseTo(call.billed, 10);
    }
  });

  it('shows how far plain token math is off once caching is on', () => {
    const naive = (u: typeof cacheHitCall.usage) => u.prompt_tokens * 1e-7 + u.completion_tokens * 5e-7;
    expect(naive(cacheWriteCall.usage) / cacheWriteCall.billed).toBeCloseTo(0.52, 2); // understated 48%
    expect(naive(cacheHitCall.usage) / cacheHitCall.billed).toBeCloseTo(6.37, 2); // overstated 6.4x
  });

  it('falls back to plain token math without usage or with usage that does not add up', () => {
    const plain = { inputTokens: 100, outputTokens: 10 };
    expect(computedRowCost(plain, haiku, '5m')).toBeCloseTo(100 * 1e-7 + 10 * 5e-7, 12);
    expect(computedRowCost({ ...plain, usage: { prompt_tokens: 1, prompt_tokens_details: { cached_tokens: 5 } } }, haiku, '5m')).toBeCloseTo(
      100 * 1e-7 + 10 * 5e-7,
      12,
    );
  });

  it('prices old manifests without cache fields the old way', () => {
    const old: ModelPrice = { inputPerToken: 1e-7, outputPerToken: 5e-7 };
    expect(priceUsage(bucketsFromOpenRouter(cacheHitCall.usage), old)).toBeCloseTo(801 * 1e-7 + 7 * 5e-7, 12);
  });
});

describe('cost check', () => {
  const at = '2026-11-07T00:00:00Z';
  const events: LedgerEvent[] = [
    { t: 'batch_submitted', batchId: 'b1', round: 1, model: 'w', customIds: ['a-r1', 'b-r1'], at } as LedgerEvent,
    { t: 'batch_result', batchId: 'b1', round: 1, model: 'w', customId: 'a-r1', rowId: 'a', ok: true, inputTokens: 0, outputTokens: 0, costUsd: 0.6, at },
    { t: 'batch_result', batchId: 'b1', round: 1, model: 'w', customId: 'b-r1', rowId: 'b', ok: true, inputTokens: 0, outputTokens: 0, costUsd: 0.5, at },
    { t: 'batch_finished', batchId: 'b1', status: 'completed', costUsd: 1, undecodable: 0, at },
  ];

  it('compares summed per-row cost with the billed batch total', () => {
    const c = costCheck(replay(events))!;
    expect(c).toEqual({ batches: 1, computedUsd: 1.1, billedUsd: 1 });
    expect(costCheckLine(c)).toBe('cost check: per-row cost $1.1000 vs billed $1.0000 over 1 batch(es) (+10.0%)');
  });

  it('is absent when no batch reported a total', () => {
    expect(costCheck(replay(events.slice(0, 3)))).toBeUndefined();
  });
});

describe('cacheable system prompt', () => {
  const base = {
    name: 't',
    state: (row: Record<string, string>) => row.text ?? '',
    verify: { instructions: '?', state: () => ({}) },
    models: { writer: 'w:batch', escalation: 's:batch', decision: 'd' },
  };
  const writer = { system: 'LABELS', promptTemplate: '{{text}}', maxTokens: 5, outputSchema: z.string() };

  it('sends the system prompt as a cache_control text part when cacheSystem is set', () => {
    const task = defineTask({ ...base, writer: { ...writer, cacheSystem: '1h' } });
    expect(writerBody(task, { text: 'hi' }, 1, replay([]), 'r1', 'normal').messages[0]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'LABELS', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    });
  });

  it('sends a plain string otherwise', () => {
    const task = defineTask({ ...base, writer });
    expect(writerBody(task, { text: 'hi' }, 1, replay([]), 'r1', 'normal').messages[0]).toEqual({ role: 'system', content: 'LABELS' });
  });
});
