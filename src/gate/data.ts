import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { z } from 'zod';
import type { Row } from '../task.ts';
import { seededOrder } from './stats.ts';

// Rows, slices and ID files for the gate. Pure apart from reading and writing the files it is given.

export function readCsvRows(path: string): Row[] {
  if (!existsSync(path)) throw new Error(`Data file not found: ${path}`);
  return parse(readFileSync(path), { columns: true, bom: true, skip_empty_lines: true, relax_column_count: false }) as Row[];
}

/** A stable ID for a row without one: a hash of its text. */
export const textId = (text: string): string => `t-${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;

export interface GateRow {
  id: string;
  text: string;
  label: string;
  data: Row;
}

/** Reads the data with the config's columns. IDs come from the id column, or a text hash; duplicates are an error. */
export function loadRows(path: string, columns: { id?: string | undefined; text: string; label: string }, idColumn: string): GateRow[] {
  const raw = readCsvRows(path);
  if (!raw.length) throw new Error(`${path} has no rows`);
  for (const col of [columns.text, columns.label, ...(columns.id ? [columns.id] : [])]) {
    if (!(col in raw[0]!)) throw new Error(`${path} has no column "${col}" (columns: ${Object.keys(raw[0]!).join(', ')})`);
  }
  const seen = new Map<string, number>();
  return raw.map((data, i) => {
    const text = data[columns.text] ?? '';
    const id = columns.id ? (data[columns.id] ?? '').trim() : textId(text);
    if (!id) throw new Error(`${path}: row ${i + 1} has no value in id column "${columns.id}"`);
    const prev = seen.get(id);
    if (prev !== undefined) {
      throw new Error(
        columns.id ? `${path}: rows ${prev + 1} and ${i + 1} share the id "${id}"` : `${path}: rows ${prev + 1} and ${i + 1} have the same text; add an id column`,
      );
    }
    seen.set(id, i);
    return { id, text, label: (data[columns.label] ?? '').trim(), data: { ...data, [idColumn]: id } };
  });
}

const idListSchema = z.union([z.array(z.string()), z.looseObject({ ids: z.array(z.string()) })]);

/** A JSON file of row IDs: a plain list, or an object with `ids` (slice and calibration files). */
export function readIdFile(path: string): string[] {
  if (!existsSync(path)) throw new Error(`ID file not found: ${path}`);
  const parsed = idListSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new Error(`${path}: expected a JSON list of IDs or {"ids": [...]}`);
  return Array.isArray(parsed.data) ? parsed.data : parsed.data.ids;
}

export interface SliceFile {
  name: string;
  source: string;
  perLabel: number;
  seed: number;
  excluded: string[];
  /** Labels with fewer rows than `perLabel` after exclusion: all of their rows are in. */
  shortLabels: Record<string, number>;
  counts: Record<string, number>;
  ids: string[];
}

/**
 * Stratified slice: per label, the first `perLabel` rows in a seeded order, after removing every excluded ID.
 * The result does not depend on row order in the CSV. IDs are returned in label order, then seeded order.
 */
export function buildSlice(rows: GateRow[], o: { perLabel: number; seed: number; exclude: Set<string> }): { ids: string[]; counts: Record<string, number>; shortLabels: Record<string, number> } {
  const byLabel = new Map<string, GateRow[]>();
  for (const r of rows) {
    if (o.exclude.has(r.id) || !r.label) continue;
    const list = byLabel.get(r.label) ?? [];
    list.push(r);
    byLabel.set(r.label, list);
  }
  const ids: string[] = [];
  const counts: Record<string, number> = {};
  const shortLabels: Record<string, number> = {};
  for (const label of [...byLabel.keys()].sort()) {
    const picked = seededOrder(byLabel.get(label)!, o.seed, (r) => r.id).slice(0, o.perLabel);
    counts[label] = picked.length;
    if (picked.length < o.perLabel) shortLabels[label] = picked.length;
    ids.push(...picked.map((r) => r.id));
  }
  return { ids, counts, shortLabels };
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

/** The rows of `ids`, in that order, as a CSV `startRun` can read (original columns plus the id column). */
export function writeRunCsv(path: string, rows: GateRow[], ids: string[]): void {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const picked = ids.map((id) => {
    const r = byId.get(id);
    if (!r) throw new Error(`Row ${id} is in the slice but not in the data. Rebuild the slice: twopass gate slice --task …`);
    return r.data;
  });
  const columns = Object.keys(picked[0] ?? {});
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify(picked, { header: true, columns }));
}
