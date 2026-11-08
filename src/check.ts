import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import type { z } from 'zod';
import type { FetchFn } from './http.ts';
import { fetchModelList, type OpenRouterModel } from './prices.ts';
import { isFormulaLike } from './report.ts';
import { parseOutput, render, verifyQuestion, verifyState, type Row, type TaskDefinition } from './task.ts';

// `twopass check`: a deterministic, model-free preflight. It validates a CSV against a task and
// produces a normalized copy, logging every change. `run` and `bench` call it before anything
// else, so a broken CSV never costs money. The only network call is the optional GET /models
// (context lengths), made only when everything else passed.

export const ROW_NUMBERING = '1-based data rows, header excluded';
/** Row numbers kept per message. */
const MAX_ROWS = 20;
/** Deliberately conservative: real tokenizers average closer to 4 characters per token. */
const CHARS_PER_TOKEN = 3;

export type Delimiter = ',' | ';' | '\t' | '|';
export const DELIMITERS: readonly Delimiter[] = [',', ';', '\t', '|'];

export interface CheckIssue {
  code: string;
  message: string;
  count: number;
  rows: number[];
}

export interface CheckChange {
  code: string;
  /** Human-readable, e.g. "trimmed 12 cells". */
  message: string;
  count: number;
  rows: number[];
}

export interface CheckInfo {
  code: string;
  message: string;
}

export interface CheckReport {
  rowNumbering: typeof ROW_NUMBERING;
  input: {
    path: string;
    sha256: string;
    encoding: 'utf-8' | 'windows-1252' | null;
    delimiter: Delimiter | null;
    delimiterSource: 'detected' | 'option';
    /** Data records in the input, including empty ones. */
    rows: number;
    columns: string[];
  };
  output: {
    /** Set when normalized.csv is written; null before. */
    path: string | null;
    sha256: string;
    rows: number;
  };
  errors: CheckIssue[];
  warnings: CheckIssue[];
  changes: CheckChange[];
  info: CheckInfo[];
}

export interface CheckOptions {
  labelColumn?: string;
  delimiter?: 'auto' | Delimiter;
  /** Models whose context length is checked. Defaults to the task's; leave a key out to skip that role. */
  models?: { writer?: string; escalation?: string; triage?: string; verify?: string };
  /** Loads OpenRouter's model list. Defaults to GET /models with `fetch` (and `apiKey` when given). */
  loadModels?: () => Promise<OpenRouterModel[]>;
  fetch?: FetchFn;
  apiKey?: string;
}

export interface CheckResult {
  report: CheckReport;
  /** Normalized rows (with mapped labels). Empty when the input could not be parsed. */
  rows: Row[];
  columns: string[];
  /** The normalized CSV text (UTF-8, comma-delimited). */
  csv: string;
}

export class CheckFailedError extends Error {
  readonly report: CheckReport;

  constructor(message: string, report: CheckReport) {
    super(message);
    this.name = 'CheckFailedError';
    this.report = report;
  }
}

// ------------------------------------------------------------------- main entry

