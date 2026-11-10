import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Budget } from './budget.ts';
import { asChoice, CANNOT_TELL, type Answer, type DecisionModel } from './decide/model.ts';
import { verifyKey, type RunState } from './ledger.ts';
import type { Point } from './calibrate.ts';
import type { RowRecord } from './pipeline.ts';
import { parseWriterOutput, verifyQuestion, verifyState, type TaskDefinition } from './task.ts';

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
  costUsd: number;
  latencyMs: number;
}

export interface ModelPoints {
  model: string;
  points: Record<Stage, Point[]>;
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
  /** Use only answers already in the ledger or cache; never call a model (reports). */
  ledgerOnly?: boolean;
  log?: (m: string) => void;
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
  const writerAnswers: Record<'verify1' | 'verify2', Map<string, string>> = { verify1: new Map(), verify2: new Map() };
  for (const res of st.results.values()) {
    if (!res.ok) continue;
    const parsed = parseWriterOutput(task, res.text ?? '');
    if (parsed.ok) writerAnswers[res.round === 1 ? 'verify1' : 'verify2'].set(res.rowId, parsed.value);
  }

  const out: ModelPoints[] = [];
  for (const decider of opts.models) {
    const model = decider.id;
    let spentUsd = 0;
    const verdicts: Record<Stage, Map<string, Answer | undefined>> = { triage: new Map(), verify1: new Map(), verify2: new Map() };
    const calls: Array<() => Promise<void>> = [];

    for (const stage of STAGES) {
      const rows = stage === 'triage' ? (task.triage ? records : []) : records.filter((r) => writerAnswers[stage].has(r.id));
      for (const row of rows) {
        const answer = stage === 'triage' ? undefined : writerAnswers[stage].get(row.id)!;
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
    for (const row of records) {
      const label = row.data[labelColumn] ?? '';
      if (verdicts.triage.has(row.id)) points.triage.push(triagePoint(verdicts.triage.get(row.id), label));
      for (const stage of ['verify1', 'verify2'] as const) {
        if (!verdicts[stage].has(row.id)) continue;
        points[stage].push(verifyPoint(verdicts[stage].get(row.id), writerAnswers[stage].get(row.id) === label));
      }
    }
    out.push({ model, points, spentUsd });
  }
  return out;
}
