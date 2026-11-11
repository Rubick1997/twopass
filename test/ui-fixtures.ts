import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { customId, Ledger } from '../src/ledger.ts';
import { writeRunLock } from './lock-helpers.ts';
import { createRunDir, sha256File, type RunManifest } from '../src/run.ts';
import { tempDir } from './helpers.ts';

// Run folders for the UI tests, built with Ledger.append like a real run would.

export const TASK = resolve('tasks/banking77.task.ts');
export const WRITER = 'anthropic/claude-haiku-5.5:batch';
export const ESCALATION = 'anthropic/claude-sonnet-5.5:batch';
export const T0 = Date.parse('2026-11-07T10:00:00.000Z');
export const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
export const MIN = 60_000;

export const LABELS = ['card_arrival', 'age_limit', 'atm_support', 'card_linking'];

export function makeRoot(): string {
  const root = join(tempDir(), 'runs');
  mkdirSync(root, { recursive: true });
  return root;
}

export function makeRun(
  root: string,
  runId: string,
  o: { rows?: number; mode?: RunManifest['mode']; maxUsd?: number; createdAt?: string; writerCache?: RunManifest['writerCache'] } = {},
): { dir: string; ledger: Ledger; rowIds: string[] } {
  const n = o.rows ?? 4;
  const records = Array.from({ length: n }, (_, i) => ({
    id: `r${i + 1}`,
    data: { id: `r${i + 1}`, text: `message ${i + 1}`, label: LABELS[i % LABELS.length]! },
  }));
  const manifest: RunManifest = {
    runId,
    createdAt: o.createdAt ?? iso(0),
    taskPath: TASK,
    inputPath: 'x.csv',
    inputColumns: ['id', 'text', 'label'],
    rowCount: n,
    labelColumn: 'label',
    mode: o.mode ?? 'normal',
    models: { writer: WRITER, escalation: ESCALATION, triage: 'typesafe/jev-1.14', verify: 'typesafe/jev-1.14' },
    thresholds: { t0: 0.9, t1: 0.9, t2: 0.9 },
    thresholdsSource: 'test',
    prices: { [WRITER]: { inputPerToken: 1e-7, outputPerToken: 1e-6 }, [ESCALATION]: { inputPerToken: 1e-6, outputPerToken: 5e-6 } },
    ...(o.maxUsd !== undefined ? { maxUsd: o.maxUsd } : {}),
    taskSha256: sha256File(TASK),
    ...(o.writerCache !== undefined ? { writerCache: o.writerCache } : {}),
  };
  const dir = join(root, runId);
  createRunDir(dir, manifest, records);
  return { dir, ledger: new Ledger(join(dir, 'ledger.jsonl')), rowIds: records.map((r) => r.id) };
}

const choice = (c: string, p: number) => ({ type: 'choice', choice: c, probabilities: { [c]: p, cannot_tell: 1 - p }, confidence: p });

export function triage(ledger: Ledger, rowId: string, label: string, p: number, at: number, costUsd = 0.001) {
  ledger.append({ t: 'decision', rowId, round: 0, stage: 'triage', model: 'typesafe/jev-1.14-x', answers: { answer: choice(label, p) }, costUsd, latencyMs: 5, at: iso(at) });
}

export function verify(ledger: Ledger, rowId: string, round: 1 | 2, supported: boolean, at: number, costUsd = 0.002) {
  ledger.append({
    t: 'decision',
    rowId,
    round,
    stage: 'verify',
    model: 'typesafe/jev-1.14-x',
    answers: { verdict: choice(supported ? 'supported' : 'unsupported', 0.95) },
    costUsd,
    latencyMs: 5,
    at: iso(at),
  });
}

export function submit(ledger: Ledger, batchId: string, round: 1 | 2, model: string, rowIds: string[], at: number) {
  ledger.append({ t: 'batch_submitted', round, batchId, model, customIds: rowIds.map((id) => customId(id, round)), at: iso(at) });
}