export async function checkCsv(path: string, task: TaskDefinition, opts: CheckOptions = {}): Promise<CheckResult> {
  const buf = readFileSync(path);
  const report: CheckReport = {
    rowNumbering: ROW_NUMBERING,
    input: {
      path: resolve(path),
      sha256: sha256(buf),
      encoding: null,
      delimiter: null,
      delimiterSource: opts.delimiter && opts.delimiter !== 'auto' ? 'option' : 'detected',
      rows: 0,
      columns: [],
    },
    output: { path: null, sha256: '', rows: 0 },
    errors: [],
    warnings: [],
    changes: [],
    info: [],
  };
  const changes = new ChangeLog();
  const done = (columns: string[], rows: string[][]): CheckResult => {
    report.changes = changes.list();
    const csv = stringify([columns, ...rows]);
    report.output.sha256 = sha256(Buffer.from(csv, 'utf8'));
    report.output.rows = rows.length;
    return { report, rows: rows.map((cells) => toRow(columns, cells)), columns, csv };
  };
  const error = (code: string, message: string, rows: number[] = [], count = rows.length || 1) =>
    report.errors.push(issue(code, message, rows, count));
  const warn = (code: string, message: string, rows: number[], count = rows.length) =>
    report.warnings.push(issue(code, message, rows, count));

  // 1. encoding
  const decoded = decode(buf);
  if ('error' in decoded) {
    error(decoded.code, decoded.error);
    return done([], []);
  }
  report.input.encoding = decoded.encoding;
  if (decoded.encoding !== 'utf-8') changes.add('converted_encoding', 0, `converted ${decoded.encoding} → utf-8`);
  if (decoded.bom) changes.add('removed_bom', 0, 'removed a byte-order mark');
  const text = decoded.text;
  if (!text.trim()) {
    error('empty_file', 'the file is empty');
    return done([], []);
  }

  // 2. delimiter
  const delimiter = opts.delimiter && opts.delimiter !== 'auto' ? opts.delimiter : detectDelimiter(text);
  report.input.delimiter = delimiter;

  // 3. parse as arrays, keeping ragged rows
  let records: string[][];
  try {
    records = parse(text, { delimiter, relax_column_count: true, relax_quotes: true, skip_empty_lines: false }) as string[][];
  } catch (err) {
    // csv-parse messages quote the offending value, which may be personal data: keep only code and line.
    const e = err as { code?: string; lines?: number };
    error('csv_parse_error', `the CSV can't be parsed (${e.code ?? 'parse error'}${e.lines ? ` near line ${e.lines}` : ''})`);
    return done([], []);
  }
  // leading blank lines before the header are not data
  while (records.length && records[0]!.every((c) => !c.trim())) records.shift();
  const rawHeader = records.shift();
  report.input.rows = records.length;
  if (!rawHeader) {
    error('no_header', 'the file has no header row');
    return done([], []);
  }

  // 4. header: cleaned like cells, never renamed beyond that
  const columns = rawHeader.map((name) => clean(name).value);
  const headerChanged = columns.filter((c, i) => c !== rawHeader[i]).length;
  if (headerChanged) changes.add('normalized_header', 0, `cleaned ${plural(headerChanged, 'column name')}`, headerChanged);
  report.input.columns = columns;
  const emptyNames = columns.flatMap((c, i) => (c ? [] : [i + 1]));
  if (emptyNames.length) {
    error('empty_column_name', `${emptyNames.length === 1 ? 'column' : 'columns'} ${emptyNames.join(', ')} (counting from 1) ${emptyNames.length === 1 ? 'has' : 'have'} no name in the header`, [], emptyNames.length);
  }
  const dupNames = [...new Set(columns.filter((c, i) => c && columns.indexOf(c) !== i))];
  if (dupNames.length) {
    error('duplicate_column_names', `duplicate column names: ${dupNames.map((c) => `"${c}"`).join(', ')}`, [], dupNames.length);
  }

  // 5–6. cells, then empty rows
  const CELL_CHANGES = [
    ['normalized_line_endings', 'normalized line endings in'],
    ['normalized_unicode', 'applied Unicode NFC to'],
    ['removed_invisible_chars', 'removed zero-width characters from'],
    ['removed_control_chars', 'removed control characters from'],
    ['trimmed_cells', 'trimmed'],
  ] as const;
  type Kept = { n: number; cells: string[] };
  let kept: Kept[] = [];
  const emptyRows: number[] = [];
  const ragged: Array<{ n: number; width: number }> = [];
  records.forEach((raw, i) => {
    const n = i + 1;
    const cells = raw.map((v) => {
      const c = clean(v);
      for (const [code, verb] of CELL_CHANGES) if (c.kinds.has(code)) changes.add(code, n, (k) => `${verb} ${plural(k, 'cell')}`);
      return c.value;
    });
    if (cells.every((c) => !c)) emptyRows.push(n);
    else if (cells.length !== columns.length) ragged.push({ n, width: cells.length });
    else kept.push({ n, cells });
  });
  for (const n of emptyRows) changes.add('removed_empty_rows', n, (k) => `removed ${plural(k, 'empty row')}`);
  if (ragged.length) {
    const eg = ragged.slice(0, 3).map((r) => `row ${r.n} has ${r.width}`).join(', ');
    error(
      'ragged_rows',
      `${plural(ragged.length, 'row')} ${ragged.length === 1 ? 'has' : 'have'} a different number of columns than the header (${columns.length}): ${eg}${ragged.length > 3 ? ', …' : ''}`,
      ragged.map((r) => r.n),
    );
  }

  // required columns
  const idx = new Map<string, number>();
  columns.forEach((c, i) => {
    if (c && !idx.has(c)) idx.set(c, i);
  });
  const required = requiredColumns(task);
  for (const { column, usedBy } of required) {
    if (idx.has(column)) continue;
    error('missing_column', `column "${column}" ${usedBy} is missing.${suggest(column, columns)}`);
  }
  const contentColumns = [...new Set(required.filter((r) => r.usedBy !== 'named as idColumn').map((r) => r.column))].filter((c) => idx.has(c));
  const cell = (r: Kept, column: string) => r.cells[idx.get(column)!] ?? '';

  // id column
  if (task.idColumn && idx.has(task.idColumn)) {
    const id = task.idColumn;
    const empty = kept.filter((r) => !cell(r, id)).map((r) => r.n);
    if (empty.length) error('empty_id', `${plural(empty.length, 'row')} ${empty.length === 1 ? 'has' : 'have'} no value in the id column "${id}"`, empty);
    const seen = new Set<string>();
    const dups = kept.filter((r) => {
      const v = cell(r, id);
      if (!v) return false;
      if (seen.has(v)) return true;
      seen.add(v);
      return false;
    });
    if (dups.length) {
      const distinct = new Set(dups.map((r) => cell(r, id))).size;
      error('duplicate_id', `${plural(dups.length, 'row')} ${dups.length === 1 ? 'repeats' : 'repeat'} an id already used in "${id}" (${plural(distinct, 'distinct id')})`, dups.map((r) => r.n));
    }
  }

  // 7. labels
  if (opts.labelColumn !== undefined) {
    const label = opts.labelColumn;
    if (!idx.has(label)) {
      error('missing_label_column', `label column "${label}" is missing.${suggest(label, columns)}`);
    } else {
      kept = checkLabels(kept, idx.get(label)!, label, task.writer.outputSchema, changes, error, warn);
    }
  }

  if (!kept.length && !report.errors.some((e) => e.code === 'ragged_rows')) error('no_rows', 'there are no data rows after normalization', [], 0);

  // warnings on the columns the task reads
  for (const c of contentColumns) {
    const empty = kept.filter((r) => !cell(r, c)).map((r) => r.n);
    if (empty.length) warn('empty_required_values', `${plural(empty.length, 'row')} ${empty.length === 1 ? 'has' : 'have'} an empty "${c}"`, empty);
  }
  if (contentColumns.length) {
    const first = new Map<string, number>();
    const repeats: number[] = [];
    for (const r of kept) {
      const values = contentColumns.map((c) => cell(r, c));
      if (values.every((v) => !v)) continue;
      const key = values.join('\u001f');
      if (first.has(key)) repeats.push(r.n);
      else first.set(key, r.n);
    }
    if (repeats.length) {
      warn(
        'duplicate_inputs',
        `${plural(repeats.length, 'duplicate input')} (same ${contentColumns.map((c) => `"${c}"`).join(', ')} as an earlier row): ` +
          `${repeats.length === 1 ? 'that row is' : 'those rows are'} paid for again (deduplication is not automatic)`,
        repeats,
      );
    }
    for (const [type, rows] of findPii(kept.map((r) => ({ n: r.n, values: contentColumns.map((c) => cell(r, c)) })))) {
      warn(
        `possible_pii_${type}`,
        `${plural(rows.length, 'row')} may contain ${PII_NAMES[type]}. OpenRouter batch has no zero data retention; ` +
          'use public or non-sensitive data.',
        rows,
      );
    }
  }
  const formula = kept.filter((r) => r.cells.some(isFormulaLike)).map((r) => r.n);
  if (formula.length) {
    warn(
      'formula_injection',
      `${plural(formula.length, 'row')} ${formula.length === 1 ? 'has' : 'have'} cells starting with =, +, @, - or a control character, ` +
        'which a spreadsheet may run as a formula. TwoPass escapes them in enriched.csv and review.csv.',
      formula,
    );
  }

  // context length: only when everything else passed, so a broken CSV makes no network call
  if (!report.errors.length) {
    await checkContext(task, columns, kept, opts, error, report.info);
  }

  return done(columns, kept.map((r) => r.cells));
}

