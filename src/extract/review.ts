import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stringify } from 'csv-stringify/sync';
import { parseLedger, replay, type RunState } from '../ledger.ts';
import { activeFieldDecisions, readOverrides, type FieldDecision, type OverrideRecord } from '../overrides.ts';
import type { RowRecord } from '../pipeline.ts';
import { escapeCell, type Accuracy } from '../report.ts';
import { loadRun, type RunManifest } from '../run.ts';
import { loadTask, type TaskDefinition, type Thresholds } from '../task.ts';
import { computeFieldOutcomes, type FieldOutcome } from './outcomes.ts';
import { FIELD_CSV_COLUMNS, fieldCsvRecords } from './report.ts';

// Review of extraction runs: a person decides one field of one document at a time. Everything here is pure over
// the ledger, the thresholds and overrides.jsonl, exactly like the classify review (overrides.ts, report.ts).

// ---------------------------------------------------------------- finding a value in the text

/** Highlights per value and document. A value that occurs more often than this is not worth highlighting everywhere. */
export const MAX_SPANS = 20;

export type Span = [start: number, end: number];

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Where `value` appears in `text`: case-insensitive, every run of whitespace in the value matches any run of
 * whitespace in the text (OCR text breaks lines anywhere), all non-overlapping occurrences up to `cap`, as
 * [start, end) offsets into `text`. A null or blank value has none.
 */
