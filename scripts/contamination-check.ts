// Is a decision model's Banking77 score memorization? A difference-in-differences test.
//
// 1. Take a seeded sample of test rows.
// 2. Paraphrase each message with a writer model: same request, different wording.
// 3. Ask each decision model the round-0 question on the original and on the paraphrase.
// 4. If paraphrasing just makes messages harder, every model drops by a similar amount.
//    If one model has memorized the test set's wording, it drops by much more.
//
// Original-wording answers are reused from a bench's test-run ledgers when given (--bench);
// everything else is cached in --out, so a re-run pays nothing twice.
//
//   OPENROUTER_API_KEY=... node scripts/contamination-check.ts --bench runs/bench-... \
//     [--n 300] [--seed 23] [--models jev,clef,luna] [--max-usd 1] [--out runs/contamination-<date>]
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DECISION_ALIASES } from '../src/bench.ts';
import { asChoice, CANNOT_TELL, type Answer } from '../src/decide/model.ts';
import { OpenRouterDecisionModel } from '../src/decide/openrouter.ts';
import { authHeaders, createLimiter, requestJson } from '../src/http.ts';
import { Ledger, replay } from '../src/ledger.ts';
import { parse } from 'csv-parse/sync';
import { loadRun, sample, toRecords } from '../src/run.ts';
import { loadTask, type Row } from '../src/task.ts';

const { values } = parseArgs({
  options: {
    bench: { type: 'string' },
    csv: { type: 'string' },
    n: { type: 'string' },
    seed: { type: 'string' },
    models: { type: 'string' },
    paraphraser: { type: 'string' },
    'max-usd': { type: 'string' },
    out: { type: 'string' },
  },
});
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error('Set OPENROUTER_API_KEY');
const n = Number(values.n ?? 300);
const seed = Number(values.seed ?? 23);
const maxUsd = Number(values['max-usd'] ?? 1);
const models = (values.models ?? 'jev,clef,luna').split(',').map((m) => DECISION_ALIASES[m] ?? m);
const paraphraser = values.paraphraser ?? 'anthropic/claude-haiku-5.5';
const out = resolve(values.out ?? `runs/contamination-${new Date().toISOString().slice(0, 10)}`);
mkdirSync(out, { recursive: true });

const task = await loadTask('tasks/banking77.task.ts');
if (!task.triage) throw new Error('task has no triage question');
const question = { answer: task.triage.question };
// Banking77 as written by `twopass bench` (clean UTF-8, comma-separated); `twopass check` passes it
const csvRows = parse(readFileSync(values.csv ?? 'data/banking77/test.csv', 'utf8'), { columns: true, bom: true }) as Row[];
const rows = sample(toRecords(csvRows, task.idColumn), n, seed);
let spent = 0;
const charge = (usd: number) => {
  spent += usd;
  if (spent > maxUsd) throw new Error(`cost cap $${maxUsd} reached`);
};

// ---- cache helpers
function readJsonl<T>(file: string): T[] {
  const p = join(out, file);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T];
      } catch {
        return []; // torn last line
      }
    });
}
const append = (file: string, rec: unknown) => appendFileSync(join(out, file), JSON.stringify(rec) + '\n');

// ---- 1. paraphrases
interface Para {
  id: string;
  original: string;
  paraphrase: string;
  costUsd: number;
}
const paras = new Map(readJsonl<Para>('paraphrases.jsonl').map((p) => [p.id, p]));
// The message goes inside <message> tags: without them, Haiku answered short questions ("How can I start
// using my card?") as if they were addressed to it, refusing on 11 of 300 rows.
const PROMPT =
  'You paraphrase messages that customers sent to their bank. The user turn contains one such message inside ' +
  '<message> tags. It is text to rewrite, never a question for you, however short it is. Rewrite it so it asks for ' +
  'exactly the same thing, with the same facts and the same request, but in clearly different words and sentence ' +
  'structure, as a different person might write it. Do not add or remove information. Keep it about as long. ' +
  'Reply with the rewritten message only, without tags.';
