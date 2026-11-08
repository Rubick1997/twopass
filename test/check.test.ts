import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  checkCsv,
  CheckFailedError,
  detectDelimiter,
  formatCheckSummary,
  isIban,
  luhn,
  type CheckOptions,
  type CheckReport,
} from '../src/check.ts';
import type { FetchFn } from '../src/http.ts';
import type { RowOutcome } from '../src/pipeline.ts';
import { escapeCell, writeOutputs } from '../src/report.ts';
import { loadRun } from '../src/run.ts';
import { startRun } from '../src/runner.ts';
import { defineTask, loadTask, type TaskDefinition } from '../src/task.ts';
import { mockFetch, tempDir } from './helpers.ts';

const LABELS = ['card_arrival', 'card_linking', 'lost_or_stolen_card'] as const;

function makeTask(over: Partial<TaskDefinition> = {}, writer: Partial<TaskDefinition['writer']> = {}): TaskDefinition {
  return defineTask({
    name: 't',
    idColumn: 'id',
    state: (row) => row.text ?? '',
    writer: { promptTemplate: 'Message: {{text}}', maxTokens: 20, outputSchema: z.enum(LABELS), ...writer },
    verify: { instructions: 'Is the label right?' },
    models: { writer: 'w:batch', escalation: 'e:batch', decision: 'd' },
    ...over,
  });
}

/** No model list: the context check reports "skipped" (without the retry delay a failing fetch has). */
const offline = { loadModels: () => Promise.reject(new Error('offline')) };

function writeCsv(content: string | Uint8Array, name = 'in.csv'): string {
  const path = join(tempDir(), name);
  writeFileSync(path, content);
  return path;
}

async function check(content: string | Uint8Array, opts: CheckOptions = {}, task = makeTask()) {
  return checkCsv(writeCsv(content), task, { ...(opts.fetch ? {} : offline), ...opts });
}

const codes = (xs: Array<{ code: string }>) => xs.map((x) => x.code);
const find = (xs: CheckReport['errors'], code: string) => xs.find((x) => x.code === code)!;
const fixture = (name: string) => join(import.meta.dirname, 'fixtures', name);

describe('checkCsv: encoding and delimiters', () => {
  it('detects ";" and ignores delimiters inside quotes', async () => {
    const { report, rows } = await checkCsv(fixture('semicolon.csv'), makeTask(), offline);
    expect(report.input).toMatchObject({ delimiter: ';', delimiterSource: 'detected', columns: ['id', 'text', 'label'] });
    expect(report.errors).toEqual([]);
    expect(rows[1]).toEqual({ id: 'r2', text: 'Karte; gesperrt', label: 'lost_or_stolen_card' });
  });

  it('detects tab and pipe', async () => {
    expect((await check('id\ttext\nr1\thello, world\nr2\tbye, now\n')).report.input.delimiter).toBe('\t');
    expect((await check('id|text\nr1|a, b; c\nr2|d\n')).report.input.delimiter).toBe('|');
    expect(detectDelimiter('a,b,c\n"x;y",2,3\n')).toBe(',');
  });

  it('lets --delimiter override detection', async () => {
    const { report } = await checkCsv(fixture('semicolon.csv'), makeTask(), { ...offline, delimiter: ',' });
    expect(report.input).toMatchObject({ delimiter: ',', delimiterSource: 'option', columns: ['id;text;label'] });
    expect(codes(report.errors)).toContain('missing_column');
  });

  it('falls back to windows-1252 and records the conversion', async () => {
    const { report, rows } = await checkCsv(fixture('windows-1252.csv'), makeTask(), offline);
    expect(report.input.encoding).toBe('windows-1252');
    expect(rows[0]!.text).toBe('Café card €5');
    expect(codes(report.changes)).toContain('converted_encoding');
    expect(formatCheckSummary(report)).toContain('encoding windows-1252 → utf-8');
  });

  it('strips a BOM', async () => {
    const { report, columns } = await checkCsv(fixture('bom.csv'), makeTask(), offline);
    expect(columns[0]).toBe('id');
    expect(report.errors).toEqual([]);
    expect(codes(report.changes)).toContain('removed_bom');
  });

  it('refuses empty, UTF-16 and binary input', async () => {
    expect(codes((await check('')).report.errors)).toEqual(['empty_file']);
    expect(codes((await check('\n  \n')).report.errors)).toEqual(['empty_file']);
    expect(codes((await check(new Uint8Array([0xff, 0xfe, 0x69, 0x00]))).report.errors)).toEqual(['not_decodable']);
    expect(codes((await check(new Uint8Array([0x69, 0x64, 0x00, 0x0a]))).report.errors)).toEqual(['not_decodable']);
  });
});

