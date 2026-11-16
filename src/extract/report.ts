import { asChoice, type Answer } from '../decide/model.ts';
import type { VrduField } from '../datasets/vrdu.ts';
import { customId, type RunState } from '../ledger.ts';
import type { RowRecord } from '../pipeline.ts';
import { escapeCell, roundTimings, type RoundTiming } from '../report.ts';
import { spendByStage } from '../stats.ts';
import { parseExtraction, type TaskDefinition, type Thresholds } from '../task.ts';
import { verifyOutcome } from '../verdict.ts';
import { computeFieldOutcomes, type FieldOutcome } from './outcomes.ts';
import { scoreSlot } from './score.ts';

// The `bench vrdu` report: pure functions over ledgers, thresholds and labels (the `gold` column of each row).
// Nothing here reads a file or calls a model.

/** One field slot of one document, scored against its gold values. */
export interface Slot {
  rowId: string;
  field: string;
  value: string | null;
  status: FieldOutcome['status'];
  /** Normalised match (dates, digits, text). False when the writer gave no usable reply. */
  correct: boolean;
  exact: boolean;
  goldPresent: boolean;
}

export interface SlotMetrics {
  fields: number;
  pending: number;
  accepted: number;
  acceptedShare: number;
  /** Share of accepted fields that are right; null when nothing was accepted. */
  precision: number | null;
  /** Accepted and wrong. */
  confidentWrong: number;
  confidentWrongShare: number;
  flagged: number;
  /** Share of all fields sent to a person. */
  flaggedShare: number;
  /** Of the flagged fields, the share where the tool's own value was right; null when none were flagged. */
  flaggedOwnRight: number | null;
  /** Every field counted with the tool's own value, flagged ones included. */
  accuracy: number;
  exactAccuracy: number;
}

export type CostStages = { write1: number; verify1: number; write2: number; verify2: number; total: number };

interface Costs {
  /** USD per 1,000 documents, by stage (only the stages the configuration uses). */
  costPer1kDocuments: CostStages;
  costPer1kFields: CostStages;
}

export interface ConfigMetrics extends SlotMetrics, Costs {
  documents: number;
}

export interface WriterAlone extends Costs {
  fields: number;
  documents: number;
  /** Documents whose reply was missing or not usable JSON (their fields count as wrong). */
  unusableDocuments: number;
  accuracy: number;
  exactAccuracy: number;
}

export interface CheckerInput {
  model: string;
  /** The round-1 threshold this checker is used at. */
  threshold: number;
  /** Its answers to the round-1 values, by document, then by field. */
  answers: ReadonlyMap<string, Record<string, Answer>>;
}

interface CannotTell {
  proposals: number;
  cannotTell: number;
  share: number | null;
}

export interface CheckerResult {
  model: string;
  threshold: number;
  /** Field slots of documents the checker saw (documents with a usable round-1 reply). */
  slots: number;
  accepted: number;
  acceptedShare: number;
  precision: number | null;
  confidentWrong: number;
  cannotTell: { value: CannotTell; null: CannotTell };
}

export interface CalibrationFacts {
  runId: string;
  documents: number;
  /** Per decision model, slot counts behind each stage's fit. */
  models: Record<
    string,
    {
      verify1?: { slots: number; wrong: number };
      verify2?: { slots: number; wrong: number };
      /** verify2 restricted to the slots the same model's verify1 did not accept. */
      verify2Conditional?: { slots: number; wrong: number };
    }
  >;
}

/** The test split was read once with thresholds fitted the first way, then the round-2 threshold was refitted. */
export interface RefitInput {
  at: string;
  /** Thresholds of the first read. */
  previousThresholds: Thresholds;
  reason: string;
}

/** The 98% operating point: the decision model's thresholds at that target, and every checker's round-1 threshold. */
export interface OperatingInput {
  target: number;
  thresholds: Thresholds;
  checkers: CheckerInput[];
}

