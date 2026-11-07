import { promptTokens, type UsageBuckets } from './usage.ts';

/** Per-token USD prices for one model, as OpenRouter lists them. Cache fields are absent in manifests before 2026-11-07. */
export interface TokenPrices {
  inputPerToken: number;
  outputPerToken: number;
  cacheReadPerToken?: number;
  /** 5-minute cache write. */
  cacheWritePerToken?: number;
  cacheWrite1hPerToken?: number;
}

export interface ModelPrice extends TokenPrices {
  /** Long-context tiers: from `minPromptTokens` on, every bucket uses these prices instead. */
  overrides?: Array<TokenPrices & { minPromptTokens: number }>;
}

export type CacheTtl = '5m' | '1h';

/** The price tier that applies to a request with this many prompt tokens (cache reads and writes included). */
export function tierFor(price: ModelPrice, prompt: number): TokenPrices {
  let tier: TokenPrices = price;
  let best = -1;
  for (const o of price.overrides ?? []) {
    if (prompt >= o.minPromptTokens && o.minPromptTokens > best) {
      tier = o;
      best = o.minPromptTokens;
    }
  }
  return tier;
}

/**
 * Cost of one call. The usage object does not say which cache TTL was written, so the caller passes
 * the TTL it asked for. A missing cache price falls back to the input price (the old behavior).
 */
export function priceUsage(b: UsageBuckets, price: ModelPrice, cacheTtl: CacheTtl = '5m'): number {
  const t = tierFor(price, promptTokens(b));
  const write = cacheTtl === '1h' ? (t.cacheWrite1hPerToken ?? t.cacheWritePerToken) : t.cacheWritePerToken;
  return (
    b.uncachedInput * t.inputPerToken +
    b.cacheRead * (t.cacheReadPerToken ?? t.inputPerToken) +
    b.cacheWrite * (write ?? t.inputPerToken) +
    b.output * t.outputPerToken
  );
}
