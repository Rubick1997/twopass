import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import type { Answer } from './decide/model.ts';

// Append-only JSONL log of everything a run has done. Run state is rebuilt from it with
// `replay`, so `twopass resume` continues exactly where a killed process stopped.
// Batch results are written the moment a poll returns them (OpenRouter keeps them only 30 days).

export type Round = 0 | 1 | 2;

export interface DecisionEvent {
  t: 'decision';
  rowId: string;
  round: Round;
  stage: 'triage' | 'verify';
  model: string;
  answers: Record<string, Answer>;
  costUsd: number;
  latencyMs: number;
  at: string;
}

export interface BatchSubmittedEvent {
  t: 'batch_submitted';
  round: 1 | 2;
  batchId: string;
  model: string;
  customIds: string[];
  at: string;
}

export interface BatchStatusEvent {
  t: 'batch_status';
  batchId: string;
  status: string;
  at: string;
}

export interface BatchResultEvent {
  t: 'batch_result';
  batchId: string;
  round: 1 | 2;
  model: string;
  customId: string;
  rowId: string;
  ok: boolean;
  text?: string;
  error?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  at: string;
}

export interface BatchFinishedEvent {
  t: 'batch_finished';
  batchId: string;
  status: string;
  /** Provider-reported total; null if it was not reported. */
  costUsd: number | null;
  undecodable: number;
  at: string;
}

export type LedgerEvent = DecisionEvent | BatchSubmittedEvent | BatchStatusEvent | BatchResultEvent | BatchFinishedEvent;

type WithoutAt<E> = E extends unknown ? Omit<E, 'at'> & { at?: string } : never;

export class Ledger {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    if (!existsSync(path)) writeFileSync(path, '');
    else repairTornTail(path);
  }

  /** Synchronous on purpose: once append returns, the event survives a kill. */
  append(event: WithoutAt<LedgerEvent>): void {
    const full = { ...event, at: event.at ?? new Date().toISOString() };
    appendFileSync(this.path, JSON.stringify(full) + '\n');
  }

  read(): LedgerEvent[] {
    return parseLedger(readFileSync(this.path, 'utf8'), this.path);
  }
}

export function parseLedger(text: string, source = 'ledger'): LedgerEvent[] {
  const lines = text.split('\n');
  const events: LedgerEvent[] = [];
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    try {
      events.push(JSON.parse(line) as LedgerEvent);
    } catch {
      const isLast = lines.slice(i + 1).every((l) => l.trim() === '');
      // A half-written last line means the process died mid-append; that event never happened.
      if (!isLast) throw new Error(`${source}: line ${i + 1} is not valid JSON`);
    }
  });
  return events;
}

/** Drops a half-written final line so the next append starts on a clean line. */
function repairTornTail(path: string): void {
  const text = readFileSync(path, 'utf8');
  if (text === '' || text.endsWith('\n')) return;
  truncateSync(path, Buffer.byteLength(text.slice(0, text.lastIndexOf('\n') + 1)));
}

// Anthropic's batch backend only allows [A-Za-z0-9_-] in custom_id (found in the first live run;
// the API answers 422 otherwise). Row IDs outside that set, or long ones, are hashed. Results are
// mapped back to rows through a lookup table, never by parsing the ID.
const SAFE_ROW_ID = /^[A-Za-z0-9_-]{1,48}$/;

export function customId(rowId: string, round: 1 | 2): string {
  const safe = SAFE_ROW_ID.test(rowId) ? rowId : `h${createHash('sha256').update(rowId).digest('hex').slice(0, 32)}`;
  return `${safe}-r${round}`;
}

export interface BatchInfo extends BatchSubmittedEvent {
  status: string;
  finished: boolean;
  finishedAt?: string;
  reportedCostUsd: number | null;
  resultCostUsd: number;
  /** Result lines the provider returned that could not be decoded (set when the batch finishes). */
  undecodable: number;
}

export interface RunState {
  triage: Map<string, DecisionEvent>;
  /** key: `${rowId}#v${round}` */
  verify: Map<string, DecisionEvent>;
  batches: Map<string, BatchInfo>;
  /** Latest result per custom_id; a successful result is never replaced by a later failure. */
  results: Map<string, BatchResultEvent>;
  /** How many batches each custom_id has been submitted in. */
  attempts: Map<string, number>;
  /** custom_ids inside a batch that has not finished yet. */
  inFlight: Set<string>;
  costByRow: Map<string, number>;
  spentUsd: number;
  firstAt?: string;
  lastAt?: string;
}

export const verifyKey = (rowId: string, round: 1 | 2): string => `${rowId}#v${round}`;

export function replay(events: LedgerEvent[]): RunState {
  const s: RunState = {
    triage: new Map(),
    verify: new Map(),
    batches: new Map(),
    results: new Map(),
    attempts: new Map(),
    inFlight: new Set(),
    costByRow: new Map(),
    spentUsd: 0,
  };
  const addRowCost = (rowId: string, usd: number) => s.costByRow.set(rowId, (s.costByRow.get(rowId) ?? 0) + usd);

  for (const ev of events) {
    s.firstAt ??= ev.at;
    s.lastAt = ev.at;
    switch (ev.t) {
      case 'decision':
        if (ev.stage === 'triage') s.triage.set(ev.rowId, ev);
        else s.verify.set(verifyKey(ev.rowId, ev.round as 1 | 2), ev);
        s.spentUsd += ev.costUsd;
        addRowCost(ev.rowId, ev.costUsd);
        break;
      case 'batch_submitted':
        s.batches.set(ev.batchId, {
          ...ev,
          status: 'submitted',
          finished: false,
          reportedCostUsd: null,
          resultCostUsd: 0,
          undecodable: 0,
        });
        for (const cid of ev.customIds) s.attempts.set(cid, (s.attempts.get(cid) ?? 0) + 1);
        break;
      case 'batch_status': {
        const b = s.batches.get(ev.batchId);
        if (b) b.status = ev.status;
        break;
      }
      case 'batch_result': {
        if (!s.results.get(ev.customId)?.ok) s.results.set(ev.customId, ev);
        const b = s.batches.get(ev.batchId);
        if (b) b.resultCostUsd += ev.costUsd;
        addRowCost(ev.rowId, ev.costUsd);
        break;
      }
      case 'batch_finished': {
        const b = s.batches.get(ev.batchId);
        if (!b) break;
        b.finished = true;
        b.status = ev.status;
        b.finishedAt = ev.at;
        b.reportedCostUsd = ev.costUsd;
        b.undecodable = ev.undecodable ?? 0;
        s.spentUsd += ev.costUsd ?? b.resultCostUsd;
        break;
      }
    }
  }
  for (const b of s.batches.values()) {
    if (!b.finished) for (const cid of b.customIds) s.inFlight.add(cid);
  }
  return s;
}
