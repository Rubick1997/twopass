import { z } from 'zod';
import { authHeaders, HttpError, realSleep, requestJson, type FetchFn, type RetryOptions } from '../http.ts';
import type { BatchHandle, BatchProvider, BatchRequest, BatchResultLine, BatchStatus, WaitOptions } from './provider.ts';

export const BATCHES_URL = 'https://openrouter.ai/api/v1/batches';
/** Confirmed in Phase 0: more than this returns HTTP 413. */
export const MAX_REQUESTS_PER_BATCH = 50_000;
export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'expired', 'cancelled']);

const batchSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  usage: z.looseObject({ cost: z.number().optional() }).nullable().optional(),
  results: z.array(z.unknown()).nullable().optional(),
  error: z.unknown().optional(),
});

const lineSchema = z.looseObject({
  custom_id: z.string(),
  response: z
    .looseObject({ status_code: z.number(), body: z.unknown() })
    .nullable()
    .optional(),
  error: z.unknown().optional(),
});

const chatBodySchema = z.looseObject({
  choices: z.array(
    z.looseObject({
      finish_reason: z.string().nullable().optional(),
      message: z.looseObject({ content: z.string().nullable().optional() }),
    }),
  ),
  usage: z
    .looseObject({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      completion_tokens_details: z.looseObject({ reasoning_tokens: z.number().optional() }).nullable().optional(),
    })
    .optional(),
});

export interface OpenRouterBatchOptions extends RetryOptions {
  apiKey: string;
  url?: string;
  fetch?: FetchFn;
  endpoint?: '/v1/chat/completions';
  maxRequestsPerBatch?: number;
  /** How long a new batch may answer 404 before we give up on it. Default 3 minutes. */
  notFoundGraceMs?: number;
  now?: () => number;
}

export class OpenRouterBatchProvider implements BatchProvider {
  private readonly opts: OpenRouterBatchOptions;

  constructor(opts: OpenRouterBatchOptions) {
    this.opts = opts;
  }

  private get url(): string {
    return this.opts.url ?? BATCHES_URL;
  }

  async submit(model: string, requests: BatchRequest[], onSubmitted: (h: BatchHandle) => void): Promise<BatchHandle[]> {
    const max = this.opts.maxRequestsPerBatch ?? MAX_REQUESTS_PER_BATCH;
    const handles: BatchHandle[] = [];
    for (let i = 0; i < requests.length; i += max) {
      await this.submitSplitting(model, requests.slice(i, i + max), (h) => {
        handles.push(h);
        onSubmitted(h);
      });
    }
    return handles;
  }

  /** Sends one batch; on HTTP 413 halves it and tries each half. */
  private async submitSplitting(model: string, requests: BatchRequest[], onSubmitted: (h: BatchHandle) => void) {
    try {
      // Key order matters: the API reads `endpoint` and `model` before `requests`.
      const body = JSON.stringify({ endpoint: this.opts.endpoint ?? '/v1/chat/completions', model, requests });
      const raw = await requestJson<unknown>(
        this.opts.fetch ?? fetch,
        this.url,
        { method: 'POST', headers: authHeaders(this.opts.apiKey), body },
        this.opts,
      );
      const batch = batchSchema.parse(raw);
      onSubmitted({ id: batch.id, customIds: requests.map((r) => r.custom_id) });
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 413) throw err;
      if (requests.length <= 1) throw new Error(`A single request is too large for the batch API: ${err.message}`);
      const mid = Math.ceil(requests.length / 2);
      await this.submitSplitting(model, requests.slice(0, mid), onSubmitted);
      await this.submitSplitting(model, requests.slice(mid), onSubmitted);
    }
  }

  async poll(id: string): Promise<BatchStatus> {
    const raw = await requestJson<unknown>(
      this.opts.fetch ?? fetch,
      `${this.url}/${encodeURIComponent(id)}`,
      { method: 'GET', headers: authHeaders(this.opts.apiKey) },
      this.opts,
    );
    return decodeBatch(raw);
  }

  async waitForTerminal(id: string, wait: WaitOptions = {}): Promise<BatchStatus> {
    const sleep = this.opts.sleep ?? realSleep;
    const now = this.opts.now ?? Date.now;
    let interval = wait.intervalMs ?? 10_000;
    const maxInterval = wait.maxIntervalMs ?? 60_000;
    const notFoundUntil = now() + (this.opts.notFoundGraceMs ?? 180_000);
    let last: string | undefined;
    for (;;) {
      let status: BatchStatus;
      try {
        status = await this.poll(id);
      } catch (err) {
        // A batch can 404 for a short while right after it is created (seen in the first live run).
        if (!(err instanceof HttpError) || err.status !== 404 || now() > notFoundUntil) throw err;
        await sleep(Math.min(interval, 5_000));
        continue;
      }
      if (status.status !== last) {
        last = status.status;
        wait.onStatus?.(status.status);
      }
      if (status.terminal) return status;
      await sleep(interval);
      interval = Math.min(Math.round(interval * 1.5), maxInterval);
    }
  }
}

export function decodeBatch(raw: unknown): BatchStatus {
  const batch = batchSchema.parse(raw);
  const results: BatchResultLine[] = [];
  let undecodable = 0;
  for (const line of batch.results ?? []) {
    const decoded = decodeResultLine(line);
    if (decoded) results.push(decoded);
    else undecodable++;
  }
  return {
    id: batch.id,
    status: batch.status,
    terminal: TERMINAL_STATUSES.has(batch.status),
    costUsd: batch.usage?.cost ?? null,
    ...(batch.error !== null && batch.error !== undefined ? { error: stringifyError(batch.error) } : {}),
    results,
    undecodable,
  };
}

/** Decodes one entry of `results[]`. Returns null when the line has no usable custom_id. */
export function decodeResultLine(raw: unknown): BatchResultLine | null {
  const parsed = lineSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { custom_id, response, error } = parsed.data;
  const fail = (message: string): BatchResultLine => ({
    custom_id,
    ok: false,
    error: message,
    inputTokens: 0,
    outputTokens: 0,
  });

  if (error !== null && error !== undefined) return fail(stringifyError(error));
  if (!response) return fail('no response');
  if (response.status_code !== 200) {
    return fail(`status ${response.status_code}: ${JSON.stringify(response.body).slice(0, 200)}`);
  }
  const body = chatBodySchema.safeParse(response.body);
  if (!body.success) return fail(`unexpected body: ${JSON.stringify(response.body).slice(0, 200)}`);
  const usage = {
    inputTokens: body.data.usage?.prompt_tokens ?? 0,
    outputTokens: body.data.usage?.completion_tokens ?? 0,
  };
  const choice = body.data.choices[0];
  if (choice?.finish_reason === 'length') {
    const reasoning = body.data.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    return { ...fail(`cut off at max_tokens (${reasoning} reasoning tokens)`), truncated: true, ...usage };
  }
  const content = choice?.message.content;
  if (typeof content !== 'string' || content.trim() === '') return { ...fail('empty content'), ...usage };
  return { custom_id, ok: true, text: content, ...usage };
}

function stringifyError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return JSON.stringify(error).slice(0, 200);
}