describe('checkCsv: structure', () => {
  it('reports ragged rows by 1-based data row number, not counting the header or removed empty rows', async () => {
    const { report } = await check('id,text\nr1,a\n,\nr3,b,extra\nr4\nr5,c\n');
    const e = find(report.errors, 'ragged_rows');
    expect(e.rows).toEqual([3, 4]);
    expect(e.message).toContain('row 3 has 3');
    expect(report.rowNumbering).toBe('1-based data rows, header excluded');
    expect(find(report.changes, 'removed_empty_rows').rows).toEqual([2]);
  });

  it('reports empty and duplicate column names', async () => {
    const { report } = await check('id,text, text ,\nr1,a,b,c\n');
    expect(codes(report.errors)).toEqual(expect.arrayContaining(['empty_column_name', 'duplicate_column_names']));
    expect(find(report.errors, 'duplicate_column_names').message).toContain('"text"');
    expect(find(report.errors, 'empty_column_name').message).toContain('column 4');
    expect(codes(report.changes)).toContain('normalized_header');
  });

  it('suggests close matches for a missing template column', async () => {
    const task = makeTask({ idColumn: undefined }, { promptTemplate: 'Item: {{description}} ({{Price}})' });
    const { report } = await check('desc,title,price\na,b,1\n', {}, task);
    const msgs = report.errors.filter((e) => e.code === 'missing_column').map((e) => e.message);
    expect(msgs).toEqual([
      'column "description" used by the prompt is missing. Did you mean "desc"? (found: desc, title, price)',
      'column "Price" used by the prompt is missing. Did you mean "price"? (found: desc, title, price)',
    ]);
  });

  it('requires the escalation template columns and inputColumns, but not previous_answer', async () => {
    const task = makeTask(
      { inputColumns: ['channel'] },
      { escalation: { template: '{{text}} {{lang}} was {{previous_answer}}' } },
    );
    const { report } = await check('id,text\nr1,a\n', {}, task);
    expect(report.errors.map((e) => e.message.split('.')[0])).toEqual([
      'column "lang" used by the escalation prompt is missing',
      'column "channel" listed in the task\'s inputColumns is missing',
    ]);
  });

  it('refuses empty and duplicate ids', async () => {
    const { report } = await check('id,text\nr1,a\n,b\nr1,c\nr2,d\nr2,e\n');
    expect(find(report.errors, 'empty_id').rows).toEqual([2]);
    expect(find(report.errors, 'duplicate_id')).toMatchObject({ count: 2, rows: [3, 5] });
  });

  it('refuses a file with no data rows', async () => {
    expect(codes((await check('id,text\n\n,\n')).report.errors)).toEqual(['no_rows']);
  });
});

describe('checkCsv: normalization', () => {
  it('cleans cells: line endings, NFC, zero-width and control characters, whitespace', async () => {
    const decomposed = 'Café';
    const { report, rows } = await check(`id,text\nr1,"  line one\r\nline two "\nr2,${decomposed}\nr3,a​b⁠c\nr4,x\u0007y\tz\n`);
    expect(rows.map((r) => r.text)).toEqual(['line one\nline two', 'Café', 'abc', 'xy\tz']);
    const byCode = Object.fromEntries(report.changes.map((c) => [c.code, c.rows]));
    expect(byCode).toMatchObject({
      normalized_line_endings: [1],
      trimmed_cells: [1],
      normalized_unicode: [2],
      removed_invisible_chars: [3],
      removed_control_chars: [4],
    });
  });

  it('caps sample row numbers at 20 while counting all', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `r${i}, padded `);
    const { report } = await check(`id,text\n${lines.join('\n')}\n`);
    expect(find(report.changes as never, 'trimmed_cells')).toMatchObject({ count: 30 });
    expect(find(report.changes as never, 'trimmed_cells').rows).toHaveLength(20);
  });

  it('never modifies the input file', async () => {
    const path = writeCsv('id,text\n r1 , a \n');
    const before = readFileSync(path);
    await checkCsv(path, makeTask(), offline);
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});

