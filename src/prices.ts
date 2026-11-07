import { z } from 'zod';
import { authHeaders, requestJson, type FetchFn, type RetryOptions } from './http.ts';
import type { Prices } from './pipeline.ts';

const modelsSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      id: z.string(),
      context_length: z.number().nullish(),
      pricing: z.looseObject({ prompt: z.string(), completion: z.string() }),
    }),
  ),
});

export type OpenRouterModel = z.infer<typeof modelsSchema>['data'][number];

/** OpenRouter's public model list (GET /models). The key is sent when given but is not required. */
export async function fetchModelList(apiKey: string | undefined, fetchFn: FetchFn = fetch, retry?: RetryOptions): Promise<OpenRouterModel[]> {
  const raw = await requestJson<unknown>(
    fetchFn,
    'https://openrouter.ai/api/v1/models',
    { method: 'GET', headers: apiKey ? authHeaders(apiKey) : { 'X-Title': 'TwoPass' } },
    retry,
  );
  return modelsSchema.parse(raw).data;
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
    prices[id] = { inputPerToken: Number(m.pricing.prompt), outputPerToken: Number(m.pricing.completion) };
  }
  return prices;
}
