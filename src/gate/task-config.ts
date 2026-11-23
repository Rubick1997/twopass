import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { isAnthropicDirect } from '../batch/anthropic.ts';
import { resolveRoute, toOpenRouterId, type ModelRoute, type Provider } from '../batch/route.ts';
import { NEVER } from '../calibrate.ts';
import { enumOptions } from '../check.ts';
import { CANNOT_TELL } from '../decide/model.ts';
import { defineTask, validateThresholds, type TaskDefinition, type Thresholds } from '../task.ts';
import { readCsvRows } from './data.ts';

// `<name>.task.yaml`: the eval gate's task config. One file per gated task; TwoPass's own gate
// (gates/banking77.task.yaml) and a reader's gate go through the same loader and the same `gate run`.
// Paths in the file are relative to the current directory (the repo root in CI).

const nonEmpty = z.string().trim().min(1);
const labelEntry = z.union([nonEmpty, z.strictObject({ name: nonEmpty, description: z.string().optional() })]);

export const gateConfigSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9_.-]+$/, 'letters, digits, ".", "_" and "-" only'),
  type: z.literal('classification'),
  data: nonEmpty,
  columns: z.strictObject({ id: nonEmpty.optional(), text: nonEmpty, label: nonEmpty }),
  /** `auto`: every distinct value of the label column. Or a list (names, or {name, description}), or a YAML/JSON file of that list. */
  labels: z.union([z.literal('auto'), z.array(labelEntry).min(2), z.strictObject({ file: nonEmpty })]).default('auto'),
  promise: z.strictObject({ acceptedPrecision: z.number().gt(0).lt(1) }),
  slice: z.strictObject({
    file: nonEmpty,
    perLabel: z.number().int().positive(),
    seed: z.number().int(),
    /** Files of row IDs that must never be in the slice (calibration rows, held-out data). */
    exclude: z.array(nonEmpty).default([]),
  }),
  calibration: z.strictObject({
    /** JSON list of calibration row IDs (drawn from `data`, never from the slice). */
    rows: nonEmpty,
    /** Calibration points per checker, written by `twopass gate calibrate`. */
    points: nonEmpty,
    checkShare: z.number().gt(0).lt(1).default(0.2),
    seed: z.number().int().default(7),
  }),
  writer: z.strictObject({ model: nonEmpty, escalation: nonEmpty }),
  checker: z.strictObject({
    model: nonEmpty,
    /** A different model for round 0 (picks the label itself). Default: `model`. */
    triage: nonEmpty.optional(),
    /** Fitted thresholds (`twopass gate calibrate`). `gate run` refuses to start without them. */
    thresholds: nonEmpty,
  }),
  provider: z.strictObject({ claude: z.enum(['anthropic', 'openrouter']) }).optional(),
  gate: z
    .strictObject({
      enforce: z.enum(['g1', 'g2', 'g3']).default('g3'),
      maxUsd: z.number().positive().default(1.5),
      /** G2: the head − base accuracy interval's lower bound must stay above −tolerance. */
      g2Tolerance: z.number().min(0).max(1).default(0.01),
    })
    .default({ enforce: 'g3', maxUsd: 1.5, g2Tolerance: 0.01 }),
  noise: nonEmpty,
  /** Reuse a TypeScript task's prompts (writer, triage and verify questions) instead of the generic ones. */
  prompts: z.strictObject({ from: nonEmpty }).optional(),
});

export type GateConfig = z.infer<typeof gateConfigSchema>;

export interface Label {
  name: string;
  description?: string;
}

export interface LoadedGateConfig {
  path: string;
  config: GateConfig;
}

export class GateConfigError extends Error {}

