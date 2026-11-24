import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Budget } from './budget.ts';
import { asChoice, CANNOT_TELL, type Answer, type DecisionModel } from './decide/model.ts';
import { verifyKey, type RunState } from './ledger.ts';
import { fitThreshold, type Point, type ThresholdFit } from './calibrate.ts';
import type { RowRecord } from './pipeline.ts';
import { parseExtraction, parseWriterOutput, verifyQuestion, verifyState, type TaskDefinition } from './task.ts';
import { verifyOutcome } from './verdict.ts';

// Turns a labeled run into (score, p, correct) points per decision model and stage.
// The run's own triage/verify answers come from its ledger. Other models are asked the same
// questions, and their answers are cached in <runDir>/scores.jsonl so nothing is paid for twice.

export type Stage = 'triage' | 'verify1' | 'verify2';
export const STAGES: Stage[] = ['triage', 'verify1', 'verify2'];

export interface ScoreRecord {
  model: string;
  servedAs: string;
  stage: Stage;
  rowId: string;
  /** For verify stages: the writer answer that was judged. */
  answer?: string;
  verdict: Answer;
  /** Extraction tasks: the answers by field (one decision call per document). `verdict` is then a placeholder. */
  answers?: Record<string, Answer>;
  costUsd: number;
  latencyMs: number;
}

/** An extraction slot of the round-2 checker, with the SAME model's round-1 answer for the same field. */
export interface Verify2Slot {
  point: Point;
  /** Undefined when the model gave no round-1 answer (e.g. the round-1 reply was unusable): the field was not accepted. */
  verify1: Answer | undefined;
}

/**
 * The round-2 points that matter in a real run: the slots round 1 did NOT accept at `t1`. "Accept" is the pipeline's own
 * rule (`verifyOutcome`). With `t1 = NEVER` nothing is accepted, so every slot is in.
 */
export function unacceptedRound2Points(slots: Verify2Slot[], t1: number): Point[] {
  return slots.filter((s) => !verifyOutcome(asChoice(s.verify1), t1).accepted).map((s) => s.point);
}

export interface ConditionalFit {
  /** The round-1 fit the round-2 population is conditional on. */
  verify1: ThresholdFit;
  verify2Conditional: ThresholdFit & { n: number; correct: number };
}

/** Fits verify1 at `target`, then verify2 on the slots that verify1 threshold did not accept. */
export function conditionalFit(verify1: Point[], slots: Verify2Slot[], target: number): ConditionalFit {
  const fit1 = fitThreshold(verify1, target);
  const pts = unacceptedRound2Points(slots, fit1.threshold);
  return { verify1: fit1, verify2Conditional: { ...fitThreshold(pts, target), n: pts.length, correct: pts.filter((p) => p.correct).length } };
}

/**
 * One field slot of a calibration document, for replaying the pipeline under other thresholds (the UI's explorer).
 * `correct*` do not depend on the checker; `answer*` are this checker's answers (undefined: it gave none).
 */
export interface FieldSlotAnswers {
  rowId: string;
  field: string;
  /** The gold label states a value for this field. */
  goldPresent: boolean;
  /** The round-1 value is right. False when round 1 gave no usable reply. */
  correct1: boolean;
  /** The round-2 value is right; null when round 2 gave no usable reply. */
  correct2: boolean | null;
  answer1: Answer | undefined;
  answer2: Answer | undefined;
}

export interface ModelPoints {
  model: string;
  points: Record<Stage, Point[]>;
  /** Classification tasks: the row ID of each point, in the same order as `points` (rows without an answer have no point). */
  ids?: Record<Stage, string[]>;
  /** Extraction tasks only: every field slot of every row, with this model's round-1 and round-2 answers. */
  fieldSlots?: FieldSlotAnswers[];
  /** Extraction tasks only: the verify2 points, each with this model's own verify1 answer for the slot. */
  verify2Slots?: Verify2Slot[];
  /** Paid in this call (cached and ledger answers are free). */
  spentUsd: number;
}

export interface ScoreOptions {
  dir: string;
  task: TaskDefinition;
  records: RowRecord[];
  labelColumn: string;
  st: RunState;
  /** The models the run itself used; their answers come from the ledger. */
  runModels: { triage: string; verify: string };
  models: DecisionModel[];
  budget?: Budget;
  /** Stages to score (default: all). The bench asks other checkers about verify1 only. */
  stages?: Stage[];
  /** Use only answers already in the ledger or cache; never call a model (reports). */
  ledgerOnly?: boolean;
  log?: (m: string) => void;
}

