// Pure display helpers (tested in test/ui-format.test.ts).

export function formatUsd(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  if (x === 0) return '$0.00';
  if (Math.abs(x) < 0.01) return `$${x.toFixed(4)}`;
  if (Math.abs(x) < 1000) return `$${x.toFixed(2)}`;
  return `$${Math.round(x).toLocaleString('en-US')}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

export function formatPct(x: number | null | undefined, digits = 0): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return `${(100 * x).toFixed(digits)}%`;
}

/** 45 s, 7 min 20 s, 1 h 05 min. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')} min`;
}

/** "just now", "3 min ago", "2 h ago", "4 days ago". */
export function formatAgo(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return '—';
  const diff = nowMs - Date.parse(iso);
  if (!Number.isFinite(diff)) return '—';
  if (diff < 10_000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)} s ago`;
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 48 * 3600_000) return `${Math.floor(diff / 3600_000)} h ago`;
  return `${Math.floor(diff / 86_400_000)} days ago`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** The expected-finish line: "in ~6 min (14:32)", "any moment now", or "—" without an estimate. */
export function formatEta(at: string | null | undefined, nowMs: number): string {
  if (!at) return '—';
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return '—';
  const left = t - nowMs;
  if (left <= 30_000) return 'any moment now';
  const mins = Math.round(left / 60_000);
  const rel = mins < 1 ? 'under a minute' : mins < 90 ? `~${mins} min` : `~${(left / 3600_000).toFixed(1)} h`;
  return `in ${rel} (${formatTime(at)})`;
}

/** 0..1 share, clamped; null when nothing is known. */
export function share(done: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.min(1, Math.max(0, done / total));
}

export function thresholdText(t: number): string {
  return t > 1 ? 'never' : t.toFixed(2);
}