// ------------------------------------------------------------------- decoding

type Decoded = { text: string; encoding: 'utf-8' | 'windows-1252'; bom: boolean } | { error: string; code: string };

export function decode(buf: Uint8Array): Decoded {
  if (!buf.length) return { error: 'the file is empty', code: 'empty_file' };
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) {
    return { error: 'the file is UTF-16; save it as UTF-8', code: 'not_decodable' };
  }
  let text: string;
  let encoding: 'utf-8' | 'windows-1252' = 'utf-8';
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    try {
      text = new TextDecoder('windows-1252', { fatal: true }).decode(buf);
      encoding = 'windows-1252';
    } catch {
      return { error: 'the file is neither UTF-8 nor Windows-1252 text', code: 'not_decodable' };
    }
  }
  if (text.includes('\u0000')) return { error: 'the file contains NUL bytes; it looks binary, not like a text CSV', code: 'not_decodable' };
  const bom = text.startsWith('﻿');
  return { text: bom ? text.slice(1) : text, encoding, bom };
}

// ------------------------------------------------------------------- delimiter

/** Picks the delimiter giving the most consistent column count (> 1) over the first ~50 records. */
export function detectDelimiter(text: string): Delimiter {
  let best: { d: Delimiter; consistency: number; width: number } = { d: ',', consistency: -1, width: 0 };
  for (const d of DELIMITERS) {
    const counts = fieldCounts(text, d, 50);
    if (!counts.length) continue;
    const freq = new Map<number, number>();
    for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
    const [width, hits] = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]!;
    if (width <= 1) continue;
    const consistency = hits / counts.length;
    if (consistency > best.consistency || (consistency === best.consistency && width > best.width)) {
      best = { d, consistency, width };
    }
  }
  return best.d;
}

