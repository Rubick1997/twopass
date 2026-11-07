import { describe, expect, it } from 'vitest';
import { decodeBatch, decodeResultLine, OpenRouterBatchProvider } from '../src/batch/openrouter.ts';
import type { BatchHandle } from '../src/batch/provider.ts';
import { chatResult, mockFetch, noSleep } from './helpers.ts';

const reqs = (n: number) => Array.from({ length: n }, (_, i) => ({ custom_id: `r${i}-r1`, body: { messages: [] } }));

describe('submit', () => {
  it('puts endpoint and model before requests in the body', async () => {
    const m = mockFetch(() => [200, { id: 'b1', status: 'validating' }]);
    const p = new OpenRouterBatchProvider({ apiKey: 'k', fetch: m.fetch, sleep: noSleep });
    await p.submit('a/b:batch', reqs(2), () => {});
    expect(Object.keys(m.calls[0]!.body as object)).toEqual(['endpoint', 'model', 'requests']);
  });

  it('splits a batch in half on HTTP 413 until each part is accepted', async () => {
    let n = 0;
    const m = mockFetch((call) => {
      const size = (call.body as { requests: unknown[] }).requests.length;
      if (size > 2) return [413, { error: { message: 'Batch of more than 2 requests is not allowed.', code: 413 } }];
      return [200, { id: `b${++n}`, status: 'validating' }];
    });
    const p = new OpenRouterBatchProvider({ apiKey: 'k', fetch: m.fetch, sleep: noSleep });
    const recorded: BatchHandle[] = [];
    const handles = await p.submit('a/b:batch', reqs(5), (h) => recorded.push(h));

    expect(handles).toEqual(recorded);
    expect(handles.every((h) => h.customIds.length <= 2)).toBe(true);
    expect(handles.flatMap((h) => h.customIds)).toEqual(reqs(5).map((r) => r.custom_id));
  });

  it('chunks above the request limit before sending', async () => {
    const m = mockFetch(() => [200, { id: 'b', status: 'validating' }]);
    const p = new OpenRouterBatchProvider({ apiKey: 'k', fetch: m.fetch, sleep: noSleep, maxRequestsPerBatch: 3 });
    await p.submit('a/b:batch', reqs(7), () => {});
    expect(m.calls.map((c) => (c.body as { requests: unknown[] }).requests.length)).toEqual([3, 3, 1]);
  });

  it('does not split on other errors', async () => {
    const m = mockFetch(() => [400, { error: { message: 'bad' } }]);
    const p = new OpenRouterBatchProvider({ apiKey: 'k', fetch: m.fetch, sleep: noSleep });
    await expect(p.submit('a/b:batch', reqs(4), () => {})).rejects.toThrow(/HTTP 400/);
    expect(m.calls).toHaveLength(1);
  });

  it('records the first part before a later part fails', async () => {
    let n = 0;
    const m = mockFetch((call) => {
      const size = (call.body as { requests: unknown[] }).requests.length;
      if (size > 2) return [413, { error: { code: 413 } }];
      return ++n === 1 ? [200, { id: 'b1', status: 'validating' }] : [400, { error: { message: 'boom' } }];
    });
    const p = new OpenRouterBatchProvider({ apiKey: 'k', fetch: m.fetch, sleep: noSleep });
    const recorded: BatchHandle[] = [];
    await expect(p.submit('a/b:batch', reqs(4), (h) => recorded.push(h))).rejects.toThrow();
    expect(recorded.map((h) => h.id)).toEqual(['b1']);
  });
});

