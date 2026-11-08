import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'csv-stringify/sync';
import { parseLedger, replay, type RunState } from './ledger.ts';
import { foldOverrides, readOverrides, type FoldedOutcome, type OverrideRecord } from './overrides.ts';
import { computeOutcomes, type RowOutcome } from './pipeline.ts';
import { loadRun, type RunManifest } from './run.ts';
import { median } from './stats.ts';
import { loadTask } from './task.ts';

/**
 * `answer` is always the pipeline's answer; `final_answer` is the reviewer's when there is one.
 * `status` is "reviewed" for rows a person decided (see overrides.ts).
 */
export const OUTPUT_COLUMNS = [
  'answer',
  'confidence',
  'verdict',
  'model',
  'round',
  'cost_usd',
  'status',
  'reviewed_by_human',
  'final_answer',
  'review_note',
] as const;

export interface Summary {
  rows: number;
  accepted: number;
  acceptedRound0: number;
  rerun: number;
  flagged: number;
  pending: number;
  spentUsd: number;
  minutes: number;
  /** Only when a label column is given. Rows the pipeline accepted; reviewed rows don't change it. */
  precision?: { correct: number; of: number };
  rounds: RoundTiming[];
  review: ReviewSummary;
}

export interface ReviewSummary {
  /** Rows the pipeline flagged (whether or not a person has looked at them since). */
  flagged: number;
  /** Flagged rows with a human decision. */
  reviewed: number;
  /** Flagged rows still without one. */
  remaining: number;
  /** Rows the pipeline did not flag that a person decided anyway. */
  reviewedOther: number;
  /** Decisions that changed the answer (any row). */
  overridden: number;
  /** Only when a label column is given; over rows that have a label. */
  accuracy?: Accuracy;
}

export interface Accuracy {
  /** The pipeline's answer for every row, flagged rows included (the bench's "accuracy, no human"). */
  noHuman: number;
  /** Same, with a reviewer's answer replacing the pipeline's where there is one. */
  withHuman: number;
  correctNoHuman: number;
  correctWithHuman: number;
  of: number;
}

export interface RoundTiming {
  round: 1 | 2;
  batches: number;
  medianMinutes: number;
  worstMinutes: number;
}

export function summarize(outcomes: RowOutcome[], st: RunState, labelColumn?: string, overrides: readonly OverrideRecord[] = []): Summary {
  const accepted = outcomes.filter((o) => o.status === 'accepted');
  const summary: Summary = {
    rows: outcomes.length,
    accepted: accepted.length,
    acceptedRound0: accepted.filter((o) => o.round === 0).length,
    rerun: outcomes.filter((o) => o.round === 2).length,
    flagged: outcomes.filter((o) => o.status === 'flagged').length,
    pending: outcomes.filter((o) => o.status === 'pending').length,
    spentUsd: st.spentUsd,
    minutes: st.firstAt && st.lastAt ? (Date.parse(st.lastAt) - Date.parse(st.firstAt)) / 60_000 : 0,
    rounds: roundTimings(st),
    review: reviewSummary(foldOverrides(outcomes, overrides), labelColumn),
  };
  if (labelColumn) {
    const correct = accepted.filter((o) => matchesLabel(o.answer, o.data[labelColumn])).length;
    summary.precision = { correct, of: accepted.length };
  }
  return summary;
}

const norm = (s: string) => s.trim().toLowerCase();
export const matchesLabel = (answer: string, label: string | undefined): boolean => !!label?.trim() && norm(answer) === norm(label);

/** Review progress and, with labels, accuracy without and with the reviewer's answers. Pure. */
export function reviewSummary(folded: readonly FoldedOutcome[], labelColumn?: string): ReviewSummary {
  const s: ReviewSummary = { flagged: 0, reviewed: 0, remaining: 0, reviewedOther: 0, overridden: 0 };
  for (const o of folded) {
    if (o.pipelineStatus === 'flagged') {
      s.flagged++;
      if (o.review) s.reviewed++;
      else s.remaining++;
    } else if (o.review) s.reviewedOther++;
    if (o.review && o.review.answer !== o.review.previous) s.overridden++;
  }
  if (labelColumn) {
    const labeled = folded.filter((o) => o.data[labelColumn]?.trim());
    const correctNoHuman = labeled.filter((o) => matchesLabel(o.answer, o.data[labelColumn])).length;
    const correctWithHuman = labeled.filter((o) => matchesLabel(o.finalAnswer, o.data[labelColumn])).length;
    const of = labeled.length;
    s.accuracy = {
      noHuman: of ? correctNoHuman / of : 0,
      withHuman: of ? correctWithHuman / of : 0,
      correctNoHuman,
      correctWithHuman,
      of,
    };
  }
  return s;
}

/** "12 of 78 flagged rows reviewed, 66 to review · 3 answers changed · accuracy, no human 94.2% → with a human 94.5%" */
export function reviewLine(r: ReviewSummary): string | null {
  if (!r.flagged && !r.reviewed && !r.reviewedOther) return null;
  const n = (x: number) => x.toLocaleString('en-US');
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  const parts = [`${n(r.reviewed)} of ${n(r.flagged)} flagged rows reviewed, ${n(r.remaining)} to review`];
  if (r.reviewedOther) parts.push(`${n(r.reviewedOther)} other row${r.reviewedOther === 1 ? '' : 's'} reviewed`);
  if (r.reviewed || r.reviewedOther) parts.push(`${n(r.overridden)} answer${r.overridden === 1 ? '' : 's'} changed`);
  if (r.accuracy?.of) parts.push(`accuracy, no human ${pct(r.accuracy.noHuman)} → with a human ${pct(r.accuracy.withHuman)}`);
  return parts.join(' · ');
}