/** Fields per record, ignoring delimiters inside quotes and blank lines. */
function fieldCounts(text: string, d: string, maxRecords: number): number[] {
  const counts: number[] = [];
  let fields = 1;
  let content = false;
  let fieldStart = true;
  let inQuotes = false;
  for (let i = 0; i < text.length && counts.length < maxRecords; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') i++;
        else inQuotes = false;
      }
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (content) counts.push(fields);
      fields = 1;
      content = false;
      fieldStart = true;
      continue;
    }
    content = true;
    if (ch === d) {
      fields++;
      fieldStart = true;
    } else if (ch === '"' && fieldStart) {
      inQuotes = true;
    } else {
      fieldStart = false;
    }
  }
  if (content && counts.length < maxRecords) counts.push(fields);
  return counts;
}

// ------------------------------------------------------------------- cells

const ZERO_WIDTH = /[​-‍⁠﻿]/g;
// C0 controls except \t (09) and \n (0A); \r is handled as a line ending first
const CONTROL = /[\u0000-\u0008\u000B-\u001F]/g;

export function clean(v: string): { value: string; kinds: Set<string> } {
  const kinds = new Set<string>();
  let s = v;
  if (s.includes('\r')) {
    s = s.replace(/\r\n?/g, '\n');
    kinds.add('normalized_line_endings');
  }
  const nfc = s.normalize('NFC');
  if (nfc !== s) kinds.add('normalized_unicode');
  s = nfc;
  const visible = s.replace(ZERO_WIDTH, '');
  if (visible !== s) kinds.add('removed_invisible_chars');
  s = visible;
  const printable = s.replace(CONTROL, '');
  if (printable !== s) kinds.add('removed_control_chars');
  s = printable;
  const trimmed = s.trim();
  if (trimmed !== s) kinds.add('trimmed_cells');
  return { value: trimmed, kinds };
}


