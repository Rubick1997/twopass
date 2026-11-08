import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { enumOptions } from './check.ts';
import { parseJsonLines, repairTornTail } from './ledger.ts';
import type { RowOutcome, RowStatus } from './pipeline.ts';
import type { TaskDefinition } from './task.ts';

// runs/<id>/overrides.jsonl: what a person decided about rows, one JSON line per decision.
//
// - Append-only, like the ledger. The last line for a row wins; undo appends {action: "clear"}.
// - Never part of the ledger, and the pipeline never reads it: computeOutcomes stays pure and
//   `resume` behaves exactly as if the file did not exist. Overrides are folded in on top of the
//   pipeline's outcomes (foldOverrides) for reports, output files and the UI.
// - A reviewed row gets its own status, "reviewed", so a human's answer is never counted as one the
//   pipeline accepted.

export const OVERRIDES_FILE = 'overrides.jsonl';
/** Longest answer a person can type for an open-ended task. */
export const MAX_ANSWER_CHARS = 2000;
export const MAX_NOTE_CHARS = 1000;

export type ReviewAction = 'accept' | 'override';

export interface ReviewDecision {
  rowId: string;
  /** accept: the pipeline's answer is right. override: `answer` replaces it. */
  action: ReviewAction;
  /** The final answer. For accept, the same as `previous`. */
  answer: string;
  /** The pipeline's answer when the decision was made. */
  previous: string;
  note?: string;
  at: string;
  /** The pipeline's status when the decision was made: anything but "flagged" means the reviewer went beyond the queue. */
  pipelineStatus?: RowStatus;
}

export interface ClearRecord {
  rowId: string;
  action: 'clear';
  at: string;
}

export type OverrideRecord = ReviewDecision | ClearRecord;

const rowId = z.string().min(1).max(500);
const at = z.string().min(1);
const recordSchema = z.discriminatedUnion('action', [
  z.object({
    rowId,
    action: z.enum(['accept', 'override']),
    answer: z.string(),
    previous: z.string(),
    note: z.string().optional(),
    at,
    pipelineStatus: z.enum(['accepted', 'flagged', 'pending']).optional(),
  }),
  z.object({ rowId, action: z.literal('clear'), at }),
]);

/** Body of POST /api/runs/:id/overrides. Unknown keys are refused. */
export const decisionInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ rowId, action: z.literal('accept'), note: z.string().max(MAX_NOTE_CHARS).optional() }),
  z.strictObject({
    rowId,
    action: z.literal('override'),
    answer: z.string().max(MAX_ANSWER_CHARS),
    note: z.string().max(MAX_NOTE_CHARS).optional(),
  }),
  z.strictObject({ rowId, action: z.literal('clear') }),
]);
export type DecisionInput = z.infer<typeof decisionInputSchema>;

export const overridesPath = (runDir: string): string => join(runDir, OVERRIDES_FILE);

/** Every record in the file, in order; [] when there is none. A torn last line is skipped. */
export function readOverrides(runDir: string): OverrideRecord[] {
  const path = overridesPath(runDir);
  if (!existsSync(path)) return [];
  return parseOverrides(readFileSync(path, 'utf8'), path);
}

export function parseOverrides(text: string, source = OVERRIDES_FILE): OverrideRecord[] {
  return parseJsonLines(text, source).map((value, i) => {
    const r = recordSchema.safeParse(value);
    if (!r.success) throw new Error(`${source}: entry ${i + 1} is not a valid override (${r.error.issues[0]?.message ?? 'invalid'})`);
    return r.data as OverrideRecord;
  });
}

/** Synchronous, like Ledger.append: once it returns, the decision survives a kill. */
export function appendOverride(runDir: string, record: OverrideRecord): void {
  const path = overridesPath(runDir);
  if (existsSync(path)) repairTornTail(path);
  appendFileSync(path, JSON.stringify(record) + '\n');
}