/** Reads and validates a task config. Errors name the field: `slice.perLabel: expected number, received string`. */
export function loadGateConfig(path: string): LoadedGateConfig {
  if (!existsSync(path)) throw new GateConfigError(`Task config not found: ${path}`);
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new GateConfigError(`${path}: not valid YAML (${(err as Error).message.split('\n')[0]})`);
  }
  const parsed = gateConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.length ? i.path.join('.') : '(top level)'}: ${i.message}`);
    throw new GateConfigError(`${path} is not a valid task config:\n${lines.join('\n')}`);
  }
  return { path: resolve(path), config: parsed.data };
}

export const isGateConfigPath = (p: string): boolean => /\.ya?ml$/i.test(p);

/** The labels the task can answer, in a fixed order. */
export function resolveLabels(config: GateConfig): Label[] {
  const norm = (e: z.infer<typeof labelEntry>): Label => (typeof e === 'string' ? { name: e } : e);
  let labels: Label[];
  if (config.labels === 'auto') {
    const seen = new Set<string>();
    for (const row of readCsvRows(config.data)) {
      const v = (row[config.columns.label] ?? '').trim();
      if (v) seen.add(v);
    }
    labels = [...seen].sort().map((name) => ({ name }));
  } else if (Array.isArray(config.labels)) {
    labels = config.labels.map(norm);
  } else {
    const file = config.labels.file;
    const list = z.array(labelEntry).min(2).safeParse(parseYaml(readFileSync(file, 'utf8')));
    if (!list.success) throw new GateConfigError(`labels.file ${file}: expected a list of labels (names or {name, description})`);
    labels = list.data.map(norm);
  }
  if (labels.length < 2) throw new GateConfigError(`labels: found ${labels.length} label(s) in ${config.data}; a classification task needs at least 2`);
  const dup = labels.find((l, i) => labels.findIndex((m) => m.name === l.name) !== i);
  if (dup) throw new GateConfigError(`labels: "${dup.name}" is listed twice`);
  if (labels.some((l) => l.name === CANNOT_TELL)) throw new GateConfigError(`labels: "${CANNOT_TELL}" is reserved`);
  return labels;
}

/** The id column the gate's run CSV carries: the config's, or a hash of the text when the data has none. */
export const ID_COLUMN_FALLBACK = '_twopass_id';
export const idColumnOf = (config: GateConfig): string => config.columns.id ?? ID_COLUMN_FALLBACK;

const human = (label: string) => label.replace(/_/g, ' ');

/** Generic classification prompts for a reader's CSV (the same structure Banking77 uses). */
export function genericTask(config: GateConfig, labels: Label[]): TaskDefinition {
  const text = config.columns.text;
  const names = labels.map((l) => l.name) as [string, ...string[]];
  const listing = labels.map((l) => (l.description ? `${l.name}: ${l.description}` : l.name)).join('\n');
  return defineTask({
    name: config.name,
    idColumn: idColumnOf(config),
    inputColumns: [text],
    state: (row) => row[text] ?? '',
    triage: {
      question: {
        type: 'choice',
        instructions: 'Which label fits this text?',
        criteria: {
          ...Object.fromEntries(labels.map((l) => [l.name, l.description ?? human(l.name)])),
          [CANNOT_TELL]: 'None of these labels fits, or the text is too ambiguous to choose',
        },
      },
    },
    writer: {
      system: `You classify texts. Reply with exactly one label from the list below, written exactly as shown, and nothing else.\n\nLabels:\n${listing}`,
      cacheSystem: '1h',
      promptTemplate: `Text: {{${text}}}`,
      maxTokens: 60,
      reasoning: { enabled: false },
      escalation: {
        template: `Text: {{${text}}}\n\nAn earlier model answered "{{previous_answer}}". It may or may not be right. Reply with the correct label only.`,
        reasoning: { effort: 'minimal' },
        maxTokens: 1024,
      },
      responseFormat: {
        type: 'json_schema',
        json_schema: {
          name: 'label',
          strict: true,
          schema: { type: 'object', properties: { label: { type: 'string', enum: names } }, required: ['label'], additionalProperties: false },
        },
      },
      answerField: 'label',
      outputSchema: z.enum(names),
    },
    verify: {
      instructions: 'Of all the labels in all_labels, is proposed_label the single best match for the text?',
      criteria: {
        supported: 'proposed_label is the best match among all_labels',
        unsupported: 'Another label in all_labels matches the text better',
        cannot_tell: 'The text is too ambiguous to judge',
      },
      state: (row, answer) => ({ text: row[text] ?? '', proposed_label: answer, all_labels: names }),
    },
    models: modelsFor(config),
  });
}

/** `task.models` must pass `validateTask` (batch-form IDs); the IDs actually called come from `resolveRoutes`. */
function modelsFor(config: GateConfig): TaskDefinition['models'] {
  const batchForm = (id: string) => (isAnthropicDirect(id) ? id : toOpenRouterId(id, 'batch'));
  return {
    writer: batchForm(config.writer.model),
    escalation: batchForm(config.writer.escalation),
    decision: config.checker.model,
    ...(config.checker.triage ? { triage: config.checker.triage } : {}),
  };
}

/**
 * The TaskDefinition the pipeline runs. With `prompts.from`, the TypeScript task's prompts are used as they are
 * (so thresholds calibrated on that task still apply); data, models and thresholds always come from the config.
 */
export async function taskFromConfig(loaded: LoadedGateConfig): Promise<TaskDefinition> {
  const { config } = loaded;
  const labels = resolveLabels(config);
  let task: TaskDefinition;
  if (config.prompts) {
    const mod = (await import(pathToFileURL(resolve(config.prompts.from)).href)) as { default?: TaskDefinition };
    if (!mod.default) throw new GateConfigError(`prompts.from ${config.prompts.from} has no default export`);
    const base = mod.default;
    if (base.extract) throw new GateConfigError('prompts.from: extraction tasks are not supported by the gate yet');
    const allowed = enumOptions(base.writer.outputSchema);
    const unknown = allowed ? labels.filter((l) => !allowed.includes(l.name)) : [];
    if (unknown.length) throw new GateConfigError(`labels: ${unknown.map((l) => l.name).join(', ')} not in ${config.prompts.from}'s output schema`);
    task = defineTask({ ...base, name: config.name, idColumn: idColumnOf(config), models: modelsFor(config) });
  } else {
    task = genericTask(config, labels);
  }
  const th = readThresholdsFile(config.checker.thresholds);
  if (th) task = { ...task, thresholds: th.thresholds };
  return task;
}