// ------------------------------------------------------------------- columns

export interface RequiredColumn {
  column: string;
  usedBy: string;
}

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Columns the task reads: template placeholders, `inputColumns`, and the id column. */
export function requiredColumns(task: TaskDefinition): RequiredColumn[] {
  const out: RequiredColumn[] = [];
  const add = (column: string, usedBy: string) => {
    if (!out.some((r) => r.column === column)) out.push({ column, usedBy });
  };
  const placeholders = (t: string | undefined) => [...(t ?? '').matchAll(PLACEHOLDER)].map((m) => m[1]!);
  for (const c of placeholders(task.writer.promptTemplate)) add(c, 'used by the prompt');
  for (const c of placeholders(task.writer.escalation?.template)) if (c !== 'previous_answer') add(c, 'used by the escalation prompt');
  for (const c of task.inputColumns ?? []) add(c, 'listed in the task\'s inputColumns');
  if (task.idColumn) add(task.idColumn, 'named as idColumn');
  return out;
}

function suggest(column: string, columns: string[]): string {
  const lc = column.toLowerCase();
  const close = columns
    .filter((c) => c)
    .map((c) => {
      const l = c.toLowerCase();
      const d = l === lc ? 0 : editDistance(l, lc);
      const prefix = Math.min(l.length, lc.length) >= 3 && (l.startsWith(lc) || lc.startsWith(l));
      return { c, d: d <= 2 ? d : prefix ? 3 : Infinity };
    })
    .filter((x) => x.d < Infinity)
    .sort((a, b) => a.d - b.d)
    .map((x) => `"${x.c}"`);
  const found = columns.filter((c) => c);
  const list = found.length ? ` (found: ${found.slice(0, 6).join(', ')}${found.length > 6 ? ', …' : ''})` : ' (the header has no named columns)';
  return (close.length ? ` Did you mean ${close.slice(0, 3).join(' or ')}?` : '') + list;
}

export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

// ------------------------------------------------------------------- labels

const canonical = (s: string) => s.trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/_+/g, '_');

/** Allowed values when the schema is a z.enum of strings (shared with overrides.ts). */
export function enumOptions(schema: z.ZodType): string[] | undefined {
  const s = schema as unknown as { def?: { type?: string }; options?: unknown };
  if (s.def?.type !== 'enum' || !Array.isArray(s.options)) return undefined;
  return s.options.filter((o): o is string => typeof o === 'string');
}

