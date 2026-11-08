// Shared by the server and the browser app (imported as a value there), so: no imports.

const SHORT_NAMES = ['jev', 'clef', 'luna', 'haiku', 'sonnet', 'opus'] as const;

/** "anthropic/claude-haiku-5.5:batch" → "haiku", "typesafe/jev-1.14-20261014" → "jev"; others: the part after the slash. */
export function shortModel(id: string): string {
  const lower = id.toLowerCase();
  const known = SHORT_NAMES.find((n) => lower.includes(n));
  if (known) return known;
  return (id.split('/').pop() ?? id).replace(/:batch$/, '');
}

/** "batch-1794002236-oAoe36taXZzgKQvqzttj" → "…qzttj" style: the last 4 characters. */
export function shortBatchId(id: string): string {
  return id.length <= 6 ? id : `…${id.slice(-4)}`;
}