export function results(
  ledger: Ledger,
  batchId: string,
  round: 1 | 2,
  model: string,
  answers: Record<string, string>,
  at: number,
  o: { costUsd?: number | null; perRowUsd?: number; undecodable?: number; inputTokens?: number } = {},
) {
  for (const [rowId, label] of Object.entries(answers)) {
    ledger.append({
      t: 'batch_result',
      batchId,
      round,
      model,
      customId: customId(rowId, round),
      rowId,
      ok: true,
      text: JSON.stringify({ label }),
      inputTokens: o.inputTokens ?? 500,
      outputTokens: 8,
      costUsd: o.perRowUsd ?? 0.0005,
      at: iso(at),
    });
  }
  ledger.append({ t: 'batch_finished', batchId, status: 'completed', costUsd: o.costUsd === undefined ? 0.01 : o.costUsd, undecodable: o.undecodable ?? 0, at: iso(at) });
}

export function lockRun(dir: string, heartbeatOffsetMs: number, pid = 4242) {
  writeRunLock(dir, { pid, startedAt: iso(0), heartbeatAt: iso(heartbeatOffsetMs) });
}

export function writeBench(root: string, benchId: string, testRuns: Record<string, string>, extra: Record<string, unknown> = {}) {
  const dir = join(root, benchId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'bench.json'),
    JSON.stringify({
      benchId,
      createdAt: iso(0),
      taskPath: TASK,
      configs: [{ name: 'jev', triage: 'typesafe/jev-1.14', verify: 'typesafe/jev-1.14' }],
      baseline: 'anthropic/claude-opus-5.5:batch',
      calibrationSize: 10,
      testSize: null,
      target: 0.95,
      seed: 1,
      testRuns,
      ...extra,
    }),
  );
  return dir;
}

/**
 * A finished run with two flagged rows, for the review queue. Labels: r1 card_arrival, r2 age_limit,
 * r3 atm_support, r4 card_linking.
 *   r1  accepted in triage (right)
 *   r2  accepted in round 1 (right)
 *   r3  flagged after round 2 with card_linking (wrong); its triage spreads over three labels
 *   r4  flagged after round 2 with card_linking (right, but the verifier couldn't tell)
 * Accuracy, no human: 3 of 4.
 */
export function reviewRun(root: string, runId = 'run-review') {
  const run = makeRun(root, runId);
  const { ledger } = run;
  const decision = (rowId: string, round: 0 | 1 | 2, answers: Record<string, unknown>, at: number) =>
    ledger.append({
      t: 'decision',
      rowId,
      round,
      stage: round === 0 ? 'triage' : 'verify',
      model: 'typesafe/jev-1.14-x',
      answers: answers as never,
      costUsd: 0.001,
      latencyMs: 5,
      at: iso(at),
    });
  const verdict = (choice: string, supported: number, unsupported: number, cannotTell: number) => ({
    verdict: { type: 'choice', choice, probabilities: { supported, unsupported, cannot_tell: cannotTell }, confidence: 0.8 },
  });
  triage(ledger, 'r1', 'card_arrival', 0.97, 0);
  triage(ledger, 'r2', 'age_limit', 0.5, 0);
  decision(
    'r3',
    0,
    { answer: { type: 'choice', choice: 'card_arrival', probabilities: { card_arrival: 0.5, atm_support: 0.3, card_linking: 0.15, age_limit: 0, cannot_tell: 0.05 }, confidence: 0.5 } },
    0,
  );
  triage(ledger, 'r4', 'card_linking', 0.6, 0);
  submit(ledger, 'batch-1', 1, WRITER, ['r2', 'r3', 'r4'], MIN);
  results(ledger, 'batch-1', 1, WRITER, { r2: 'age_limit', r3: 'card_arrival', r4: 'age_limit' }, 5 * MIN);
  decision('r2', 1, verdict('supported', 0.96, 0.03, 0.01), 6 * MIN);
  decision('r3', 1, verdict('unsupported', 0.1, 0.85, 0.05), 6 * MIN);
  decision('r4', 1, verdict('unsupported', 0.2, 0.7, 0.1), 6 * MIN);
  submit(ledger, 'batch-2', 2, ESCALATION, ['r3', 'r4'], 7 * MIN);
  results(ledger, 'batch-2', 2, ESCALATION, { r3: 'card_linking', r4: 'card_linking' }, 10 * MIN);
  decision('r3', 2, verdict('unsupported', 0.2, 0.6, 0.2), 11 * MIN);
  decision('r4', 2, verdict('cannot_tell', 0.4, 0.1, 0.5), 11 * MIN);
  return run;
}

