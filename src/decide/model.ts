// Question and answer shapes for OpenRouter's Decisions API (POST /api/alpha/decisions).
// OpenRouter uses these four type names for every decision model (checked against Jev, Clef and
// Luna on 2026-11-06), so there is no per-provider mapping.

export const CANNOT_TELL = 'cannot_tell';

export interface ChoiceQuestion {
  type: 'choice';
  instructions?: string;
  /** option id -> description. Must include `cannot_tell`. */
  criteria: Record<string, string>;
}

export interface NoulQuestion {
  type: 'noul';
  instructions?: string;
  criteria?: string;
}

export interface ScoreQuestion {
  type: 'score';
  instructions?: string;
  criteria: unknown[];
}

export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export type Answer = ChoiceAnswer | NoulAnswer | { type: string; [key: string]: unknown };

export interface DecisionResult {
  /** Model version that actually answered, e.g. typesafe/jev-1.14-20261014. */
  model: string;
  answers: Record<string, Answer>;
  costUsd: number;
  latencyMs: number;
  requestId?: string;
  provider?: string;
}

export type DecisionState = string | Record<string, unknown> | unknown[];

export interface DecisionModel {
  readonly id: string;
  decide(state: DecisionState, questions: Questions): Promise<DecisionResult>;
}

export function asChoice(answer: Answer | undefined): ChoiceAnswer | undefined {
  if (!answer || answer.type !== 'choice') return undefined;
  const a = answer as ChoiceAnswer;
  return typeof a.choice === 'string' && a.probabilities ? a : undefined;
}

/** Hard rule from the brief: every closed question offers an explicit way to abstain. */
export function assertHasCannotTell(questions: Questions): void {
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === 'choice' && !(CANNOT_TELL in q.criteria)) {
      throw new Error(`Decision question "${id}" has no "${CANNOT_TELL}" option. Every choice question needs one.`);
    }
  }
}
