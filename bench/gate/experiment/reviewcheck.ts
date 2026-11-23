// For a red PR: how many of the reviewer rows were actually wrong? Offline, no calls.
//   node bench/gate/experiment/reviewcheck.ts <base.json> <head.json> [more base/head pairs …]
//
// The PR comment never shows gold labels; this script checks the same rows against gold afterwards.

import { compareResults } from '../../../src/gate/compare.ts';
import { readResult } from '../../../src/gate/result.ts';
import { reviewRows } from '../../../src/gate/review.ts';

const args = process.argv.slice(2);
if (args.length < 2 || args.length % 2) {
  console.error('usage: node bench/gate/experiment/reviewcheck.ts <base.json> <head.json> [<base.json> <head.json> …]');
  process.exit(1);
}
for (let i = 0; i < args.length; i += 2) {
  const base = readResult(args[i]!);
  const head = readResult(args[i + 1]!);
  const c = compareResults(base, head);
  const gold = new Map(head.rows.map((r) => [r.id, r.label]));
  const rows = reviewRows(c);
  const wrong = rows.filter((r) => r.headAnswer !== gold.get(r.id));
  const wrongAccepted = wrong.filter((r) => r.headStatus === 'accepted');
  console.log(`${args[i + 1]}: ${wrong.length} of ${rows.length} reviewer rows have a wrong head answer (${wrongAccepted.length} of them auto-accepted)`);
  for (const r of rows) {
    console.log(`  ${r.headAnswer === gold.get(r.id) ? 'right' : 'WRONG'}  ${r.headStatus.padEnd(8)} conf ${r.confidence?.toFixed(3) ?? '–'}  ${r.baseAnswer} → ${r.headAnswer}  (gold ${gold.get(r.id)})  ${r.text.slice(0, 70)}`);
  }
}
