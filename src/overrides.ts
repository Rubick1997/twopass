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
  /** Extraction runs: the field this undoes. Absent for closed-choice and open-ended tasks. */
  field?: string;
}

/**
 * Extraction runs: a decision about one field of one document. `answer` and `previous` are the field's value, where
 * null means "this document does not state it". Folded per (rowId, field); classify runs never have these.
 */
export interface FieldDecision {
  rowId: string;
  field: string;
  action: ReviewAction;
  answer: string | null;
  previous: string | null;
  note?: string;
  at: string;
  pipelineStatus?: RowStatus;
}

export type OverrideRecord = ReviewDecision | FieldDecision | ClearRecord;

const rowId = z.string().min(1).max(500);
const at = z.string().min(1);
const fieldName = z.string().min(1).max(200);
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

/**
 * Body of POST /api/runs/:id/overrides. Unknown keys are refused. `field` is for extraction runs (required there,
 * refused for other runs: checked against the task), and only then may `answer` be null ("not in this document").
 */
export const decisionInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ rowId, field: fieldName.optional(), action: z.literal('accept'), note: z.string().max(MAX_NOTE_CHARS).optional() }),
  z.strictObject({
    rowId,
    field: fieldName.optional(),
    action: z.literal('override'),
    answer: z.string().max(MAX_ANSWER_CHARS).nullable(),
    note: z.string().max(MAX_NOTE_CHARS).optional(),
  }),
  z.strictObject({ rowId, field: fieldName.optional(), action: z.literal('clear') }),
]);
export type DecisionInput = z.infer<typeof decisionInputSchema>;

export const overridesPath = (runDir: string): string => join(runDir, OVERRIDES_FILE);

/** Every record in the file, in order; [] when there is none. A torn last line is skipped. */
export function readOverrides(runDir: string): OverrideRecord[] {
  const path = overridesPath(runDir);
  if (!existsSync(path)) return [];
  return parseOverrides(readFileSync(path, 'utf8'), path);
}

const fieldRecordSchema = z.discriminatedUnion('action', [
  z.object({
    rowId,
    field: fieldName,
    action: z.enum(['accept', 'override']),
    answer: z.string().nullable(),
    previous: z.string().nullable(),
    note: z.string().optional(),
    at,
    pipelineStatus: z.enum(['accepted', 'flagged', 'pending']).optional(),
  }),
  z.object({ rowId, field: fieldName, action: z.literal('clear'), at }),
]);

export function parseOverrides(text: string, source = OVERRIDES_FILE): OverrideRecord[] {
  return parseJsonLines(text, source).map((value, i) => {
    const isField = typeof value === 'object' && value !== null && 'field' in value;
    const r = (isField ? fieldRecordSchema : recordSchema).safeParse(value);
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
    if ('field' in r && r.field !== undefined) continue; // field decisions belong to extraction runs (activeFieldDecisions)
    if (r.action === 'clear') active.delete(r.rowId);
    else active.set(r.rowId, r as ReviewDecision);
  }
  return active;
}

export const fieldKey = (rowId: string, field: string): string => `${rowId}\u0000${field}`;

/** (rowId, field) → its current decision. The last line wins; "clear" removes the decision. Records without a field are ignored. */
export function activeFieldDecisions(records: readonly OverrideRecord[]): Map<string, FieldDecision> {
  const active = new Map<string, FieldDecision>();
  for (const r of records) {
    if (!('field' in r) || r.field === undefined) continue;
    const key = fieldKey(r.rowId, r.field);
    if (r.action === 'clear') active.delete(key);
    else active.set(key, r as FieldDecision);
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
  if (task.extract) throw new OverrideError('invalid', 'This is an extraction run: decisions are per field');
  if (input.field !== undefined) throw new OverrideError('invalid', 'field is only for extraction runs');
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
    if (input.answer === null) throw new OverrideError('invalid', 'The answer cannot be null for this task');
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

/** What `makeFieldOverride` needs to know about the field slot's pipeline outcome. */
export interface FieldPipelineState {
  status: 'accepted' | 'flagged' | 'pending';
  value: string | null;
  /** The writer gave no usable reply, so `value` is a placeholder and cannot be accepted. */
  unusable: boolean;
}

/**
 * Extraction runs: turns a reviewer's request into the line to append. `state` is the slot's pipeline outcome
 * (undefined when the run has no such document). The field must be one of the task's fields. An override is a
 * non-empty text up to MAX_ANSWER_CHARS, or null for "not in this document".
 */
export function makeFieldOverride(input: DecisionInput, state: FieldPipelineState | undefined, task: TaskDefinition, now = new Date()): OverrideRecord {
  const ex = task.extract;
  if (!ex) throw new OverrideError('invalid', 'field is only for extraction runs');
  if (input.field === undefined) throw new OverrideError('invalid', `This is an extraction run: say which field (one of ${ex.fields.join(', ')})`);
  if (!ex.fields.includes(input.field)) throw new OverrideError('invalid', `"${input.field.slice(0, 80)}" is not a field of this task (${ex.fields.join(', ')})`);
  if (!state) throw new OverrideError('unknown_row', `This run has no document "${input.rowId.slice(0, 80)}"`);
  const stamp = now.toISOString();
  if (input.action === 'clear') return { rowId: input.rowId, field: input.field, action: 'clear', at: stamp };

  const note = input.note?.trim();
  let answer: string | null;
  if (input.action === 'accept') {
    if (state.status === 'pending' || state.unusable) throw new OverrideError('invalid', 'The pipeline has no value for this field to accept; override it instead');
    answer = state.value;
  } else if (input.answer === null) {
    answer = null;
  } else {
    answer = input.answer.trim();
    if (!answer) throw new OverrideError('invalid', 'The answer is empty; use null for "not in this document"');
    if (answer.length > MAX_ANSWER_CHARS) throw new OverrideError('invalid', `The answer is longer than ${MAX_ANSWER_CHARS} characters`);
  }
  return {
    rowId: input.rowId,
    field: input.field,
    action: input.action,
    answer,
    previous: state.value,
    ...(note ? { note } : {}),
    at: stamp,
    pipelineStatus: state.status,
  };
}