// ---------------------------------------------------------------- results explorer

export const JEV = 'typesafe/jev-1.14';
export const CLEF = 'cloudflare/clef';

/** Rows of exploreRun, in order; the label of rN is LABELS[(N-1) % 4]. */
export const EXPLORE_ROWS = 9;

/**
 * A `collect` run (every row through every stage) built by hand, 9 rows, jev for triage and verify.
 * Labels: r1 card_arrival, r2 age_limit, r3 atm_support, r4 card_linking, r5 card_arrival, r6 age_limit,
 * r7 atm_support, r8 card_linking, r9 card_arrival.
 *   r1  triage right (0.97)                      -> accepted in round 0
 *   r2  triage 0.5; w1 right, v1 supported 0.95  -> accepted in round 1
 *   r3  w1 wrong (v1 unsupported); w2 right, v2 supported 0.96 -> accepted in round 2
 *   r4  triage WRONG with 0.95                   -> accepted in round 0, incorrect
 *   r5  triage cannot_tell; w1 right, v1 supported 0.8; w2 right, v2 unsupported -> flagged, right
 *   r6  w1 output does not parse; w2 right, v2 supported 0.99 -> accepted in round 2
 *   r7  w1 failed twice; w2 wrong, v2 unsupported -> flagged, wrong
 *   r8  triage 0.6 right; w1 right, v1 supported 0.92 -> accepted in round 1
 *   r9  triage 0.6; w1 WRONG, v1 supported 0.91 -> accepted in round 1, incorrect
 * Costs: triage $0.001, verify $0.002, writer rows $0.0005 (round 1) and $0.004 (round 2).
 * With `usage: true` the writer results carry a raw `usage` object (a run priced with caching).
 */
