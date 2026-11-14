// VRDU Registration Forms (FARA), google-research-datasets/vrdu. Raw download in <dataDir>/vrdu/dataset.jsonl.gz,
// normalised to <dataDir>/vrdu/documents.jsonl (one VrduDocument per line, sorted by docId).
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';

/** `principle` is the dataset's own spelling. */
export const VRDU_FIELDS = ['file_date', 'foreign_principle_name', 'registrant_name', 'registration_num', 'signer_name', 'signer_title'] as const;
export type VrduField = (typeof VRDU_FIELDS)[number];

export const VRDU_TEMPLATES = ['Amendment', 'Dissemination Report', 'Short-Form'] as const;
export const VRDU_DOC_COUNT = 1915;
export const VRDU_BASE_URL = 'https://raw.githubusercontent.com/google-research-datasets/vrdu/main/registration-form/main';

export interface VrduDocument {
  docId: string;
  filename: string;
  template: string;
  text: string;
  gold: Record<VrduField, string[]>;
}

interface RawDoc {
  filename: string;
  ocr: { text: string };
  annotations: Array<[string, Array<[string, ...unknown[]]>]>;
}

export const templateOf = (filename: string): string => filename.slice(filename.lastIndexOf('_') + 1).replace(/\.pdf$/i, '');

function emptyGold(): Record<VrduField, string[]> {
  return Object.fromEntries(VRDU_FIELDS.map((f) => [f, [] as string[]])) as unknown as Record<VrduField, string[]>;
}

/** One raw line → a document without its docId (assigned after sorting all filenames). */
export function parseRawDoc(line: string): Omit<VrduDocument, 'docId'> {
  const raw = JSON.parse(line) as RawDoc;
  const gold = emptyGold();
  for (const [name, values] of raw.annotations) {
    if (!(VRDU_FIELDS as readonly string[]).includes(name)) continue;
    const list = gold[name as VrduField];
    for (const v of values) {
      const s = String(v[0]).trim();
      if (s && !list.includes(s)) list.push(s);
    }
  }
  return { filename: raw.filename, template: templateOf(raw.filename), text: raw.ocr.text, gold };
}

/** Assigns d0001… by plain code-unit order of the filenames; fails loudly on a wrong count or an unknown template. */
export function assignDocIds(docs: Array<Omit<VrduDocument, 'docId'>>, expected: number | null = VRDU_DOC_COUNT): VrduDocument[] {
  if (expected !== null && docs.length !== expected) throw new Error(`VRDU: expected ${expected} documents, found ${docs.length}`);
  const sorted = [...docs].sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.filename === sorted[i - 1]!.filename) throw new Error(`VRDU: duplicate filename ${sorted[i]!.filename}`);
  }
  for (const d of sorted) {
    if (expected !== null && !(VRDU_TEMPLATES as readonly string[]).includes(d.template)) {
      throw new Error(`VRDU: unknown template "${d.template}" in ${d.filename}`);
    }
  }
  return sorted.map((d, i) => ({ docId: `d${String(i + 1).padStart(4, '0')}`, ...d }));
}

/** Stream-parses a gzipped JSONL (never holds the whole file in memory) into documents with ids. */
export async function parseVrduGz(gzPath: string, expected: number | null = VRDU_DOC_COUNT): Promise<VrduDocument[]> {
  const rl = createInterface({ input: createReadStream(gzPath).pipe(createGunzip()), crlfDelay: Infinity });
  const docs: Array<Omit<VrduDocument, 'docId'>> = [];
  for await (const line of rl) if (line.trim()) docs.push(parseRawDoc(line));
  return assignDocIds(docs, expected);
}

export function vrduPaths(dataDir: string) {
  const dir = join(dataDir, 'vrdu');
  return { dir, gz: join(dir, 'dataset.jsonl.gz'), meta: join(dir, 'meta.json'), documents: join(dir, 'documents.jsonl') };
}

async function download(url: string, path: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const tmp = `${path}.part`;
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
  renameSync(tmp, path);
}

/** Downloads missing raw files, then (re)builds documents.jsonl when absent or older than the gz. Returns its path. */
export async function ensureVrdu(dataDir: string, log: (m: string) => void = () => {}, opts: { expected?: number | null } = {}): Promise<string> {
  const p = vrduPaths(dataDir);
  mkdirSync(p.dir, { recursive: true });
  for (const [path, name] of [[p.gz, 'dataset.jsonl.gz'], [p.meta, 'meta.json']] as const) {
    if (existsSync(path)) continue;
    log(`downloading ${name}…`);
    await download(`${VRDU_BASE_URL}/${name}`, path);
  }
  if (!existsSync(p.documents) || statSync(p.documents).mtimeMs < statSync(p.gz).mtimeMs) {
    log('parsing dataset.jsonl.gz → documents.jsonl…');
    const docs = await parseVrduGz(p.gz, opts.expected === undefined ? VRDU_DOC_COUNT : opts.expected);
    const tmp = `${p.documents}.part`;
    writeFileSync(tmp, docs.map((d) => JSON.stringify(d) + '\n').join(''));
    renameSync(tmp, p.documents);
    log(`wrote ${docs.length} documents to ${p.documents}`);
  }
  return p.documents;
}

export function loadVrduDocuments(path: string): VrduDocument[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as VrduDocument);
}
