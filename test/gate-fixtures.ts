import { createHash } from 'node:crypto';
import type { GateResult, ResultRow } from '../src/gate/result.ts';

/** A deterministic number in [0, 1) from a string. */
export const h = (s: string): number => parseInt(createHash('sha256').update(s).digest('hex').slice(0, 8), 16) / 0x100000000;

export interface FixtureRow {
  id: string;
  label: string;
  answer?: string;
  status?: ResultRow['status'];
  confidence?: number | null;
  text?: string;
}

/** A result file from short row specs: default status accepted, answer = label (right), confidence 0.99. */
export function makeResult(rows: FixtureRow[], over: Partial<GateResult> = {}): GateResult {
  return {
    kind: 'twopass-gate-result',
    version: 1,
    task: 'toy',
    configPath: 'gates/toy.task.yaml',
    configSha256: 'x',
    ref: 'base',
    gitSha: null,
    createdAt: '2026-11-23T00:00:00.000Z',
    runId: 'r',
    promise: { acceptedPrecision: 0.95 },
    thresholds: { t0: 0.9, t1: 0.9, t2: 0.9 },
    thresholdsSource: 'test',
    triageStage: true,
    models: { writer: 'w', escalation: 'e', triage: 'chk', verify: 'chk' },
    routes: [],
    routingKey: 'same',
    servedModels: ['chk'],
    rows: rows.map((r) => ({
      id: r.id,
      label: r.label,
      text: r.text ?? `text of ${r.id}`,
      status: r.status ?? 'accepted',
      answer: r.answer ?? r.label,
      confidence: r.confidence === undefined ? 0.99 : r.confidence,
      verdict: 'triage',
      round: 0,
      model: 'chk',
      costUsd: 0.001,
    })),
    cost: { listUsd: rows.length * 0.001, byProvider: {} },
    runtimeSec: 1,
    ...over,
  };
}

/** n rows per label over `labels`, ids `<label>-<i>`, all right and accepted. */
export function grid(labels: string[], n: number): FixtureRow[] {
  return labels.flatMap((label) => Array.from({ length: n }, (_, i) => ({ id: `${label}-${String(i).padStart(3, '0')}`, label })));
}

/** Apply changes to some rows of a grid by id. */
export function withRows(rows: FixtureRow[], change: (r: FixtureRow, i: number) => Partial<FixtureRow> | undefined): FixtureRow[] {
  return rows.map((r, i) => ({ ...r, ...(change(r, i) ?? {}) }));
}
