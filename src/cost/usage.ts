import { z } from 'zod';

/**
 * Token counts split into the buckets that are priced differently.
 * `uncachedInput + cacheRead + cacheWrite` is the whole prompt; `output` includes `reasoning`.
 */
export interface UsageBuckets {
  uncachedInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Hidden reasoning tokens, already counted in `output` (billed as output). */
  reasoning: number;
}

const n = z.number().nullish();
const openRouterUsageSchema = z.looseObject({
  prompt_tokens: n,
  completion_tokens: n,
  prompt_tokens_details: z.looseObject({ cached_tokens: n, cache_write_tokens: n }).nullish(),
  completion_tokens_details: z.looseObject({ reasoning_tokens: n }).nullish(),
});

/**
 * OpenRouter's chat-completions `usage` (sync and batch). Verified 2026-11-06: `prompt_tokens`
 * INCLUDES cache reads (`cached_tokens`) and cache writes (`cache_write_tokens`), and
 * `completion_tokens` includes `reasoning_tokens`. See docs/cost-audit-phase0.md.
 */
export function bucketsFromOpenRouter(raw: unknown): UsageBuckets {
  const u = openRouterUsageSchema.parse(raw ?? {});
  const prompt = u.prompt_tokens ?? 0;
  const cacheRead = u.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = u.prompt_tokens_details?.cache_write_tokens ?? 0;
  if (cacheRead + cacheWrite > prompt) {
    throw new Error(
      `Usage does not add up: cached (${cacheRead}) + cache write (${cacheWrite}) > prompt_tokens (${prompt}). ` +
        'The provider may report cache tokens outside prompt_tokens; check before pricing.',
    );
  }
  return {
    uncachedInput: prompt - cacheRead - cacheWrite,
    cacheRead,
    cacheWrite,
    output: u.completion_tokens ?? 0,
    reasoning: u.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

export const promptTokens = (b: UsageBuckets): number => b.uncachedInput + b.cacheRead + b.cacheWrite;