/** rowId → its current decision. The last line wins; "clear" removes the row's decision. */
export function activeDecisions(records: readonly OverrideRecord[]): Map<string, ReviewDecision> {
  const active = new Map<string, ReviewDecision>();
  for (const r of records) {
    if (r.action === 'clear') active.delete(r.rowId);
    else active.set(r.rowId, r);
  }
  return active;
}

export type FinalStatus = RowStatus | 'reviewed';

export interface FoldedOutcome extends Omit<RowOutcome, 'status'> {
  /** "reviewed" when a person decided; otherwise the pipeline's status. */
  status: FinalStatus;
  pipelineStatus: RowStatus;
  /** The reviewer's answer when there is one, otherwise the pipeline's `answer` (which is kept unchanged). */
  finalAnswer: string;
  review: ReviewDecision | null;
}

/**
 * Applies the reviewer's decisions on top of the pipeline's outcomes. Pure: the inputs are not
 * changed. Decisions for rows the run does not have are ignored.
 */
export function foldOverrides(outcomes: readonly RowOutcome[], records: readonly OverrideRecord[]): FoldedOutcome[] {
  const active = activeDecisions(records);
  return outcomes.map((o) => {
    const review = active.get(o.rowId) ?? null;
    return {
      ...o,
      status: review ? 'reviewed' : o.status,
      pipelineStatus: o.status,
      finalAnswer: review ? review.answer : o.answer,
      review,
    };
  });
}

/** The allowed answers of a closed-choice task (the output schema's enum, as `check` reads it); null for open-ended tasks. */
export function allowedAnswers(task: TaskDefinition): string[] | null {
  return enumOptions(task.writer.outputSchema) ?? null;
}

export class OverrideError extends Error {
  readonly code: 'unknown_row' | 'invalid';
  constructor(code: 'unknown_row' | 'invalid', message: string) {
    super(message);
    this.code = code;
    this.name = 'OverrideError';
  }
}

/** Checks a reviewer's answer against the task: one of the labels, or non-empty text up to MAX_ANSWER_CHARS. */
export function validateAnswer(task: TaskDefinition, answer: string): string {
  const labels = allowedAnswers(task);
  if (labels) {
    if (!labels.includes(answer)) throw new OverrideError('invalid', `"${answer.slice(0, 80)}" is not one of the task's labels`);
    return answer;
  }
  const text = answer.trim();
  if (!text) throw new OverrideError('invalid', 'The answer is empty');
  if (text.length > MAX_ANSWER_CHARS) throw new OverrideError('invalid', `The answer is longer than ${MAX_ANSWER_CHARS} characters`);
  return text;
}

/**
 * Turns a reviewer's request into the line to append. `outcome` is the row's pipeline outcome
 * (undefined when the run has no such row). Accept needs a valid pipeline answer to accept.
 */
export function makeOverride(input: DecisionInput, outcome: RowOutcome | undefined, task: TaskDefinition, now = new Date()): OverrideRecord {
  if (!outcome) throw new OverrideError('unknown_row', `This run has no row "${input.rowId.slice(0, 80)}"`);
  const stamp = now.toISOString();
  if (input.action === 'clear') return { rowId: outcome.rowId, action: 'clear', at: stamp };

  const note = input.note?.trim();
  let answer: string;
  if (input.action === 'accept') {
    if (!outcome.answer) throw new OverrideError('invalid', 'The pipeline has no answer for this row to accept; override it instead');
    try {
      answer = validateAnswer(task, outcome.answer);
    } catch {
      throw new OverrideError('invalid', "The pipeline's answer is not a valid answer for this task; override it instead");
    }
  } else {
    answer = validateAnswer(task, input.answer);
  }
  return {
    rowId: outcome.rowId,
    action: input.action,
    answer,
    previous: outcome.answer,
    ...(note ? { note } : {}),
    at: stamp,
    pipelineStatus: outcome.status,
  };
}