export function exploreRun(
  root: string,
  runId = 'run-calib',
  o: {
    /** true: raw usage without cache tokens; 'cache': raw usage with cache-read tokens; absent: no usage (old ledger). */
    usage?: boolean | 'cache';
    /** The manifest's `writerCache`; absent: an old manifest without the field. */
    writerCache?: RunManifest['writerCache'];
    mode?: RunManifest['mode'];
  } = {},
) {
  const run = makeRun(root, runId, { rows: EXPLORE_ROWS, mode: o.mode ?? 'collect', ...(o.writerCache !== undefined ? { writerCache: o.writerCache } : {}) });
  const { ledger } = run;
  const tri = (rowId: string, c: string, p: number) =>
    ledger.append({
      t: 'decision', rowId, round: 0, stage: 'triage', model: `${JEV}-x`, costUsd: 0.001, latencyMs: 5, at: iso(0),
      answers: { answer: { type: 'choice', choice: c, probabilities: { [c]: p, cannot_tell: 1 - p }, confidence: p } },
    });
  const ver = (rowId: string, round: 1 | 2, choice: 'supported' | 'unsupported' | 'cannot_tell', pSupported: number) =>
    ledger.append({
      t: 'decision', rowId, round, stage: 'verify', model: `${JEV}-x`, costUsd: 0.002, latencyMs: 5, at: iso(MIN),
      answers: { verdict: { type: 'choice', choice, probabilities: { supported: pSupported, unsupported: 1 - pSupported, cannot_tell: 0 }, confidence: 0.9 } },
    });
  const write = (batchId: string, round: 1 | 2, model: string, rowId: string, text: string | null) =>
    ledger.append({
      t: 'batch_result', batchId, round, model, customId: customId(rowId, round), rowId, ok: text !== null,
      ...(text !== null ? { text } : { error: 'boom' }), inputTokens: 500, outputTokens: 8,
      ...(o.usage === 'cache'
        ? { usage: { prompt_tokens: 500, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 400 } } }
        : o.usage
          ? { usage: { prompt_tokens: 500, completion_tokens: 8 } }
          : {}),
      costUsd: round === 1 ? 0.0005 : 0.004, at: iso(MIN),
    });
  const ans = (label: string) => JSON.stringify({ label });
  const finish = (batchId: string) => ledger.append({ t: 'batch_finished', batchId, status: 'completed', costUsd: 0.01, undecodable: 0, at: iso(2 * MIN) });

  tri('r1', 'card_arrival', 0.97);
  tri('r2', 'age_limit', 0.5);
  tri('r3', 'atm_support', 0.5);
  tri('r4', 'card_arrival', 0.95); // the label is card_linking
  ledger.append({
    t: 'decision', rowId: 'r5', round: 0, stage: 'triage', model: `${JEV}-x`, costUsd: 0.001, latencyMs: 5, at: iso(0),
    answers: { answer: { type: 'choice', choice: 'cannot_tell', probabilities: { cannot_tell: 0.9, card_arrival: 0.05 }, confidence: 0.9 } },
  });
  tri('r6', 'age_limit', 0.4);
  tri('r7', 'atm_support', 0.3);
  tri('r8', 'card_linking', 0.6);
  tri('r9', 'card_arrival', 0.6);

  const all = run.rowIds;
  submit(ledger, 'b1', 1, WRITER, all, MIN);
  write('b1', 1, WRITER, 'r1', ans('card_arrival'));
  write('b1', 1, WRITER, 'r2', ans('age_limit'));
  write('b1', 1, WRITER, 'r3', ans('card_linking'));
  write('b1', 1, WRITER, 'r4', ans('card_linking'));
  write('b1', 1, WRITER, 'r5', ans('card_arrival'));
  write('b1', 1, WRITER, 'r6', 'not json at all');
  write('b1', 1, WRITER, 'r7', null);
  write('b1', 1, WRITER, 'r8', ans('card_linking'));
  write('b1', 1, WRITER, 'r9', ans('age_limit'));
  finish('b1');
  submit(ledger, 'b1b', 1, WRITER, ['r7'], 3 * MIN); // the retry of the failed row fails too
  write('b1b', 1, WRITER, 'r7', null);
  finish('b1b');
  ver('r1', 1, 'supported', 0.97);
  ver('r2', 1, 'supported', 0.95);
  ver('r3', 1, 'unsupported', 0.1);
  ver('r4', 1, 'supported', 0.5);
  ver('r5', 1, 'supported', 0.8);
  ver('r8', 1, 'supported', 0.92);
  ver('r9', 1, 'supported', 0.91);

  submit(ledger, 'b2', 2, ESCALATION, all, 4 * MIN);
  write('b2', 2, ESCALATION, 'r1', ans('card_arrival'));
  write('b2', 2, ESCALATION, 'r2', ans('age_limit'));
  write('b2', 2, ESCALATION, 'r3', ans('atm_support'));
  write('b2', 2, ESCALATION, 'r4', ans('card_linking'));
  write('b2', 2, ESCALATION, 'r5', ans('card_arrival'));
  write('b2', 2, ESCALATION, 'r6', ans('age_limit'));
  write('b2', 2, ESCALATION, 'r7', ans('card_linking'));
  write('b2', 2, ESCALATION, 'r8', ans('card_linking'));
  write('b2', 2, ESCALATION, 'r9', ans('card_arrival'));
  finish('b2');
  ver('r1', 2, 'supported', 0.99);
  ver('r2', 2, 'supported', 0.99);
  ver('r3', 2, 'supported', 0.96);
  ver('r4', 2, 'supported', 0.9);
  ver('r5', 2, 'unsupported', 0.3);
  ver('r6', 2, 'supported', 0.99);
  ver('r7', 2, 'unsupported', 0.2);
  ver('r8', 2, 'supported', 0.99);
  ver('r9', 2, 'supported', 0.99);
  return run;
}

