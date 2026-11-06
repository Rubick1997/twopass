import { describe, expect, it } from 'vitest';
import { OpenRouterDecisionModel } from '../src/decide/openrouter.ts';
import type { Questions } from '../src/decide/model.ts';
import { mockFetch, noSleep } from './helpers.ts';

const questions: Questions = {
  intent: { type: 'choice', criteria: { card_arrival: 'card arrival', cannot_tell: 'unclear' } },
};

// Shape recorded from a live call in Phase 0.
const live = {
  model: 'typesafe/jev-1.14-20261014',
  answers: {
    intent: {
      type: 'choice',
      choice: 'card_arrival',
      probabilities: { card_arrival: 0.96, cannot_tell: 0.04 },
      confidence: 0.96,
    },
  },
  usage: { input_tokens: 395, output_tokens: 76, cost: 0.00001659, is_byok: false },
  id: 'gen-dec-1',
  provider: 'TypeSafe',
};

describe('OpenRouterDecisionModel', () => {
  it('posts model, state and keyed questions to the alpha decisions endpoint', async () => {
    const m = mockFetch(() => [200, live]);
    const d = new OpenRouterDecisionModel({ apiKey: 'k', model: 'typesafe/jev-1.14', fetch: m.fetch });
    const res = await d.decide('my card has not arrived', questions);

    expect(m.calls[0]!.url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(m.calls[0]!.body).toEqual({ model: 'typesafe/jev-1.14', state: 'my card has not arrived', questions });
    expect(res).toMatchObject({ model: 'typesafe/jev-1.14-20261014', costUsd: 0.00001659, provider: 'TypeSafe' });
    expect(res.answers.intent).toMatchObject({ choice: 'card_arrival' });
  });

  it('refuses a choice question without cannot_tell', async () => {
    const m = mockFetch(() => [200, live]);
    const d = new OpenRouterDecisionModel({ apiKey: 'k', model: 'x', fetch: m.fetch });
    expect(() => d.decide('s', { q: { type: 'choice', criteria: { a: 'A', b: 'B' } } })).toThrow(/cannot_tell/);
    expect(m.calls).toHaveLength(0);
  });

  it('retries 429 and 5xx, but not 400', async () => {
    const statuses = [429, 503, 200];
    const m = mockFetch(() => {
      const s = statuses.shift()!;
      return [s, s === 200 ? live : { error: { message: 'busy' } }];
    });
    const d = new OpenRouterDecisionModel({ apiKey: 'k', model: 'x', fetch: m.fetch, sleep: noSleep });
    await expect(d.decide('s', questions)).resolves.toBeDefined();
    expect(m.calls).toHaveLength(3);

    const bad = mockFetch(() => [400, { error: { message: 'invalid' } }]);
    const d2 = new OpenRouterDecisionModel({ apiKey: 'k', model: 'x', fetch: bad.fetch, sleep: noSleep });
    await expect(d2.decide('s', questions)).rejects.toThrow(/HTTP 400/);
    expect(bad.calls).toHaveLength(1);
  });

  it('never runs more calls at once than the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const m = mockFetch(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      return [200, live];
    });
    const d = new OpenRouterDecisionModel({ apiKey: 'k', model: 'x', fetch: m.fetch, concurrency: 3 });
    await Promise.all(Array.from({ length: 20 }, () => d.decide('s', questions)));
    expect(peak).toBe(3);
  });
});
