import { z } from 'zod';
import { authHeaders, createLimiter, requestJson, type FetchFn, type RetryOptions } from '../http.ts';
import {
  assertHasCannotTell,
  type Answer,
  type DecisionModel,
  type DecisionResult,
  type DecisionState,
  type Questions,
} from './model.ts';

export const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';

const responseSchema = z.looseObject({
  model: z.string(),
  answers: z.record(z.string(), z.looseObject({ type: z.string() })),
  usage: z.looseObject({ cost: z.number().optional() }).optional(),
  id: z.string().optional(),
  provider: z.string().optional(),
});

export interface OpenRouterDecisionOptions extends RetryOptions {
  apiKey: string;
  /** Jev, Clef and Luna all use this one client and differ only by model ID. */
  model: string;
  url?: string;
  fetch?: FetchFn;
  concurrency?: number;
  now?: () => number;
}

export class OpenRouterDecisionModel implements DecisionModel {
  readonly id: string;
  private readonly opts: OpenRouterDecisionOptions;
  private readonly limit: ReturnType<typeof createLimiter>;

  constructor(opts: OpenRouterDecisionOptions) {
    this.id = opts.model;
    this.opts = opts;
    this.limit = createLimiter(opts.concurrency ?? 16);
  }

  decide(state: DecisionState, questions: Questions): Promise<DecisionResult> {
    assertHasCannotTell(questions);
    return this.limit(async () => {
      const now = this.opts.now ?? Date.now;
      const started = now();
      const raw = await requestJson<unknown>(
        this.opts.fetch ?? fetch,
        this.opts.url ?? DECISIONS_URL,
        {
          method: 'POST',
          headers: authHeaders(this.opts.apiKey),
          body: JSON.stringify({ model: this.opts.model, state, questions }),
        },
        this.opts,
      );
      return decodeDecisionResponse(raw, now() - started);
    });
  }
}

export function decodeDecisionResponse(raw: unknown, latencyMs: number): DecisionResult {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Unexpected Decisions API response: ${JSON.stringify(raw).slice(0, 300)}`);
  }
  const r = parsed.data;
  return {
    model: r.model,
    answers: r.answers as Record<string, Answer>,
    costUsd: r.usage?.cost ?? 0,
    latencyMs,
    ...(r.id ? { requestId: r.id } : {}),
    ...(r.provider ? { provider: r.provider } : {}),
  };
}
