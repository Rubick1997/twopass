// Recomputes every figure the article cites, straight from the files in runs/. No model calls, no network.
//
//   node scripts/article-figures.ts [--runs runs] [--json]
//
// The computations are exported pure functions (rows / ledger state in, numbers out); the CLI part at the
// bottom only reads files and prints. A missing run folder or file stops the script with a non-zero exit:
// it never prints a number it could not compute. All figures are about the pipeline's own answers (the
// `answer` column), never `final_answer`, and overrides.jsonl is ignored.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'csv-parse/sync';
import { asChoice } from '../src/decide/model.ts';
import { parseLedger, replay, type RunState } from '../src/ledger.ts';
import { matchesLabel } from '../src/report.ts';

// ---------------------------------------------------------------------------------------------------------
// Pure computations

/** The columns of enriched.csv these figures read. */
export interface EnrichedRow {
  id: string;
  label: string;
  /** The pipeline's own answer (not final_answer). */
  answer: string;
  status: string;
  round: string;
}

export interface Ratio {
  count: number;
  of: number;
  /** count / of as a fraction, unrounded; NaN when of is 0. */
  fraction: number;
}

export const ratio = (count: number, of: number): Ratio => ({ count, of, fraction: of === 0 ? NaN : count / of });

/** Percentage with one decimal, e.g. "94.3%". */
export const pct1 = (fraction: number): string => (Number.isNaN(fraction) ? 'n/a' : `${(fraction * 100).toFixed(1)}%`);

export const describe = (r: Ratio): string => `${r.count.toLocaleString('en-US')} of ${r.of.toLocaleString('en-US')} (${pct1(r.fraction)})`;

const isRight = (r: EnrichedRow): boolean => matchesLabel(r.answer, r.label);

export function indexById(rows: readonly EnrichedRow[], source = 'rows'): Map<string, EnrichedRow> {
  const m = new Map<string, EnrichedRow>();
  for (const r of rows) {
    if (m.has(r.id)) throw new Error(`${source}: duplicate id ${r.id}`);
    m.set(r.id, r);
  }
  return m;
}

/** Figure 1: rows the pipeline flagged, and on how many of them its own answer equals the label. */
export function flaggedRight(rows: readonly EnrichedRow[]): { flagged: number; right: Ratio } {
  const flagged = rows.filter((r) => r.status === 'flagged');
  return { flagged: flagged.length, right: ratio(flagged.filter(isRight).length, flagged.length) };
}

/** Figure 2: rows accepted in round 1 or 2 (after a rewrite) rather than by round-0 triage, and how many are right. */
export function acceptedAfterRewrite(rows: readonly EnrichedRow[]): { accepted: number; right: Ratio } {
  const rewritten = rows.filter((r) => r.status === 'accepted' && (r.round === '1' || r.round === '2'));
  return { accepted: rewritten.length, right: ratio(rewritten.filter(isRight).length, rewritten.length) };
}

/** Figure 3: accuracy of the full pipeline with no human (every row, flagged ones included, by its own answer). */
export function pipelineAccuracy(rows: readonly EnrichedRow[]): Ratio {
  return ratio(rows.filter(isRight).length, rows.length);
}

/**
 * Figure 3: accuracy of the checker's first pick alone: the round-0 triage choice of every row, whatever its
 * confidence and whether or not triage accepted it. `cannot_tell` and a missing triage decision count as wrong.
 */
export function triageTop1(st: Pick<RunState, 'triage'>, rows: readonly EnrichedRow[]): Ratio & { missing: number } {
  let right = 0;
  let missing = 0;
  for (const r of rows) {
    const ev = st.triage.get(r.id);
    if (!ev) {
      missing++;
      continue;
    }
    const choice = asChoice(ev.answers.answer)?.choice ?? '';
    if (matchesLabel(choice, r.label)) right++;
  }
  return { ...ratio(right, rows.length), missing };
}

export interface Pairwise {
  /** Ids present in both runs: the only rows compared. */
  shared: number;
  onlyA: number;
  onlyB: number;
  aRight: Ratio;
  bRight: Ratio;
  /** A right and B wrong. */
  aWins: number;
  /** B right and A wrong. */
  bWins: number;
  bothRight: number;
  bothWrong: number;
}