describe('checkCsv: labels', () => {
  it('maps labels with exactly one canonical match and logs it', async () => {
    const { report, rows } = await check('id,text,label\nr1,a,Card Arrival\nr2,b,card-linking\nr3,c,card_arrival\n', { labelColumn: 'label' });
    expect(report.errors).toEqual([]);
    expect(rows.map((r) => r.label)).toEqual(['card_arrival', 'card_linking', 'card_arrival']);
    expect(find(report.changes as never, 'mapped_labels')).toMatchObject({ count: 2, rows: [1, 2] });
  });

  it('refuses unknown and ambiguous labels, listing distinct values with counts', async () => {
    const task = makeTask({}, { outputSchema: z.enum(['card_arrival', 'Card-Arrival', 'other']) });
    const { report } = await check('id,text,label\nr1,a,card arrival\nr2,b,refund\nr3,c,refund\n', { labelColumn: 'label' }, task);
    const e = find(report.errors, 'invalid_labels');
    expect(e.rows).toEqual([1, 2, 3]);
    expect(e.message).toContain('"refund" ×2');
    expect(e.message).toContain('"card arrival" ×1 (ambiguous: card_arrival, Card-Arrival)');
  });

  it('never prints a bad label value that looks like personal data', async () => {
    const { report } = await check('id,text,label\nr1,a,jane.doe@example.com\nr2,b,card_arrival\n', { labelColumn: 'label' });
    const e = find(report.errors, 'invalid_labels');
    expect(e.rows).toEqual([1]);
    expect(e.message).toContain('<redacted: possible personal data>');
    expect(JSON.stringify(report) + formatCheckSummary(report)).not.toContain('jane.doe');
  });

  it('validates non-enum schemas with parseOutput and does not map', async () => {
    const task = makeTask({}, { outputSchema: z.string().regex(/^[a-z]+$/) });
    const { report } = await check('id,text,label\nr1,a,ok\nr2,b,Not Ok\n', { labelColumn: 'label' }, task);
    expect(find(report.errors, 'invalid_labels').rows).toEqual([2]);
    expect(codes(report.changes)).not.toContain('mapped_labels');
  });

  it('refuses a missing label column', async () => {
    const { report } = await check('id,text,Label\nr1,a,card_arrival\n', { labelColumn: 'label' });
    expect(find(report.errors, 'missing_label_column').message).toContain('Did you mean "Label"?');
  });

  it('warns about calibration readiness', async () => {
    const { report } = await check('id,text,label\nr1,a,card_arrival\nr2,b,card_linking\nr3,c,\n', { labelColumn: 'label' });
    expect(codes(report.warnings)).toEqual(expect.arrayContaining(['few_labeled_rows', 'rare_labels', 'empty_labels']));
    expect(find(report.warnings, 'rare_labels').message).toContain('card_arrival ×1');
  });
});

