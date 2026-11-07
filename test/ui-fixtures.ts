import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { customId, Ledger } from '../src/ledger.ts';
import { writeRunLock } from './lock-helpers.ts';
import { createRunDir, sha256File, type RunManifest } from '../src/run.ts';
import { tempDir } from './helpers.ts';

// Run folders for the UI tests, built with Ledger.append like a real run would.

export const TASK = resolve('tasks/banking77.task.ts');
export const WRITER = 'anthropic/claude-haiku-5.5:batch';
export const ESCALATION = 'anthropic/claude-sonnet-5.5:batch';
export const T0 = Date.parse('2026-11-07T10:00:00.000Z');
export const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
export const MIN = 60_000;

export const LABELS = ['card_arrival', 'age_limit', 'atm_support', 'card_linking'];

export function makeRoot(): string {
  const root = join(tempDir(), 'runs');
  mkdirSync(root, { recursive: true });
  return root;
}

export function makeRun(
  root: string,
  runId: string,
  o: { rows?: number; mode?: RunManifest['mode']; maxUsd?: number; createdAt?: string } = {},
): { dir: string; ledger: Ledger; rowIds: string[] } {
  const n = o.rows ?? 4;
  const records = Array.from({ length: n }, (_, i) => ({
    id: `r${i + 1}`,
    data: { id: `r${i + 1}`, text: `message ${i + 1}`, label: LABELS[i % LABELS.length]! },
  }));
  const manifest: RunManifest = {
    runId,
    createdAt: o.createdAt ?? iso(0),
    taskPath: TASK,
    inputPath: 'x.csv',
    inputColumns: ['id', 'text', 'label'],
    rowCount: n,
    labelColumn: 'label',
    mode: o.mode ?? 'normal',
    models: { writer: WRITER, escalation: ESCALATION, triage: 'typesafe/jev-1.14', verify: 'typesafe/jev-1.14' },
    thresholds: { t0: 0.9, t1: 0.9, t2: 0.9 },
    thresholdsSource: 'test',
    prices: { [WRITER]: { inputPerToken: 1e-7, outputPerToken: 1e-6 }, [ESCALATION]: { inputPerToken: 1e-6, outputPerToken: 5e-6 } },
    ...(o.maxUsd !== undefined ? { maxUsd: o.maxUsd } : {}),
    taskSha256: sha256File(TASK),
  };
  const dir = join(root, runId);
  createRunDir(dir, manifest, records);
  return { dir, ledger: new Ledger(join(dir, 'ledger.jsonl')), rowIds: records.map((r) => r.id) };
}

const choice = (c: string, p: number) => ({ type: 'choice', choice: c, probabilities: { [c]: p, cannot_tell: 1 - p }, confidence: p });

export function triage(ledger: Ledger, rowId: string, label: string, p: number, at: number, costUsd = 0.001) {
  ledger.append({ t: 'decision', rowId, round: 0, stage: 'triage', model: 'typesafe/jev-1.14-x', answers: { answer: choice(label, p) }, costUsd, latencyMs: 5, at: iso(at) });
}

export function verify(ledger: Ledger, rowId: string, round: 1 | 2, supported: boolean, at: number, costUsd = 0.002) {
  ledger.append({
    t: 'decision',
    rowId,
    round,
    stage: 'verify',
    model: 'typesafe/jev-1.14-x',
    answers: { verdict: choice(supported ? 'supported' : 'unsupported', 0.95) },
    costUsd,
    latencyMs: 5,
    at: iso(at),
  });
}

export function submit(ledger: Ledger, batchId: string, round: 1 | 2, model: string, rowIds: string[], at: number) {
  ledger.append({ t: 'batch_submitted', round, batchId, model, customIds: rowIds.map((id) => customId(id, round)), at: iso(at) });
}

export function results(
  ledger: Ledger,
  batchId: string,
  round: 1 | 2,
  model: string,
  answers: Record<string, string>,
  at: number,
  o: { costUsd?: number | null; perRowUsd?: number; undecodable?: number; inputTokens?: number } = {},
) {
  for (const [rowId, label] of Object.entries(answers)) {
    ledger.append({
      t: 'batch_result',
      batchId,
      round,
      model,
      customId: customId(rowId, round),
      rowId,
      ok: true,
      text: JSON.stringify({ label }),
      inputTokens: o.inputTokens ?? 500,
      outputTokens: 8,
      costUsd: o.perRowUsd ?? 0.0005,
      at: iso(at),
    });
  }
  ledger.append({ t: 'batch_finished', batchId, status: 'completed', costUsd: o.costUsd === undefined ? 0.01 : o.costUsd, undecodable: o.undecodable ?? 0, at: iso(at) });
}

export function lockRun(dir: string, heartbeatOffsetMs: number, pid = 4242) {
  writeRunLock(dir, { pid, startedAt: iso(0), heartbeatAt: iso(heartbeatOffsetMs) });
}

export function writeBench(root: string, benchId: string, testRuns: Record<string, string>, extra: Record<string, unknown> = {}) {
  const dir = join(root, benchId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'bench.json'),
    JSON.stringify({
      benchId,
      createdAt: iso(0),
      taskPath: TASK,
      configs: [{ name: 'jev', triage: 'typesafe/jev-1.14', verify: 'typesafe/jev-1.14' }],
      baseline: 'anthropic/claude-opus-5.5:batch',
      calibrationSize: 10,
      testSize: null,
      target: 0.95,
      seed: 1,
      testRuns,
      ...extra,
    }),
  );
  return dir;
}