/** Figure 4: accuracy of two runs and the win/loss counts, on the ids both contain (joined by id). */
export function pairwise(a: readonly EnrichedRow[], b: readonly EnrichedRow[]): Pairwise {
  const ia = indexById(a, 'run A');
  const ib = indexById(b, 'run B');
  let shared = 0;
  let aRight = 0;
  let bRight = 0;
  let aWins = 0;
  let bWins = 0;
  let bothRight = 0;
  let bothWrong = 0;
  for (const [id, ra] of ia) {
    const rb = ib.get(id);
    if (!rb) continue;
    shared++;
    const x = isRight(ra);
    const y = isRight(rb);
    if (x) aRight++;
    if (y) bRight++;
    if (x && y) bothRight++;
    else if (x) aWins++;
    else if (y) bWins++;
    else bothWrong++;
  }
  return {
    shared,
    onlyA: ia.size - shared,
    onlyB: ib.size - shared,
    aRight: ratio(aRight, shared),
    bRight: ratio(bRight, shared),
    aWins,
    bWins,
    bothRight,
    bothWrong,
  };
}

const normAnswer = (s: string): string => s.trim().toLowerCase();

/**
 * Figure 5: share of shared ids on which two runs' `answer` differ (case and edge whitespace ignored, as in label
 * matching; two empty answers count as the same). Ids in only one run are not compared; `shared` is the denominator.
 */
export function disagreement(a: readonly EnrichedRow[], b: readonly EnrichedRow[]): Ratio & { onlyA: number; onlyB: number } {
  const ia = indexById(a, 'run A');
  const ib = indexById(b, 'run B');
  let shared = 0;
  let differ = 0;
  for (const [id, ra] of ia) {
    const rb = ib.get(id);
    if (!rb) continue;
    shared++;
    if (normAnswer(ra.answer) !== normAnswer(rb.answer)) differ++;
  }
  return { ...ratio(differ, shared), onlyA: ia.size - shared, onlyB: ib.size - shared };
}

/** Figure 6: share of rows with status `flagged` (sent to a person). */
export function flaggedShare(rows: readonly EnrichedRow[]): Ratio {
  return ratio(rows.filter((r) => r.status === 'flagged').length, rows.length);
}

const roundCents = (usd: number): number => Math.round(usd * 100) / 100;

/** Figure 8: how many times cheaper `cheap` is than `dear`, from the exact costs and from the costs rounded to cents. */
export function costRatio(dearUsd: number, cheapUsd: number): { unrounded: number; rounded: number; dearCents: number; cheapCents: number } {
  const dearCents = roundCents(dearUsd);
  const cheapCents = roundCents(cheapUsd);
  return { unrounded: dearUsd / cheapUsd, rounded: dearCents / cheapCents, dearCents, cheapCents };
}

export interface ParaphraseAnswer {
  model: string;
  id: string;
  variant: string;
  answer: unknown;
}

/**
 * Figure 7: accuracy on the original and the paraphrased wording of the same messages, and the drop (original minus
 * paraphrase). `originalChoices` are the round-0 choices on the original wording (id -> choice, from a run's triage
 * decisions); the paraphrased choices come from the test's own answers.jsonl lines for `model`. A `cannot_tell` or
 * a missing answer counts as wrong. Only ids that have a paraphrase answer are scored.
 */
export function paraphraseDrop(
  originalChoices: ReadonlyMap<string, string>,
  answers: readonly ParaphraseAnswer[],
  labels: ReadonlyMap<string, string>,
  model: string,
): { original: Ratio; paraphrase: Ratio; drop: number; ids: number } {
  const para = new Map<string, string>();
  for (const a of answers) {
    if (a.model !== model || a.variant !== 'paraphrase') continue;
    para.set(a.id, asChoice(a.answer as Parameters<typeof asChoice>[0])?.choice ?? '');
  }
  const ids = [...para.keys()];
  const original = ratio(ids.filter((id) => matchesLabel(originalChoices.get(id) ?? '', labels.get(id))).length, ids.length);
  const paraphrase = ratio(ids.filter((id) => matchesLabel(para.get(id) ?? '', labels.get(id))).length, ids.length);
  return { original, paraphrase, drop: original.fraction - paraphrase.fraction, ids: ids.length };
}

// ---------------------------------------------------------------------------------------------------------
// Reading files (fails loudly)

export class MissingInputError extends Error {}

function need(path: string, what: string): string {
  if (!existsSync(path)) throw new MissingInputError(`missing ${what}: ${path}`);
  return path;
}

