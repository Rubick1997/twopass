import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { renderWorkflow } from '../src/gate/init.ts';

// GitHub rejects a workflow whose YAML doesn't parse, and only says so on the Actions page.
describe('workflow files', () => {
  const files = { repo: readFileSync('.github/workflows/eval-gate.yml', 'utf8'), rendered: renderWorkflow({ taskPath: 'gates/x.task.yaml', twopassVersion: '1.2.3' }) };
  for (const [name, text] of Object.entries(files)) {
    it(`${name} workflow is valid YAML with the expected triggers and no pull_request_target`, () => {
      const doc = parseDocument(text);
      expect(doc.errors.map((e) => e.message)).toEqual([]);
      const wf = doc.toJS() as { on: Record<string, unknown>; jobs: Record<string, { if?: string; steps: unknown[] }> };
      expect(Object.keys(wf.on).sort()).toEqual(['pull_request', 'workflow_dispatch']);
      expect(text).not.toContain('pull_request_target:');
      expect(wf.jobs.gate!.if).toContain('head.repo.full_name == github.repository');
    });
  }
});
