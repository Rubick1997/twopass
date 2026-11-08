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

/**
 * A finished run with two flagged rows, for the review queue. Labels: r1 card_arrival, r2 age_limit,
 * r3 atm_support, r4 card_linking.
 *   r1  accepted in triage (right)
 *   r2  accepted in round 1 (right)
 *   r3  flagged after round 2 with card_linking (wrong); its triage spreads over three labels
 *   r4  flagged after round 2 with card_linking (right, but the verifier couldn't tell)
 * Accuracy, no human: 3 of 4.
 */
export function reviewRun(root: string, runId = 'run-review') {
  const run = makeRun(root, runId);
  const { ledger } = run;
  const decision = (rowId: string, round: 0 | 1 | 2, answers: Record<string, unknown>, at: number) =>
    ledger.append({
      t: 'decision',
      rowId,
      round,
      stage: round === 0 ? 'triage' : 'verify',
      model: 'typesafe/jev-1.14-x',
      answers: answers as never,
      costUsd: 0.001,
      latencyMs: 5,
      at: iso(at),
    });
  const verdict = (choice: string, supported: number, unsupported: number, cannotTell: number) => ({
    verdict: { type: 'choice', choice, probabilities: { supported, unsupported, cannot_tell: cannotTell }, confidence: 0.8 },
  });
  triage(ledger, 'r1', 'card_arrival', 0.97, 0);
  triage(ledger, 'r2', 'age_limit', 0.5, 0);
  decision(
    'r3',
    0,
    { answer: { type: 'choice', choice: 'card_arrival', probabilities: { card_arrival: 0.5, atm_support: 0.3, card_linking: 0.15, age_limit: 0, cannot_tell: 0.05 }, confidence: 0.5 } },
    0,
  );
  triage(ledger, 'r4', 'card_linking', 0.6, 0);
  submit(ledger, 'batch-1', 1, WRITER, ['r2', 'r3', 'r4'], MIN);
  results(ledger, 'batch-1', 1, WRITER, { r2: 'age_limit', r3: 'card_arrival', r4: 'age_limit' }, 5 * MIN);
  decision('r2', 1, verdict('supported', 0.96, 0.03, 0.01), 6 * MIN);
  decision('r3', 1, verdict('unsupported', 0.1, 0.85, 0.05), 6 * MIN);
  decision('r4', 1, verdict('unsupported', 0.2, 0.7, 0.1), 6 * MIN);
  submit(ledger, 'batch-2', 2, ESCALATION, ['r3', 'r4'], 7 * MIN);
  results(ledger, 'batch-2', 2, ESCALATION, { r3: 'card_linking', r4: 'card_linking' }, 10 * MIN);
  decision('r3', 2, verdict('unsupported', 0.2, 0.6, 0.2), 11 * MIN);
  decision('r4', 2, verdict('cannot_tell', 0.4, 0.1, 0.5), 11 * MIN);
  return run;
}