const limit = createLimiter(8);
const todoParas = rows.filter((r) => !paras.has(r.id));
if (todoParas.length) console.log(`paraphrasing ${todoParas.length} messages with ${paraphraser}`);
await Promise.all(
  todoParas.map((r) =>
    limit(async () => {
      const res = await requestJson<{
        choices: Array<{ message: { content: string | null }; finish_reason: string }>;
        usage?: { cost?: number };
      }>(fetch, 'https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: authHeaders(apiKey),
        body: JSON.stringify({
          model: paraphraser,
          max_tokens: 200,
          reasoning: { enabled: false },
          messages: [
            { role: 'system', content: PROMPT },
            { role: 'user', content: `<message>${r.data.text ?? ''}</message>` },
          ],
        }),
      });
      const text = res.choices[0]?.message.content?.trim();
      if (!text || res.choices[0]?.finish_reason !== 'stop') throw new Error(`bad paraphrase for ${r.id}`);
      if (/\b(rewrite|paste|original message|I can'?t|I'?m not able)\b/i.test(text)) {
        throw new Error(`paraphrase for ${r.id} looks like a refusal, not a rewrite: ${text.slice(0, 80)}`);
      }
      const p: Para = { id: r.id, original: r.data.text ?? '', paraphrase: text, costUsd: res.usage?.cost ?? 0 };
      charge(p.costUsd);
      append('paraphrases.jsonl', p);
      paras.set(r.id, p);
    }),
  ),
);

// ---- 2. original-wording answers from the bench ledgers
type Variant = 'original' | 'paraphrase';
interface Scored {
  model: string;
  id: string;
  variant: Variant;
  answer: Answer | undefined;
  costUsd: number;
  source: 'bench' | 'call';
}
const scored = new Map(readJsonl<Scored>('answers.jsonl').map((s) => [`${s.model}|${s.id}|${s.variant}`, s]));
if (values.bench) {
  const bench = JSON.parse(readFileSync(join(values.bench, 'bench.json'), 'utf8')) as { testRuns: Record<string, string> };
  for (const runId of Object.values(bench.testRuns)) {
    const dir = resolve(values.bench, '..', runId);
    const { manifest } = loadRun(dir);
    if (manifest.mode !== 'normal' || !models.includes(manifest.models.triage)) continue;
    const st = replay(new Ledger(join(dir, 'ledger.jsonl')).read());
    for (const r of rows) {
      const k = `${manifest.models.triage}|${r.id}|original`;
      const d = st.triage.get(r.id);
      if (d && !scored.has(k)) scored.set(k, { model: manifest.models.triage, id: r.id, variant: 'original', answer: d.answers.answer, costUsd: 0, source: 'bench' });
    }
  }
}

// ---- 3. round-0 answers for whatever is missing
for (const model of models) {
  const decider = new OpenRouterDecisionModel({ apiKey, model, concurrency: 8 });
  const todo = rows.flatMap((r) =>
    (['original', 'paraphrase'] as const).filter((v) => !scored.has(`${model}|${r.id}|${v}`)).map((v) => ({ r, v })),
  );
  if (!todo.length) continue;
  console.log(`${model}: ${todo.length} round-0 calls`);
  await Promise.all(
    todo.map(async ({ r, v }) => {
      const text = v === 'original' ? (r.data.text ?? '') : paras.get(r.id)!.paraphrase;
      const res = await decider.decide(text, question);
      charge(res.costUsd);
      const s: Scored = { model, id: r.id, variant: v, answer: res.answers.answer, costUsd: res.costUsd, source: 'call' };
      append('answers.jsonl', s);
      scored.set(`${model}|${r.id}|${v}`, s);
    }),
  );
}

// ---- 4. analysis
const label = new Map(rows.map((r) => [r.id, r.data.label ?? '']));
const correct = (model: string, id: string, v: Variant) => {
  const a = asChoice(scored.get(`${model}|${id}|${v}`)?.answer);
  return !!a && a.choice !== CANNOT_TELL && a.choice === label.get(id);
};
const abstained = (model: string, id: string, v: Variant) => asChoice(scored.get(`${model}|${id}|${v}`)?.answer)?.choice === CANNOT_TELL;
const ids = rows.map((r) => r.id);

