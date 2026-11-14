import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { assignDocIds, ensureVrdu, loadVrduDocuments, parseRawDoc, parseVrduGz, templateOf, VRDU_FIELDS } from '../src/datasets/vrdu.ts';
import { splitVrdu } from '../src/datasets/vrdu-split.ts';
import { tempDir } from './helpers.ts';

const raw = (filename: string, annotations: unknown[], text = 'T') => JSON.stringify({ filename, file_path: 'x', ocr: { text, pages: [] }, annotations });
const FIXTURE = [
  raw('19410222_B Firm_Amendment_Amendment.pdf', [['registration_num', [['3712\n', [0, 0, 0, 1, 1], [[1, 2]]]]]], 'OCR  text\n'),
  raw('19410222_A Firm_Short-Form_Short-Form.pdf', [
    ['signer_name', [[' Jo ', [], []], ['Jo', [], []], ['', [], []], ['Al', [], []]]],
    ['not_a_field', [['x', [], []]]],
  ]),
  raw('20100101_C Firm_Dissemination Report_Dissemination Report.pdf', []),
];

describe('vrdu parsing', () => {
  it('takes the template after the last underscore', () => {
    expect(templateOf('19410222_DLA Piper US LLP_Amendment_Amendment.pdf')).toBe('Amendment');
  });

  it('keeps trimmed, deduplicated, non-empty gold and the text unchanged', () => {
    const d = parseRawDoc(FIXTURE[1]!);
    expect(d.gold.signer_name).toEqual(['Jo', 'Al']);
    expect(d.gold.file_date).toEqual([]);
    expect(Object.keys(d.gold)).toEqual([...VRDU_FIELDS]);
    expect(parseRawDoc(FIXTURE[0]!).text).toBe('OCR  text\n');
    expect(parseRawDoc(FIXTURE[0]!).gold.registration_num).toEqual(['3712']);
  });

  it('assigns d0001.. by code-unit filename order and checks counts and templates', () => {
    const docs = assignDocIds(FIXTURE.map(parseRawDoc), 3);
    expect(docs.map((d) => [d.docId, d.filename.slice(9, 15)])).toEqual([['d0001', 'A Firm'], ['d0002', 'B Firm'], ['d0003', 'C Firm']]);
    expect(() => assignDocIds(FIXTURE.map(parseRawDoc), 1915)).toThrow(/expected 1915/);
    expect(() => assignDocIds([{ ...parseRawDoc(FIXTURE[0]!), template: 'Other' }], 1)).toThrow(/unknown template/);
    const dup = parseRawDoc(FIXTURE[0]!);
    expect(() => assignDocIds([dup, dup], 2)).toThrow(/duplicate/);
  });

  it('streams a gz, writes documents.jsonl once and rebuilds when the gz is newer', async () => {
    const dir = tempDir();
    const gz = join(dir, 'vrdu', 'dataset.jsonl.gz');
    const { mkdirSync, utimesSync, statSync } = await import('node:fs');
    mkdirSync(join(dir, 'vrdu'));
    writeFileSync(gz, gzipSync(FIXTURE.join('\n') + '\n'));
    writeFileSync(join(dir, 'vrdu', 'meta.json'), '{}');
    expect((await parseVrduGz(gz, 3)).length).toBe(3);
    const log: string[] = [];
    const path = await ensureVrdu(dir, (m) => log.push(m), { expected: 3 });
    expect(loadVrduDocuments(path).map((d) => d.docId)).toEqual(['d0001', 'd0002', 'd0003']);
    const first = statSync(path).mtimeMs;
    await ensureVrdu(dir, (m) => log.push(m), { expected: 3 });
    expect(statSync(path).mtimeMs).toBe(first);
    const future = new Date(Date.now() + 60_000);
    utimesSync(gz, future, future);
    const n = log.length;
    await ensureVrdu(dir, (m) => log.push(m), { expected: 3 });
    expect(log.length).toBeGreaterThan(n);
  });

  it('fails loudly on the wrong document count with the real default', async () => {
    const dir = tempDir();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'vrdu'));
    writeFileSync(join(dir, 'vrdu', 'dataset.jsonl.gz'), gzipSync(FIXTURE.join('\n') + '\n'));
    writeFileSync(join(dir, 'vrdu', 'meta.json'), '{}');
    await expect(ensureVrdu(dir)).rejects.toThrow(/expected 1915/);
  });
});

describe('splitVrdu', () => {
  const sizes = { 'Short-Form': 789, Amendment: 709, 'Dissemination Report': 417 };
  const docs = Object.entries(sizes).flatMap(([template, n]) => Array.from({ length: n }, (_, i) => ({ docId: `${template[0]}${i}`, template })));
  const s = splitVrdu(docs);

  it('hits the exact sizes and keeps splits disjoint', () => {
    expect([s.dev.length, s.calibration.length, s.test.length]).toEqual([30, 300, 500]);
    const all = [...s.dev, ...s.calibration, ...s.test];
    expect(new Set(all).size).toBe(830);
    for (const l of [s.dev, s.calibration, s.test]) expect(l).toEqual([...l].sort());
  });

  it('is proportional per template and accounts for every document', () => {
    for (const split of ['dev', 'calibration', 'test'] as const) {
      expect(Object.values(s.templates).reduce((n, t) => n + t[split], 0)).toBe(s.sizes[split]);
    }
    expect(s.templates['Short-Form']).toEqual({ dev: 12, calibration: 124, test: 206, unused: 447 });
    for (const [t, c] of Object.entries(s.templates)) expect(c.dev + c.calibration + c.test + c.unused).toBe(sizes[t as keyof typeof sizes]);
    const tmpl = new Map(docs.map((d) => [d.docId, d.template]));
    expect(s.dev.filter((id) => tmpl.get(id) === 'Amendment')).toHaveLength(s.templates.Amendment!.dev);
  });

  it('is deterministic, input-order independent, and seed dependent', () => {
    expect(JSON.stringify(splitVrdu(docs))).toBe(JSON.stringify(s));
    expect(JSON.stringify(splitVrdu([...docs].reverse()))).toBe(JSON.stringify(s));
    expect(splitVrdu(docs, { seed: 1, dev: 30, calibration: 300, test: 500 }).test).not.toEqual(s.test);
    expect(s.seed).toBe(20261114);
  });

  it('rejects splits larger than the corpus', () => {
    expect(() => splitVrdu(docs.slice(0, 10))).toThrow();
  });
});