/** Does the label cell (a JSON map of field to list of gold values) state a value for `field`? */
export function goldHasValue(label: string, field: string): boolean {
  try {
    const g = (JSON.parse(label) as Record<string, unknown>)[field];
    return Array.isArray(g) && g.some((x) => typeof x === 'string' && x.trim() !== '');
  } catch {
    return false;
  }
}

export function triagePoint(answer: Answer | undefined, label: string): Point {
  const a = asChoice(answer);
  if (!a) return { score: 0, p: 0, correct: false };
  const prob = a.probabilities[a.choice] ?? 0;
  const abstained = a.choice === CANNOT_TELL;
  return { score: abstained ? 0 : prob, p: abstained ? 0 : prob, correct: !abstained && a.choice === label };
}

export function verifyPoint(answer: Answer | undefined, correct: boolean): Point {
  const a = asChoice(answer);
  const p = a?.probabilities.supported ?? 0;
  return { score: a?.choice === 'supported' ? p : 0, p, correct };
}

export async function scoreRun(opts: ScoreOptions): Promise<ModelPoints[]> {
  const { task, st, records, labelColumn } = opts;
  const cachePath = join(opts.dir, 'scores.jsonl');
  const cache = new Map<string, ScoreRecord>();
  if (existsSync(cachePath)) {
    for (const line of readFileSync(cachePath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as ScoreRecord;
        cache.set(`${r.model}|${r.stage}|${r.rowId}`, r);
      } catch {
        // a torn last line from a killed process
      }
    }
  }

  // writer answers to verify, per round
  const extractValues = new Map<string, Record<string, string | null>>();
  const writerAnswers: Record<'verify1' | 'verify2', Map<string, string>> = { verify1: new Map(), verify2: new Map() };
  for (const res of st.results.values()) {
    if (!res.ok) continue;
    if (task.extract) {
      const parsed = parseExtraction(task, res.text ?? '');
      if (parsed.ok) {
        writerAnswers[res.round === 1 ? 'verify1' : 'verify2'].set(res.rowId, JSON.stringify(parsed.values));
        extractValues.set(`${res.round}|${res.rowId}`, parsed.values);
      }
      continue;
    }
    const parsed = parseWriterOutput(task, res.text ?? '');
    if (parsed.ok) writerAnswers[res.round === 1 ? 'verify1' : 'verify2'].set(res.rowId, parsed.value);
  }

  const out: ModelPoints[] = [];
  for (const decider of opts.models) {
    const model = decider.id;
    let spentUsd = 0;
    const verdicts: Record<Stage, Map<string, Answer | undefined>> = { triage: new Map(), verify1: new Map(), verify2: new Map() };
    const fieldAnswers: Record<Stage, Map<string, Record<string, Answer>>> = { triage: new Map(), verify1: new Map(), verify2: new Map() };
    const calls: Array<() => Promise<void>> = [];

    for (const stage of opts.stages ?? STAGES) {
      if (task.extract && stage === 'triage') continue;
      const rows = stage === 'triage' ? (task.triage ? records : []) : records.filter((r) => writerAnswers[stage].has(r.id));
      for (const row of rows) {
        const answer = stage === 'triage' ? undefined : writerAnswers[stage].get(row.id)!;
        if (task.extract) {
          const round = stage === 'verify1' ? 1 : 2;
          const own = model === opts.runModels.verify ? st.verify.get(verifyKey(row.id, round))?.answers : undefined;
          const cached = cache.get(`${model}|${stage}|${row.id}`);
          const known = own ?? (cached && cached.answer === answer ? cached.answers : undefined);
          if (known) {
            fieldAnswers[stage].set(row.id, known);
            continue;
          }
          if (opts.ledgerOnly) continue;
          const values = extractValues.get(`${round}|${row.id}`)!;
          const ex = task.extract;
          calls.push(async () => {
            opts.budget?.assertCanSpend();
            const res = await decider.decide(
              verifyState(task, row.data, answer!),
              Object.fromEntries(ex.fields.map((f) => [f, ex.question(f, values[f] ?? null)])),
            );
            const rec: ScoreRecord = {
              model,
              servedAs: res.model,
              stage,
              rowId: row.id,
              answer: answer!,
              verdict: { type: 'missing' },
              answers: res.answers,
              costUsd: res.costUsd,
              latencyMs: res.latencyMs,
            };
            appendFileSync(cachePath, JSON.stringify(rec) + '\n');
            fieldAnswers[stage].set(row.id, res.answers);
            spentUsd += res.costUsd;
            opts.budget?.charge(res.costUsd);
          });
          continue;
        }
        const fromLedger =
          stage === 'triage'
            ? model === opts.runModels.triage
              ? st.triage.get(row.id)?.answers.answer
              : undefined
            : model === opts.runModels.verify
              ? st.verify.get(verifyKey(row.id, stage === 'verify1' ? 1 : 2))?.answers.verdict
              : undefined;
        if (fromLedger) {
          verdicts[stage].set(row.id, fromLedger);
          continue;
        }
        const cached = cache.get(`${model}|${stage}|${row.id}`);
        if (cached && cached.answer === answer) {
          verdicts[stage].set(row.id, cached.verdict);
          continue;
        }
        if (opts.ledgerOnly) continue;
        calls.push(async () => {
          opts.budget?.assertCanSpend();
          const res =
            stage === 'triage'
              ? await decider.decide(task.state(row.data), { answer: task.triage!.question })
              : await decider.decide(verifyState(task, row.data, answer!), { verdict: verifyQuestion(task) });
          const verdict = stage === 'triage' ? res.answers.answer : res.answers.verdict;
          const rec: ScoreRecord = {
            model,
            servedAs: res.model,
            stage,
            rowId: row.id,
            ...(answer !== undefined ? { answer } : {}),
            verdict: verdict ?? { type: 'missing' },
            costUsd: res.costUsd,
            latencyMs: res.latencyMs,
          };
          appendFileSync(cachePath, JSON.stringify(rec) + '\n');
          verdicts[stage].set(row.id, verdict);
          spentUsd += res.costUsd;
          opts.budget?.charge(res.costUsd);
        });
      }
    }

    if (calls.length) opts.log?.(`${model}: ${calls.length} decision calls`);
    const settled = await Promise.allSettled(calls.map((c) => c()));
    const failed = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    if (failed.length) {
      throw new Error(`${model}: ${failed.length} calls failed (first: ${String(failed[0]!.reason)}). Answers so far are cached; run again.`);
    }

    const points: Record<Stage, Point[]> = { triage: [], verify1: [], verify2: [] };
    const ids: Record<Stage, string[]> = { triage: [], verify1: [], verify2: [] };
    const verify2Slots: Verify2Slot[] = [];
    const fieldSlots: FieldSlotAnswers[] = [];
    for (const row of records) {
      const label = row.data[labelColumn] ?? '';
      if (task.extract) {
        const v1 = extractValues.get(`1|${row.id}`);
        const v2 = extractValues.get(`2|${row.id}`);
        for (const f of task.extract.fields) {
          fieldSlots.push({
            rowId: row.id,
            field: f,
            goldPresent: goldHasValue(label, f),
            correct1: v1 ? task.extract.isCorrect(f, v1[f] ?? null, label) : false,
            correct2: v2 ? task.extract.isCorrect(f, v2[f] ?? null, label) : null,
            answer1: fieldAnswers.verify1.get(row.id)?.[f],
            answer2: fieldAnswers.verify2.get(row.id)?.[f],
          });
        }
        for (const stage of ['verify1', 'verify2'] as const) {
          const answers = fieldAnswers[stage].get(row.id);
          if (!answers) continue;
          const values = extractValues.get(`${stage === 'verify1' ? 1 : 2}|${row.id}`)!;
          for (const f of task.extract.fields) {
            const value = values[f] ?? null;
            const point = verifyPoint(answers[f], task.extract.isCorrect(f, value, label));
            points[stage].push(point);
            if (stage === 'verify2') verify2Slots.push({ point, verify1: fieldAnswers.verify1.get(row.id)?.[f] });
          }
        }
        continue;
      }
      if (verdicts.triage.has(row.id)) {
        points.triage.push(triagePoint(verdicts.triage.get(row.id), label));
        ids.triage.push(row.id);
      }
      for (const stage of ['verify1', 'verify2'] as const) {
        if (!verdicts[stage].has(row.id)) continue;
        points[stage].push(verifyPoint(verdicts[stage].get(row.id), writerAnswers[stage].get(row.id) === label));
        ids[stage].push(row.id);
      }
    }
    out.push({ model, points, ...(task.extract ? { verify2Slots, fieldSlots } : { ids }), spentUsd });
  }
  return out;
}