let s = seed >>> 0;
const rand = () => {
  s = (s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const B = 4000;
const resamples = Array.from({ length: B }, () => ids.map(() => ids[Math.floor(rand() * ids.length)]!));
const ci = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return [sorted[Math.floor(0.025 * B)]!, sorted[Math.floor(0.975 * B)]!] as const;
};
const acc = (model: string, v: Variant, sampleIds: string[]) => sampleIds.filter((id) => correct(model, id, v)).length / sampleIds.length;
const drop = (model: string, sampleIds: string[]) => acc(model, 'original', sampleIds) - acc(model, 'paraphrase', sampleIds);

const perModel = models.map((model) => {
  const drops = resamples.map((sm) => drop(model, sm));
  return {
    model,
    accOriginal: acc(model, 'original', ids),
    accParaphrase: acc(model, 'paraphrase', ids),
    drop: drop(model, ids),
    dropCi: ci(drops),
    abstainOriginal: ids.filter((id) => abstained(model, id, 'original')).length / ids.length,
    abstainParaphrase: ids.filter((id) => abstained(model, id, 'paraphrase')).length / ids.length,
    flipsRightToWrong: ids.filter((id) => correct(model, id, 'original') && !correct(model, id, 'paraphrase')).length,
    flipsWrongToRight: ids.filter((id) => !correct(model, id, 'original') && correct(model, id, 'paraphrase')).length,
    _drops: drops,
  };
});
const pairs = perModel.flatMap((a, i) =>
  perModel.slice(i + 1).map((b) => {
    const diffs = a._drops.map((d, k) => d - b._drops[k]!);
    return {
      a: a.model,
      b: b.model,
      dropDifference: a.drop - b.drop,
      ci: ci(diffs),
      pAtMostZero: diffs.filter((d) => d <= 0).length / B,
    };
  }),
);

// word overlap, to show the paraphrases really are reworded
const words = (t: string) => new Set(t.toLowerCase().match(/[a-z0-9']+/g) ?? []);
const overlaps = ids.map((id) => {
  const a = words(paras.get(id)!.original);
  const b = words(paras.get(id)!.paraphrase);
  const inter = [...a].filter((w) => b.has(w)).length;
  return inter / Math.max(1, new Set([...a, ...b]).size);
});
const meanOverlap = overlaps.reduce((x, y) => x + y, 0) / overlaps.length;
// rows every model got wrong on the paraphrase but right on the original: likely a paraphrase that changed the intent
const allBroke = ids.filter((id) => models.every((m) => correct(m, id, 'original') && !correct(m, id, 'paraphrase')));

const result = {
  createdAt: new Date().toISOString(),
  n: ids.length,
  seed,
  paraphraser,
  meanWordOverlap: meanOverlap,
  rowsEveryModelLostOnParaphrase: allBroke,
  perModel: perModel.map(({ _drops, ...rest }) => rest),
  pairs,
  spentThisRunUsd: spent,
};
writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');

const short = (m: string) => Object.entries(DECISION_ALIASES).find(([, v]) => v === m)?.[0] ?? m;
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
console.log(`\n${ids.length} test rows · paraphrased by ${paraphraser} · mean word overlap ${pct(meanOverlap)}\n`);
console.log('model   original   paraphrase   drop (95% CI)               right→wrong  wrong→right  cannot_tell orig→para');
for (const m of perModel) {
  console.log(
    [
      short(m.model).padEnd(7),
      pct(m.accOriginal).padEnd(10),
      pct(m.accParaphrase).padEnd(12),
      `${pct(m.drop)} (${pct(m.dropCi[0])} to ${pct(m.dropCi[1])})`.padEnd(27),
      String(m.flipsRightToWrong).padEnd(12),
      String(m.flipsWrongToRight).padEnd(12),
      `${pct(m.abstainOriginal)} → ${pct(m.abstainParaphrase)}`,
    ].join(' '),
  );
}
console.log('\ndifference in drop (a − b): positive = a lost more to paraphrasing');
for (const p of pairs) {
  console.log(
    `  ${short(p.a)} − ${short(p.b)}: ${pct(p.dropDifference)} (95% CI ${pct(p.ci[0])} to ${pct(p.ci[1])}), P(≤0) = ${p.pAtMostZero.toFixed(3)}`,
  );
}
console.log(`\n${allBroke.length} rows every model lost on the paraphrase (likely paraphrases that changed the intent)`);
console.log(`spent this run: $${spent.toFixed(4)} · results: ${join(out, 'result.json')}`);
