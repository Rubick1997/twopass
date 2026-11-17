import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'csv-parse/sync';
import { NEVER } from '../src/calibrate.ts';
import { runVrduBench } from '../src/bench-vrdu.ts';
import { computeFieldOutcomes } from '../src/extract/outcomes.ts';
import { loadFieldReport, readRunState } from '../src/extract/review.ts';
import { loadRun } from '../src/run.ts';
import { toyTask } from './extract-helpers.ts';
import { BadRequestError, getReview, NotFoundError, postOutputs, postOverride } from '../src/ui/api.ts';
import type { ExtractOverrideResponse, ExtractReviewResponse } from '../src/ui/api-types.ts';
import { installFakeApi, setup } from './vrdu-bench-helpers.ts';

// The bench fixture: 30 documents d01..d30. The cheap writer gives garbage for n % 7 == 0 and a wrong b for n % 3 == 0;
// the strong writer is always right. Calibration = d01..d15, test = d16..d30.

afterEach(() => vi.unstubAllGlobals());

async function bench() {
  installFakeApi();
  const { root, options } = setup();
  const { benchDir } = await runVrduBench(options());
  const state = JSON.parse(readFileSync(join(benchDir, 'bench.json'), 'utf8'));
  return { root, runsRoot: join(root, 'runs'), benchDir, state };
}

/**
 * The fixture's checker accepts everything the strong writer says, so nothing is flagged. Make round 2 refuse
 * (t2 = never): the fields round 1 did not accept, which the ledger holds round-2 answers for, are flagged.
 * Returns how many that is. (A stricter t1 could not be replayed: the ledger has no round-2 answers for it.)
 */
function flagAll(runsRoot: string, runId: string): number {
  const path = join(runsRoot, runId, 'manifest.json');
  const m = JSON.parse(readFileSync(path, 'utf8'));
  m.thresholds = { ...m.thresholds, t2: NEVER };
  writeFileSync(path, JSON.stringify(m));
  return computeFieldOutcomes(readRunState(join(runsRoot, runId)), { task: toyTask, rows: loadRun(join(runsRoot, runId)).records, thresholds: m.thresholds, mode: 'normal' }).filter((o) => o.status === 'flagged').length;
}

const review = async (runsRoot: string, id: string, filter: string | null = null) => (await getReview(runsRoot, id, filter)) as ExtractReviewResponse;
const post = async (runsRoot: string, id: string, body: unknown) => (await postOverride(runsRoot, id, body)) as ExtractOverrideResponse;

describe('GET /api/runs/:id/review for an extraction run', () => {
  it('lists the flagged fields with values, verdicts, spans and the document text once', async () => {
    const { runsRoot, state } = await bench();
    const normal = state.testRuns.normal as string;
    const n = flagAll(runsRoot, normal);
    expect(n).toBeGreaterThan(5);
    const r = await review(runsRoot, normal);
    expect(r).toMatchObject({ kind: 'extract', filter: 'flagged', fields: ['a', 'b', 'c'], labelColumn: 'gold', running: false });
    expect(r.counts).toMatchObject({ fields: 45, flagged: n, reviewed: 0, remaining: n, documents: 15 });
    expect(r.items).toHaveLength(n);
    expect(r.items.every((i) => i.pipelineStatus === 'flagged' && i.review === null)).toBe(true);
    expect(r.accuracy).toMatchObject({ of: 45 }); // every slot has a label and none is pending
    // the text goes once per document, not per field
    expect(Object.keys(r.documents).sort()).toEqual([...new Set(r.items.map((i) => i.docId))].sort());
    expect(Object.keys(r.documents).length).toBeLessThan(r.items.length);

    const first = r.items[0]!;
    expect(r.documents[first.docId]).toContain('line two  with  gaps');
    expect(first.round1).toMatchObject({ round: 1 });
    expect(first.expected).not.toBeNull();
    // every item has its round-1 value; when the stronger writer ran, round 2 is there with probabilities
    const twoRounds = r.items.find((i) => i.round2);
    expect(twoRounds?.round2?.probabilities).toMatchObject({ supported: expect.any(Number) });
    // a value is highlighted where it appears in the document
    const withSpan = r.items.find((i) => i.round1!.spans.length);
    if (withSpan) {
      const [a, b] = withSpan.round1!.spans[0]!;
      expect(r.documents[withSpan.docId]!.slice(a, b).toLowerCase()).toBe(withSpan.round1!.value!.toLowerCase());
    }
  });

  it('filters: reviewed shows only decided fields, all shows every slot; anything else is a 400', async () => {
    const { runsRoot, state } = await bench();
    const normal = state.testRuns.normal as string;
    expect((await review(runsRoot, normal, 'all')).items).toHaveLength(45);
    expect((await review(runsRoot, normal, 'reviewed')).items).toHaveLength(0);
    await expect(getReview(runsRoot, normal, 'nope')).rejects.toBeInstanceOf(BadRequestError);
  });

  it('takes the thresholds the bench report used (bench.json refit) rather than the manifest’s', async () => {
    const { runsRoot, benchDir, state } = await bench();
    const normal = state.testRuns.normal as string;
    const n = flagAll(runsRoot, normal); // the manifest says: round 2 accepts nothing
    expect((await review(runsRoot, normal)).counts.flagged).toBe(n);
    const bj = JSON.parse(readFileSync(join(benchDir, 'bench.json'), 'utf8'));
    bj.refit = { at: 'x', previousThresholds: { t0: NEVER, t1: NEVER, t2: NEVER }, thresholds: { ...JSON.parse(readFileSync(join(runsRoot, normal, 'manifest.json'), 'utf8')).thresholds, t2: 0.5 }, reason: 'test' };
    writeFileSync(join(benchDir, 'bench.json'), JSON.stringify(bj));
    expect((await review(runsRoot, normal)).counts.flagged).toBe(0);
  });

  it('works on the baseline run (nothing flagged) and the calibration run', async () => {
    const { runsRoot, state } = await bench();
    expect((await review(runsRoot, state.testRuns.baseline)).items).toHaveLength(0);
    expect((await review(runsRoot, state.calibrationRunId, 'all')).counts.documents).toBe(15);
  });
});

