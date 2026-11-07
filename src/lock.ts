import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// runs/<id>/run.lock: { pid, startedAt, heartbeatAt }, written while `executeRun` works on a run.
// A ledger cannot tell a running process from a killed one; the lock can. It is advisory only:
// nothing ever refuses to start because of it, so a crash (which leaves a stale file) never
// blocks `resume`. The UI calls a run "running" only if the heartbeat is fresh AND the pid is alive.

export const LOCK_FILE = 'run.lock';
export const HEARTBEAT_MS = 15_000;
/** A heartbeat older than this means the process is gone (or frozen). */
export const STALE_AFTER_MS = 60_000;

export interface RunLock {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
}

export interface LockHandle {
  readonly path: string;
  /** Rewrites heartbeatAt now (also done every `intervalMs`). */
  beat(): void;
  /** Stops the heartbeat and removes the file. Safe to call more than once. */
  release(): void;
}

export function acquireRunLock(
  dir: string,
  o: { intervalMs?: number; now?: () => Date; pid?: number } = {},
): LockHandle {
  const path = join(dir, LOCK_FILE);
  const now = o.now ?? (() => new Date());
  const lock: RunLock = { pid: o.pid ?? process.pid, startedAt: now().toISOString(), heartbeatAt: now().toISOString() };
  let released = false;

  const write = () => writeFileSync(path, JSON.stringify(lock) + '\n');
  const beat = () => {
    if (released) return;
    lock.heartbeatAt = now().toISOString();
    try {
      write();
    } catch {
      // the run folder was moved or deleted; the next beat tries again
    }
  };
  write();
  const timer = setInterval(beat, o.intervalMs ?? HEARTBEAT_MS);
  timer.unref();

  const release = () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    process.off('exit', release);
    process.off('SIGINT', onSigint);
    rmSync(path, { force: true });
  };
  // Ctrl-C: remove the lock. The CLI's own SIGINT handler exits the process (which also fires
  // 'exit'); without any other handler, exit here as Node would have done.
  const onSigint = () => {
    release();
    if (process.listenerCount('SIGINT') === 0) process.exit(130);
  };
  process.on('exit', release);
  process.once('SIGINT', onSigint);
  return { path, beat, release };
}

export function readRunLock(dir: string): RunLock | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, LOCK_FILE), 'utf8')) as Partial<RunLock>;
    if (typeof raw.pid !== 'number' || typeof raw.heartbeatAt !== 'string' || typeof raw.startedAt !== 'string') return null;
    return { pid: raw.pid, startedAt: raw.startedAt, heartbeatAt: raw.heartbeatAt };
  } catch {
    return null; // missing, or torn mid-write
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The lock's heartbeat is fresh and its process is alive. */
export function isLockLive(lock: RunLock | null, nowMs = Date.now(), pidAlive: (pid: number) => boolean = isPidAlive): boolean {
  if (!lock) return false;
  const age = nowMs - Date.parse(lock.heartbeatAt);
  return Number.isFinite(age) && age < STALE_AFTER_MS && pidAlive(lock.pid);
}
