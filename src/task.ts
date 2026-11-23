import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { z } from 'zod';
import { isAnthropicDirect } from './batch/anthropic.ts';
import { NEVER } from './calibrate.ts';
import { assertHasCannotTell, CANNOT_TELL, type ChoiceQuestion, type DecisionState } from './decide/model.ts';

export type Row = Record<string, string>;

export interface Thresholds {
  /** Round 0: accept the triage answer when its probability is at least t0. */
  t0: number;
  /** Round 1: accept the writer's answer when p(supported) is at least t1. */
  t1: number;
  /** Round 2: same, for the escalation model's answer. */
  t2: number;
}

export interface TaskDefinition {
  name: string;
  /** Column holding a stable row id. Defaults to the row's position. */
  idColumn?: string;
  /**
   * Columns the task reads besides `{{placeholders}}` in the writer templates (e.g. ones only
   * `state` uses). `twopass check` refuses a CSV that lacks any of them.
   */
  inputColumns?: string[];
  /** What the decision model reads about an input row. */
  state: (row: Row) => DecisionState;
  /**
   * Round 0, for closed-choice tasks only: if the decision model can pick the answer itself
   * with enough confidence, no writer call is made. The chosen option is the answer.
   */
  triage?: { question: ChoiceQuestion };
  writer: {
    system?: string;
    /** `{{column}}` placeholders are filled from the row. */
    promptTemplate: string;
    /** Visible answer budget. With reasoning off, a short label needs ~20. */
    maxTokens: number;
    /**
     * OpenRouter `reasoning` setting. Models that think spend max_tokens on hidden reasoning
     * and can return no answer at all (first live run: 32 of 75 Haiku rows), so set it explicitly.
     */
    reasoning?: Record<string, unknown>;
    /**
     * Mark `system` as a cacheable prefix (Anthropic via OpenRouter). `'1h'` suits batches, which can run
     * longer than the 5-minute default. Ignored by providers that cache automatically.
     */
    cacheSystem?: '5m' | '1h';
    /** Round 2 overrides. `template` also gets `{{previous_answer}}`. */
    escalation?: { template?: string; maxTokens?: number; reasoning?: Record<string, unknown> };
    /**
     * OpenRouter `response_format`, e.g. a JSON schema with an enum of allowed answers. Without it,
     * Sonnet 5.5 explained itself in 46 of 65 answers; with it, the reply is always parseable.
     */
    responseFormat?: Record<string, unknown>;
    /** When the reply is a JSON object, the field that holds the answer. */
    answerField?: string;
    outputSchema: z.ZodType;
  };
  verify: {
    instructions: string;
    criteria?: { supported: string; unsupported: string; cannot_tell?: string };
    /** Defaults to { input: state(row), proposed_answer }. */
    state?: (row: Row, answer: string) => DecisionState;
  };
  /**
   * Extraction tasks: one document per row, several fields per document. The writer's reply is a JSON object
   * (see `parseExtraction`); the decision model gets one call per document with one question per field.
   * Not combinable with `triage`.
   */
  extract?: {
    /** Field names, in output order. The writer's reply is a JSON object with exactly these keys, each string | null. */
    fields: readonly string[];
    /** The checker's question about one field: a proposed value, or null = "the writer says the document has no such field". Must include cannot_tell. */
    question: (field: string, value: string | null) => ChoiceQuestion;
    /** Scoring against the label column (labeled runs only). `label` is the row's label cell. */
    isCorrect: (field: string, value: string | null, label: string) => boolean;
  };
  /** `decision` is the default for both triage and verify; either can be set separately. */
  models: { writer: string; escalation: string; decision: string; triage?: string; verify?: string };
  /** Must come from `twopass calibrate` on a held-out split, never from vendor defaults. */
  thresholds?: Thresholds;
}

export function defineTask(task: TaskDefinition): TaskDefinition {
  validateTask(task);
  return task;
}

export function validateTask(task: TaskDefinition): void {
  if (task.triage) assertHasCannotTell({ triage: task.triage.question });
  if (task.extract) {
    if (task.triage) throw new Error(`Task "${task.name}": an extract task cannot have triage.`);
    if (!task.extract.fields.length) throw new Error(`Task "${task.name}": extract.fields is empty.`);
    for (const f of task.extract.fields) {
      assertHasCannotTell({ [`${f} (value)`]: task.extract.question(f, 'x'), [`${f} (null)`]: task.extract.question(f, null) });
    }
  }
  const batchModel = (id: string) => id.endsWith(':batch') || isAnthropicDirect(id);
  if (!batchModel(task.models.writer) || !batchModel(task.models.escalation)) {
    throw new Error(`Task "${task.name}": writer and escalation models must be ":batch" OpenRouter IDs or Anthropic model IDs such as "claude-haiku-5-5".`);
  }
  if (task.thresholds) validateThresholds(task.thresholds);
}

