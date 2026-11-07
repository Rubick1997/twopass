import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireRunLock, isLockLive, isPidAlive, LOCK_FILE, readRunLock, STALE_AFTER_MS } from '../src/lock.ts';
import { createRunDir, sha256File, type RunManifest } from '../src/run.ts';
import { executeRun } from '../src/runner.ts';
import { tempDir } from './helpers.ts';
import { writeRunLock } from './lock-helpers.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('run.lock', () => {
  it('is written on acquire, refreshed by the heartbeat, and removed on release', () => {
    vi.useFakeTimers();
    const dir = tempDir();
    let now = Date.parse('2026-11-07T10:00:00Z');
    const lock = acquireRunLock(dir, { intervalMs: 15_000, now: () => new Date(now) });

    const first = readRunLock(dir)!;
    expect(first).toEqual({ pid: process.pid, startedAt: '2026-11-07T10:00:00.000Z', heartbeatAt: '2026-11-07T10:00:00.000Z' });

    now += 15_000;
    vi.advanceTimersByTime(15_000);
    expect(readRunLock(dir)).toEqual({ ...first, heartbeatAt: '2026-11-07T10:00:15.000Z' });

    lock.release();
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
    now += 15_000;
    vi.advanceTimersByTime(30_000); // no beat after release
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
    lock.release(); // twice is fine
  });

  it('removes itself on process exit and does not leak listeners', () => {
    const dir = tempDir();
    const before = { exit: process.listenerCount('exit'), sigint: process.listenerCount('SIGINT') };
    const lock = acquireRunLock(dir);
    expect(process.listenerCount('exit')).toBe(before.exit + 1);
    expect(process.listenerCount('SIGINT')).toBe(before.sigint + 1);
    // what process.exit (or the CLI's SIGINT handler) triggers
    const onExit = process.listeners('exit').at(-1) as () => void;
    onExit();
    expect(existsSync(lock.path)).toBe(false);
    expect(process.listenerCount('exit')).toBe(before.exit);
    expect(process.listenerCount('SIGINT')).toBe(before.sigint);
  });

  it('removes itself on SIGINT when another handler (the CLI) exits the process', () => {
    const dir = tempDir();
    const cliHandler = vi.fn();
    process.once('SIGINT', cliHandler); // registered first, like `execute` in cli.ts
    const lock = acquireRunLock(dir);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    process.emit('SIGINT');
    expect(cliHandler).toHaveBeenCalled();
    expect(existsSync(lock.path)).toBe(false);
    expect(exit).toHaveBeenCalledWith(130); // no other handler left: exit as Node would
    exit.mockRestore();
  });

  it('counts as live only with a fresh heartbeat and a living pid', () => {
    const now = Date.parse('2026-11-07T10:01:00Z');
    const lock = { pid: 1, startedAt: '2026-11-07T10:00:00Z', heartbeatAt: '2026-11-07T10:00:30Z' };
    expect(isLockLive(lock, now, () => true)).toBe(true);
    expect(isLockLive(lock, now, () => false)).toBe(false);
    expect(isLockLive({ ...lock, heartbeatAt: new Date(now - STALE_AFTER_MS).toISOString() }, now, () => true)).toBe(false);
    expect(isLockLive(null, now, () => true)).toBe(false);
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2 ** 22 + 12345)).toBe(false);
  });

  it('reads a torn or foreign file as no lock', () => {
    const dir = tempDir();
    writeFileSync(join(dir, LOCK_FILE), '{"pid": 12');
    expect(readRunLock(dir)).toBeNull();
    writeFileSync(join(dir, LOCK_FILE), '{"pid": "x"}');
    expect(readRunLock(dir)).toBeNull();
  });
});

describe('executeRun and the lock', () => {
  /** The repo's task file, or a private copy the test may break. */
  function makeRun(o: { ownTask?: boolean } = {}) {
    const root = tempDir();
    mkdirSync(join(root, 'tasks'));
    let taskPath = resolve('tasks/banking77.task.ts');
    if (o.ownTask) {
      taskPath = join(root, 'tasks', 'banking77.task.ts');
      copyFileSync('tasks/banking77.task.ts', taskPath);
    }
    const manifest: RunManifest = {
      runId: 'r',
      createdAt: '2026-11-06T00:00:00Z',
      taskPath,
      inputPath: 'x.csv',
      inputColumns: ['id', 'text', 'label'],
      rowCount: 0,
      mode: 'normal',
      models: { writer: 'w:batch', escalation: 'e:batch', triage: 't', verify: 'v' },
      thresholds: { t0: 0.9, t1: 0.9, t2: 0.9 },
      thresholdsSource: 'test',
      prices: {},
      taskSha256: sha256File(taskPath),
    };
    const dir = join(root, 'runs', 'r');
    createRunDir(dir, manifest, []); // no rows: the pipeline makes no network call
    return dir;
  }

  it('a stale lock left by a crash never blocks a resume, and the lock is gone afterwards', async () => {
    const dir = makeRun();
    writeRunLock(dir, { pid: 2 ** 22 + 999, startedAt: '2026-11-06T00:00:00Z', heartbeatAt: '2026-11-06T00:00:00Z' });
    await executeRun(dir, { apiKey: 'k' });
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
    expect(existsSync(join(dir, 'enriched.csv'))).toBe(true);
  });

  it('holds the lock while it works and removes it when the run fails', async () => {
    const dir = makeRun({ ownTask: true });
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as RunManifest;
    // A task file that reports whether the lock exists while executeRun loads it, then fails.
    writeFileSync(
      m.taskPath,
      `import { existsSync } from 'node:fs';\n` +
        `throw new Error(existsSync(${JSON.stringify(join(dir, LOCK_FILE))}) ? 'lock held' : 'no lock');\n`,
    );
    await expect(executeRun(dir, { apiKey: 'k', allowTaskChange: true })).rejects.toThrow('lock held');
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
  });
});
