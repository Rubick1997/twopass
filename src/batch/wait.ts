import { realSleep } from '../http.ts';
import type { BatchStatus, WaitOptions } from './provider.ts';

export interface WaitDeps {
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
  /** How long a new batch may answer 404 before we give up on it. Default 3 minutes. */
  notFoundGraceMs?: number | undefined;
}

/**
 * Polls until `poll` reports a terminal status, with growing intervals. A batch can 404 for a short while right
 * after it is created (seen in the first live run), so `isNotFound` errors are retried within a grace period.
 */
export async function waitForTerminalStatus(
  poll: () => Promise<BatchStatus>,
  isNotFound: (err: unknown) => boolean,
  wait: WaitOptions = {},
  deps: WaitDeps = {},
): Promise<BatchStatus> {
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  let interval = wait.intervalMs ?? 10_000;
  const maxInterval = wait.maxIntervalMs ?? 60_000;
  const notFoundUntil = now() + (deps.notFoundGraceMs ?? 180_000);
  let last: string | undefined;
  for (;;) {
    let status: BatchStatus;
    try {
      status = await poll();
    } catch (err) {
      if (!isNotFound(err) || now() > notFoundUntil) throw err;
      await sleep(Math.min(interval, 5_000));
      continue;
    }
    if (status.status !== last) {
      last = status.status;
      wait.onStatus?.(status.status);
    }
    if (status.terminal) return status;
    await sleep(interval);
    interval = Math.min(Math.round(interval * 1.5), maxInterval);
  }
}