export function validateThresholds(t: Thresholds): void {
  for (const [k, v] of Object.entries(t)) {
    // NEVER (1.01) is allowed: calibration found no threshold that reaches the precision target.
    if (typeof v !== 'number' || !(v >= 0 && (v <= 1 || v === NEVER))) {
      throw new Error(`Threshold ${k} must be between 0 and 1 (or ${NEVER} for "never accept"), got ${v}`);
    }
  }
}

export function verifyQuestion(task: TaskDefinition): ChoiceQuestion {
  const c = task.verify.criteria;
  return {
    type: 'choice',
    instructions: task.verify.instructions,
    criteria: {
      supported: c?.supported ?? 'The proposed answer is correct for this input.',
      unsupported: c?.unsupported ?? 'The proposed answer is wrong for this input.',
      [CANNOT_TELL]: c?.cannot_tell ?? 'It is not possible to tell from the input whether the answer is correct.',
    },
  };
}

export function verifyState(task: TaskDefinition, row: Row, answer: string): DecisionState {
  return task.verify.state ? task.verify.state(row, answer) : { input: task.state(row), proposed_answer: answer };
}

/** Parses a writer reply using the task's answerField and outputSchema. */
export const parseWriterOutput = (task: TaskDefinition, text: string): ParsedOutput =>
  parseOutput(task.writer.outputSchema, text, task.writer.answerField);

export type ParsedExtraction = { ok: true; values: Record<string, string | null> } | { ok: false; error: string };

/**
 * Parses an extraction reply: a JSON object with every field of `task.extract.fields`. A value that is empty
 * or only whitespace counts as null ("not in the document"). Built on `parseWriterOutput`.
 */
export function parseExtraction(task: TaskDefinition, text: string): ParsedExtraction {
  const ex = task.extract;
  if (!ex) throw new Error(`Task "${task.name}" has no extract block.`);
  const parsed = parseWriterOutput(task, text);
  if (!parsed.ok) return parsed;
  let obj: unknown;
  try {
    obj = JSON.parse(parsed.value);
  } catch {
    return { ok: false, error: 'reply is not a JSON object' };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'reply is not a JSON object' };
  const values: Record<string, string | null> = {};
  for (const f of ex.fields) {
    const v = (obj as Record<string, unknown>)[f];
    if (v === undefined) return { ok: false, error: `reply has no "${f}"` };
    if (v !== null && typeof v !== 'string') return { ok: false, error: `"${f}" is not a string or null` };
    values[f] = v === null || v.trim() === '' ? null : v;
  }
  return { ok: true, values };
}

export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`Template uses {{${name}}}, but the row has no such column.`);
    return value;
  });
}

export type ParsedOutput = { ok: true; value: string } | { ok: false; error: string };

/** Checks writer text against the task's output schema. Objects come back as JSON strings. */
export function parseOutput(schema: z.ZodType, text: string, answerField?: string): ParsedOutput {
  if (answerField) {
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      return { ok: false, error: 'reply is not JSON' };
    }
    if (!obj || typeof obj !== 'object' || !(answerField in obj)) return { ok: false, error: `reply has no "${answerField}"` };
    const value = (obj as Record<string, unknown>)[answerField];
    text = typeof value === 'string' ? value : JSON.stringify(value);
  }
  const trimmed = text.trim().replace(/^(["'`])(.*)\1$/s, '$2').trim();
  let result = schema.safeParse(trimmed);
  if (!result.success && /^[[{]/.test(trimmed)) {
    try {
      result = schema.safeParse(JSON.parse(trimmed));
    } catch {
      // keep the first error
    }
  }
  if (!result.success) return { ok: false, error: result.error.issues[0]?.message ?? 'invalid output' };
  const v = result.data;
  return { ok: true, value: typeof v === 'string' ? v : JSON.stringify(v) };
}

export async function loadTask(path: string): Promise<TaskDefinition> {
  // An eval-gate task config (`*.task.yaml`) builds the same TaskDefinition; see src/gate/task-config.ts.
  if (/\.ya?ml$/i.test(path)) {
    const { loadGateConfig, taskFromConfig } = await import('./gate/task-config.ts');
    const task = await taskFromConfig(loadGateConfig(path));
    validateTask(task);
    return task;
  }
  const mod = (await import(pathToFileURL(resolve(path)).href)) as { default?: TaskDefinition };
  if (!mod.default) throw new Error(`${path} has no default export. Export the result of defineTask(...).`);
  validateTask(mod.default);
  return mod.default;
}
