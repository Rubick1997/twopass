import Anthropic from '@anthropic-ai/sdk';
import type { FetchFn } from '../http.ts';
import { bucketsFromAnthropic } from '../cost/usage.ts';
import type { BatchHandle, BatchProvider, BatchRequest, BatchResultLine, BatchStatus, WaitOptions } from './provider.ts';
import { waitForTerminalStatus } from './wait.ts';

/** Anthropic's limits are 100,000 requests or 256 MB per batch; stay well under both. */
export const MAX_REQUESTS_PER_BATCH = 10_000;
const MAX_BATCH_BYTES = 200_000_000;
export const ANTHROPIC_BATCH_ID_PREFIX = 'msgbatch_';

/** `claude-haiku-5-5`: Anthropic's own model IDs. OpenRouter IDs contain `/` and end in `:batch`. */
export const isAnthropicDirect = (model: string): boolean => /^claude-[a-z0-9-]+$/.test(model);

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const KNOWN_KEYS = new Set(['messages', 'max_tokens', 'reasoning', 'response_format']);

type Params = Anthropic.MessageCreateParamsNonStreaming;

/**
 * Translates the pipeline's OpenRouter chat-completions body (see `writerBody`) into Messages API params.
 * Unknown keys throw instead of being dropped; `temperature`, `top_p`, `top_k` and `stream` are never sent.
 */
export function toMessagesParams(model: string, body: Record<string, unknown>): Params {
  for (const k of Object.keys(body)) {
    if (!KNOWN_KEYS.has(k)) throw new Error(`Anthropic direct: don't know how to send request field "${k}" (known: ${[...KNOWN_KEYS].join(', ')})`);
  }
  if (!Array.isArray(body.messages)) throw new Error('Anthropic direct: body.messages must be an array');
  if (typeof body.max_tokens !== 'number') throw new Error('Anthropic direct: body.max_tokens must be a number');

  const system: string[] = [];
  const messages: Array<{ role: 'user' | 'assistant'; content: Anthropic.MessageParam['content'] }> = [];
  for (const m of body.messages as Array<{ role?: unknown; content?: unknown }>) {
    if (m.role === 'system') system.push(systemText(m.content));
    else if (m.role === 'user' || m.role === 'assistant') messages.push({ role: m.role, content: m.content as Anthropic.MessageParam['content'] });
    else throw new Error(`Anthropic direct: unsupported message role ${JSON.stringify(m.role)}`);
  }

  const params: Params = { model, max_tokens: body.max_tokens, messages };
  if (system.length) params.system = system.join('\n\n');

  const outputConfig: Anthropic.OutputConfig = {};
  const reasoning = body.reasoning;
  if (reasoning !== undefined) {
    if (!reasoning || typeof reasoning !== 'object') throw new Error('Anthropic direct: reasoning must be an object');
    const r = reasoning as Record<string, unknown>;
    const extra = Object.keys(r).filter((k) => k !== 'enabled' && k !== 'effort');
    if (extra.length) throw new Error(`Anthropic direct: unsupported reasoning field "${extra[0]}"`);
    if (r.enabled === false) {
      if (r.effort !== undefined) throw new Error('Anthropic direct: reasoning cannot be both disabled and have an effort');
      params.thinking = { type: 'disabled' };
    } else if (typeof r.effort === 'string') {
      const effort = r.effort === 'minimal' ? 'low' : r.effort;
      if (!EFFORTS.has(effort)) throw new Error(`Anthropic direct: unknown reasoning effort "${r.effort}"`);
      outputConfig.effort = effort as NonNullable<Anthropic.OutputConfig['effort']>;
    } else {
      throw new Error(`Anthropic direct: unsupported reasoning setting ${JSON.stringify(reasoning)}`);
    }
  }

  const rf = body.response_format as { type?: unknown; json_schema?: { schema?: unknown } } | undefined;
  if (rf !== undefined) {
    const schema = rf.json_schema?.schema;
    if (rf.type !== 'json_schema' || !schema || typeof schema !== 'object') {
      throw new Error('Anthropic direct: only response_format {type: "json_schema", json_schema: {schema}} is supported');
    }
    outputConfig.format = { type: 'json_schema', schema: schema as Record<string, unknown> };
  }
  if (Object.keys(outputConfig).length) params.output_config = outputConfig;
  return params;
}