export interface ThresholdsFile {
  thresholds: Thresholds;
  /** Precision target they were fitted for. */
  target: number;
  checker: { triage: string; verify: string };
  /** Where they came from: a calibration run, a gate recalibration, … */
  source: string;
  fittedAt: string;
}

const thresholdsFileSchema = z.looseObject({
  thresholds: z.strictObject({ t0: z.number(), t1: z.number(), t2: z.number() }),
  target: z.number(),
  checker: z.strictObject({ triage: z.string(), verify: z.string() }),
  source: z.string(),
  fittedAt: z.string(),
});

export function readThresholdsFile(path: string): ThresholdsFile | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = thresholdsFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new GateConfigError(`${path}: not a thresholds file (${parsed.error.issues[0]?.path.join('.')}: ${parsed.error.issues[0]?.message})`);
  validateThresholds(parsed.data.thresholds);
  return parsed.data as ThresholdsFile;
}

/** Thresholds for this config, or an error that says how to make them. Never a silent default. */
export function requireThresholds(loaded: LoadedGateConfig): ThresholdsFile {
  const { config } = loaded;
  const th = readThresholdsFile(config.checker.thresholds);
  const triage = config.checker.triage ?? config.checker.model;
  if (!th) {
    throw new GateConfigError(
      `No thresholds at ${config.checker.thresholds}. Fit them first:\n  twopass gate calibrate --task ${loaded.path}\n` +
        'The gate never runs on default thresholds.',
    );
  }
  if (th.checker.verify !== config.checker.model || th.checker.triage !== triage) {
    throw new GateConfigError(
      `${config.checker.thresholds} was fitted for ${th.checker.triage} / ${th.checker.verify}, but the task uses ${triage} / ${config.checker.model}. ` +
        `Recalibrate: twopass gate calibrate --task ${loaded.path}`,
    );
  }
  return th;
}

/** Where each writer model goes for this run. Base and head must agree (`compare` checks). */
export function resolveRoutes(config: GateConfig, env: { anthropicKey: boolean }): { writer: ModelRoute; escalation: ModelRoute } {
  const o = { transport: 'sync' as const, anthropicKey: env.anthropicKey, ...(config.provider ? { claude: config.provider.claude as Provider } : {}) };
  return { writer: resolveRoute(config.writer.model, o), escalation: resolveRoute(config.writer.escalation, o) };
}

export const neverAccepts = (t: Thresholds): boolean => t.t0 >= NEVER && t.t1 >= NEVER && t.t2 >= NEVER;
