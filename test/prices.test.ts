import { describe, expect, it } from 'vitest';
import { fetchModelList, pricesFrom } from '../src/prices.ts';
import { mockFetch } from './helpers.ts';

const model = (id: string, context_length: number) => ({ id, context_length, pricing: { prompt: '0.000001', completion: '0.000005' } });

describe('fetchModelList', () => {
  it('includes decision models, which OpenRouter lists only under output_modalities=decisions', async () => {
    const m = mockFetch((call) =>
      call.url.includes('output_modalities=decisions')
        ? [200, { data: [model('typesafe/jev-1.14', 262144), model('cloudflare/clef', 65537)] }]
        : [200, { data: [model('anthropic/claude-haiku-5.5:batch', 200000)] }],
    );
    const list = await fetchModelList(undefined, m.fetch);
    expect(list.map((x) => [x.id, x.context_length])).toEqual([
      ['anthropic/claude-haiku-5.5:batch', 200000],
      ['typesafe/jev-1.14', 262144],
      ['cloudflare/clef', 65537],
    ]);
    expect(pricesFrom(list, ['anthropic/claude-haiku-5.5:batch'])).toEqual({
      'anthropic/claude-haiku-5.5:batch': { inputPerToken: 0.000001, outputPerToken: 0.000005 },
    });
  });
});