function roundTimings(st: RunState): RoundTiming[] {
  return ([1, 2] as const).flatMap((round) => {
    const mins = [...st.batches.values()]
      .filter((b) => b.round === round && b.finishedAt)
      .map((b) => (Date.parse(b.finishedAt!) - Date.parse(b.at)) / 60_000)
      .sort((a, b) => a - b);
    if (!mins.length) return [];
    return [{ round, batches: mins.length, medianMinutes: median(mins), worstMinutes: mins[mins.length - 1]! }];
  });
}


/** e.g. "3,080 rows · 2,710 auto-accepted at 97% precision · 312 re-run · 58 need a look · $1.94 · 41 min" */
export function summaryLine(s: Summary): string {
  const n = (x: number) => x.toLocaleString('en-US');
  const precision = s.precision?.of ? ` at ${Math.round((100 * s.precision.correct) / s.precision.of)}% precision` : '';
  const parts = [
    `${n(s.rows)} rows`,
    `${n(s.accepted)} auto-accepted${precision}`,
    `${n(s.rerun)} re-run`,
    `${n(s.flagged)} need a look`,
    ...(s.pending ? [`${n(s.pending)} pending`] : []),
    `$${s.spentUsd.toFixed(2)}`,
    `${Math.round(s.minutes)} min`,
  ];
  return parts.join(' · ');
}

/**
 * OWASP CSV-injection guidance: a cell starting with =, +, @, tab or CR, or a "-" that does not
 * start a number, gets a leading apostrophe so spreadsheets show it as text. "-12.5" is unchanged.
 */
export const isFormulaLike = (v: string): boolean => /^(?:[=+@\t\r]|-(?=\D))/.test(v);

export const escapeCell = (v: string): string => (isFormulaLike(v) ? `'${v}` : v);

const escapeRecord = (r: Record<string, string>) =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, escapeCell(v)]));

/** Outcomes without review data count as unreviewed (e.g. straight from computeOutcomes). */
const asFolded = (o: RowOutcome | FoldedOutcome): FoldedOutcome =>
  'pipelineStatus' in o ? o : { ...o, pipelineStatus: o.status, finalAnswer: o.answer, review: null };

export function writeOutputs(runDir: string, outcomes: ReadonlyArray<RowOutcome | FoldedOutcome>, inputColumns: string[]): void {
  const columns = [...inputColumns.filter((c) => !(OUTPUT_COLUMNS as readonly string[]).includes(c)), ...OUTPUT_COLUMNS];
  const folded = outcomes.map(asFolded);
  const toRecord = (o: FoldedOutcome) => escapeRecord({
    ...o.data,
    answer: o.answer,
    confidence: o.confidence === null ? '' : o.confidence.toFixed(4),
    verdict: o.verdict,
    model: o.model,
    round: o.pipelineStatus === 'pending' ? '' : String(o.round),
    cost_usd: o.costUsd.toFixed(6),
    status: o.status,
    reviewed_by_human: o.review ? (o.review.action === 'accept' ? 'accepted' : 'overridden') : '',
    final_answer: o.finalAnswer,
    review_note: o.review?.note ?? '',
  } as Record<string, string>);
  writeFileSync(join(runDir, 'enriched.csv'), stringify(folded.map(toRecord), { header: true, columns }));
  // Only rows that still need a person: flagged by the pipeline and not reviewed yet.
  writeFileSync(
    join(runDir, 'review.csv'),
    stringify(folded.filter((o) => o.status === 'flagged').map(toRecord), { header: true, columns }),
  );
}

export interface RunReport {
  manifest: RunManifest;
  st: RunState;
  outcomes: RowOutcome[];
  overrides: OverrideRecord[];
  folded: FoldedOutcome[];
}

/** Everything `report` needs, from the ledger plus overrides.jsonl. Calls no model. */
export async function loadReport(dir: string): Promise<RunReport> {
  const { manifest, records } = loadRun(dir);
  const task = await loadTask(manifest.taskPath);
  // Read only: opening a Ledger would repair (truncate) a torn tail, which a live run may be writing.
  const ledgerPath = join(dir, 'ledger.jsonl');
  const st = replay(existsSync(ledgerPath) ? parseLedger(readFileSync(ledgerPath, 'utf8'), ledgerPath) : []);
  const outcomes = computeOutcomes(st, { task, rows: records, thresholds: manifest.thresholds, mode: manifest.mode });
  const overrides = readOverrides(dir);
  return { manifest, st, outcomes, overrides, folded: foldOverrides(outcomes, overrides) };
}

/** `twopass report --write` and the UI's "Write output files": rewrites enriched.csv and review.csv. */
export async function rewriteOutputs(dir: string): Promise<RunReport> {
  const report = await loadReport(dir);
  writeOutputs(dir, report.folded, report.manifest.inputColumns);
  return report;
}