export function readEnriched(runsDir: string, runId: string): EnrichedRow[] {
  const dir = need(join(runsDir, runId), `run folder ${runId}`);
  const text = readFileSync(need(join(dir, 'enriched.csv'), `enriched.csv of ${runId}`), 'utf8');
  const recs = parse(text, { columns: true, skip_empty_lines: true, bom: true }) as Record<string, string>[];
  return recs.map((r, i) => {
    for (const c of ['id', 'label', 'answer', 'status', 'round'])
      if (!(c in r)) throw new Error(`${runId}/enriched.csv: column "${c}" missing (row ${i + 1})`);
    return { id: r.id!, label: r.label!, answer: r.answer!, status: r.status!, round: r.round! };
  });
}

function readLedger(runsDir: string, runId: string): RunState {
  const path = need(join(runsDir, runId, 'ledger.jsonl'), `ledger.jsonl of ${runId}`);
  return replay(parseLedger(readFileSync(path, 'utf8'), path)); // read only: never opens a Ledger (no tail repair)
}

function readJson<T>(path: string, what: string): T {
  return JSON.parse(readFileSync(need(path, what), 'utf8')) as T;
}

interface BenchJson {
  testRuns: Record<string, string>;
}
interface BenchReport {
  configs: Array<{ name: string; runId: string; rows: number; flaggedShare: number; triageTop1?: number; accuracyNoHuman?: number; costPer1k: { total: number } }>;
}

function readBench(runsDir: string, benchId: string) {
  const dir = need(join(runsDir, benchId), `bench folder ${benchId}`);
  const bench = readJson<BenchJson>(join(dir, 'bench.json'), `bench.json of ${benchId}`);
  const report = readJson<BenchReport>(join(dir, 'bench-report.json'), `bench-report.json of ${benchId}`);
  const run = (name: string): string => {
    const id = bench.testRuns?.[name];
    if (!id) throw new Error(`${benchId}/bench.json: no testRuns.${name}`);
    return id;
  };
  const config = (name: string) => {
    const c = report.configs.find((x) => x.name === name);
    if (!c) throw new Error(`${benchId}/bench-report.json: no config "${name}"`);
    return c;
  };
  return { run, config };
}

// ---------------------------------------------------------------------------------------------------------
// The figures

export const CACHED_BENCH = 'bench-2026-11-08-5310';
export const UNCACHED_BENCH = 'bench-2026-11-06-f417';
export const PARAPHRASE_DIR = 'contamination-2026-11-07';
export const CLEF_MODEL = 'cloudflare/clef';

export interface Figure {
  /** Article figure number (1-8) and a short key. */
  n: number;
  name: string;
  /** Display value (counts, denominator, percentage). */
  value: string;
  /** How it was computed and from which files. */
  how: string;
  /** Raw unrounded numbers, for --json. */
  raw: Record<string, number | string | null>;
}

const num = (x: number): number | null => (Number.isNaN(x) ? null : x);
const rawRatio = (prefix: string, r: Ratio): Record<string, number | null> => ({
  [`${prefix}Count`]: r.count,
  [`${prefix}Of`]: r.of,
  [`${prefix}Fraction`]: num(r.fraction),
});
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