function checkLabels<T extends { n: number; cells: string[] }>(
  rows: T[],
  col: number,
  label: string,
  schema: z.ZodType,
  changes: ChangeLog,
  error: (code: string, message: string, rows?: number[], count?: number) => void,
  warn: (code: string, message: string, rows: number[], count?: number) => void,
): T[] {
  const options = enumOptions(schema);
  const byCanon = new Map<string, string[]>();
  for (const o of options ?? []) byCanon.set(canonical(o), [...(byCanon.get(canonical(o)) ?? []), o]);
  const bad = new Map<string, { rows: number[]; candidates: string[] }>();
  const empty: number[] = [];
  const valid: Array<{ n: number; value: string }> = [];
  for (const r of rows) {
    const v = r.cells[col] ?? '';
    if (!v) {
      empty.push(r.n);
      continue;
    }
    if (options) {
      if (options.includes(v)) {
        valid.push({ n: r.n, value: v });
        continue;
      }
      const candidates = byCanon.get(canonical(v)) ?? [];
      if (candidates.length === 1) {
        r.cells[col] = candidates[0]!;
        changes.add('mapped_labels', r.n, (k) => `mapped ${plural(k, 'label')} to the allowed set`);
        valid.push({ n: r.n, value: candidates[0]! });
        continue;
      }
      const b = bad.get(v) ?? { rows: [], candidates };
      b.rows.push(r.n);
      bad.set(v, b);
    } else if (parseOutput(schema, v).ok) {
      valid.push({ n: r.n, value: v });
    } else {
      const b = bad.get(v) ?? { rows: [], candidates: [] };
      b.rows.push(r.n);
      bad.set(v, b);
    }
  }
  if (bad.size) {
    const entries = [...bad.entries()].sort((a, b) => b[1].rows.length - a[1].rows.length);
    const shown = entries
      .slice(0, 20)
      .map(([v, b]) => `${showValue(v)} ×${b.rows.length}${b.candidates.length > 1 ? ` (ambiguous: ${b.candidates.join(', ')})` : ''}`)
      .join(', ');
    const allRows = entries.flatMap(([, b]) => b.rows).sort((a, b) => a - b);
    error(
      'invalid_labels',
      `${plural(allRows.length, 'row')} in "${label}" ${allRows.length === 1 ? 'has' : 'have'} a label the task's output schema does not allow ` +
        `(${plural(bad.size, 'distinct value')}): ${shown}${entries.length > 20 ? ', …' : ''}`,
      allRows,
    );
  }
  if (empty.length) warn('empty_labels', `${plural(empty.length, 'row')} ${empty.length === 1 ? 'has' : 'have'} no value in the label column "${label}"`, empty);
  if (valid.length < 200) {
    warn('few_labeled_rows', `only ${plural(valid.length, 'labeled row')}; calibration needs at least 200 for stable thresholds`, [], valid.length);
  }
  const perLabel = new Map<string, number[]>();
  for (const v of valid) perLabel.set(v.value, [...(perLabel.get(v.value) ?? []), v.n]);
  const rare = [...perLabel.entries()].filter(([, ns]) => ns.length < 5).sort((a, b) => a[1].length - b[1].length);
  if (rare.length) {
    const shown = rare.slice(0, 20).map(([l, ns]) => `${l} ×${ns.length}`).join(', ');
    warn(
      'rare_labels',
      `${plural(rare.length, 'label')} ${rare.length === 1 ? 'has' : 'have'} fewer than 5 examples, too few to calibrate on: ${shown}${rare.length > 20 ? ', …' : ''}`,
      rare.flatMap(([, ns]) => ns).sort((a, b) => a - b),
    );
  }
  return rows;
}

// ------------------------------------------------------------------- personal data

/** A bad value as it may appear in a message. Values that look like personal data are never printed. */
const showValue = (v: string): string =>
  findPii([{ n: 0, values: [v] }]).size ? '"<redacted: possible personal data>"' : `"${v}"`;

type PiiType = 'email' | 'phone' | 'card' | 'iban';
const PII_NAMES: Record<PiiType, string> = {
  email: 'email addresses',
  phone: 'phone numbers',
  card: 'payment card numbers (Luhn-valid)',
  iban: 'IBANs (checksum-valid)',
};
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const IBAN_CANDIDATE = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}/g;
const NUMBER_CANDIDATE = /(?:\+|\b)\d[\d ().-]{7,30}\d\b/g;

/** Rows per type. Only row numbers come out, never the matched values. */
export function findPii(rows: Array<{ n: number; values: string[] }>): Map<PiiType, number[]> {
  const found = new Map<PiiType, number[]>();
  const hit = (type: PiiType, n: number) => {
    const list = found.get(type) ?? [];
    if (list[list.length - 1] !== n) list.push(n);
    found.set(type, list);
  };
  for (const { n, values } of rows) {
    for (const value of values) {
      let rest = value;
      if (rest.search(EMAIL) >= 0) hit('email', n);
      rest = rest.replace(EMAIL, ' ');
      // IBAN-shaped text is not a phone or card number, whether or not its checksum passes
      rest = rest.replace(IBAN_CANDIDATE, (m) => {
        if (isIban(m)) hit('iban', n);
        return ' ';
      });
      for (const m of rest.matchAll(NUMBER_CANDIDATE)) {
        const digits = m[0].replace(/\D/g, '');
        if (digits.length >= 13 && digits.length <= 19 && /^[\d -]+$/.test(m[0]) && luhn(digits)) hit('card', n);
        else if (digits.length >= 9 && digits.length <= 15) hit('phone', n);
      }
    }
  }
  return new Map([...found.entries()].sort());
}

