import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as toYaml } from 'yaml';
import { buildSlice, loadRows, readIdFile, writeJson } from './data.ts';
import { idColumnOf, ID_COLUMN_FALLBACK, loadGateConfig, type GateConfig } from './task-config.ts';

// `twopass gate init`: everything a reader needs in their repo, from one labelled CSV. No API calls.

export interface InitOptions {
  data: string;
  text: string;
  label: string;
  id?: string;
  name?: string;
  dir?: string;
  perLabel?: number;
  calibrationPerLabel?: number;
  seed?: number;
  writer?: string;
  escalation?: string;
  checker?: string;
  target?: number;
  workflow?: string;
  twopassVersion?: string;
  force?: boolean;
}

export interface InitOutput {
  taskPath: string;
  files: string[];
  sliceRows: number;
  calibrationRows: number;
  shortLabels: Record<string, number>;
}

export const DEFAULTS = {
  writer: 'claude-haiku-5-5',
  escalation: 'claude-sonnet-5-5',
  checker: 'cloudflare/clef',
  perLabel: 20,
  calibrationPerLabel: 15,
  seed: 42,
  target: 0.95,
};

export function gateInit(o: InitOptions): InitOutput {
  const name = o.name ?? (o.data.split('/').pop() ?? 'task').replace(/\.csv$/i, '').replace(/[^A-Za-z0-9_.-]/g, '-');
  const dir = o.dir ?? 'gates';
  const seed = o.seed ?? DEFAULTS.seed;
  const paths = {
    task: join(dir, `${name}.task.yaml`),
    calibration: join(dir, `${name}.calibration-rows.json`),
    points: join(dir, `${name}.calibration-points.json`),
    thresholds: join(dir, `${name}.thresholds.json`),
    slice: join(dir, `${name}.slice.json`),
    noise: join(dir, `${name}.noise.json`),
    workflow: o.workflow ?? '.github/workflows/eval-gate.yml',
  };
  const writes = [paths.task, paths.calibration, paths.slice, paths.workflow];
  const clash = writes.filter((p) => existsSync(p));
  if (clash.length && !o.force) throw new Error(`Already exists: ${clash.join(', ')}. Pass --force to overwrite.`);

  const config: GateConfig = {
    name,
    type: 'classification',
    data: o.data,
    columns: { ...(o.id ? { id: o.id } : {}), text: o.text, label: o.label },
    labels: 'auto',
    promise: { acceptedPrecision: o.target ?? DEFAULTS.target },
    slice: { file: paths.slice, perLabel: o.perLabel ?? DEFAULTS.perLabel, seed, exclude: [paths.calibration] },
    calibration: { rows: paths.calibration, points: paths.points, checkShare: 0.2, seed: 7 },
    writer: { model: o.writer ?? DEFAULTS.writer, escalation: o.escalation ?? DEFAULTS.escalation },
    checker: { model: o.checker ?? DEFAULTS.checker, thresholds: paths.thresholds },
    gate: { enforce: 'g3', maxUsd: 1.5, g2Tolerance: 0.01 },
    noise: paths.noise,
  };
  const rows = loadRows(o.data, config.columns, idColumnOf(config));

  // Calibration rows first (their own seed), then the slice from what is left.
  const calibration = buildSlice(rows, { perLabel: o.calibrationPerLabel ?? DEFAULTS.calibrationPerLabel, seed: seed + 1, exclude: new Set() });
  const slice = buildSlice(rows, { perLabel: config.slice.perLabel, seed, exclude: new Set(calibration.ids) });

  mkdirSync(dir, { recursive: true });
  writeFileSync(paths.task, taskYaml(config));
  writeJson(paths.calibration, { ids: [...calibration.ids].sort() });
  writeJson(paths.slice, sliceFile(config, slice));
  mkdirSync(dirname(paths.workflow), { recursive: true });
  writeFileSync(paths.workflow, renderWorkflow({ taskPath: paths.task, twopassVersion: o.twopassVersion ?? packageVersion() }));
  return {
    taskPath: paths.task,
    files: writes,
    sliceRows: slice.ids.length,
    calibrationRows: calibration.ids.length,
    shortLabels: slice.shortLabels,
  };
}

function sliceFile(config: GateConfig, s: ReturnType<typeof buildSlice>) {
  return {
    name: config.name,
    source: config.data,
    perLabel: config.slice.perLabel,
    seed: config.slice.seed,
    excluded: config.slice.exclude,
    shortLabels: s.shortLabels,
    counts: s.counts,
    ids: s.ids,
  };
}

/** `twopass gate slice`: rebuilds the slice file from the config (data, perLabel, seed, exclusions). */
export function gateSlice(taskPath: string, o: { write?: boolean } = {}): { ids: string[]; changed: boolean; shortLabels: Record<string, number> } {
  const { config } = loadGateConfig(taskPath);
  const rows = loadRows(config.data, config.columns, idColumnOf(config));
  const exclude = new Set(config.slice.exclude.flatMap((f) => readIdFile(f)));
  const s = buildSlice(rows, { perLabel: config.slice.perLabel, seed: config.slice.seed, exclude });
  const prev = existsSync(config.slice.file) ? readIdFile(config.slice.file) : [];
  const changed = prev.join('\n') !== s.ids.join('\n');
  if (o.write) writeJson(config.slice.file, sliceFile(config, s));
  return { ids: s.ids, changed, shortLabels: s.shortLabels };
}

const HEADER = `# TwoPass eval gate task config. Docs: https://github.com/Rubick1997/twopass/blob/main/docs/eval-gate.md
# Paths are relative to the repo root. Next: twopass gate calibrate --task <this file> --collect --max-usd <cap>
`;

function taskYaml(config: GateConfig): string {
  const body = toYaml(config, { lineWidth: 0 });
  return HEADER + (config.columns.id ? '' : `# No id column: rows are identified by a hash of their text (${ID_COLUMN_FALLBACK}).\n`) + body;
}

function findUp(rel: string): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const p = join(d, rel);
    if (existsSync(p)) return p;
    d = dirname(d);
  }
  throw new Error(`TwoPass install is missing ${rel}`);
}

export function packageVersion(): string {
  return (JSON.parse(readFileSync(findUp('package.json'), 'utf8')) as { version: string }).version;
}

/** The workflow template with the task path and the pinned TwoPass version filled in. */
export function renderWorkflow(o: { taskPath: string; twopassVersion: string }): string {
  return readFileSync(findUp('templates/github/eval-gate.yml'), 'utf8').replaceAll('__TASK__', o.taskPath).replaceAll('__TWOPASS_VERSION__', o.twopassVersion);
}