export function computeFigures(runsDir: string): { figures: Figure[]; checks: string[]; problems: string[] } {
  const figures: Figure[] = [];
  const checks: string[] = [];
  const problems: string[] = [];
  const check = (ok: boolean, okMsg: string, badMsg: string) => {
    if (ok) checks.push(okMsg);
    else problems.push(badMsg);
  };

  const cached = readBench(runsDir, CACHED_BENCH);
  const uncached = readBench(runsDir, UNCACHED_BENCH);

  const clefId = cached.run('clef');
  const opusId = cached.run('baseline');
  const clef = readEnriched(runsDir, clefId);
  const opus = readEnriched(runsDir, opusId);
  const clefLedger = readLedger(runsDir, clefId);
  const clefCfg = cached.config('clef');

  // 1. flagged rows
  const f1 = flaggedRight(clef);
  figures.push({
    n: 1,
    name: 'Cached Clef run: flagged rows, and flagged rows where the pipeline\'s own answer equals the label',
    value: `${f1.flagged} flagged; own answer right on ${describe(f1.right)}`,
    how: `${clefId}/enriched.csv: status = flagged; right = \`answer\` matches \`label\` (matchesLabel, case-insensitive). \`final_answer\`/overrides ignored.`,
    raw: { flagged: f1.flagged, ...rawRatio('right', f1.right) },
  });

  // 2. accepted after a rewrite
  const f2 = acceptedAfterRewrite(clef);
  figures.push({
    n: 2,
    name: 'Cached Clef run: rows accepted after a rewrite (round 1 or 2), and how many are right',
    value: `${f2.accepted} accepted after a rewrite; right on ${describe(f2.right)}`,
    how: `${clefId}/enriched.csv: status = accepted and round in {1, 2} (round 0 = accepted by triage); right = \`answer\` matches \`label\`.`,
    raw: { accepted: f2.accepted, ...rawRatio('right', f2.right) },
  });

  // 3. top-1 vs pipeline
  const top1 = triageTop1(clefLedger, clef);
  const acc = pipelineAccuracy(clef);
  figures.push({
    n: 3,
    name: 'Cached Clef run: accuracy of the checker\'s first pick alone vs full pipeline with no human',
    value: `first pick ${describe(top1)}; full pipeline ${describe(acc)}`,
    how:
      `First pick: ${clefId}/ledger.jsonl, round-0 triage decision of every row, argmax choice vs \`label\`, ignoring the threshold ` +
      `(cannot_tell counts as wrong; ${top1.missing} rows without a triage decision). Pipeline: enriched.csv \`answer\` vs \`label\` over all rows, flagged rows included.`,
    raw: { ...rawRatio('top1', top1), top1Missing: top1.missing, ...rawRatio('pipeline', acc) },
  });
  check(
    near(top1.fraction, clefCfg.triageTop1 ?? NaN),
    `first pick ${top1.fraction} = bench-report triageTop1`,
    `first pick ${top1.fraction} differs from bench-report triageTop1 ${clefCfg.triageTop1}`,
  );
  check(
    near(acc.fraction, clefCfg.accuracyNoHuman ?? NaN),
    `pipeline accuracy ${acc.fraction} = bench-report accuracyNoHuman`,
    `pipeline accuracy ${acc.fraction} differs from bench-report accuracyNoHuman ${clefCfg.accuracyNoHuman}`,
  );

  // 4. TwoPass vs Opus on the baseline's rows
  const p4 = pairwise(clef, opus);
  figures.push({
    n: 4,
    name: 'On the Opus baseline\'s rows (8 Nov): TwoPass vs Opus accuracy, and head-to-head',
    value:
      `TwoPass ${describe(p4.aRight)}; Opus ${describe(p4.bRight)}; ` +
      `TwoPass right & Opus wrong ${p4.aWins}; Opus right & TwoPass wrong ${p4.bWins} (both right ${p4.bothRight}, both wrong ${p4.bothWrong})`,
    how: `${clefId} and ${opusId} enriched.csv joined by \`id\`, shared ids only (${p4.shared}; only in TwoPass ${p4.onlyA}, only in Opus ${p4.onlyB}); \`answer\` vs \`label\`.`,
    raw: {
      shared: p4.shared,
      ...rawRatio('twopassRight', p4.aRight),
      ...rawRatio('opusRight', p4.bRight),
      twopassWins: p4.aWins,
      opusWins: p4.bWins,
      bothRight: p4.bothRight,
      bothWrong: p4.bothWrong,
    },
  });

  // 5. run-to-run disagreement, 6 Nov vs 8 Nov
  const clef6Id = uncached.run('clef');
  const opus6Id = uncached.run('baseline');
  const clef6 = readEnriched(runsDir, clef6Id);
  const opus6 = readEnriched(runsDir, opus6Id);
  const d5a = disagreement(opus6, opus);
  const d5b = disagreement(clef6, clef);
  const d5c8 = disagreement(clef, opus); // TwoPass vs Opus, both 8 Nov
  const d5c6 = disagreement(clef6, opus6); // TwoPass vs Opus, both 6 Nov
  const dx1 = disagreement(clef6, opus); // 6 Nov TwoPass vs 8 Nov Opus
  const dx2 = disagreement(clef, opus6); // 8 Nov TwoPass vs 6 Nov Opus
  const dis = (d: Ratio & { onlyA: number; onlyB: number }, label: string) => ({
    ...rawRatio(label, d),
    [`${label}OnlyA`]: d.onlyA,
    [`${label}OnlyB`]: d.onlyB,
  });
  figures.push({
    n: 5,
    name: 'Run-to-run disagreement of the `answer` column, 6 Nov runs (bench f417) vs 8 Nov runs (bench 5310)',
    value:
      `Opus baseline vs Opus baseline ${describe(d5a)}; ` +
      `TwoPass-Clef vs TwoPass-Clef ${describe(d5b)}; ` +
      `TwoPass vs Opus, both 8 Nov ${describe(d5c8)}; TwoPass vs Opus, both 6 Nov ${describe(d5c6)}`,
    how:
      `enriched.csv \`answer\` compared by \`id\` (trimmed, case-insensitive), shared ids only. Opus: ${opus6Id} vs ${opusId}. Clef: ${clef6Id} vs ${clefId}. ` +
      `TwoPass vs Opus = same-day pair on the ids both ran on (8 Nov = ${clefId} vs ${opusId}; 6 Nov = ${clef6Id} vs ${opus6Id}). ` +
      `Not asked, but in --json: mixed-day pairs (6 Nov Clef vs 8 Nov Opus ${pct1(dx1.fraction)} of ${dx1.of}; 8 Nov Clef vs 6 Nov Opus ${pct1(dx2.fraction)} of ${dx2.of}).`,
    raw: {
      ...dis(d5a, 'opusVsOpus'),
      ...dis(d5b, 'clefVsClef'),
      ...dis(d5c8, 'twopassVsOpus8Nov'),
      ...dis(d5c6, 'twopassVsOpus6Nov'),
      ...dis(dx1, 'clef6NovVsOpus8Nov'),
      ...dis(dx2, 'clef8NovVsOpus6Nov'),
    },
  });

  // 6. share sent to a person, other two checkers (bench f417)
  const f6raw: Record<string, number | string | null> = {};
  const f6parts: string[] = [];
  for (const [name, label] of [['jev', 'Jev'], ['luna', 'Luna']] as const) {
    const cfg = uncached.config(name);
    const rows = readEnriched(runsDir, uncached.run(name));
    const fromCsv = flaggedShare(rows);
    check(
      near(fromCsv.fraction, cfg.flaggedShare),
      `${label}: enriched.csv flagged share ${fromCsv.fraction} = bench-report flaggedShare`,
      `${label}: enriched.csv flagged share ${fromCsv.fraction} differs from bench-report flaggedShare ${cfg.flaggedShare}`,
    );
    f6parts.push(`${label} ${describe(fromCsv)}`);
    Object.assign(f6raw, rawRatio(name, fromCsv), { [`${name}BenchReportFlaggedShare`]: cfg.flaggedShare });
  }
  figures.push({
    n: 6,
    name: 'Share of rows sent to a person, the other two checkers (bench f417)',
    value: f6parts.join('; '),
    how: `enriched.csv \`status\` = flagged of all rows in ${uncached.run('jev')} and ${uncached.run('luna')}; cross-checked against bench-report.json \`flaggedShare\` (agrees, see checks).`,
    raw: f6raw,
  });

  // 7. paraphrase test
  const pdir = need(join(runsDir, PARAPHRASE_DIR), `paraphrase folder ${PARAPHRASE_DIR}`);
  const answers = readFileSync(need(join(pdir, 'answers.jsonl'), 'answers.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as ParaphraseAnswer);
  const labels = new Map(clef.map((r) => [r.id, r.label]));
  const pids = answers.filter((a) => a.model === CLEF_MODEL && a.variant === 'paraphrase').map((a) => a.id);
  const unlabeled = pids.filter((id) => !labels.has(id));
  if (unlabeled.length) throw new Error(`${PARAPHRASE_DIR}/answers.jsonl: ${unlabeled.length} ids have no label in ${clefId}/enriched.csv (e.g. ${unlabeled[0]})`);
  const triageChoices = (st: RunState) => new Map([...st.triage].map(([id, ev]) => [id, asChoice(ev.answers.answer)?.choice ?? '']));
  const clef6Ledger = readLedger(runsDir, clef6Id);
  const p7 = paraphraseDrop(triageChoices(clef6Ledger), answers, labels, CLEF_MODEL);
  const p7b = paraphraseDrop(triageChoices(clefLedger), answers, labels, CLEF_MODEL);
  figures.push({
    n: 7,
    name: 'Paraphrase test: Clef round-0 accuracy, original vs paraphrased wording',
    value: `original ${describe(p7.original)}; paraphrase ${describe(p7.paraphrase)}; drop ${(p7.drop * 100).toFixed(1)} points on ${p7.ids} messages`,
    how:
      `Original wording: round-0 triage choice in ${clef6Id}/ledger.jsonl (the 6 Nov run the test was built on; answers.jsonl holds paraphrase answers only). ` +
      `Paraphrase: ${PARAPHRASE_DIR}/answers.jsonl, model ${CLEF_MODEL}. Argmax choice vs label (labels by id from ${clefId}/enriched.csv); cannot_tell counts as wrong. ` +
      `Drop = original minus paraphrase. Alternative, original wording from the 8 Nov run ${clefId}: ${pct1(p7b.original.fraction)} original, drop ${(p7b.drop * 100).toFixed(1)} points.`,
    raw: {
      ids: p7.ids,
      ...rawRatio('original', p7.original),
      ...rawRatio('paraphrase', p7.paraphrase),
      dropPoints: p7.drop * 100,
      alt8NovOriginalFraction: p7b.original.fraction,
      alt8NovDropPoints: p7b.drop * 100,
    },
  });
  const resultJson = readJson<{ perModel: Array<{ model: string; accOriginal: number; accParaphrase: number; drop: number }> }>(join(pdir, 'result.json'), 'result.json');
  const rj = resultJson.perModel.find((m) => m.model === CLEF_MODEL);
  check(
    !!rj && near(rj.accOriginal, p7.original.fraction) && near(rj.accParaphrase, p7.paraphrase.fraction),
    `paraphrase accuracies match ${PARAPHRASE_DIR}/result.json`,
    `paraphrase accuracies (${p7.original.fraction}, ${p7.paraphrase.fraction}) differ from result.json (${rj?.accOriginal}, ${rj?.accParaphrase})`,
  );

  // 8. cost per 1,000 rows
  const raw8: Record<string, number | string | null> = {};
  const parts8: string[] = [];
  for (const [label, bench, benchId] of [['uncached (6 Nov, f417)', uncached, UNCACHED_BENCH], ['cached (8 Nov, 5310)', cached, CACHED_BENCH]] as const) {
    const c = bench.config('clef').costPer1k.total;
    const o = bench.config('baseline').costPer1k.total;
    const r = costRatio(o, c);
    const key = benchId === UNCACHED_BENCH ? 'uncached' : 'cached';
    parts8.push(
      `${label}: Clef $${c.toFixed(5)} vs Opus $${o.toFixed(5)} per 1,000 rows; Opus/Clef = ${r.unrounded.toFixed(2)} unrounded, ` +
        `${r.rounded.toFixed(2)} from cents ($${r.dearCents.toFixed(2)} / $${r.cheapCents.toFixed(2)})`,
    );
    Object.assign(raw8, {
      [`${key}ClefPer1k`]: c,
      [`${key}OpusPer1k`]: o,
      [`${key}RatioUnrounded`]: r.unrounded,
      [`${key}RatioFromCents`]: r.rounded,
      [`${key}ClefCents`]: r.cheapCents,
      [`${key}OpusCents`]: r.dearCents,
    });
  }
  figures.push({
    n: 8,
    name: 'Cost per 1,000 rows, Clef vs Opus baseline, and the ratio',
    value: parts8.join(' | '),
    how: `bench-report.json \`configs[name=clef|baseline].costPer1k.total\` of ${UNCACHED_BENCH} and ${CACHED_BENCH}, unrounded; ratio = Opus ÷ Clef, also from each cost rounded to the cent.`,
    raw: raw8,
  });

  return { figures, checks, problems };
}

export function toMarkdown(figures: readonly Figure[]): string {
  const esc = (s: string) => s.replaceAll('|', '\\|');
  const lines = ['| # | Figure | Value | How it was computed |', '|---|---|---|---|'];
  for (const f of figures) lines.push(`| ${f.n} | ${esc(f.name)} | ${esc(f.value)} | ${esc(f.how)} |`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------
// CLI

function main(): void {
  const { values } = parseArgs({
    options: { runs: { type: 'string', default: 'runs' }, json: { type: 'boolean', default: false } },
  });
  let result;
  try {
    result = computeFigures(values.runs!);
  } catch (err) {
    console.error(`article-figures: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  console.log(toMarkdown(result.figures));
  console.log('\nCross-checks:');
  for (const c of result.checks) console.log(`- ok: ${c}`);
  for (const p of result.problems) console.log(`- MISMATCH: ${p}`);
  if (values.json) {
    console.log('\n```json');
    console.log(JSON.stringify(Object.fromEntries(result.figures.map((f) => [`figure${f.n}`, f.raw])), null, 2));
    console.log('```');
  }
  if (result.problems.length) {
    console.error(`article-figures: ${result.problems.length} cross-check(s) disagree; see MISMATCH lines`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
