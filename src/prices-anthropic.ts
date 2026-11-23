import type { ModelPrice } from './cost/price.ts';
import type { Prices } from './pipeline.ts';

/**
 * Prices for models called through Anthropic directly; OpenRouter does not list them under these IDs.
 * Pinned by hand: re-check against Anthropic's pricing page when `verifiedAt` gets old. USD per token.
 *
 * List (sync) prices, checked 2026-11-23 against Anthropic's model table and OpenRouter's listing of the same models:
 *   Haiku 5.5  $0.10 / $0.50 per million (prompts up to 100K tokens; longer prompts are not used here)
 *   Sonnet 5.5 $2.00 / $10.00
 *   Opus 5.5   $4.00 / $20.00
 * Cache: a read is 0.1× input on Haiku 5.5 and 0.05× on Sonnet / Opus 5.5; a write is 1.25× input (5 minutes) or 2× (1 hour).
 * Batch prices are 50% of every list price, cache buckets included.
 */
export const ANTHROPIC_PRICES_VERIFIED_AT = '2026-11-23';

/** Written as exact per-token literals (price per million ÷ 1e6) so they print and compare cleanly. */
export const ANTHROPIC_LIST_PRICES: Record<string, Required<Omit<ModelPrice, 'overrides'>>> = {
  'claude-haiku-5-5': { inputPerToken: 1e-7, outputPerToken: 5e-7, cacheReadPerToken: 1e-8, cacheWritePerToken: 1.25e-7, cacheWrite1hPerToken: 2e-7 },
  'claude-sonnet-5-5': { inputPerToken: 2e-6, outputPerToken: 1e-5, cacheReadPerToken: 1e-7, cacheWritePerToken: 2.5e-6, cacheWrite1hPerToken: 4e-6 },
  'claude-opus-5-5': { inputPerToken: 4e-6, outputPerToken: 2e-5, cacheReadPerToken: 2e-7, cacheWritePerToken: 5e-6, cacheWrite1hPerToken: 8e-6 },
};

const half = (p: Required<Omit<ModelPrice, 'overrides'>>) =>
  Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v / 2])) as Required<Omit<ModelPrice, 'overrides'>>;

/** Message Batches: 50% of list. */
export const ANTHROPIC_BATCH_PRICES: Record<string, Required<Omit<ModelPrice, 'overrides'>>> = Object.fromEntries(
  Object.entries(ANTHROPIC_LIST_PRICES).map(([id, p]) => [id, half(p)]),
);

/** Context length of every pinned model. */
export const ANTHROPIC_CONTEXT_LENGTH = 1_000_000;

export type Transport = 'batch' | 'sync';

export function anthropicPrices(ids: string[], transport: Transport = 'batch'): Prices {
  const table = transport === 'sync' ? ANTHROPIC_LIST_PRICES : ANTHROPIC_BATCH_PRICES;
  const out: Prices = {};
  for (const id of ids) {
    const p = table[id];
    if (!p) {
      throw new Error(`No pinned price for Anthropic model ${id}. Add it to src/prices-anthropic.ts (known: ${Object.keys(table).join(', ')}).`);
    }
    out[id] = { ...p };
  }
  return out;
}
