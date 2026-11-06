import { CANNOT_TELL, type ChoiceAnswer } from './decide/model.ts';

// Thresholds are applied to the probability of the chosen option, not the vendor's separate
// `confidence` field: probabilities mean the same thing across vendors, and both are kept in
// the ledger so calibrate.ts can compare them.

export interface TriageOutcome {
  accepted: boolean;
  answer: string;
  probability: number;
}

export function triageOutcome(answer: ChoiceAnswer | undefined, t0: number): TriageOutcome {
  if (!answer) return { accepted: false, answer: '', probability: 0 };
  const probability = answer.probabilities[answer.choice] ?? 0;
  return {
    accepted: answer.choice !== CANNOT_TELL && probability >= t0,
    answer: answer.choice,
    probability,
  };
}

export type Verdict = 'supported' | 'unsupported' | 'cannot_tell' | 'invalid_output' | 'writer_failed';

export interface VerifyOutcome {
  accepted: boolean;
  verdict: Verdict;
  /** p(supported) */
  probability: number;
}

export function verifyOutcome(answer: ChoiceAnswer | undefined, threshold: number): VerifyOutcome {
  if (!answer) return { accepted: false, verdict: 'cannot_tell', probability: 0 };
  const probability = answer.probabilities.supported ?? 0;
  const verdict: Verdict =
    answer.choice === 'supported' || answer.choice === 'unsupported' ? answer.choice : 'cannot_tell';
  return { accepted: verdict === 'supported' && probability >= threshold, verdict, probability };
}