/** A bench with bench-report.json for the explorer; its calibration run is `calibrationRunId` (or reused through a file). */
export function exploreBench(
  root: string,
  benchId: string,
  o: { calibrationRunId?: string; calibrationPath?: string; calibrationReused?: boolean; testRuns?: Record<string, string> } = {},
) {
  const dir = writeBench(root, benchId, o.testRuns ?? {}, {
    ...(o.calibrationRunId ? { calibrationRunId: o.calibrationRunId } : {}),
    ...(o.calibrationPath ? { calibrationPath: o.calibrationPath, calibrationReused: o.calibrationReused ?? false } : {}),
  });
  const stage = (stage: string) => ({
    stage, model: JEV, n: 9, eceRaw: 0.12, eceCalibrated: 0.03,
    reliabilityRaw: [{ lo: 0.9, hi: 1, n: 9, meanP: 0.95, accuracy: 0.8 }],
    reliabilityCalibrated: [{ lo: 0.9, hi: 1, n: 9, meanP: 0.82, accuracy: 0.8 }],
  });
  const costPer1k = { triage: 1, write1: 2, verify1: 3, write2: 4, verify2: 5, total: 15 };
  writeFileSync(
    join(dir, 'bench-report.json'),
    JSON.stringify({
      benchId, createdAt: iso(0), calibrationRunId: o.calibrationRunId ?? 'run-calib', calibrationRows: EXPLORE_ROWS, target: 0.95,
      configs: [
        {
          name: 'jev', runId: o.testRuns?.jev ?? 'run-test', triage: JEV, verify: JEV, thresholds: { t0: 0.9, t1: 0.9, t2: 0.9 }, rows: 100,
          round0Share: 0.5, autoAcceptShare: 0.6, escalatedShare: 0.4, flaggedShare: 0.1, precision: 0.96, accuracyNoHuman: 0.94,
          triageTop1: 0.87, costPer1k, minutes: { round0: 1, rounds: [], total: 10 },
          calibration: [stage('triage'), stage('verify1'), stage('verify2')],
        },
        {
          name: 'baseline', runId: o.testRuns?.baseline ?? 'run-base', triage: null, verify: null, thresholds: null, rows: 100, round0Share: 0,
          autoAcceptShare: 1, escalatedShare: 0, flaggedShare: 0, precision: 0.95, accuracyNoHuman: 0.95, triageTop1: null,
          costPer1k: { ...costPer1k, total: 20 }, minutes: { round0: null, rounds: [], total: 10 }, calibration: [],
        },
      ],
      calibrationFits: { [JEV]: { triage: { fit: { threshold: 0.93 } }, verify1: { fit: { threshold: 0.91 } } } },
    }),
  );
  return dir;
}

/**
 * A larger `collect` run for the refit tests: `n` rows with seeded pseudo-random answers. Jev (the run's own model)
 * answers in the ledger; Clef's answers go to scores.jsonl, as `calibrate --models` would leave them. Triage
 * probabilities have two decimals for Jev and four for Clef (like the real models), a few rows abstain, a few
 * writer outputs do not parse, and a verdict is "supported" more often when the writer was right.
 */
