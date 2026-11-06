export interface BatchRequest {
  custom_id: string;
  /** Request body for the batch endpoint, without `model` (the batch sets it). */
  body: Record<string, unknown>;
}

export interface BatchHandle {
  id: string;
  customIds: string[];
}

export interface BatchResultLine {
  custom_id: string;
  ok: boolean;
  text?: string;
  error?: string;
  /** The answer hit max_tokens (finish_reason "length"). */
  truncated?: boolean;
  inputTokens: number;
  outputTokens: number;
}

export interface BatchStatus {
  id: string;
  status: string;
  terminal: boolean;
  /** Total cost the provider reports for the batch, once it is known. */
  costUsd: number | null;
  results: BatchResultLine[];
  /** Result lines that could not be decoded (counted, never silently dropped). */
  undecodable: number;
  /** Batch-level error message, when the provider gives one. */
  error?: string;
}

export interface WaitOptions {
  intervalMs?: number;
  maxIntervalMs?: number;
  onStatus?: (status: string) => void;
}

export interface BatchProvider {
  /**
   * Submit requests for one model. A large set may be split into several batches;
   * `onSubmitted` runs for each batch as soon as it exists, so the caller can record it
   * before the next one is sent.
   */
  submit(model: string, requests: BatchRequest[], onSubmitted: (h: BatchHandle) => void): Promise<BatchHandle[]>;
  poll(id: string): Promise<BatchStatus>;
  waitForTerminal(id: string, opts?: WaitOptions): Promise<BatchStatus>;
}
