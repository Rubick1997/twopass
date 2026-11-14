import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { VrduBenchOptions } from '../src/bench-vrdu.ts';
import type { VrduDocument } from '../src/datasets/vrdu.ts';
import { chatResult, tempDir } from './helpers.ts';

// 30 fixture documents d01..d30. Truth: a = A<n>, b = B<n>, c = C<n> (absent when n % 4 == 0).
// The cheap writer: garbage for n % 7 == 0, a wrong b for n % 3 == 0, otherwise right. The strong writer is always right.
const pad = (n: number) => String(n).padStart(2, '0');
const truth = (n: number) => ({ a: `A${n}`, b: `B${n}`, c: n % 4 === 0 ? null : `C${n}` });
export const docs: VrduDocument[] = Array.from({ length: 30 }, (_, i) => {
  const n = i + 1;
  const t = truth(n);
  return {
    docId: `d${pad(n)}`,
    filename: `f${n}_Amendment.pdf`,
    template: 'Amendment',
    text: `doc d${pad(n)}\r\nline two  with  gaps\n`,
    gold: { a: [t.a], b: [t.b], c: t.c ? [t.c] : [] } as unknown as VrduDocument['gold'],
  };
});

const MODELS = ['dec/main', 'dec/other', 'cheap:batch', 'strong:batch'];

export function installFakeApi() {
  const requests: string[] = [];
  const batches = new Map<string, { model: string; requests: Array<{ custom_id: string; body: { messages: Array<{ content: string }> } }> }>();
  let nextBatch = 1;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    requests.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
    const path = new URL(url).pathname;
    if (path.endsWith('/models')) {
      return json({ data: MODELS.map((id) => ({ id, context_length: 200_000, pricing: { prompt: '0.000001', completion: '0.000005' } })) });
    }
    const body = init?.body ? (JSON.parse(init.body) as Record<string, any>) : {};
    if (path.endsWith('/alpha/decisions')) {
      const n = Number(String(body.state.document).match(/d(\d\d)/)![1]);
      const strong = body.model === 'dec/main';
      const answers = Object.fromEntries(
        Object.entries(body.questions as Record<string, { instructions: string }>).map(([f, q]) => {
          const ok = q.instructions === `${f}=${(truth(n) as Record<string, string | null>)[f]}`;
          const p = ok ? (strong ? 0.95 : 0.8) : strong ? 0.05 : 0.2;
          return [f, { type: 'choice', choice: ok ? 'supported' : 'unsupported', probabilities: { supported: p, unsupported: 1 - p, cannot_tell: 0 }, confidence: 1 }];
        }),
      );
      return json({ model: body.model, answers, usage: { cost: 0.001 } });
    }
    if (init?.method === 'POST' && path.endsWith('/batches')) {
      const id = `vb-${nextBatch++}`;
      batches.set(id, { model: body.model, requests: body.requests });
      return json({ id, status: 'validating' });
    }
    if (init?.method === 'GET' && path.includes('/batches/')) {
      const id = path.split('/').pop()!;
      const b = batches.get(id)!;
      const results = b.requests.map((r) => {
        const n = Number(r.body.messages.at(-1)!.content.match(/d(\d\d)/)![1]);
        let text = JSON.stringify(truth(n));
        if (b.model === 'cheap:batch') {
          if (n % 7 === 0) text = 'garbage';
          else if (n % 3 === 0) text = JSON.stringify({ ...truth(n), b: 'BAD' });
        }
        return chatResult(r.custom_id, text);
      });
      return json({ id, status: 'completed', usage: { cost: 0.01 }, results });
    }
    return json({}, 404);
  });
  return { requests };
}

export function setup() {
  const root = tempDir();
  const dataDir = join(root, 'data');
  mkdirSync(join(dataDir, 'vrdu'), { recursive: true });
  const documents = join(dataDir, 'vrdu', 'documents.jsonl');
  writeFileSync(documents, docs.map((d) => JSON.stringify(d)).join('\n') + '\n');
  const splitsPath = join(root, 'splits.json');
  writeFileSync(splitsPath, JSON.stringify({ dev: docs.map((d) => d.docId), calibration: [], test: [] }));
  const options = (over: Partial<VrduBenchOptions> = {}): VrduBenchOptions => ({
    apiKey: 'k',
    runsRoot: join(root, 'runs'),
    dataDir,
    maxUsd: 5,
    split: 'dev',
    decision: 'dec/main',
    also: ['dec/other'],
    baseline: 'strong:batch',
    target: 0.95,
    log: () => {},
    taskPath: join(process.cwd(), 'test/fixtures/toy-extract.task.ts'),
    splitsPath,
    ensureData: async () => documents,
    ...over,
  });
  return { root, dataDir, options };
}

