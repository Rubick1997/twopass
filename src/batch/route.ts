import { isAnthropicDirect } from './anthropic.ts';
import type { Transport } from '../prices-anthropic.ts';

// Where a writer / escalation model is called, and under which ID.
//
// Rule (eval gate and any caller that resolves routes): a Claude model goes to Anthropic directly when
// ANTHROPIC_API_KEY is set, otherwise to OpenRouter; a task can force either with `provider: { claude: … }`.
// Everything else goes to OpenRouter. The same model can be named either way (`claude-haiku-5-5`,
// `anthropic/claude-haiku-5.5`, `anthropic/claude-haiku-5.5:batch`); the route decides the ID that is sent.
//
// `twopass run` and `bench` do not use this: they route by the ID as written (an Anthropic ID goes direct, an
// OpenRouter ID to OpenRouter), so the published part 1 (OpenRouter) and part 2 (direct) runs reproduce as they were.

export type Provider = 'anthropic' | 'openrouter';

export interface ModelRoute {
  /** The model as the task names it. */
  requested: string;
  provider: Provider;
  /** The ID sent to that provider. */
  callId: string;
  transport: Transport;
}

export const isClaude = (id: string): boolean => isAnthropicDirect(id) || /^anthropic\/claude-[a-z0-9.-]+(:batch)?$/.test(id);

/** `anthropic/claude-haiku-5.5:batch` → `claude-haiku-5-5`. Anthropic IDs pass through. */
export function toAnthropicId(id: string): string {
  if (isAnthropicDirect(id)) return id;
  const m = /^anthropic\/(claude-[a-z0-9.-]+?)(:batch)?$/.exec(id);
  if (!m) throw new Error(`${id} is not a Claude model ID`);
  return m[1]!.replace(/\./g, '-');
}

/** `claude-haiku-5-5` → `anthropic/claude-haiku-5.5` (+ `:batch` for batches). OpenRouter IDs get the suffix fixed. */
export function toOpenRouterId(id: string, transport: Transport): string {
  let base: string;
  if (isAnthropicDirect(id)) {
    const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(id);
    if (!m) throw new Error(`Can't map ${id} to an OpenRouter ID; name it as anthropic/… instead`);
    base = `anthropic/claude-${m[1]}-${m[2]}${m[3] !== undefined ? `.${m[3]}` : ''}`;
  } else {
    base = id.replace(/:batch$/, '');
  }
  return transport === 'batch' ? `${base}:batch` : base;
}

export interface RouteOptions {
  transport: Transport;
  /** Whether ANTHROPIC_API_KEY is set. Only presence matters; the key itself never reaches this module. */
  anthropicKey: boolean;
  /** Task override for Claude models. */
  claude?: Provider;
}

export function resolveRoute(model: string, o: RouteOptions): ModelRoute {
  if (!isClaude(model)) {
    return { requested: model, provider: 'openrouter', callId: toOpenRouterId(model, o.transport), transport: o.transport };
  }
  const provider: Provider = o.claude ?? (o.anthropicKey ? 'anthropic' : 'openrouter');
  if (provider === 'anthropic' && !o.anthropicKey) {
    throw new Error(`${model}: the task routes Claude models to Anthropic, but ANTHROPIC_API_KEY is not set`);
  }
  const callId = provider === 'anthropic' ? toAnthropicId(model) : toOpenRouterId(model, o.transport);
  return { requested: model, provider, callId, transport: o.transport };
}

/** Two runs can be compared only if every model went through the same provider and transport. */
export function routingKey(routes: ModelRoute[]): string {
  return routes
    .map((r) => `${r.requested}→${r.provider}:${r.callId}/${r.transport}`)
    .sort()
    .join(', ');
}

/** The startup line: which providers are active. Names keys by variable, never prints them. */
export function activeProvidersLine(env: { openrouter: boolean; anthropic: boolean }): string {
  const on = (b: boolean) => (b ? 'set' : 'not set');
  return (
    `providers: OpenRouter (OPENROUTER_API_KEY ${on(env.openrouter)}) for decision models and non-Claude writers; ` +
    `Anthropic direct (ANTHROPIC_API_KEY ${on(env.anthropic)}) for Claude models${env.anthropic ? '' : ' (falling back to OpenRouter)'}`
  );
}
