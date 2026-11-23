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
    // A string reply is sent as it is (JSONL result files); anything else as JSON.
    if (typeof json === 'string') return new Response(json, { status, headers: { 'content-type': 'application/x-jsonl' } });
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

export function anthropicMessage(text: string | null, over: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content: text === null ? [] : [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 40, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage },
    ...over,
  };
}

export const anthropicSucceeded = (customId: string, text: string | null, over: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) => ({
  custom_id: customId,
  result: { type: 'succeeded', message: anthropicMessage(text, over, usage) },
});

export const BATCH_COUNTS = { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 };

export const anthropicBatch = (id: string, status: 'in_progress' | 'canceling' | 'ended') => ({
  id,
  type: 'message_batch',
  processing_status: status,
  request_counts: BATCH_COUNTS,
  created_at: '2026-11-14T00:00:00Z',
  expires_at: '2026-11-15T00:00:00Z',
  ended_at: status === 'ended' ? '2026-11-14T01:00:00Z' : null,
  archived_at: null,
  cancel_initiated_at: null,
  results_url: status === 'ended' ? `https://api.anthropic.com/v1/messages/batches/${id}/results` : null,
});

export const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
