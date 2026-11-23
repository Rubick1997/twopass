import { readFileSync } from 'node:fs';
import { z } from 'zod';

// The file `gate run` writes: everything `compare`, `noise`, `recalibrate` and the reviewer list need, so they run
// offline (no keys, no network) on the two files a CI job produced.

export interface ResultRow {
  id: string;
  label: string;
  text: string;
  status: 'accepted' | 'flagged' | 'pending';
  answer: string;
  /** p(chosen) at triage, or p(supported) at verify; null when nothing was scored. */
  confidence: number | null;
  verdict: string;
  round: 0 | 1 | 2;
  /** The model whose answer this is (checker for round 0, writer for rounds 1–2). */
  model: string;
  costUsd: number;
}

export interface ProviderCost {
  /** List price computed from usage (cache buckets priced separately). */
  listUsd: number;
  calls: number;
  uncachedInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** What the provider reported billing, when it reports per call (OpenRouter decisions). */
  billedUsd: number | null;
}

export interface GateResult {
  kind: 'twopass-gate-result';
  version: 1;
  task: string;
  configPath: string;
  configSha256: string;
  ref: string;
  gitSha: string | null;
  createdAt: string;
  runId: string;
  promise: { acceptedPrecision: number };
  thresholds: { t0: number; t1: number; t2: number };
  thresholdsSource: string;
  /** The task has round 0 (the checker picks the label itself); recalibration fits t0 only then. */
  triageStage: boolean;
  models: { writer: string; escalation: string; triage: string; verify: string };
  routes: Array<{ requested: string; provider: 'anthropic' | 'openrouter'; callId: string; transport: 'sync' | 'batch' }>;
  routingKey: string;
  servedModels: string[];
  rows: ResultRow[];
  cost: { listUsd: number; byProvider: Record<string, ProviderCost> };
  runtimeSec: number;
}

const rowSchema = z.looseObject({
  id: z.string(),
  label: z.string(),
  text: z.string(),
  status: z.enum(['accepted', 'flagged', 'pending']),
  answer: z.string(),
  confidence: z.number().nullable(),
  verdict: z.string(),
  round: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  model: z.string(),
  costUsd: z.number(),
});

const resultSchema = z.looseObject({
  kind: z.literal('twopass-gate-result'),
  version: z.literal(1),
  task: z.string(),
  ref: z.string(),
  promise: z.looseObject({ acceptedPrecision: z.number() }),
  thresholds: z.looseObject({ t0: z.number(), t1: z.number(), t2: z.number() }),
  models: z.looseObject({ writer: z.string(), escalation: z.string(), triage: z.string(), verify: z.string() }),
  routingKey: z.string(),
  rows: z.array(rowSchema),
  cost: z.looseObject({ listUsd: z.number() }),
});

export function readResult(path: string): GateResult {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path}: not a JSON file (${(err as Error).message})`);
  }
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0]!;
    throw new Error(`${path}: not a gate result file (${i.path.join('.')}: ${i.message})`);
  }
  return parsed.data as unknown as GateResult;
}