describe('checkCsv: warnings', () => {
  it('warns about empty required values and duplicate inputs', async () => {
    const { report } = await check('id,text\nr1,hello\nr2,\nr3,hello\nr4,bye\nr5,hello\n');
    expect(find(report.warnings, 'empty_required_values').rows).toEqual([2]);
    expect(find(report.warnings, 'duplicate_inputs')).toMatchObject({ count: 2, rows: [3, 5] });
    expect(report.errors).toEqual([]);
  });

  it('finds possible personal data by checksum and never prints the values', async () => {
    const secrets = {
      email: 'jane.doe@example.com',
      phone: '+44 20 7946 0958',
      card: '4111 1111 1111 1111',
      iban: 'GB82 WEST 1234 5698 7654 32',
    };
    const notSecrets = ['4111 1111 1111 1112', 'GB82 WEST 1234 5698 7654 33'];
    const csv = [
      'id,text',
      `r1,write to ${secrets.email}`,
      `r2,call ${secrets.phone}`,
      `r3,my card ${secrets.card} was charged`,
      `r4,pay to ${secrets.iban} please`,
      `r5,bad card ${notSecrets[0]}`,
      `r6,bad iban ${notSecrets[1]}`,
      'r7,order 2026-11-06 for 12.50',
    ].join('\n');
    const { report } = await check(csv);
    const pii = Object.fromEntries(report.warnings.filter((w) => w.code.startsWith('possible_pii_')).map((w) => [w.code, w.rows]));
    expect(pii).toEqual({
      possible_pii_card: [3],
      possible_pii_email: [1],
      possible_pii_iban: [4],
      possible_pii_phone: [2],
    });
    expect(find(report.warnings, 'possible_pii_email').message).toContain('no zero data retention');
    const printed = JSON.stringify(report) + formatCheckSummary(report);
    for (const v of [...Object.values(secrets), ...notSecrets]) {
      expect(printed).not.toContain(v);
      expect(printed).not.toContain(v.replace(/ /g, ''));
    }
  });

  it('implements Luhn and IBAN mod-97', () => {
    expect(luhn('4111111111111111')).toBe(true);
    expect(luhn('4111111111111112')).toBe(false);
    expect(isIban('DE89 3704 0044 0532 0130 00')).toBe(true);
    expect(isIban('DE89 3704 0044 0532 0130 01')).toBe(false);
  });

  it('warns about formula-like cells but not negative numbers', async () => {
    const { report } = await check('id,text\nr1,=SUM(A1)\nr2,-12.5\nr3,@cmd\nr4,-cmd\nr5,+1\nr6,plain\n');
    expect(find(report.warnings, 'formula_injection').rows).toEqual([1, 3, 4, 5]);
  });
});

describe('checkCsv: context length', () => {
  const models = (ctx: Record<string, number | null>) =>
    mockFetch(() => [
      200,
      { data: Object.entries(ctx).map(([id, context_length]) => ({ id, context_length, pricing: { prompt: '0', completion: '0' } })) },
    ]);

  it('refuses rows estimated over a model context length (chars / 3 + max_tokens)', async () => {
    const long = 'x'.repeat(300);
    const m = models({ 'w:batch': 100, 'e:batch': 100_000 });
    const { report } = await check(`id,text\nr1,short\nr2,${long}\n`, { fetch: m.fetch });
    expect(m.calls).toHaveLength(2); // the model list and the decision-model list
    const e = find(report.errors, 'context_too_long');
    expect(e.rows).toEqual([2]);
    expect(e.message).toContain('w:batch: 100 tokens');
    expect(report.info).toEqual([expect.objectContaining({ code: 'context_length_unknown', message: expect.stringContaining('d') })]);
  });

  it('skips the check with an info line when the model list is unavailable', async () => {
    const failing: FetchFn = async () => {
      throw new Error('network down');
    };
    const { report } = await checkCsv(writeCsv('id,text\nr1,a\n'), makeTask(), { fetch: failing });
    expect(report.errors).toEqual([]);
    expect(codes(report.info)).toEqual(['context_check_skipped']);
  });

  it('does not fetch at all when the CSV already has errors', async () => {
    const m = models({});
    await check('id,other\nr1,a\n', { fetch: m.fetch });
    expect(m.calls).toHaveLength(0);
  });
});

describe('Banking77', () => {
  it('a Banking77-shaped fixture passes the real task with no errors', async () => {
    const task = await loadTask('tasks/banking77.task.ts');
    const { report, rows } = await checkCsv(fixture('banking77-small.csv'), task, { labelColumn: 'label', ...offline });
    expect(report.errors).toEqual([]);
    expect(rows).toHaveLength(12);
    expect(report.input).toMatchObject({ encoding: 'utf-8', delimiter: ',', columns: ['id', 'text', 'label'] });
  });
});

