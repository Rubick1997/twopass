import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { Prices, RowRecord } from './pipeline.ts';
import type { Row, Thresholds } from './task.ts';

// Each run lives in runs/<runId>/:
//   manifest.json   pinned model IDs, date, thresholds, prices, cost cap
//   rows.jsonl      the normalized input rows, so resume does not need the original CSV
//   normalized.csv, check-report.json   what `twopass check` changed and found in the input
//   ledger.jsonl    everything that happened (see ledger.ts)
//   enriched.csv, review.csv   outputs
//   overrides.jsonl a reviewer's decisions (see overrides.ts); never read by the pipeline

export interface RunManifest {
  runId: string;
  createdAt: string;
  taskPath: string;
  inputPath: string;
  inputColumns: string[];
  rowCount: number;
  labelColumn?: string;
  mode: 'normal' | 'collect' | 'baseline';
  models: RunModels;
  thresholds: Thresholds;
  thresholdsSource: string;
  prices: Prices;
  maxUsd?: number;
  /** sha256 of the task file when the run started; resume refuses a changed file unless told otherwise. */
  taskSha256: string;
  /** Every time the run was resumed with a changed task file. */
  taskChanges?: Array<{ at: string; sha256: string }>;
  /** The input CSV as checked and normalized before the run (absent in runs made before `check`). */
  input?: { originalSha256: string; normalizedSha256: string; checkReport: string; warnings: number };
  /** Model versions that actually answered, filled in as the run goes. */
  servedModels?: string[];
}

export interface RunModels {
  writer: string;
  escalation: string;
  triage: string;
  verify: string;
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function toRecords(rows: Row[], idColumn?: string): RowRecord[] {
  const width = String(rows.length).length;
  const records = rows.map((data, i) => ({
    id: idColumn ? requireValue(data, idColumn, i) : `row-${String(i + 1).padStart(width, '0')}`,
    data,
  }));
  const seen = new Set<string>();
  for (const r of records) {
    if (seen.has(r.id)) throw new Error(`Duplicate row id "${r.id}" in column ${idColumn}`);
    seen.add(r.id);
  }
  return records;
}

function requireValue(row: Row, column: string, i: number): string {
  const v = row[column];
  if (!v) throw new Error(`Row ${i + 1} has no value in id column "${column}"`);
  return v;
}

/** Deterministic sample, so a dev run on 200 rows sees many labels rather than the first few. */
export function sample<T>(items: T[], n: number, seed: number): T[] {
  const copy = [...items];
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, n);
}

export function newRunId(taskName: string): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  return `${stamp}-${taskName}-${randomBytes(2).toString('hex')}`;
}

export function runDir(runsRoot: string, runId: string): string {
  return resolve(runsRoot, runId);
}

export function createRunDir(dir: string, manifest: RunManifest, records: RowRecord[]): void {
  if (existsSync(dir)) throw new Error(`Run directory already exists: ${dir}`);
  mkdirSync(dir, { recursive: true });
  writeManifest(dir, manifest);
  writeFileSync(join(dir, 'rows.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  copyFileSync(manifest.taskPath, join(dir, `task-snapshot-${basename(manifest.taskPath)}`));
}

export function writeManifest(dir: string, manifest: RunManifest): void {
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

export function loadRun(dir: string): { manifest: RunManifest; records: RowRecord[] } {
  if (!existsSync(join(dir, 'manifest.json'))) throw new Error(`No run found at ${dir}`);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as RunManifest;
  // runs from before triage and verify models were separate
  const legacy = manifest.models as RunModels & { decision?: string };
  if (legacy.decision) {
    legacy.triage ??= legacy.decision;
    legacy.verify ??= legacy.decision;
    delete legacy.decision;
  }
  manifest.mode ??= 'normal';
  const records = readFileSync(join(dir, 'rows.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RowRecord);
  return { manifest, records };
}
