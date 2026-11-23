import type { Comparison } from './compare.ts';

// The rows a reviewer should read: what changed between base and head, the riskiest first.
// No gold labels in the output: the reviewer judges.

export interface ReviewRow {
  id: string;
  text: string;
  baseAnswer: string;
  headAnswer: string;
  headStatus: 'accepted' | 'flagged' | 'pending';
  /** Head's checker confidence for its answer (null when nothing was scored). */
  confidence: number | null;
  why: 'flipped' | 'newly accepted' | 'flipped and newly accepted';
}

/**
 * Candidates: rows whose answer flipped base → head, and rows head auto-accepts that base did not.
 * Order: auto-accepted rows first, lowest confidence first (the ones most likely to be wrong), then the rest the same way.
 */
export function reviewRows(c: Comparison, max = 10): ReviewRow[] {
  const out: ReviewRow[] = [];
  for (const { base, head } of c.pairs) {
    const flipped = base.answer !== head.answer;
    const newly = head.status === 'accepted' && base.status !== 'accepted';
    if (!flipped && !newly) continue;
    out.push({
      id: head.id,
      text: head.text,
      baseAnswer: base.answer,
      headAnswer: head.answer,
      headStatus: head.status,
      confidence: head.confidence,
      why: flipped && newly ? 'flipped and newly accepted' : flipped ? 'flipped' : 'newly accepted',
    });
  }
  const conf = (r: ReviewRow) => r.confidence ?? -1;
  out.sort((a, b) => {
    const acc = Number(b.headStatus === 'accepted') - Number(a.headStatus === 'accepted');
    if (acc) return acc;
    return conf(a) - conf(b) || a.id.localeCompare(b.id);
  });
  return out.slice(0, max);
}