export function findSpans(text: string, value: string | null, cap = MAX_SPANS): Span[] {
  if (value === null) return [];
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const re = new RegExp(words.map(escapeRegExp).join('\\s+'), 'gi');
  const spans: Span[] = [];
  for (let m = re.exec(text); m && spans.length < cap; m = re.exec(text)) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

// ---------------------------------------------------------------- thresholds

/**
 * The thresholds the bench report was built with for this run. A bench that refitted t2 after the first test read
 * keeps them in bench.json and leaves the run's manifest alone, so the review must take them from there or it
 * would not list the fields the report counts. Falls back to the manifest's.
 */
export function effectiveThresholds(runDir: string, manifest: Pick<RunManifest, 'runId' | 'thresholds'>): Thresholds {
  const root = dirname(runDir);
  try {
    for (const name of readdirSync(root)) {
      const path = join(root, name, 'bench.json');
      if (!name.startsWith('bench-') || !existsSync(path)) continue;
      const state = JSON.parse(readFileSync(path, 'utf8')) as { kind?: string; testRuns?: Record<string, string>; refit?: { thresholds?: Thresholds } };
      if (state.kind === 'extract' && state.testRuns?.normal === manifest.runId && state.refit?.thresholds) return state.refit.thresholds;
    }
  } catch {
    // an unreadable folder or bench.json: use the manifest's
  }
  return manifest.thresholds;
}

// ---------------------------------------------------------------- folding

export type FieldFinalStatus = FieldOutcome['status'] | 'reviewed';

export interface FoldedField extends Omit<FieldOutcome, 'status'> {
  /** "reviewed" when a person decided; otherwise the pipeline's status. */
  status: FieldFinalStatus;
  pipelineStatus: FieldOutcome['status'];
  /** The reviewer's value when there is a decision (null = "not in this document"), otherwise the pipeline's. */
  finalValue: string | null;
  review: FieldDecision | null;
}

/** The writer gave no usable reply, so the outcome's value is a placeholder. */
export const isUnusable = (o: Pick<FieldOutcome, 'verdict'>): boolean => o.verdict === 'writer_failed' || o.verdict === 'invalid_output';

/** Applies the reviewer's decisions on top of the pipeline's field outcomes. Pure. Decisions for slots the run does not have are ignored. */
export function foldFieldOverrides(outcomes: readonly FieldOutcome[], records: readonly OverrideRecord[]): FoldedField[] {
  const active = activeFieldDecisions(records);
  return outcomes.map((o) => {
    const review = active.get(`${o.rowId}\u0000${o.field}`) ?? null;
    return { ...o, status: review ? 'reviewed' : o.status, pipelineStatus: o.status, finalValue: review ? review.answer : o.value, review };
  });
}

export interface FieldReviewSummary {
  /** Field slots in the run. */
  fields: number;
  /** Slots the pipeline flagged (whether or not a person has looked at them since). */
  flagged: number;
  reviewed: number;
  remaining: number;
  /** Slots the pipeline did not flag that a person decided anyway. */
  reviewedOther: number;
  /** Decisions that changed the value. */
  overridden: number;
  /** Only with a label column; over slots with a label that are not pending. */
  accuracy?: Accuracy;
}

/** Review progress and, with labels, field accuracy without and with the reviewer's values. Pure. */
export function fieldReviewSummary(folded: readonly FoldedField[], task: TaskDefinition, labelOf: (rowId: string) => string | undefined): FieldReviewSummary {
  const s: FieldReviewSummary = { fields: folded.length, flagged: 0, reviewed: 0, remaining: 0, reviewedOther: 0, overridden: 0 };
  let of = 0;
  let noHuman = 0;
  let withHuman = 0;
  for (const f of folded) {
    if (f.pipelineStatus === 'flagged') {
      s.flagged++;
      if (f.review) s.reviewed++;
      else s.remaining++;
    } else if (f.review) s.reviewedOther++;
    if (f.review && f.review.answer !== f.review.previous) s.overridden++;
    const label = labelOf(f.rowId);
    if (!label?.trim() || f.pipelineStatus === 'pending') continue;
    of++;
    if (!isUnusable(f) && task.extract!.isCorrect(f.field, f.value, label)) noHuman++;
    if (f.review ? task.extract!.isCorrect(f.field, f.finalValue, label) : !isUnusable(f) && task.extract!.isCorrect(f.field, f.value, label)) withHuman++;
  }
  if (of) s.accuracy = { noHuman: noHuman / of, withHuman: withHuman / of, correctNoHuman: noHuman, correctWithHuman: withHuman, of };
  return s;
}

/** "12 of 78 flagged fields reviewed, 66 to review · 3 values changed · field accuracy, no human 94.2% → with a human 94.5%" */
export function fieldReviewLine(r: FieldReviewSummary): string | null {
  if (!r.flagged && !r.reviewed && !r.reviewedOther) return null;
  const n = (x: number) => x.toLocaleString('en-US');
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  const parts = [`${n(r.reviewed)} of ${n(r.flagged)} flagged fields reviewed, ${n(r.remaining)} to review`];
  if (r.reviewedOther) parts.push(`${n(r.reviewedOther)} other field${r.reviewedOther === 1 ? '' : 's'} reviewed`);
  if (r.reviewed || r.reviewedOther) parts.push(`${n(r.overridden)} value${r.overridden === 1 ? '' : 's'} changed`);
  if (r.accuracy?.of) parts.push(`field accuracy, no human ${pct(r.accuracy.noHuman)} → with a human ${pct(r.accuracy.withHuman)}`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------- a whole run, from disk

export interface FieldReport {
  manifest: RunManifest;
  task: TaskDefinition;
  records: RowRecord[];
  st: RunState;
  thresholds: Thresholds;
  outcomes: FieldOutcome[];
  overrides: OverrideRecord[];
  folded: FoldedField[];
  summary: FieldReviewSummary;
}

/** The ledger as the readers use it: parsed without opening a Ledger (which would repair a torn tail a live run may be writing). */
export function readRunState(dir: string): RunState {
  const path = join(dir, 'ledger.jsonl');
  return replay(existsSync(path) ? parseLedger(readFileSync(path, 'utf8'), path) : []);
}

export function labelReader(manifest: Pick<RunManifest, 'labelColumn'>, records: readonly RowRecord[]): (rowId: string) => string | undefined {
  const byId = new Map(records.map((r) => [r.id, r]));
  return (rowId) => (manifest.labelColumn ? byId.get(rowId)?.data[manifest.labelColumn] : undefined);
}

/** Everything `report` and the output files need for an extraction run. Calls no model. */
export async function loadFieldReport(dir: string): Promise<FieldReport> {
  const { manifest, records } = loadRun(dir);
  const task = await loadTask(manifest.taskPath);
  if (!task.extract) throw new Error(`${manifest.runId} is not an extraction run`);
  const st = readRunState(dir);
  const thresholds = effectiveThresholds(dir, manifest);
  const outcomes = computeFieldOutcomes(st, { task, rows: records, thresholds, mode: manifest.mode });
  const overrides = readOverrides(dir);
  const folded = foldFieldOverrides(outcomes, overrides);
  return { manifest, task, records, st, thresholds, outcomes, overrides, folded, summary: fieldReviewSummary(folded, task, labelReader(manifest, records)) };
}

export const FIELD_OUTPUT_COLUMNS = [...FIELD_CSV_COLUMNS, 'reviewed_by_human', 'final_value', 'review_note'] as const;

/** `report --write` and the UI's "Write output files" for an extraction run: enriched-fields.csv with the reviewer's decisions. */
export function writeFieldOutputs(dir: string, report: Pick<FieldReport, 'outcomes' | 'folded' | 'records'>): void {
  const base = fieldCsvRecords(report.outcomes, report.records);
  const rows = base.map((r, i) => {
    const f = report.folded[i]!;
    return {
      ...r,
      reviewed_by_human: f.review ? (f.review.action === 'accept' ? 'accepted' : 'overridden') : '',
      final_value: escapeCell(f.finalValue ?? ''),
      review_note: escapeCell(f.review?.note ?? ''),
    };
  });
  writeFileSync(join(dir, 'enriched-fields.csv'), stringify(rows, { header: true, columns: [...FIELD_OUTPUT_COLUMNS] }));
}

/** `twopass report --write` for an extraction run. */
export async function rewriteFieldOutputs(dir: string): Promise<FieldReport> {
  const report = await loadFieldReport(dir);
  writeFieldOutputs(dir, report);
  return report;
}
