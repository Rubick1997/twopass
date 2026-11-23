// Deterministic, template-stratified dev / calibration / test split of the VRDU documents.

export interface SplitOptions {
  seed: number;
  dev: number;
  calibration: number;
  test: number;
}

export const DEFAULT_SPLIT: SplitOptions = { seed: 20261114, dev: 30, calibration: 300, test: 500 };

export interface SplitResult {
  seed: number;
  sizes: { dev: number; calibration: number; test: number };
  templates: Record<string, { dev: number; calibration: number; test: number; unused: number }>;
  dev: string[];
  calibration: string[];
  test: string[];
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, 32 bit. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Largest-remainder allocation of `total` over `sizes` proportionally; ties go to the earlier key (callers pass keys sorted by name). */
function allocate(sizes: Array<[string, number]>, total: number): Map<string, number> {
  const sum = sizes.reduce((n, [, s]) => n + s, 0);
  const rows = sizes.map(([k, s]) => ({ k, base: Math.floor((total * s) / sum), rem: (total * s) % sum }));
  let left = total - rows.reduce((n, r) => n + r.base, 0);
  const order = [...rows].sort((a, b) => b.rem - a.rem || (a.k < b.k ? -1 : 1));
  for (const r of order) {
    if (left <= 0) break;
    r.base++;
    left--;
  }
  return new Map(rows.map((r) => [r.k, r.base]));
}

export function splitVrdu(docs: Array<{ docId: string; template: string }>, opts: SplitOptions = DEFAULT_SPLIT): SplitResult {
  const byTemplate = new Map<string, string[]>();
  for (const d of docs) (byTemplate.get(d.template) ?? byTemplate.set(d.template, []).get(d.template)!).push(d.docId);
  const names = [...byTemplate.keys()].sort();
  const sizes: Array<[string, number]> = names.map((t) => [t, byTemplate.get(t)!.length]);
  const total = docs.length;
  if (opts.dev + opts.calibration + opts.test > total) throw new Error('splitVrdu: splits are larger than the dataset');

  // Allocate each split against what the earlier ones left, so a template is never asked for more than it has.
  const counts = { dev: new Map<string, number>(), calibration: new Map<string, number>(), test: new Map<string, number>() };
  let remaining = new Map(sizes);
  for (const split of ['dev', 'calibration', 'test'] as const) {
    const alloc = allocate(sizes, opts[split]);
    // Proportional to the full template sizes (so every split mirrors the corpus mix).
    for (const [t, n] of alloc) {
      const cap = remaining.get(t)!;
      if (n > cap) throw new Error(`splitVrdu: template ${t} cannot supply ${n} for ${split}`);
    }
    counts[split] = alloc;
    remaining = new Map([...remaining].map(([t, c]) => [t, c - alloc.get(t)!]));
  }

  const out: SplitResult = { seed: opts.seed, sizes: { dev: opts.dev, calibration: opts.calibration, test: opts.test }, templates: {}, dev: [], calibration: [], test: [] };
  for (const t of names) {
    const ids = [...byTemplate.get(t)!].sort();
    const rand = mulberry32((opts.seed ^ hashString(t)) >>> 0);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    }
    let at = 0;
    for (const split of ['dev', 'calibration', 'test'] as const) {
      const n = counts[split].get(t)!;
      out[split].push(...ids.slice(at, at + n));
      at += n;
    }
    out.templates[t] = { dev: counts.dev.get(t)!, calibration: counts.calibration.get(t)!, test: counts.test.get(t)!, unused: ids.length - at };
  }
  for (const s of ['dev', 'calibration', 'test'] as const) out[s].sort();
  return out;
}