export function exploreRunLarge(root: string, runId = 'run-calib-big', n = 80) {
  const run = makeRun(root, runId, { rows: n, mode: 'collect' });
  const { ledger } = run;
  let seed = 11;
  const rand = () => {
    // mulberry32: deterministic, and every step stays within 32 bits
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (p: number) => rand() < p;
  const other = (label: string) => LABELS[(LABELS.indexOf(label) + 1 + Math.floor(rand() * 3)) % LABELS.length]!;
  const scores: Array<Record<string, unknown>> = [];
  const triageAnswer = (label: string, digits: number) => {
    if (pick(0.06)) return { type: 'choice', choice: 'cannot_tell', probabilities: { cannot_tell: 0.7, [label]: 0.3 }, confidence: 0.7 };
    const p = Number((0.5 + 0.5 * rand()).toFixed(digits));
    const c = pick(p) ? label : other(label);
    return { type: 'choice', choice: c, probabilities: { [c]: p, cannot_tell: 1 - p }, confidence: p };
  };
  const verdictAnswer = (correct: boolean, digits: number) => {
    const p = Number((0.5 + 0.5 * rand()).toFixed(digits));
    const choice = pick(correct ? 0.9 : 0.35) ? 'supported' : pick(0.8) ? 'unsupported' : 'cannot_tell';
    return { type: 'choice', choice, probabilities: { supported: p, unsupported: 1 - p, cannot_tell: 0 }, confidence: p };
  };
  const labelOf = (i: number) => LABELS[i % LABELS.length]!;

  run.rowIds.forEach((rowId, i) => {
    ledger.append({ t: 'decision', rowId, round: 0, stage: 'triage', model: `${JEV}-x`, costUsd: 0.001, latencyMs: 5, at: iso(0), answers: { answer: triageAnswer(labelOf(i), 2) } });
    scores.push({ model: CLEF, servedAs: CLEF, stage: 'triage', rowId, verdict: triageAnswer(labelOf(i), 4), costUsd: 0.004, latencyMs: 1 });
  });

  for (const round of [1, 2] as const) {
    const model = round === 1 ? WRITER : ESCALATION;
    submit(ledger, `big${round}`, round, model, run.rowIds, round * MIN);
    const written = new Map<string, string | null>();
    run.rowIds.forEach((rowId, i) => {
      const label = labelOf(i);
      const text = pick(0.05) ? null : pick(round === 1 ? 0.75 : 0.85) ? label : other(label);
      written.set(rowId, text);
      ledger.append({
        t: 'batch_result', batchId: `big${round}`, round, model, customId: customId(rowId, round), rowId, ok: text !== null,
        ...(text !== null ? { text: JSON.stringify({ label: text }) } : { error: 'boom' }), inputTokens: 500, outputTokens: 8,
        costUsd: round === 1 ? 0.0005 : 0.004, at: iso(round * MIN),
      });
    });
    ledger.append({ t: 'batch_finished', batchId: `big${round}`, status: 'completed', costUsd: 0.05, undecodable: 0, at: iso(round * MIN + 1) });
    run.rowIds.forEach((rowId, i) => {
      const text = written.get(rowId);
      if (text === null || text === undefined) return;
      const correct = text === labelOf(i);
      ledger.append({ t: 'decision', rowId, round, stage: 'verify', model: `${JEV}-x`, costUsd: 0.002, latencyMs: 5, at: iso(round * MIN + 2), answers: { verdict: verdictAnswer(correct, 2) } });
      if (pick(0.95)) scores.push({ model: CLEF, servedAs: CLEF, stage: `verify${round}`, rowId, answer: text, verdict: verdictAnswer(correct, 4), costUsd: 0.004, latencyMs: 1 });
    });
  }
  writeFileSync(join(run.dir, 'scores.jsonl'), scores.map((s) => JSON.stringify(s)).join('\n') + '\n');
  return run;
}
