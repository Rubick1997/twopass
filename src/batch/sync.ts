import { randomBytes } from 'node:crypto';
import { createLimiter } from '../http.ts';
import type { BatchHandle, BatchProvider, BatchRequest, BatchResultLine, BatchStatus, WaitOptions } from './provider.ts';

/**
 * Synchronous calls behind the `BatchProvider` interface, so the pipeline (and its ledger, budget and resume rules)
 * stays one code path. `submit` records each "batch" through `onSubmitted` first, then calls every request with a
 * concurrency limit; `waitForTerminal` returns the results.
 *
 * Results live in memory. If the process dies between `submit` and `waitForTerminal`, the ledger still names the batch:
 * polling it then reports `expired` with no results, the pipeline records those rows as failed attempts and retries
 * them (the same path as an expired provider batch). Nothing is paid twice for rows already saved.
 */
export const SYNC_BATCH_ID_PREFIX = 'sync_';

export type SyncCaller = (model: string, req: BatchRequest) => Promise<BatchResultLine>;

export interface SyncBatchOptions {
  /** Picks the caller for a model (Anthropic direct or OpenRouter). */
  callerFor: (model: string) => SyncCaller;
  concurrency?: number;
  /** Rows per recorded "batch": smaller chunks lose less to a crash. Default 200. */
  chunkSize?: number;
}

export class SyncBatchProvider implements BatchProvider {
  private readonly opts: SyncBatchOptions;
  private readonly done = new Map<string, BatchResultLine[]>();
  private readonly limit: ReturnType<typeof createLimiter>;

  constructor(opts: SyncBatchOptions) {
    this.opts = opts;
    this.limit = createLimiter(opts.concurrency ?? 16);
  }

  async submit(model: string, requests: BatchRequest[], onSubmitted: (h: BatchHandle) => void): Promise<BatchHandle[]> {
    const call = this.opts.callerFor(model);
    const size = this.opts.chunkSize ?? 200;
    const handles: BatchHandle[] = [];
    for (let i = 0; i < requests.length; i += size) {
      const chunk = requests.slice(i, i + size);
      const h = { id: `${SYNC_BATCH_ID_PREFIX}${randomBytes(6).toString('hex')}`, customIds: chunk.map((r) => r.custom_id) };
      onSubmitted(h); // recorded before any call is made
      handles.push(h);
      this.done.set(h.id, await Promise.all(chunk.map((r) => this.limit(() => call(model, r)))));
    }
    return handles;
  }

  async poll(id: string): Promise<BatchStatus> {
    const results = this.done.get(id);
    if (!results) return { id, status: 'expired', terminal: true, costUsd: null, results: [], undecodable: 0 };
    // No batch-level bill exists for sync calls: the budget charges the per-row computed (list-price) sum.
    return { id, status: 'completed', terminal: true, costUsd: null, results, undecodable: 0 };
  }

  waitForTerminal(id: string, _opts?: WaitOptions): Promise<BatchStatus> {
    return this.poll(id);
  }
}
