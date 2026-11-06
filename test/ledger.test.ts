import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { customId, Ledger, parseLedger, replay } from '../src/ledger.ts';
import { tempDir } from './helpers.ts';

const decision = (rowId: string, cost: number) =>
  ({ t: 'decision', rowId, round: 0, stage: 'triage', model: 'm', answers: {}, costUsd: cost, latencyMs: 1 }) as const;

describe('Ledger', () => {
  it('ignores a half-written last line and repairs it on reopen', () => {
    const path = join(tempDir(), 'ledger.jsonl');
    const ledger = new Ledger(path);
    ledger.append(decision('a', 0.1));
    appendFileSync(path, '{"t":"decision","rowId":"b"'); // process killed mid-write

    expect(ledger.read()).toHaveLength(1);
    const reopened = new Ledger(path);
    reopened.append(decision('c', 0.2));
    expect(reopened.read().map((e) => (e as { rowId: string }).rowId)).toEqual(['a', 'c']);
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
  });

  it('rejects corruption in the middle of the file', () => {
    expect(() => parseLedger('{"t":"decision"}\nnot json\n{"t":"decision"}\n')).toThrow(/line 2/);
  });
});

describe('replay', () => {
  it('tracks attempts, in-flight batches, results and spend', () => {
    const at = '2026-11-07T10:00:00.000Z';
    const result = (customId: string, ok: boolean, batchId: string) => ({
      t: 'batch_result' as const,
      batchId,
      round: 1 as const,
      model: 'w',
      customId,
      rowId: customId.split('#')[0]!,
      ok,
      inputTokens: 10,
      outputTokens: 2,
      costUsd: 0.001,
      at,
    });
    const st = replay([
      { ...decision('a', 0.01), at },
      { t: 'batch_submitted', round: 1, batchId: 'b1', model: 'w', customIds: ['a#r1', 'b#r1'], at },
      result('a#r1', true, 'b1'),
      result('b#r1', false, 'b1'),
      { t: 'batch_finished', batchId: 'b1', status: 'completed', costUsd: 0.0015, undecodable: 0, at },
      { t: 'batch_submitted', round: 1, batchId: 'b2', model: 'w', customIds: ['b#r1'], at },
    ]);

    expect(st.attempts.get('a#r1')).toBe(1);
    expect(st.attempts.get('b#r1')).toBe(2);
    expect(st.results.get('a#r1')?.ok).toBe(true);
    expect([...st.inFlight]).toEqual(['b#r1']);
    expect(st.spentUsd).toBeCloseTo(0.0115);
  });

  it('never replaces a successful result with a later failure', () => {
    const at = 'x';
    const base = { t: 'batch_result' as const, round: 1 as const, model: 'w', customId: 'a#r1', rowId: 'a', inputTokens: 0, outputTokens: 0, costUsd: 0, at };
    const st = replay([
      { ...base, batchId: 'b1', ok: true, text: 'yes' },
      { ...base, batchId: 'b2', ok: false, error: 'late failure' },
    ]);
    expect(st.results.get('a#r1')).toMatchObject({ ok: true, text: 'yes' });
  });
});

describe('customId', () => {
  it('uses only characters every batch provider accepts', () => {
    expect(customId('test-00042', 1)).toBe('test-00042-r1');
    for (const id of ['row #1', 'ü/ä', 'x'.repeat(200)]) {
      expect(customId(id, 2)).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }
    expect(customId('row #1', 1)).not.toBe(customId('row #2', 1));
  });
});