export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** True when some prefix of the (space-stripped) candidate is a valid IBAN by mod-97. */
export function isIban(candidate: string): boolean {
  const compact = candidate.replace(/ /g, '').toUpperCase();
  for (let len = Math.min(34, compact.length); len >= 15; len--) {
    if (mod97(compact.slice(0, len)) === 1) return true;
  }
  return false;
}

function mod97(iban: string): number {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem;
}

// ------------------------------------------------------------------- context length

async function checkContext(
  task: TaskDefinition,
  columns: string[],
  rows: Array<{ n: number; cells: string[] }>,
  opts: CheckOptions,
  error: (code: string, message: string, rows?: number[], count?: number) => void,
  info: CheckInfo[],
): Promise<void> {
  const models = opts.models ?? {
    writer: task.models.writer,
    escalation: task.models.escalation,
    ...(task.triage ? { triage: task.models.triage ?? task.models.decision } : {}),
    verify: task.models.verify ?? task.models.decision,
  };
  let list: OpenRouterModel[];
  try {
    list = await (opts.loadModels ?? (() => fetchModelList(opts.apiKey, opts.fetch ?? fetch, { maxRetries: 1 })))();
  } catch (err) {
    info.push({
      code: 'context_check_skipped',
      message: `context-length check skipped: OpenRouter's model list is unavailable (${err instanceof Error ? err.message.slice(0, 120) : String(err)})`,
    });
    return;
  }
  const w = task.writer;
  const sys = w.system ?? '';
  const prompts: Record<string, (row: Row) => number> = {
    writer: (row) => (sys + render(w.promptTemplate, row)).length / CHARS_PER_TOKEN + w.maxTokens,
    escalation: (row) =>
      (sys + render(w.escalation?.template ?? w.promptTemplate, { ...row, previous_answer: '' })).length / CHARS_PER_TOKEN +
      (w.escalation?.maxTokens ?? w.maxTokens),
    triage: (row) => (JSON.stringify(task.state(row)) + JSON.stringify(task.triage?.question ?? '')).length / CHARS_PER_TOKEN,
    verify: (row) => (JSON.stringify(verifyState(task, row, '')) + JSON.stringify(verifyQuestion(task))).length / CHARS_PER_TOKEN,
  };
  const unknown = new Set<string>();
  for (const [role, model] of Object.entries(models)) {
    if (!model) continue;
    const limit = list.find((m) => m.id === model)?.context_length;
    if (!limit) {
      unknown.add(model);
      continue;
    }
    const over: number[] = [];
    let worst = 0;
    for (const r of rows) {
      let tokens: number;
      try {
        tokens = Math.ceil(prompts[role]!(toRow(columns, r.cells)));
      } catch {
        continue; // a task function that fails on this row fails the same way at run time; not this check's job
      }
      if (tokens > limit) over.push(r.n);
      worst = Math.max(worst, tokens);
    }
    if (over.length) {
      error(
        'context_too_long',
        `${plural(over.length, 'row')} ${over.length === 1 ? 'is' : 'are'} estimated over the ${role} model's context length ` +
          `(${model}: ${limit.toLocaleString('en-US')} tokens; longest ≈ ${worst.toLocaleString('en-US')} at ${CHARS_PER_TOKEN} chars per token)`,
        over,
      );
    }
  }
  if (unknown.size) {
    info.push({
      code: 'context_length_unknown',
      message: `context length not listed on OpenRouter for ${[...unknown].join(', ')}; not checked`,
    });
  }
}

// ------------------------------------------------------------------- output

