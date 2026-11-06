import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchFn } from '../src/http.ts';

export interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** A fetch stand-in: `handler` returns [status, json] for each request. */
export function mockFetch(handler: (call: Call) => [number, unknown] | Promise<[number, unknown]>) {
  const calls: Call[] = [];
  const fn: FetchFn = async (input, init) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const [status, json] = await handler(call);
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch: fn, calls };
}

export const noSleep = async () => {};

export const tempDir = () => mkdtempSync(join(tmpdir(), 'twopass-test-'));

export function chatResult(customId: string, content: string, promptTokens = 40, completionTokens = 5) {
  return {
    custom_id: customId,
    response: {
      status_code: 200,
      body: {
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
      },
    },
    error: null,
  };
}