describe('writeOutputs escaping', () => {
  it('prefixes formula-like cells with an apostrophe and leaves negative numbers alone', () => {
    expect(['=1+1', '+1', '@x', '\tx', '\rx', '-x', '-12.5', '-3', 'a=b'].map(escapeCell)).toEqual([
      "'=1+1",
      "'+1",
      "'@x",
      "'\tx",
      "'\rx",
      "'-x",
      '-12.5',
      '-3',
      'a=b',
    ]);
    const dir = tempDir();
    const outcome = {
      id: 'r1',
      data: { text: '=HYPERLINK("x")', amount: '-12.5' },
      answer: '-cmd',
      confidence: 0.9,
      verdict: 'supported',
      model: 'm',
      round: 1,
      costUsd: 0,
      status: 'flagged',
    } as unknown as RowOutcome;
    writeOutputs(dir, [outcome], ['text', 'amount']);
    for (const f of ['enriched.csv', 'review.csv']) {
      const line = readFileSync(join(dir, f), 'utf8').split('\n')[1]!;
      expect(line).toBe(`"'=HYPERLINK(""x"")",-12.5,'-cmd,0.9000,supported,m,1,0.000000,flagged,,'-cmd,`); // final_answer escaped too
    }
  });
});

describe('startRun runs the check first', () => {
  function setup() {
    const root = tempDir();
    return { root, taskPath: 'tasks/banking77.task.ts', runsRoot: join(root, 'runs') };
  }

  it('makes zero HTTP calls and creates no run directory when the CSV has errors', async () => {
    const { root, taskPath, runsRoot } = setup();
    const csvPath = join(root, 'bad.csv');
    writeFileSync(csvPath, 'id,message,label\nr1,where is my card,card_arrival\n');
    const failOnCall: FetchFn = async (url) => {
      throw new Error(`unexpected HTTP call to ${String(url)}`);
    };
    const err = await startRun({ apiKey: 'k', runsRoot, csvPath, taskPath, labelColumn: 'label', fetch: failOnCall }).catch((e) => e);
    expect(err).toBeInstanceOf(CheckFailedError);
    expect(err.message).toContain('✗ column "text" used by the prompt is missing');
    expect(err.message).toContain('Nothing was sent to any model');
    expect(existsSync(runsRoot)).toBe(false);
  });

  it('writes the normalized input, the report and the manifest entry, and prints warnings', async () => {
    const { root, taskPath, runsRoot } = setup();
    const csvPath = join(root, 'ok.csv');
    writeFileSync(csvPath, 'id;text;label\nr1; where is my card ;Card Arrival\nr2;where is my card;card_arrival\n');
    const m = mockFetch(() => [
      200,
      {
        data: ['anthropic/claude-haiku-5.5:batch', 'anthropic/claude-sonnet-5.5:batch'].map((id) => ({
          id,
          context_length: 1_000_000,
          pricing: { prompt: '0.000001', completion: '0.000005' },
        })),
      },
    ]);
    const logs: string[] = [];
    const { dir, manifest } = await startRun({
      apiKey: 'k',
      runsRoot,
      csvPath,
      taskPath,
      labelColumn: 'label',
      fetch: m.fetch,
      log: (l) => logs.push(l),
    });
    expect(m.calls).toHaveLength(2); // one model-list fetch (regular + decision models) serves the check and the prices
    expect(readdirSync(dir)).toEqual(expect.arrayContaining(['normalized.csv', 'check-report.json', 'rows.jsonl', 'manifest.json']));
    const report = JSON.parse(readFileSync(join(dir, 'check-report.json'), 'utf8')) as CheckReport;
    expect(report.output.path).toBe(join(dir, 'normalized.csv'));
    expect(manifest.input).toEqual({
      originalSha256: report.input.sha256,
      normalizedSha256: report.output.sha256,
      checkReport: 'check-report.json',
      warnings: report.warnings.length,
    });
    expect(loadRun(dir).records.map((r) => r.data)).toEqual([
      { id: 'r1', text: 'where is my card', label: 'card_arrival' },
      { id: 'r2', text: 'where is my card', label: 'card_arrival' },
    ]);
    expect(logs.join('\n')).toContain('⚠ 1 duplicate input');
    expect(manifest.prices['anthropic/claude-haiku-5.5:batch']).toEqual({ inputPerToken: 0.000001, outputPerToken: 0.000005 });
  });
});
