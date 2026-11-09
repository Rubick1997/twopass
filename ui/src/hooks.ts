import { useEffect, useRef, useState } from 'react';

export const POLL_MS = 3000;

export interface Polled<T> {
  data: T | null;
  error: string | null;
  /** When data last arrived (ms). */
  updatedAt: number | null;
  /** Polling is paused because the tab is hidden. */
  paused: boolean;
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<{ text: string; value: T }> {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? message;
    } catch {
      // not JSON
    }
    throw new Error(message);
  }
  return { text, value: JSON.parse(text) as T };
}

/**
 * Fetches `url` now and every 3 s while the tab is visible; pauses while it is hidden and
 * refreshes as soon as it is shown again. Keeps the last good data on errors, and skips the state
 * update when the response did not change, so nothing flickers or loses its scroll position.
 */
export function usePoll<T>(url: string | null, intervalMs = POLL_MS): Polled<T> {
  const [state, setState] = useState<Polled<T>>({ data: null, error: null, updatedAt: null, paused: false });
  const lastText = useRef<string | null>(null);

  useEffect(() => {
    lastText.current = null;
    setState({ data: null, error: null, updatedAt: null, paused: false });
    if (!url) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === 'hidden') {
        setState((s) => (s.paused ? s : { ...s, paused: true }));
        return; // resumed by visibilitychange
      }
      controller = new AbortController();
      try {
        const { text, value } = await getJson<T>(url, controller.signal);
        if (stopped) return;
        const changed = text !== lastText.current;
        lastText.current = text;
        setState((s) => ({ data: changed ? value : s.data, error: null, updatedAt: Date.now(), paused: false }));
      } catch (err) {
        if (stopped || (err as Error).name === 'AbortError') return;
        setState((s) => ({ ...s, error: (err as Error).message || 'Request failed', paused: false }));
      }
      if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(timer);
        controller?.abort();
        void tick();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [url, intervalMs]);

  return state;
}

/** The current time, re-rendering every `ms` (for ticking ages). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export type Route =
  | { page: 'home' }
  | { page: 'run'; id: string }
  | { page: 'review'; id: string }
  | { page: 'bench'; id: string }
  | { page: 'explore'; id: string }
  | { page: 'notfound'; hash: string };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '') || '/';
  if (path === '/') return { page: 'home' };
  const m = /^\/(runs|benches)\/([^/]+)(\/review|\/explore)?\/?$/.exec(path);
  if (m && !(m[3] === '/review' && m[1] !== 'runs') && !(m[3] === '/explore' && m[1] !== 'benches')) {
    let id: string;
    try {
      id = decodeURIComponent(m[2]!);
    } catch {
      return { page: 'notfound', hash };
    }
    if (m[3] === '/review') return { page: 'review', id };
    if (m[3] === '/explore') return { page: 'explore', id };
    return m[1] === 'runs' ? { page: 'run', id } : { page: 'bench', id };
  }
  return { page: 'notfound', hash };
}

export const runHref = (id: string) => `#/runs/${encodeURIComponent(id)}`;
export const reviewHref = (id: string) => `#/runs/${encodeURIComponent(id)}/review`;
export const benchHref = (id: string) => `#/benches/${encodeURIComponent(id)}`;
export const exploreHref = (id: string) => `#/benches/${encodeURIComponent(id)}/explore`;

/** A tiny hash router: `#/`, `#/runs/:id`, `#/runs/:id/review`, `#/benches/:id`, `#/benches/:id/explore`. */
export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
