import type { Prices } from './pipeline.ts';

/**
 * Batch prices (50% of list) for models called through Anthropic directly; OpenRouter does not list them.
 * Pinned by hand: re-check against Anthropic's pricing page when `verifiedAt` gets old. Cache prices are omitted
 * (no cache markers are sent on direct calls). USD per million tokens.
 */
export const ANTHROPIC_PRICES_VERIFIED_AT = '2026-11-14';

/** Written as exact per-token literals (price per million ÷ 1e6) so they print and compare cleanly. */
export const ANTHROPIC_BATCH_PRICES: Record<string, { inputPerToken: number; outputPerToken: number }> = {
  'claude-haiku-5-5': { inputPerToken: 5e-8, outputPerToken: 2.5e-7 }, // $0.05 / $0.25 per million
  'claude-sonnet-5-5': { inputPerToken: 1e-6, outputPerToken: 5e-6 }, // $1.00 / $5.00
  'claude-opus-5-5': { inputPerToken: 2e-6, outputPerToken: 1e-5 }, // $2.00 / $10.00
};

/** Context length of every pinned model. */
export const ANTHROPIC_CONTEXT_LENGTH = 1_000_000;

export function anthropicPrices(ids: string[]): Prices {
  const out: Prices = {};
  for (const id of ids) {
    const p = ANTHROPIC_BATCH_PRICES[id];
    if (!p) {
      throw new Error(`No pinned price for Anthropic model ${id}. Add it to src/prices-anthropic.ts (known: ${Object.keys(ANTHROPIC_BATCH_PRICES).join(', ')}).`);
    }
    out[id] = { ...p };
  }
  return out;
}
