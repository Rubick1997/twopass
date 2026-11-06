// Banking77 (PolyAI, CC-BY-4.0), downloaded from the Hugging Face datasets server into
// <dataDir>/banking77/{train,test}.csv with columns id, text, label.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'csv-stringify/sync';
import { BANKING77_LABELS } from '../../tasks/banking77.labels.ts';

const PAGE = 100;
const EXPECTED = { train: 10_003, test: 3_080 } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RowsResponse {
  num_rows_total: number;
  rows: Array<{ row_idx: number; row: { text: string; label: number } }>;
}

export type Split = keyof typeof EXPECTED;

export function banking77Path(dataDir: string, split: Split): string {
  return join(dataDir, 'banking77', `${split}.csv`);
}

/** Downloads any split that is missing. Returns the CSV paths. */
export async function ensureBanking77(dataDir: string, log: (m: string) => void = () => {}): Promise<Record<Split, string>> {
  mkdirSync(join(dataDir, 'banking77'), { recursive: true });
  for (const split of ['test', 'train'] as const) {
    const path = banking77Path(dataDir, split);
    if (existsSync(path)) continue;
    log(`downloading Banking77 ${split} split (${EXPECTED[split]} rows)…`);
    const rows = await fetchSplit(split);
    if (rows.length !== EXPECTED[split]) throw new Error(`Banking77 ${split}: expected ${EXPECTED[split]} rows, got ${rows.length}`);
    writeFileSync(path, stringify(rows, { header: true, columns: ['id', 'text', 'label'] }));
  }
  return { train: banking77Path(dataDir, 'train'), test: banking77Path(dataDir, 'test') };
}

async function fetchSplit(split: Split) {
  const out: Array<{ id: string; text: string; label: string }> = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `https://datasets-server.huggingface.co/rows?dataset=PolyAI%2Fbanking77&config=default&split=${split}&offset=${offset}&length=${PAGE}`;
    let res: Response | undefined;
    for (let attempt = 0; attempt < 8; attempt++) {
      res = await fetch(url);
      if (res.ok) break;
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : Math.min(2000 * 2 ** attempt, 60_000));
    }
    if (!res?.ok) throw new Error(`${url}: HTTP ${res?.status}`);
    const page = (await res.json()) as RowsResponse;
    for (const { row_idx, row } of page.rows) {
      const label = BANKING77_LABELS[row.label];
      if (!label) throw new Error(`Unknown label id ${row.label}`);
      out.push({ id: `${split}-${String(row_idx).padStart(5, '0')}`, text: row.text, label });
    }
    if (offset + PAGE >= page.num_rows_total) break;
    await sleep(300); // stay under the datasets server's rate limit
  }
  return out;
}