describe('POST /api/runs/:id/overrides and /outputs for an extraction run', () => {
  it('records a decision per field, folds it, and rejects what the task does not allow', async () => {
    const { runsRoot, state } = await bench();
    const normal = state.testRuns.normal as string;
    flagAll(runsRoot, normal);
    const r = await review(runsRoot, normal);
    const item = r.items.find((i) => i.acceptable)!;
    const other = r.items.find((i) => i.docId === item.docId && i.field !== item.field);

    const res = await post(runsRoot, normal, { rowId: item.docId, field: item.field, action: 'override', answer: null, note: 'checked' });
    expect(res.item).toMatchObject({ status: 'reviewed', finalValue: null, review: { action: 'override', value: null, previous: item.value, note: 'checked', stale: false } });
    expect(res.counts).toMatchObject({ reviewed: 1, remaining: r.counts.remaining - 1, overridden: item.value === null ? 0 : 1 });
    if (other) expect((await review(runsRoot, normal)).items.find((i) => i.field === other.field && i.docId === other.docId)!.review).toBeNull(); // per field

    expect((await review(runsRoot, normal, 'reviewed')).items.map((i) => [i.docId, i.field])).toEqual([[item.docId, item.field]]);
    const undone = await post(runsRoot, normal, { rowId: item.docId, field: item.field, action: 'clear' });
    expect(undone.item.review).toBeNull();
    expect(undone.counts.reviewed).toBe(0);

    const bad = (body: unknown) => expect(postOverride(runsRoot, normal, body)).rejects;
    await (await bad({ rowId: item.docId, action: 'accept' })).toBeInstanceOf(BadRequestError); // field required
    await (await bad({ rowId: item.docId, field: 'zzz', action: 'accept' })).toBeInstanceOf(BadRequestError);
    await (await bad({ rowId: item.docId, field: item.field, action: 'override', answer: 'x'.repeat(2001) })).toBeInstanceOf(BadRequestError);
    await (await bad({ rowId: item.docId, field: item.field, action: 'override', answer: ' ' })).toBeInstanceOf(BadRequestError);
    await (await bad({ rowId: item.docId, field: item.field, action: 'accept', extra: 1 })).toBeInstanceOf(BadRequestError);
    await (await bad({ rowId: 'nope', field: item.field, action: 'accept' })).toBeInstanceOf(NotFoundError);
  });

  it('writes enriched-fields.csv with the three review columns, and report numbers agree', async () => {
    const { runsRoot, state } = await bench();
    const normal = state.testRuns.normal as string;
    flagAll(runsRoot, normal);
    const r = await review(runsRoot, normal);
    const [a, b] = r.items;
    await post(runsRoot, normal, { rowId: a!.docId, field: a!.field, action: 'override', answer: 'FIXED' });
    if (b!.acceptable) await post(runsRoot, normal, { rowId: b!.docId, field: b!.field, action: 'accept' });
    const out = await postOutputs(runsRoot, normal);
    expect(out.written).toEqual(['enriched-fields.csv']);
    const rows = parse(readFileSync(join(runsRoot, normal, 'enriched-fields.csv'), 'utf8'), { columns: true }) as Array<Record<string, string>>;
    expect(rows).toHaveLength(45);
    expect(Object.keys(rows[0]!).slice(-3)).toEqual(['reviewed_by_human', 'final_value', 'review_note']);
    expect(rows.filter((x) => x.reviewed_by_human === 'overridden')).toEqual([expect.objectContaining({ doc_id: a!.docId, field: a!.field, final_value: 'FIXED' })]);

    const fr = await loadFieldReport(join(runsRoot, normal));
    expect(fr.summary.reviewed).toBe(b!.acceptable ? 2 : 1);
    expect(fr.summary.accuracy!.of).toBe(45);
  });
});

