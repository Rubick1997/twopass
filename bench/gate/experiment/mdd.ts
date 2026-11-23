// Minimum detectable drop per label at the CI slice size, from the noise file. Offline, no keys.
//   node bench/gate/experiment/mdd.ts [gates/banking77.task.yaml]
//
// G3 (2) blocks a label when its net right→wrong loss exceeds max(2, the largest loss between two unchanged runs).
// So the smallest loss it can see is that limit + 1 rows, i.e. (limit + 1) / n of the label's accuracy.
// The promise check's smallest detectable drop is the noise allowance on accepted precision (the spread over runs).

import { readFileSync, writeFileSync } from 'node:fs';
import { loadGateConfig } from '../../../src/gate/task-config.ts';
import { labelLimit, type NoiseFile } from '../../../src/gate/noise.ts';

const taskPath = process.argv[2] ?? 'gates/banking77.task.yaml';
const { config } = loadGateConfig(taskPath);
const noise = JSON.parse(readFileSync(config.noise, 'utf8')) as NoiseFile;

const rows = Object.entries(noise.perLabel)
  .map(([label, { n, maxNetLoss }]) => {
    const limit = labelLimit(noise, label);
    return { label, n, maxNetLoss, limit, mddRows: limit + 1, mddPoints: (100 * (limit + 1)) / n };
  })
  .sort((a, b) => b.mddPoints - a.mddPoints || a.label.localeCompare(b.label));

const byLimit = new Map<number, number>();
for (const r of rows) byLimit.set(r.limit, (byLimit.get(r.limit) ?? 0) + 1);
const m = noise.metrics;
const lines = [
  `# Minimum detectable drop (${config.name}, ${noise.runs} noise runs, ${rows[0]?.n ?? '?'} rows per label)`,
  '',
  `Promise check: accepted precision moved ${(100 * m.acceptedPrecision.spread).toFixed(2)} points between unchanged runs ` +
    `(${(100 * m.acceptedPrecision.min).toFixed(2)}%–${(100 * m.acceptedPrecision.max).toFixed(2)}%), so the floor is ` +
    `${(100 * (config.promise.acceptedPrecision - m.acceptedPrecision.spread)).toFixed(2)}%.`,
  `Confident-wrong: moved ${m.confidentWrong.spread} rows between unchanged runs (${m.confidentWrong.min}–${m.confidentWrong.max}).`,
  `Accuracy: ${(100 * m.accuracy.min).toFixed(2)}%–${(100 * m.accuracy.max).toFixed(2)}%; answer flips between two unchanged runs: up to ${noise.maxAnswerFlips}; rows identical in every run: ${(100 * noise.identicalShare).toFixed(1)}%.`,
  '',
  'Per label (G3 check 2): limit = max(2, largest net loss between two unchanged runs)',
  '',
  ...[...byLimit.entries()].sort((a, b) => a[0] - b[0]).map(([limit, count]) => `- ${count} label(s) with limit ${limit}: smallest visible drop ${limit + 1} rows = ${((100 * (limit + 1)) / (rows[0]?.n ?? 20)).toFixed(0)} accuracy points`),
  '',
  '| label | rows | max net loss in noise | limit | smallest visible drop |',
  '|---|---:|---:|---:|---:|',
  ...rows.map((r) => `| ${r.label} | ${r.n} | ${r.maxNetLoss} | ${r.limit} | ${r.mddRows} rows (${r.mddPoints.toFixed(0)} pts) |`),
];
const out = 'bench/gate/mdd.md';
writeFileSync(out, lines.join('\n') + '\n');
console.log(lines.slice(0, 12).join('\n'));
console.log(`\nwrote ${out}`);
