export type FetchFn = typeof fetch;

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, url: string) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 300)}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** JSON request with retries on network errors, 429 and 5xx. Other statuses throw HttpError at once. */
export async function requestJson<T>(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  opts: RetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const sleep = opts.sleep ?? realSleep;

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchFn(url, init);
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      await sleep(baseDelayMs * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    if (res.ok) return JSON.parse(text) as T;

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= maxRetries) throw new HttpError(res.status, text, url);
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** attempt);
  }
}

/** Runs at most `n` tasks at once. A finishing task hands its slot straight to the next waiter. */
export function createLimiter(n: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (active < n) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

export function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'X-Title': 'TwoPass',
  };
}
