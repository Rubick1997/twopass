import { z } from 'zod';
import { authHeaders, requestJson, type FetchFn } from './http.ts';
import type { Prices } from './pipeline.ts';

const modelsSchema = z.looseObject({
  data: z.array(z.looseObject({ id: z.string(), pricing: z.looseObject({ prompt: z.string(), completion: z.string() }) })),
});

/** Live per-token prices from OpenRouter, pinned into the run manifest. */
export async function fetchPrices(apiKey: string, ids: string[], fetchFn: FetchFn = fetch): Promise<Prices> {
  const raw = await requestJson<unknown>(fetchFn, 'https://openrouter.ai/api/v1/models', {
    method: 'GET',
    headers: authHeaders(apiKey),
  });
  const models = modelsSchema.parse(raw).data;
  const prices: Prices = {};
  for (const id of ids) {
    const m = models.find((x) => x.id === id);
    if (!m) throw new Error(`Model ${id} is not listed on OpenRouter. Batch models need the ":batch" suffix.`);
    prices[id] = { inputPerToken: Number(m.pricing.prompt), outputPerToken: Number(m.pricing.completion) };
  }
  return prices;
}