describe('decoding result lines', () => {
  it('reads content and token counts from a chat completion', () => {
    expect(decodeResultLine(chatResult('a-r1', 'card_arrival', 46, 13))).toEqual({
      custom_id: 'a-r1',
      ok: true,
      text: 'card_arrival',
      inputTokens: 46,
      outputTokens: 13,
      usage: { prompt_tokens: 46, completion_tokens: 13 },
    });
  });

  it('marks errors, non-200 responses and empty content as failed', () => {
    expect(decodeResultLine({ custom_id: 'a', response: null, error: { message: 'rate limited' } })).toMatchObject({
      ok: false,
      error: 'rate limited',
    });
    expect(decodeResultLine({ custom_id: 'b', response: { status_code: 500, body: { e: 1 } }, error: null })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^status 500/),
    });
    expect(decodeResultLine(chatResult('c', '   '))).toMatchObject({ ok: false, error: 'empty content' });
  });

  it('marks an answer cut off by max_tokens as truncated, even with partial text', () => {
    const line = chatResult('a-r1', 'The message asks about fees', 804, 20);
    (line.response.body.choices[0] as Record<string, unknown>).finish_reason = 'length';
    (line.response.body.usage as Record<string, unknown>).completion_tokens_details = { reasoning_tokens: 20 };
    expect(decodeResultLine(line)).toMatchObject({
      ok: false,
      truncated: true,
      error: 'cut off at max_tokens (20 reasoning tokens)',
      outputTokens: 20,
    });
  });

  it('returns null for a line without custom_id', () => {
    expect(decodeResultLine({ response: {} })).toBeNull();
  });

  it('decodes a whole batch, keeping out-of-order lines and counting bad ones', () => {
    const status = decodeBatch({
      id: 'b1',
      status: 'completed',
      usage: { cost: 0.00001 },
      results: [chatResult('row-2-r1', 'x'), { nope: true }, chatResult('row-1-r1', 'y')],
    });
    expect(status).toMatchObject({ terminal: true, costUsd: 0.00001, undecodable: 1 });
    expect(status.results.map((r) => r.custom_id)).toEqual(['row-2-r1', 'row-1-r1']);
  });

  it('treats validating and in_progress as not terminal', () => {
    expect(decodeBatch({ id: 'b', status: 'validating', results: null }).terminal).toBe(false);
    expect(decodeBatch({ id: 'b', status: 'in_progress' }).terminal).toBe(false);
    expect(decodeBatch({ id: 'b', status: 'expired' }).terminal).toBe(true);
  });
});

describe('waitForTerminal', () => {
  it('polls until a terminal status and reports each change once', async () => {
    const seq = ['validating', 'in_progress', 'in_progress', 'completed'];
    const m = mockFetch(() => [200, { id: 'b1', status: seq.shift(), results: [] }]);
    const p = new OpenRouterBatchProvider({ apiKey: 'k', fetch: m.fetch, sleep: noSleep });
    const seen: string[] = [];
    const final = await p.waitForTerminal('b1', { onStatus: (s) => seen.push(s) });
    expect(final.status).toBe('completed');
    expect(seen).toEqual(['validating', 'in_progress', 'completed']);
    expect(m.calls[0]!.url).toBe('https://openrouter.ai/api/v1/batches/b1');
  });

  it('tolerates 404 right after creation, but not forever', async () => {
    const seq: Array<[number, unknown]> = [
      [404, { error: { code: 404, message: 'Batch job b1 not found.' } }],
      [404, { error: { code: 404 } }],
      [200, { id: 'b1', status: 'completed', results: [] }],
    ];
    const m = mockFetch(() => seq.shift()!);
    const p = new OpenRouterBatchProvider({ apiKey: 'k', fetch: m.fetch, sleep: noSleep, maxRetries: 0 });
    await expect(p.waitForTerminal('b1')).resolves.toMatchObject({ status: 'completed' });

    let t = 0;
    const gone = mockFetch(() => [404, { error: { code: 404 } }]);
    const p2 = new OpenRouterBatchProvider({
      apiKey: 'k',
      fetch: gone.fetch,
      sleep: async (ms) => void (t += ms),
      now: () => t,
      maxRetries: 0,
      notFoundGraceMs: 60_000,
    });
    await expect(p2.waitForTerminal('b1')).rejects.toThrow(/HTTP 404/);
  });
});
