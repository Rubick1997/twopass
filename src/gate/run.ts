import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { activeProvidersLine, routingKey } from '../batch/route.ts';
import { bucketsFromAnthropic, bucketsFromOpenRouter, type UsageBuckets } from '../cost/usage.ts';
import type { LedgerEvent } from '../ledger.ts';
import { Ledger } from '../ledger.ts';
import { loadRun } from '../run.ts';
import { executeRun, startRun } from '../runner.ts';
import { loadRows, readIdFile, writeJson, writeRunCsv } from './data.ts';
import type { GateResult, ProviderCost, ResultRow } from './result.ts';
import { idColumnOf, loadGateConfig, requireThresholds, resolveRoutes, taskFromConfig } from './task-config.ts';

export interface GateRunOptions {
  taskPath: string;
  ref: string;
  out: string;
  maxUsd?: number;
  runsRoot?: string;
  /** Only the first N slice rows (smoke tests, cost probes). */
  limit?: number;
  /** Experiments only: run on thresholds fitted for another checker, recorded in the result. */
  allowThresholdMismatch?: boolean;
  /** Continue an interrupted gate run (its run ID under runsRoot) instead of starting a new one. Nothing is paid twice. */
  resume?: string;
  env: { openRouterKey?: string; anthropicKey?: string };
  log?: (m: string) => void;
  /** For tests: replaces the run step (no network). */
  execute?: typeof executeRun;
  start?: typeof startRun;
}

/** Runs the task's CI slice through the full pipeline on the sync path and writes one result file. */
export async function gateRun(o: GateRunOptions): Promise<GateResult> {
  const log = o.log ?? (() => {});
  const started = Date.now();
  const loaded = loadGateConfig(o.taskPath);
  const { config } = loaded;
  const th = requireThresholds(loaded, { allowMismatch: !!o.allowThresholdMismatch });
  if (th.mismatch) {
    log(`WARNING: thresholds fitted for ${th.mismatch.fittedFor.triage} / ${th.mismatch.fittedFor.verify}, running ${th.mismatch.using.triage} / ${th.mismatch.using.verify} (--allow-threshold-mismatch)`);
  }
  const task = await taskFromConfig(loaded);
  if (!o.env.openRouterKey) throw new Error('OPENROUTER_API_KEY is not set: the checker runs on OpenRouter.');
  const routes = resolveRoutes(config, { anthropicKey: !!o.env.anthropicKey });
  log(activeProvidersLine({ openrouter: !!o.env.openRouterKey, anthropic: !!o.env.anthropicKey }));
  for (const r of [routes.writer, routes.escalation]) log(`  ${r.requested} → ${r.provider} as ${r.callId} (${r.transport})`);

  const idColumn = idColumnOf(config);
  const rows = loadRows(config.data, config.columns, idColumn);
  let ids = readIdFile(config.slice.file);
  assertNoOverlap(ids, config.slice.exclude);
  if (o.limit) ids = ids.slice(0, o.limit);
  const maxUsd = o.maxUsd ?? config.gate.maxUsd;
  const runsRoot = resolve(o.runsRoot ?? 'runs');
  const csvPath = join(runsRoot, 'gate-inputs', `${config.name}-${createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 12)}.csv`);
  writeRunCsv(csvPath, rows, ids);

  const start = o.start ?? startRun;
  const execute = o.execute ?? executeRun;
  const triage = config.checker.triage ?? config.checker.model;
  const { dir, manifest } = o.resume
    ? resumable(join(runsRoot, o.resume), { routes, triage, verify: config.checker.model, thresholds: th.thresholds, rows: ids.length })
    : await start({
    apiKey: o.env.openRouterKey,
    runsRoot,
    csvPath,
    taskPath: loaded.path,
    labelColumn: config.columns.label,
    models: { writer: routes.writer.callId, escalation: routes.escalation.callId, triage, verify: config.checker.model },
    thresholds: { values: th.thresholds, source: `${config.checker.thresholds} (${th.source})` },
    maxUsd,
    transport: 'sync',
    runIdSuffix: 'gate',
    log,
  });
  log(`gate run ${manifest.runId}${o.resume ? ' (resumed)' : ''}: ${ids.length} rows, cap $${maxUsd} (list price)`);
  const { outcomes } = await execute(dir, {
    apiKey: o.env.openRouterKey,
    maxUsdOverride: maxUsd,
    ...(o.env.anthropicKey ? { anthropicApiKey: o.env.anthropicKey } : {}),
    log,
  });

  const events = new Ledger(join(dir, 'ledger.jsonl')).read();
  const label = new Map(rows.map((r) => [r.id, r]));
  const resultRows: ResultRow[] = outcomes.map((x) => ({
    id: x.rowId,
    label: label.get(x.rowId)?.label ?? '',
    text: label.get(x.rowId)?.text ?? '',
    status: x.status,
    answer: x.answer,
    confidence: x.confidence,
    verdict: x.verdict,
    round: x.round,
    model: x.model,
    costUsd: x.costUsd,
  }));
  const byProvider = costByProvider(events, routes);
  const result: GateResult = {
    kind: 'twopass-gate-result',
    version: 1,
    task: config.name,
    configPath: o.taskPath,
    configSha256: createHash('sha256').update(readFileSync(loaded.path)).digest('hex'),
    ref: o.ref,
    gitSha: gitSha(),
    createdAt: new Date().toISOString(),
    runId: manifest.runId,
    promise: config.promise,
    thresholds: th.thresholds,
    thresholdsSource: th.source,
    triageStage: !!task.triage,
    ...(th.mismatch ? { thresholdMismatch: th.mismatch } : {}),
    models: { writer: routes.writer.callId, escalation: routes.escalation.callId, triage, verify: config.checker.model },
    routes: [routes.writer, routes.escalation],
    routingKey: routingKey([routes.writer, routes.escalation]),
    servedModels: servedModels(events),
    rows: resultRows,
    cost: { listUsd: Object.values(byProvider).reduce((s, p) => s + p.listUsd, 0), byProvider },
    runtimeSec: Math.round((Date.now() - started) / 1000),
  };
  writeJson(o.out, result);
  log(`wrote ${o.out}: $${result.cost.listUsd.toFixed(4)} list price, ${result.runtimeSec}s`);
  return result;
}