/** What `check` did to the document text on its way into the runs (see bench-vrdu.ts). */
export interface TextCheck {
  documents: number;
  /** Documents whose stored text differs from the dataset's. */
  changed: number;
  /** Documents changed inside the text (line endings, Unicode form, control or zero-width characters), not only trimmed at the ends. */
  changedInside: number;
  /** Documents per kind of change. */
  kinds: Record<string, number>;
}

export interface ExtractReportInput {
  benchId: string;
  createdAt: string;
  split: 'dev' | 'test';
  task: TaskDefinition;
  rows: RowRecord[];
  normal: RunState;
  baseline: RunState;
  thresholds: Thresholds;
  thresholdsSource: string;
  decisionModel: string;
  baselineModel: string;
  checkers: CheckerInput[];
  calibration: CalibrationFacts;
  target: number;
  maxAttempts?: number;
  textCheck?: TextCheck;
  refit?: RefitInput;
  operating?: OperatingInput;
}

export interface ExtractReport {
  benchId: string;
  kind: 'extract';
  createdAt: string;
  split: 'dev' | 'test';
  debugOnly: boolean;
  documents: number;
  fields: number;
  target: number;
  decisionModel: string;
  baselineModel: string;
  thresholds: Thresholds;
  thresholdsSource: string;
  configs: {
    baseline: ConfigMetrics;
    writerAlone: WriterAlone;
    simple: ConfigMetrics;
    full: ConfigMetrics;
  };
  /** `full` and `simple` split by whether the gold has a value. */
  presence: Record<'full' | 'simple', { present: SlotMetrics; absent: SlotMetrics }>;
  perField: Record<'full' | 'simple', Record<string, SlotMetrics>>;
  checkers: CheckerResult[];
  /** Present when the thresholds were refitted after the first read of the test split. */
  refit: (RefitInput & { fullFirstRead: ConfigMetrics }) | null;
  /** Replay at the 98% operating point; null when the calibration has none. */
  operatingPoint: { target: number; thresholds: Thresholds; simple: ConfigMetrics; full: ConfigMetrics; checkers: CheckerResult[] } | null;
  calibration: CalibrationFacts;
  textCheck: TextCheck | null;
  minutes: { normal: { rounds: RoundTiming[]; total: number }; baseline: { rounds: RoundTiming[]; total: number } };
}

// ---------------------------------------------------------------- slots

