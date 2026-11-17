import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runVrduBench } from '../src/bench-vrdu.ts';
import { getBench, getBenchExplore, getBenchReport, getReview, getRun, listBenches, listRuns, postOutputs } from '../src/ui/api.ts';
import { installFakeApi, setup } from './vrdu-bench-helpers.ts';

describe('the UI API on an extract bench', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function bench() {
    installFakeApi();
    const { root, options } = setup();
    const { benchDir } = await runVrduBench(options());
    const state = JSON.parse(readFileSync(join(benchDir, 'bench.json'), 'utf8'));
    return { runsRoot: join(root, 'runs'), state };
  }

  it('lists the bench and its runs, and loads each without throwing', async () => {
    const { runsRoot, state } = await bench();

    const benches = await listBenches(runsRoot);
    expect(benches.benches).toHaveLength(1);
    expect(benches.benches[0]).toMatchObject({ benchId: state.benchId, kind: 'extract', status: 'finished', hasReport: true });
    expect(benches.benches[0]!.configs.map((c) => c.name).sort()).toEqual(['baseline', 'normal']);
    expect(benches.benches[0]!.calibration?.run).not.toBeNull();

    const detail = await getBench(runsRoot, state.benchId);
    expect(detail).toMatchObject({ kind: 'extract', resumeCommand: null });
    expect(detail.state).toMatchObject({ kind: 'extract', split: 'dev' });
    expect(getBenchReport(runsRoot, state.benchId).markdown.split('\n')[0]).toContain('fields');

    const runs = await listRuns(runsRoot);
    expect(runs.runs).toHaveLength(3); // calibration, normal, baseline
    for (const r of runs.runs) {
      expect(r.status).toBe('finished');
      expect(r.bench?.benchId).toBe(state.benchId);
      const d = await getRun(runsRoot, r.runId);
      expect(d.stages.length).toBeGreaterThan(0);
      expect(d.precision).not.toBeUndefined();
    }
  });

  it('serves the explorer and the review queue (see test/ui-extract-review.test.ts)', async () => {
    const { runsRoot, state } = await bench();
    expect(await getBenchExplore(runsRoot, state.benchId)).toMatchObject({ kind: 'extract', benchId: state.benchId });
    expect(await getReview(runsRoot, state.testRuns.normal, null)).toMatchObject({ kind: 'extract', runId: state.testRuns.normal });
    expect((await postOutputs(runsRoot, state.testRuns.normal)).written).toEqual(['enriched-fields.csv']);
  });

  it('a stopped extract bench offers the vrdu resume command', async () => {
    installFakeApi();
    const { root, options } = setup();
    await expect(runVrduBench(options({ maxUsd: 0.03 }))).rejects.toThrow();
    const runsRoot = join(root, 'runs');
    const [b] = (await listBenches(runsRoot)).benches;
    expect(b).toMatchObject({ kind: 'extract', status: 'stopped' });
    const detail = await getBench(runsRoot, b!.benchId);
    expect(detail.resumeCommand).toContain(`twopass bench vrdu --id ${b!.benchId}`);
  });
});
