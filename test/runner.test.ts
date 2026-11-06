import { appendFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRunDir, loadRun, sha256File, type RunManifest } from '../src/run.ts';
import { executeRun, TaskChangedError, thresholdsFromCalibration, type CalibrationFile } from '../src/runner.ts';
import { tempDir } from './helpers.ts';

function makeRun() {
  const root = tempDir();
  mkdirSync(join(root, 'tasks'));
  const taskPath = join(root, 'tasks', 'banking77.task.ts');
  copyFileSync('tasks/banking77.task.ts', taskPath);
  copyFileSync('tasks/banking77.labels.ts', join(root, 'tasks', 'banking77.labels.ts'));
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
  createRunDir(dir, manifest, []);
  return { dir, taskPath };
}

describe('executeRun', () => {
  it('refuses to resume with a changed task file unless allowed, and records the change', async () => {
    const { dir, taskPath } = makeRun();
    appendFileSync(taskPath, '\n// edited\n');
    await expect(executeRun(dir, { apiKey: 'k' })).rejects.toBeInstanceOf(TaskChangedError);
    await executeRun(dir, { apiKey: 'k', allowTaskChange: true }).catch(() => {}); // network may fail; the record is written first
    expect(loadRun(dir).manifest.taskChanges).toEqual([{ at: expect.any(String), sha256: sha256File(taskPath) }]);
  });

  it('reads runs made before triage and verify models were separate', () => {
    const { dir } = makeRun();
    const path = join(dir, 'manifest.json');
    const m = JSON.parse(require('node:fs').readFileSync(path, 'utf8'));
    m.models = { writer: 'w', escalation: 'e', decision: 'd' };
    delete m.mode;
    require('node:fs').writeFileSync(path, JSON.stringify(m));
    expect(loadRun(dir).manifest).toMatchObject({ mode: 'normal', models: { triage: 'd', verify: 'd' } });
  });
});

describe('thresholdsFromCalibration', () => {
  it('takes t0 from the triage model and t1/t2 from the verify model', () => {
    const fit = (threshold: number) => ({ fit: { threshold } }) as never;
    const c = {
      runId: 'c',
      models: {
        jev: { triage: fit(0.8), verify1: fit(0.99), verify2: fit(0.98) },
        clef: { triage: fit(0.7), verify1: fit(0.6), verify2: fit(0.65) },
      },
    } as unknown as CalibrationFile;
    expect(thresholdsFromCalibration(c, 'jev', 'clef')).toEqual({ t0: 0.8, t1: 0.6, t2: 0.65 });
    expect(() => thresholdsFromCalibration(c, 'luna', 'clef')).toThrow(/no triage fit for luna/);
  });
});