function goldOf(row: RowRecord, field: string): string[] {
  try {
    const g = (JSON.parse(row.data.gold ?? '{}') as Record<string, unknown>)[field];
    return Array.isArray(g) ? g.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const unusable = (o: Pick<FieldOutcome, 'verdict'>) => o.verdict === 'writer_failed' || o.verdict === 'invalid_output';

export function slotsOf(outcomes: FieldOutcome[], rows: RowRecord[]): Slot[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return outcomes.map((o) => {
    const s = scoreSlot(o.field as VrduField, o.value, goldOf(byId.get(o.rowId)!, o.field));
    const bad = unusable(o);
    return { rowId: o.rowId, field: o.field, value: o.value, status: o.status, correct: !bad && s.correct, exact: !bad && s.exact, goldPresent: s.goldPresent };
  });
}

const share = (n: number, of: number): number => (of ? n / of : 0);

export function slotMetrics(slots: Slot[]): SlotMetrics {
  const accepted = slots.filter((s) => s.status === 'accepted');
  const flagged = slots.filter((s) => s.status === 'flagged');
  const wrong = accepted.filter((s) => !s.correct).length;
  return {
    fields: slots.length,
    pending: slots.filter((s) => s.status === 'pending').length,
    accepted: accepted.length,
    acceptedShare: share(accepted.length, slots.length),
    precision: accepted.length ? accepted.filter((s) => s.correct).length / accepted.length : null,
    confidentWrong: wrong,
    confidentWrongShare: share(wrong, slots.length),
    flagged: flagged.length,
    flaggedShare: share(flagged.length, slots.length),
    flaggedOwnRight: flagged.length ? flagged.filter((s) => s.correct).length / flagged.length : null,
    accuracy: share(slots.filter((s) => s.correct).length, slots.length),
    exactAccuracy: share(slots.filter((s) => s.exact).length, slots.length),
  };
}

type StageKey = 'write1' | 'verify1' | 'write2' | 'verify2';
const ALL_STAGES: StageKey[] = ['write1', 'verify1', 'write2', 'verify2'];

/** Stage costs (`spendByStage`) for the stages a configuration uses, per 1,000 documents and per 1,000 fields. */
function costs(st: RunState, stages: StageKey[], documents: number, fieldsPerDoc: number): Costs {
  const spend = spendByStage(st);
  const make = (per: number): CostStages => {
    const c: CostStages = { write1: 0, verify1: 0, write2: 0, verify2: 0, total: 0 };
    for (const k of stages) {
      c[k] = per ? (1000 * spend[k]) / per : 0;
      c.total += c[k];
    }
    return c;
  };
  return { costPer1kDocuments: make(documents), costPer1kFields: make(documents * fieldsPerDoc) };
}

const minutes = (st: RunState) => (st.firstAt && st.lastAt ? (Date.parse(st.lastAt) - Date.parse(st.firstAt)) / 60_000 : 0);

// ---------------------------------------------------------------- the report

export function buildExtractReport(i: ExtractReportInput): ExtractReport {
  const { task, rows } = i;
  const fields = task.extract!.fields;
  const ctx = { task, rows, thresholds: i.thresholds, ...(i.maxAttempts !== undefined ? { maxAttempts: i.maxAttempts } : {}) };
  const docs = rows.length;
  const fpd = fields.length;

  const baselineSlots = slotsOf(computeFieldOutcomes(i.baseline, { ...ctx, mode: 'baseline' }), rows);
  const replayAt = (thresholds: Thresholds, maxRound?: 1) =>
    slotsOf(computeFieldOutcomes(i.normal, { ...ctx, thresholds, mode: 'normal' }, maxRound ? { maxRound } : {}), rows);
  const fullSlots = replayAt(i.thresholds);
  const simpleSlots = replayAt(i.thresholds, 1);

  // writer alone: the round-1 values, no checker
  const alone: Slot[] = [];
  let unusableDocuments = 0;
  for (const row of rows) {
    const res = i.normal.results.get(customId(row.id, 1));
    const parsed = res?.ok ? parseExtraction(task, res.text ?? '') : undefined;
    if (!parsed?.ok) unusableDocuments++;
    for (const f of fields) {
      const value = parsed?.ok ? (parsed.values[f] ?? null) : null;
      const s = scoreSlot(f as VrduField, value, goldOf(row, f));
      alone.push({ rowId: row.id, field: f, value, status: 'accepted', correct: !!parsed?.ok && s.correct, exact: !!parsed?.ok && s.exact, goldPresent: s.goldPresent });
    }
  }
  const aloneMetrics = slotMetrics(alone);

  const config = (slots: Slot[], st: RunState, stages: StageKey[]): ConfigMetrics => ({
    ...slotMetrics(slots),
    documents: docs,
    ...costs(st, stages, docs, fpd),
  });
  const split = (slots: Slot[]) => ({
    present: slotMetrics(slots.filter((s) => s.goldPresent)),
    absent: slotMetrics(slots.filter((s) => !s.goldPresent)),
  });
  const perField = (slots: Slot[]) => Object.fromEntries(fields.map((f) => [f, slotMetrics(slots.filter((s) => s.field === f))]));

  return {
    benchId: i.benchId,
    kind: 'extract',
    createdAt: i.createdAt,
    split: i.split,
    debugOnly: i.split === 'dev',
    documents: docs,
    fields: docs * fpd,
    target: i.target,
    decisionModel: i.decisionModel,
    baselineModel: i.baselineModel,
    thresholds: i.thresholds,
    thresholdsSource: i.thresholdsSource,
    configs: {
      baseline: config(baselineSlots, i.baseline, ['write1']),
      writerAlone: {
        fields: aloneMetrics.fields,
        documents: docs,
        unusableDocuments,
        accuracy: aloneMetrics.accuracy,
        exactAccuracy: aloneMetrics.exactAccuracy,
        ...costs(i.normal, ['write1'], docs, fpd),
      },
      simple: config(simpleSlots, i.normal, ['write1', 'verify1']),
      full: config(fullSlots, i.normal, ALL_STAGES),
    },
    presence: { full: split(fullSlots), simple: split(simpleSlots) },
    perField: { full: perField(fullSlots), simple: perField(simpleSlots) },
    checkers: i.checkers.map((c) => checkerResult(c, i)),
    refit: i.refit ? { ...i.refit, fullFirstRead: config(replayAt(i.refit.previousThresholds), i.normal, ALL_STAGES) } : null,
    operatingPoint: i.operating
      ? {
          target: i.operating.target,
          thresholds: i.operating.thresholds,
          simple: config(replayAt(i.operating.thresholds, 1), i.normal, ['write1', 'verify1']),
          full: config(replayAt(i.operating.thresholds), i.normal, ALL_STAGES),
          checkers: i.operating.checkers.map((c) => checkerResult(c, i)),
        }
      : null,
    calibration: i.calibration,
    textCheck: i.textCheck ?? null,
    minutes: {
      normal: { rounds: roundTimings(i.normal), total: minutes(i.normal) },
      baseline: { rounds: roundTimings(i.baseline), total: minutes(i.baseline) },
    },
  };
}

function checkerResult(c: CheckerInput, i: ExtractReportInput): CheckerResult {
  const { task, rows } = i;
  const fields = task.extract!.fields;
  let slots = 0;
  let accepted = 0;
  let acceptedRight = 0;
  let wrong = 0;
  const ct = { value: { proposals: 0, cannotTell: 0 }, null: { proposals: 0, cannotTell: 0 } };
  for (const row of rows) {
    const res = i.normal.results.get(customId(row.id, 1));
    const parsed = res?.ok ? parseExtraction(task, res.text ?? '') : undefined;
    const answers = c.answers.get(row.id);
    if (!parsed?.ok || !answers) continue;
    for (const f of fields) {
      const value = parsed.values[f] ?? null;
      const o = verifyOutcome(asChoice(answers[f]), c.threshold);
      const right = scoreSlot(f as VrduField, value, goldOf(row, f)).correct;
      slots++;
      const kind = value === null ? 'null' : 'value';
      ct[kind].proposals++;
      if (o.verdict === 'cannot_tell') ct[kind].cannotTell++;
      if (o.accepted) {
        accepted++;
        if (right) acceptedRight++;
        else wrong++;
      }
    }
  }
  const part = (x: { proposals: number; cannotTell: number }): CannotTell => ({ ...x, share: x.proposals ? x.cannotTell / x.proposals : null });
  return {
    model: c.model,
    threshold: c.threshold,
    slots,
    accepted,
    acceptedShare: share(accepted, slots),
    precision: accepted ? acceptedRight / accepted : null,
    confidentWrong: wrong,
    cannotTell: { value: part(ct.value), null: part(ct.null) },
  };
}

// ---------------------------------------------------------------- enriched-fields.csv

export const FIELD_CSV_COLUMNS = ['doc_id', 'field', 'value', 'gold', 'correct', 'verdict', 'confidence', 'model', 'round', 'cost_usd'] as const;

/** One record per field slot, formula-escaped like the other CSV outputs. */
export function fieldCsvRecords(outcomes: FieldOutcome[], rows: RowRecord[]): Array<Record<(typeof FIELD_CSV_COLUMNS)[number], string>> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const slots = slotsOf(outcomes, rows);
  return outcomes.map((o, k) => {
    const gold = goldOf(byId.get(o.rowId)!, o.field).filter((g) => g.trim() !== '');
    return {
      doc_id: escapeCell(o.rowId),
      field: o.field,
      value: escapeCell(o.value ?? ''),
      gold: escapeCell(gold.join(' | ')),
      correct: slots[k]!.correct ? 'true' : 'false',
      verdict: o.verdict,
      confidence: o.confidence === null ? '' : o.confidence.toFixed(4),
      model: o.model,
      round: o.status === 'pending' ? '' : String(o.round),
      cost_usd: o.costUsd.toFixed(6),
    };
  });
}

// ---------------------------------------------------------------- markdown

const n0 = (x: number) => x.toLocaleString('en-US');
const pct = (x: number | null, d = 1) => (x === null ? 'n/a' : `${(100 * x).toFixed(d)}%`);
const usd = (x: number) => `$${x.toFixed(2)}`;
const usd3 = (x: number) => `$${x.toFixed(3)}`;

/** `**N fields · X% accepted at Y% precision · Z sent to a person · $C per 1,000 fields**` for the full pipeline. */
export function headline(r: ExtractReport): string {
  const f = r.configs.full;
  const parts = [
    `${n0(f.fields)} fields`,
    `${pct(f.acceptedShare, 0)} accepted at ${pct(f.precision, 0)} precision`,
    `${n0(f.flagged)} sent to a person`,
    `${usd(f.costPer1kFields.total)} per 1,000 fields`,
    ...(r.debugOnly ? ['dev split, these numbers are for debugging only'] : []),
  ];
  return `**${parts.join(' · ')}**`;
}

function metricRow(label: string, m: SlotMetrics): string {
  return `| ${label} | ${n0(m.fields)} | ${pct(m.acceptedShare)} | ${pct(m.precision)} | ${n0(m.confidentWrong)} | ${pct(m.flaggedShare)} | ${pct(m.flaggedOwnRight)} | ${pct(m.accuracy)} |`;
}

const th3 = (x: number) => (x > 1 ? 'never' : x.toFixed(3));

function methodChange(r: ExtractReport, f: NonNullable<ExtractReport['refit']>): string[] {
  const a = f.fullFirstRead;
  const b = r.configs.full;
  const acc = (m: ConfigMetrics) => `${n0(m.accepted)} fields accepted (${pct(m.acceptedShare)}) at ${pct(m.precision)} precision`;
  return [
    '',
    '## Method change after the first test read',
    '',
    `The round-2 threshold was first fitted on all calibration fields. In a real run, round 2 only decides the fields round 1 did not accept, ` +
      `which are the harder ones, so that fit did not match the population it was used on. The test split had already been read once with it ` +
      `(t2 = ${th3(f.previousThresholds.t2)}: ${acc(a)} for the full pipeline). The threshold was then refitted on the calibration fields that round 1 ` +
      `did not accept (t2 = ${th3(r.thresholds.t2)}: ${acc(b)}). The new threshold uses calibration data only, and no model calls were made to ` +
      `produce it: the test ledgers were replayed under the new value, and round 1 (t1 = ${th3(r.thresholds.t1)}) did not change. ` +
      'Both reads are shown in the configurations table.',
  ];
}

function operatingSection(r: ExtractReport, o: NonNullable<ExtractReport['operatingPoint']>): string[] {
  const label = pct(o.target, 0);
  const L: string[] = ['', `## ${label} operating point`, ''];
  L.push(
    `The same calibration refitted for ${label} precision, replayed on the test split by pure replay (no model calls). ` +
      `For \`${r.decisionModel}\`: t1 = ${th3(o.thresholds.t1)}, t2 = ${th3(o.thresholds.t2)}; t2 is fitted on the fields round 1 did not accept at that t1.`,
    '',
  );
  if (o.thresholds.t1 > 1) L.push(`For t1, no threshold reaches ${label}: round 1 accepts nothing, so every field goes to round 2.`, '');
  if (o.thresholds.t2 > 1) L.push(`For t2, no threshold reaches ${label}: round 2 accepts nothing, so every field round 1 did not accept goes to a person.`, '');
  L.push('| Configuration | Fields | Accepted | Precision | Confident wrong | Sent to a person |', '|---|---|---|---|---|---|');
  const row = (name: string, m: ConfigMetrics) =>
    `| ${name} | ${n0(m.fields)} | ${pct(m.acceptedShare)} | ${pct(m.precision)} | ${n0(m.confidentWrong)} (${pct(m.confidentWrongShare, 2)}) | ${pct(m.flaggedShare)} |`;
  L.push(row('simple (writer, checker, person)', o.simple), row('full (with the stronger re-extraction)', o.full));
  L.push('', `Round 1 for each checker at its ${label} threshold:`, '');
  L.push('| Checker | Threshold | Slots | Accepted | Precision | Confident wrong |', '|---|---|---|---|---|---|');
  for (const c of o.checkers) {
    if (c.threshold > 1) L.push(`| ${c.model} | no threshold reaches ${label} | ${n0(c.slots)} | n/a | n/a | n/a |`);
    else L.push(`| ${c.model} | ${c.threshold.toFixed(3)} | ${n0(c.slots)} | ${pct(c.acceptedShare)} | ${pct(c.precision)} | ${n0(c.confidentWrong)} |`);
  }
  return L;
}

export function renderExtractReport(r: ExtractReport): string {
  const L: string[] = [headline(r), ''];
  L.push(`# Bench ${r.benchId}: VRDU extraction (${r.split} split)`, '');
  L.push(
    `${n0(r.documents)} test documents, ${n0(r.fields)} field slots. Decision model \`${r.decisionModel}\`, baseline \`${r.baselineModel}\`. ` +
      'Correct means a normalised match (dates, digits, text); a null is right only when the form states no such field. ' +
      'Costs are the test runs only; calibration spend is not included.',
    '',
  );

  const w = r.configs.writerAlone;
  L.push('## Four configurations on the same documents', '');
  L.push("| Configuration | Fields | Accepted | Precision | Confident wrong | Sent to a person | Flagged, tool's own value right | Accuracy, own values | Cost / 1,000 fields |");
  L.push('|---|---|---|---|---|---|---|---|---|');
  const row = (name: string, m: ConfigMetrics) =>
    `| ${name} | ${n0(m.fields)} | ${pct(m.acceptedShare)} | ${pct(m.precision)} | ${n0(m.confidentWrong)} (${pct(m.confidentWrongShare, 2)}) | ${pct(m.flaggedShare)} | ${pct(m.flaggedOwnRight)} | ${pct(m.accuracy)} | ${usd3(m.costPer1kFields.total)} |`;
  L.push(row('baseline (every field taken as is)', r.configs.baseline));
  L.push(`| writer alone (round-1 values, no checker) | ${n0(w.fields)} | n/a | n/a | n/a | n/a | n/a | ${pct(w.accuracy)} | ${usd3(w.costPer1kFields.total)} |`);
  L.push(row('simple (writer, checker, person)', r.configs.simple));
  L.push(row('full (with the stronger re-extraction)', r.configs.full));
  if (r.refit) L.push(row('full, first read (round-2 threshold fitted on all fields)', r.refit.fullFirstRead));
  if (w.unusableDocuments) L.push('', `Writer alone: ${n0(w.unusableDocuments)} document(s) had no usable reply; their fields count as wrong.`);

  if (r.refit) L.push(...methodChange(r, r.refit));

  L.push('', '## Cost by stage, USD per 1,000 documents', '');
  L.push('| Configuration | Write 1 | Verify 1 | Write 2 | Verify 2 | Total | Per 1,000 fields |', '|---|---|---|---|---|---|---|');
  const costRow = (name: string, c: Costs) => {
    const d = c.costPer1kDocuments;
    return `| ${name} | ${usd(d.write1)} | ${usd(d.verify1)} | ${usd(d.write2)} | ${usd(d.verify2)} | ${usd(d.total)} | ${usd3(c.costPer1kFields.total)} |`;
  };
  L.push(costRow('baseline', r.configs.baseline), costRow('writer alone', w), costRow('simple', r.configs.simple), costRow('full', r.configs.full));

  L.push('', '## Normalised and exact match', '');
  L.push('| Configuration | Normalised match | Exact match |', '|---|---|---|');
  L.push(`| baseline | ${pct(r.configs.baseline.accuracy)} | ${pct(r.configs.baseline.exactAccuracy)} |`);
  L.push(`| writer alone | ${pct(w.accuracy)} | ${pct(w.exactAccuracy)} |`);

  const header = '| {} | Fields | Accepted | Precision | Confident wrong | Sent to a person | Flagged, own value right | Accuracy |\n|---|---|---|---|---|---|---|---|';
  for (const name of ['full', 'simple'] as const) {
    L.push('', `## ${name}: value present vs absent in the gold`, '', header.replace('{}', 'Gold'));
    L.push(metricRow('has a value', r.presence[name].present), metricRow('blank (absent)', r.presence[name].absent));
    L.push('', `## ${name}: per field`, '', header.replace('{}', 'Field'));
    for (const [f, m] of Object.entries(r.perField[name])) L.push(metricRow(f, m));
  }

  L.push('', '## Checkers, round 1 only', '');
  L.push('Each judges the same round-1 values, at its own fitted threshold.', '');
  L.push('| Checker | Threshold | Slots | Accepted | Precision | Confident wrong | cannot_tell on values | cannot_tell on nulls |', '|---|---|---|---|---|---|---|---|');
  const ct = (x: CannotTell) => `${n0(x.cannotTell)} of ${n0(x.proposals)} (${pct(x.share)})`;
  for (const c of r.checkers) {
    L.push(
      `| ${c.model} | ${c.threshold > 1 ? 'never' : c.threshold.toFixed(3)} | ${n0(c.slots)} | ${pct(c.acceptedShare)} | ${pct(c.precision)} | ${n0(c.confidentWrong)} | ${ct(c.cannotTell.value)} | ${ct(c.cannotTell.null)} |`,
    );
  }

  if (r.operatingPoint) L.push(...operatingSection(r, r.operatingPoint));

  L.push('', '## Thresholds', '');
  const th = (x: number) => (x > 1 ? 'never' : x.toFixed(3));
  L.push(`Used by \`${r.decisionModel}\`: t1 = ${th(r.thresholds.t1)}, t2 = ${th(r.thresholds.t2)} (t0 unused: no triage). Source: ${r.thresholdsSource}. Target precision ${pct(r.target, 0)}.`, '');
  L.push(`Fitted on ${n0(r.calibration.documents)} calibration documents (run \`${r.calibration.runId}\`), one point per field slot:`, '');
  L.push('| Model | Stage | Slots | Wrong slots |', '|---|---|---|---|');
  for (const [model, stages] of Object.entries(r.calibration.models)) {
    for (const stage of ['verify1', 'verify2', 'verify2Conditional'] as const) {
      const s = stages[stage];
      const label = stage === 'verify2Conditional' ? 'verify2Conditional (slots round 1 did not accept)' : stage;
      if (s) L.push(`| ${model} | ${label} | ${n0(s.slots)} | ${n0(s.wrong)} |`);
    }
  }

  if (r.textCheck) {
    const t = r.textCheck;
    L.push('', '## Document text', '');
    L.push(
      `\`check\` changed the text of ${n0(t.changed)} of ${n0(t.documents)} documents on its way into the runs ` +
        `(${n0(t.changedInside)} inside the text, not only at the ends)` +
        (Object.keys(t.kinds).length ? `: ${Object.entries(t.kinds).map(([k, v]) => `${k} ${n0(v)}`).join(', ')}.` : '.'),
    );
  }

  L.push('', '## Wall-clock', '');
  L.push('| Run | Round 1 (median / worst) | Round 2 (median / worst) | Total |', '|---|---|---|---|');
  for (const [name, m] of [['normal', r.minutes.normal], ['baseline', r.minutes.baseline]] as const) {
    const rd = (n: 1 | 2) => {
      const x = m.rounds.find((y) => y.round === n);
      return x ? `${x.medianMinutes.toFixed(1)} / ${x.worstMinutes.toFixed(1)} min` : 'n/a';
    };
    L.push(`| ${name} | ${rd(1)} | ${rd(2)} | ${m.total.toFixed(0)} min |`);
  }
  L.push('');
  return L.join('\n');
}