function systemText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p: { type?: unknown; text?: unknown }) => {
        if (p?.type !== 'text' || typeof p.text !== 'string') throw new Error('Anthropic direct: system content parts must be text');
        return p.text;
      })
      .join('');
  }
  throw new Error('Anthropic direct: system message content must be a string or text parts');
}

/** Decodes one batch result line. Always fills tokens, usage and buckets when a message exists. */
export function decodeAnthropicResult(line: Anthropic.Messages.MessageBatchIndividualResponse): BatchResultLine {
  const custom_id = line.custom_id;
  const r = line.result;
  const fail = (error: string, extra: Partial<BatchResultLine> = {}): BatchResultLine => ({
    custom_id,
    ok: false,
    error,
    inputTokens: 0,
    outputTokens: 0,
    ...extra,
  });
  if (r.type === 'errored') return fail(`${r.error.error.type}: ${r.error.error.message}`);
  if (r.type === 'canceled') return fail('canceled');
  if (r.type === 'expired') return fail('expired');

  const msg = r.message;
  const u = msg.usage;
  const usage = {
    inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
    usage: u,
    buckets: bucketsFromAnthropic(u),
  };
  if (msg.stop_reason === 'max_tokens') {
    const thinking = usage.buckets.reasoning;
    return fail(`cut off at max_tokens (${thinking} reasoning tokens)`, { truncated: true, ...usage });
  }
  if (msg.stop_reason === 'refusal') {
    const category = msg.stop_details?.category;
    return fail(category ? `refusal (${category})` : 'refusal', usage);
  }
  const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  if (text.trim() === '') return fail('empty content', usage);
  return { custom_id, ok: true, text, ...usage };
}

export interface AnthropicBatchOptions {
  apiKey: string;
  fetch?: FetchFn;
  /** The SDK's own retries (network errors, 429, 5xx). */
  maxRetries?: number;
  maxRequestsPerBatch?: number;
  /** How long a new batch may answer 404 before we give up on it. Default 3 minutes. */
  notFoundGraceMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class AnthropicBatchProvider implements BatchProvider {
  private readonly opts: AnthropicBatchOptions;
  private readonly client: Anthropic;

  constructor(opts: AnthropicBatchOptions) {
    this.opts = opts;
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    });
  }

  async submit(model: string, requests: BatchRequest[], onSubmitted: (h: BatchHandle) => void): Promise<BatchHandle[]> {
    const max = this.opts.maxRequestsPerBatch ?? MAX_REQUESTS_PER_BATCH;
    const handles: BatchHandle[] = [];
    let chunk: Array<{ custom_id: string; params: Params }> = [];
    let bytes = 0;
    const flush = async () => {
      if (!chunk.length) return;
      const batch = await this.client.messages.batches.create({ requests: chunk });
      const h = { id: batch.id, customIds: chunk.map((r) => r.custom_id) };
      handles.push(h);
      onSubmitted(h);
      chunk = [];
      bytes = 0;
    };
    for (const r of requests) {
      const item = { custom_id: r.custom_id, params: toMessagesParams(model, r.body) };
      const size = JSON.stringify(item).length;
      if (chunk.length >= max || (chunk.length > 0 && bytes + size > MAX_BATCH_BYTES)) await flush();
      chunk.push(item);
      bytes += size;
    }
    await flush();
    return handles;
  }

  async poll(id: string): Promise<BatchStatus> {
    const b = await this.client.messages.batches.retrieve(id);
    const ended = b.processing_status === 'ended';
    const status: BatchStatus = {
      id: b.id,
      status: ended ? 'completed' : b.processing_status,
      terminal: ended,
      costUsd: null,
      results: [],
      undecodable: 0,
    };
    if (!ended) return status;
    for await (const line of await this.client.messages.batches.results(id)) {
      try {
        status.results.push(decodeAnthropicResult(line));
      } catch {
        status.undecodable++;
      }
    }
    return status;
  }

  waitForTerminal(id: string, wait: WaitOptions = {}): Promise<BatchStatus> {
    return waitForTerminalStatus(() => this.poll(id), (err) => err instanceof Anthropic.NotFoundError, wait, this.opts);
  }
}