/** An interrupted gate run may be continued only if it is the same configuration this config would start now. */
function resumable(
  dir: string,
  want: { routes: ReturnType<typeof resolveRoutes>; triage: string; verify: string; thresholds: { t0: number; t1: number; t2: number }; rows: number },
) {
  const { manifest } = loadRun(dir);
  const m = manifest.models;
  const same =
    manifest.transport === 'sync' &&
    m.writer === want.routes.writer.callId &&
    m.escalation === want.routes.escalation.callId &&
    m.triage === want.triage &&
    m.verify === want.verify &&
    JSON.stringify(manifest.thresholds) === JSON.stringify(want.thresholds) &&
    manifest.rowCount === want.rows;
  if (!same) throw new Error(`${dir} is not a gate run of this configuration (models, routing, thresholds or rows differ); start a new run instead.`);
  return { dir, manifest };
}

/** The slice must not contain any excluded ID (calibration rows, held-out data). */
export function assertNoOverlap(sliceIds: string[], excludeFiles: string[]): void {
  const slice = new Set(sliceIds);
  for (const f of excludeFiles) {
    const hit = readIdFile(f).filter((id) => slice.has(id));
    if (hit.length) throw new Error(`The slice contains ${hit.length} row(s) listed in ${f} (first: ${hit[0]}). Rebuild the slice.`);
  }
}

function servedModels(events: LedgerEvent[]): string[] {
  const s = new Set<string>();
  for (const e of events) {
    if (e.t === 'decision') s.add(e.model);
    if (e.t === 'batch_result' && e.ok) s.add(e.servedModel ?? e.model);
  }
  return [...s].sort();
}

const emptyCost = (): ProviderCost => ({ listUsd: 0, calls: 0, uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, billedUsd: null });

/**
 * Cost per provider. Writer calls: list price computed from usage (Anthropic credits don't change it). Decision calls
 * go through OpenRouter, which reports a billed cost per call; it is both the list and the billed amount there.
 */
export function costByProvider(events: LedgerEvent[], routes: { writer: { callId: string; provider: string }; escalation: { callId: string; provider: string } }): Record<string, ProviderCost> {
  const out: Record<string, ProviderCost> = {};
  const providerOf = (model: string) => (model === routes.writer.callId ? routes.writer.provider : model === routes.escalation.callId ? routes.escalation.provider : 'openrouter');
  for (const e of events) {
    if (e.t === 'batch_result') {
      const p = (out[e.provider ?? providerOf(e.model)] ??= emptyCost());
      p.calls++;
      p.listUsd += e.costUsd;
      const b = buckets(e);
      if (b) {
        p.uncachedInput += b.uncachedInput;
        p.cacheRead += b.cacheRead;
        p.cacheWrite += b.cacheWrite;
        p.output += b.output;
      }
    }
    if (e.t === 'decision') {
      const p = (out['openrouter-decisions'] ??= emptyCost());
      p.calls++;
      p.listUsd += e.costUsd;
      p.billedUsd = (p.billedUsd ?? 0) + e.costUsd;
    }
  }
  return out;
}

function buckets(e: Extract<LedgerEvent, { t: 'batch_result' }>): UsageBuckets | undefined {
  if (!e.usage) return undefined;
  try {
    return (e.provider ?? 'openrouter') === 'anthropic' ? bucketsFromAnthropic(e.usage) : bucketsFromOpenRouter(e.usage);
  } catch {
    return undefined;
  }
}

function gitSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}