/** Writes normalized.csv and check-report.json into `dir`; returns the report's path. */
export function writeCheckOutputs(dir: string, result: CheckResult): string {
  mkdirSync(dir, { recursive: true });
  const csvPath = resolve(dir, 'normalized.csv');
  writeFileSync(csvPath, result.csv);
  result.report.output.path = csvPath;
  const reportPath = join(dir, 'check-report.json');
  writeFileSync(reportPath, JSON.stringify(result.report, null, 2) + '\n');
  return reportPath;
}

const DELIMITER_NAMES: Record<Delimiter, string> = { ',': ',', ';': ';', '\t': 'tab', '|': '|' };

/** The ✓ / ⚠ / ✗ summary printed by `twopass check` and used as the CheckFailedError message. */
export function formatCheckSummary(report: CheckReport, o: { heading?: string; reportPath?: string } = {}): string {
  const lines: string[] = [];
  if (o.heading) lines.push(o.heading);
  const { input } = report;
  if (input.encoding && input.delimiter) {
    const enc = input.encoding === 'utf-8' ? 'utf-8' : `${input.encoding} → utf-8`;
    lines.push(
      `  ✓ ${plural(report.output.rows, 'row')}, ${plural(input.columns.length, 'column')}, ` +
        `delimiter "${DELIMITER_NAMES[input.delimiter]}" (${input.delimiterSource === 'option' ? 'given' : 'detected'}), encoding ${enc}`,
    );
    const phrases = report.changes.filter((c) => c.code !== 'converted_encoding').map((c) => c.message);
    lines.push(`  ✓ normalized: ${phrases.length ? phrases.join(', ') : 'nothing to change'}`);
  }
  for (const w of report.warnings) lines.push(`  ⚠ ${w.message}${rowsSuffix(w)}`);
  for (const e of report.errors) lines.push(`  ✗ ${e.message}${rowsSuffix(e)}`);
  for (const i of report.info) lines.push(`  ℹ ${i.message}`);
  const n = report.errors.length;
  lines.push(
    n
      ? `  → ${plural(n, 'error')}. Nothing was sent to any model.`
      : `  → no errors${report.warnings.length ? `, ${plural(report.warnings.length, 'warning')}` : ''}.`,
  );
  if (o.reportPath) lines.push(`  report: ${o.reportPath}`);
  return lines.join('\n');
}

function rowsSuffix(i: CheckIssue): string {
  if (!i.rows.length) return '';
  const shown = i.rows.slice(0, 5);
  const more = i.count - shown.length;
  return ` (${shown.length === 1 && more <= 0 ? 'row' : 'rows'} ${shown.join(', ')}${more > 0 ? `, … +${more.toLocaleString('en-US')}` : ''})`;
}

// ------------------------------------------------------------------- helpers

class ChangeLog {
  private readonly map = new Map<string, { message: string | ((k: number) => string); count: number; rows: number[] }>();

  /** `n` is the data row (0 for file-level changes); `by` adds to the count without a row. */
  add(code: string, n: number, message: string | ((k: number) => string), by = 1): void {
    const e = this.map.get(code) ?? { message, count: 0, rows: [] };
    e.count += by;
    if (n > 0 && e.rows.length < MAX_ROWS && e.rows[e.rows.length - 1] !== n) e.rows.push(n);
    this.map.set(code, e);
  }

  list(): CheckChange[] {
    return [...this.map.entries()].map(([code, e]) => ({
      code,
      message: typeof e.message === 'function' ? e.message(e.count) : e.message,
      count: e.count,
      rows: e.rows,
    }));
  }
}

function issue(code: string, message: string, rows: number[], count: number): CheckIssue {
  return { code, message, count, rows: rows.slice(0, MAX_ROWS) };
}

const toRow = (columns: string[], cells: string[]): Row => {
  const row: Row = {};
  columns.forEach((c, i) => {
    if (!(c in row)) row[c] = cells[i] ?? '';
  });
  return row;
};

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? word : word.endsWith('y') ? word.slice(0, -1) + 'ies' : word + 's'}`;
}
