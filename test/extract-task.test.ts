import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'csv-stringify/sync';
import { describe, expect, it } from 'vitest';
import { checkCsv } from '../src/check.ts';
import { VRDU_FIELDS } from '../src/datasets/vrdu.ts';
import { parseExtraction, validateTask, type TaskDefinition } from '../src/task.ts';
import vrdu from '../tasks/vrdu.task.ts';
import { toyTask } from './extract-helpers.ts';
import { tempDir } from './helpers.ts';

describe('validateTask for extract tasks', () => {
  it('forbids triage', () => {
    const bad = { ...toyTask, triage: { question: { type: 'choice', criteria: { a: 'A', cannot_tell: '?' } } } } as TaskDefinition;
    expect(() => validateTask(bad)).toThrow(/cannot have triage/);
  });

  it('requires cannot_tell on both the value and the null question of every field', () => {
    const noValue = { ...toyTask, extract: { ...toyTask.extract!, question: (f: string, v: string | null) => (v === null ? toyTask.extract!.question(f, v) : { type: 'choice' as const, criteria: { supported: 's', unsupported: 'u' } }) } };
    expect(() => validateTask(noValue)).toThrow(/a \(value\).*cannot_tell/);
    const noNull = { ...toyTask, extract: { ...toyTask.extract!, question: (f: string, v: string | null) => (v !== null ? toyTask.extract!.question(f, v) : { type: 'choice' as const, criteria: { supported: 's', unsupported: 'u' } }) } };
    expect(() => validateTask(noNull)).toThrow(/a \(null\).*cannot_tell/);
    expect(() => validateTask(toyTask)).not.toThrow();
  });
});

describe('parseExtraction', () => {
  it('returns the values in field order, with blank strings as null', () => {
    const r = parseExtraction(toyTask, JSON.stringify({ c: null, a: 'x', b: '  ' }));
    expect(r).toEqual({ ok: true, values: { a: 'x', b: null, c: null } });
  });
  it('rejects non-JSON, a missing field and a wrong type', () => {
    expect(parseExtraction(toyTask, 'hello').ok).toBe(false);
    expect(parseExtraction(toyTask, '{"a":"x","b":null}').ok).toBe(false);
    expect(parseExtraction(toyTask, '{"a":1,"b":null,"c":null}').ok).toBe(false);
  });
  it('throws for a task without extract', () => {
    const plain = { ...toyTask, extract: undefined } as TaskDefinition;
    expect(() => parseExtraction(plain, '{}')).toThrow(/no extract/);
  });
});

describe('the VRDU task', () => {
  const ex = vrdu.extract!;

  it('has the six dataset fields in order', () => {
    expect(ex.fields).toEqual([...VRDU_FIELDS]);
  });

  it('asks a value question and a null question, both with cannot_tell', () => {
    const v = ex.question('registrant_name', 'ACME LLC');
    expect(v.instructions).toBe('The writer says the registrant name (the name of the registrant entered in the form) in this document is "ACME LLC". Is that right?');
    expect(v.criteria).toEqual({
      supported: 'The document gives this value for the registrant name',
      unsupported: 'The document gives a different registrant name, or none',
      cannot_tell: 'It is not possible to tell from the document',
    });
    const n = ex.question('file_date', null);
    expect(n.instructions).toBe('The writer says this document does not state a date of signature (the date written next to the signature at the end of the form). Is that right?');
    expect(n.criteria).toEqual({
      supported: 'The document does not state a date of signature',
      unsupported: 'The document does state a date of signature',
      cannot_tell: 'It is not possible to tell from the document',
    });
  });

  it('puts the document in the checker state and the field list in the writer prompt', () => {
    expect(vrdu.verify.state!({ text: 'DOC' }, 'ignored')).toEqual({ document: 'DOC' });
    for (const f of VRDU_FIELDS) expect(vrdu.writer.system).toContain(`${f}: `);
    expect(vrdu.writer.cacheSystem).toBeUndefined();
    expect(vrdu.writer.promptTemplate).toBe('<document>\n{{text}}\n</document>\n\nExtract the six fields.');
  });

  it('writer schema accepts six nullable strings and rejects a missing key', () => {
    const all = Object.fromEntries(VRDU_FIELDS.map((f) => [f, null]));
    expect(vrdu.writer.outputSchema.safeParse(all).success).toBe(true);
    expect(vrdu.writer.outputSchema.safeParse({ ...all, file_date: undefined }).success).toBe(false);
  });

  describe('isCorrect against the gold cell', () => {
    const gold = JSON.stringify({ file_date: ['March 3, 2019'], registrant_name: ['ACME LLC'], signer_name: [], registration_num: ['6543'], foreign_principle_name: [], signer_title: [] });
    it('null is right only when the field is absent', () => {
      expect(ex.isCorrect('signer_name', null, gold)).toBe(true);
      expect(ex.isCorrect('registrant_name', null, gold)).toBe(false);
    });
    it('a value is wrong when the field is absent, right when it matches', () => {
      expect(ex.isCorrect('signer_name', 'Jane Roe', gold)).toBe(false);
      expect(ex.isCorrect('registrant_name', 'ACME LLC', gold)).toBe(true);
      expect(ex.isCorrect('registrant_name', 'Other', gold)).toBe(false);
    });
    it('matches a date after normalisation', () => {
      expect(ex.isCorrect('file_date', '3/3/2019', gold)).toBe(true);
      expect(ex.isCorrect('file_date', 'March 4, 2019', gold)).toBe(false);
    });
    it('treats a field missing from the gold map as absent', () => {
      expect(ex.isCorrect('signer_title', null, '{}')).toBe(true);
    });
  });
});

describe('check on an extract task', () => {
  const csv = (gold: string) => {
    const dir = tempDir();
    const path = join(dir, 'in.csv');
    writeFileSync(path, stringify([['doc_id', 'text', 'gold'], ['d1', 'some document', gold]]));
    return path;
  };
  it('accepts a gold cell (field -> list of strings) as the label, without enum or rare-label checks', async () => {
    const r = await checkCsv(csv('{"a":["x"],"b":[],"c":[]}'), toyTask, { labelColumn: 'gold', loadModels: async () => [] });
    expect(r.report.errors).toEqual([]);
    expect(r.report.warnings.map((w) => w.code)).not.toContain('rare_labels');
  });
  it('rejects a label that is not a gold map', async () => {
    const r = await checkCsv(csv('Amendment'), toyTask, { labelColumn: 'gold', loadModels: async () => [] });
    expect(r.report.errors.map((e) => e.code)).toContain('invalid_labels');
    const wrongKey = await checkCsv(csv('{"zzz":["x"]}'), toyTask, { labelColumn: 'gold', loadModels: async () => [] });
    expect(wrongKey.report.errors.map((e) => e.code)).toContain('invalid_labels');
  });
});
