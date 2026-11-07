import { z } from 'zod';
import { authHeaders, requestJson, type FetchFn, type RetryOptions } from './http.ts';
import type { TokenPrices } from './cost/price.ts';
import type { Prices } from './pipeline.ts';

const modelsSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      id: z.string(),
      context_length: z.number().nullish(),
      pricing: z.looseObject({
        prompt: z.string(),
        completion: z.string(),
        input_cache_read: z.string().optional(),
        input_cache_write: z.string().optional(),
        input_cache_write_1h: z.string().optional(),
        overrides: z.array(z.looseObject({ min_prompt_tokens: z.number() })).optional(),
      }),
    }),
  ),
});

export type OpenRouterModel = z.infer<typeof modelsSchema>['data'][number];

/**
 * OpenRouter's public model list. The key is sent when given but is not required. Decision models
 * (Jev, Clef, Luna, …) only appear with `?output_modalities=decisions`, so both lists are fetched.
 */
export async function fetchModelList(apiKey: string | undefined, fetchFn: FetchFn = fetch, retry?: RetryOptions): Promise<OpenRouterModel[]> {
  const headers = apiKey ? authHeaders(apiKey) : { 'X-Title': 'TwoPass' };
  const lists = await Promise.all(
    ['https://openrouter.ai/api/v1/models', 'https://openrouter.ai/api/v1/models?output_modalities=decisions'].map(
      async (url) => modelsSchema.parse(await requestJson<unknown>(fetchFn, url, { method: 'GET', headers }, retry)).data,
    ),
  );
  const byId = new Map<string, OpenRouterModel>();
  for (const m of lists.flat()) if (!byId.has(m.id)) byId.set(m.id, m);
  return [...byId.values()];
}

/** Live per-token prices from OpenRouter, pinned into the run manifest. */
export async function fetchPrices(apiKey: string, ids: string[], fetchFn: FetchFn = fetch): Promise<Prices> {
  return pricesFrom(await fetchModelList(apiKey, fetchFn), ids);
}

export function pricesFrom(models: OpenRouterModel[], ids: string[]): Prices {
  const prices: Prices = {};
  for (const id of ids) {
    const m = models.find((x) => x.id === id);
    if (!m) throw new Error(`Model ${id} is not listed on OpenRouter. Batch models need the ":batch" suffix.`);
    const p = m.pricing;
    const overrides = (p.overrides ?? []).map((o) => ({ minPromptTokens: o.min_prompt_tokens, ...tokenPrices({ ...p, ...o }) }));
    prices[id] = { ...tokenPrices(p), ...(overrides.length ? { overrides } : {}) };
  }
  return prices;
}

/** An override lists only the prices it changes, so it is merged over the base pricing first. */
function tokenPrices(p: Record<string, unknown>): TokenPrices {
  const num = (k: string): number | undefined => (typeof p[k] === 'string' ? Number(p[k]) : undefined);
  const cacheRead = num('input_cache_read');
  const cacheWrite = num('input_cache_write');
  const cacheWrite1h = num('input_cache_write_1h');
  return {
    inputPerToken: num('prompt') ?? 0,
    outputPerToken: num('completion') ?? 0,
    ...(cacheRead !== undefined ? { cacheReadPerToken: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWritePerToken: cacheWrite } : {}),
    ...(cacheWrite1h !== undefined ? { cacheWrite1hPerToken: cacheWrite1h } : {}),
  };
}
