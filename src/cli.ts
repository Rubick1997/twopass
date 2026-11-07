#!/usr/bin/env node
import { basename, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DECISION_ALIASES, listBenches, parseConfigs, runBench } from './bench.ts';
import { BudgetExceededError } from './budget.ts';
import { CheckFailedError, checkCsv, DELIMITERS, formatCheckSummary, writeCheckOutputs, type Delimiter } from './check.ts';
import { NEVER, type StageCalibration } from './calibrate.ts';
import { readOverrides } from './overrides.ts';
import { BatchFailedError, TruncatedOutputError } from './pipeline.ts';
import { costCheckLine, loadReport, reviewLine, summarize, summaryLine, writeOutputs } from './report.ts';
import { runDir } from './run.ts';
import {
  calibrateRun,
  executeRun,
  readCalibration,
  startRun,
  TaskChangedError,
  thresholdsFromCalibration,
} from './runner.ts';
import { STAGES } from './score.ts';
import { loadTask, validateThresholds, type Thresholds } from './task.ts';

const USAGE = `twopass: batch LLM work, checked row by row by a decision model

  twopass check <csv> --task <file.task.ts> [options]     no model calls, no cost
      validates the CSV against the task and writes normalized.csv + check-report.json
      (run and bench do this automatically and refuse to start on errors)
      --label <column>       also validate labels (mapped to the task's allowed set)
      --delimiter <d>        auto (default), ",", ";", tab or pipe
      --out <dir>            default runs/checks/<timestamp>-<name>/
      --json                 print the report instead of the summary
  twopass run <csv> --task <file.task.ts> [options]
      --max-usd <n>          stop before spending more than this (recommended)
      --sample <n>           use n rows, sampled with --seed (default 7)
      --limit <n>            use the first n rows
      --label <column>       ground-truth column, for precision in the summary
      --decision <model>     decision model for triage and verify (jev, clef, luna or a model ID)
      --triage <model>       decision model for round 0 only
      --verify <model>       decision model for verification only
      --calibration <file>   thresholds from a calibration.json (made by \`twopass calibrate\`)
      --t0/--t1/--t2 <p>     thresholds by hand (otherwise from the task file)
      --collect              send every row through every stage (calibration data)
      --runs <dir>           where runs are kept (default ./runs)
  twopass resume <runId> [--max-usd <n>] [--allow-task-change]
  twopass report <runId> [--label <column>] [--write]     no model calls, no cost
      summary from the ledger plus the reviewer's decisions (overrides.jsonl)
      --write                rewrite enriched.csv and review.csv from them
  twopass calibrate <runId> --models jev,clef,luna [--target 0.95] [--max-usd <n>]
  twopass bench banking77 --max-usd <n> [--configs jev,clef,luna,jev+clef]
      [--baseline <model>] [--calibration-size 1000] [--test-size <n>] [--baseline-size <n>]
      [--max-batch-rows <n>] [--target 0.95] [--id <benchId>]
      --max-batch-rows sends batches one at a time, so OpenRouter's worst-case
      reservation (every row at max_tokens) stays within your credit balance.

  twopass ui [--runs <dir>] [--port 4777] [--no-open]     no model calls, no cost
      a local web app (127.0.0.1 only) showing every run and bench with live progress;
      with OPENROUTER_API_KEY set it also shows your OpenRouter balance

  Needs OPENROUTER_API_KEY.`;

const ALIAS_HELP = Object.entries(DECISION_ALIASES)
  .map(([k, v]) => `${k}=${v}`)
  .join(', ');

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      task: { type: 'string' },
      'max-usd': { type: 'string' },
      sample: { type: 'string' },
      seed: { type: 'string' },
      limit: { type: 'string' },
      label: { type: 'string' },
      decision: { type: 'string' },
      triage: { type: 'string' },
      verify: { type: 'string' },
      calibration: { type: 'string' },
      collect: { type: 'boolean' },
      t0: { type: 'string' },
      t1: { type: 'string' },
      t2: { type: 'string' },
      runs: { type: 'string' },
      'allow-task-change': { type: 'boolean' },
      models: { type: 'string' },
      target: { type: 'string' },
      configs: { type: 'string' },
      baseline: { type: 'string' },
      'calibration-size': { type: 'string' },
      'test-size': { type: 'string' },
      'baseline-size': { type: 'string' },
      'max-batch-rows': { type: 'string' },
      id: { type: 'string' },
      data: { type: 'string' },
      delimiter: { type: 'string' },
      out: { type: 'string' },
      json: { type: 'boolean' },
      write: { type: 'boolean' },
      port: { type: 'string' },
      'no-open': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, target] = positionals;
  const runsRoot = resolve(values.runs ?? 'runs');
  const log = (m: string) => console.log(m);
  if (values.help || !command) {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  const alias = (m: string | undefined) => (m ? (DECISION_ALIASES[m] ?? m) : undefined);
  const maxUsd = values['max-usd'] !== undefined ? toNumber(values['max-usd'], 'max-usd') : undefined;

  switch (command) {
    case 'check': {
      if (!target || !values.task) throw new UsageError('check needs <csv> and --task <file>');
      const task = await loadTask(values.task);
      const result = await checkCsv(target, task, {
        ...(values.label ? { labelColumn: values.label } : {}),
        delimiter: parseDelimiter(values.delimiter),
        ...(process.env.OPENROUTER_API_KEY ? { apiKey: process.env.OPENROUTER_API_KEY } : {}),
      });
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
      const outDir = resolve(values.out ?? join(runsRoot, 'checks', `${stamp}-${basename(target, extname(target))}`));
      const reportPath = writeCheckOutputs(outDir, result);
      if (values.json) log(JSON.stringify(result.report, null, 2));
      else {
        const args = [target, '--task', values.task, ...(values.label ? ['--label', values.label] : [])].join(' ');
        log(formatCheckSummary(result.report, { heading: `twopass check ${args}`, reportPath }));
      }
      return result.report.errors.length ? 1 : 0;
    }
    case 'run': {
      if (!target || !values.task) throw new UsageError('run needs <csv> and --task <file>');
      const apiKey = requireKey();
      const triage = alias(values.triage ?? values.decision);
      const verify = alias(values.verify ?? values.decision);
      const task = await loadTask(values.task);
      const models = {
        ...(triage ? { triage } : {}),
        ...(verify ? { verify } : {}),
      };
      const thresholds = pickThresholds(values, {
        triage: triage ?? task.models.triage ?? task.models.decision,
        verify: verify ?? task.models.verify ?? task.models.decision,
      });
      const { dir, manifest } = await startRun({
        apiKey,
        runsRoot,
        csvPath: target,
        taskPath: values.task,
        mode: values.collect ? 'collect' : 'normal',
        ...(values.sample ? { sample: toInt(values.sample, 'sample') } : {}),
        ...(values.seed ? { seed: toInt(values.seed, 'seed') } : {}),
        ...(values.limit ? { limit: toInt(values.limit, 'limit') } : {}),
        ...(values.label ? { labelColumn: values.label } : {}),
        models,
        ...(thresholds ? { thresholds } : {}),
        ...(maxUsd !== undefined ? { maxUsd } : {}),
        log,
      });
      log(`run ${manifest.runId} (${manifest.mode}): ${manifest.rowCount} rows → ${dir}`);
      log(`  triage ${manifest.models.triage}, verify ${manifest.models.verify}; thresholds ${fmtThresholds(manifest.thresholds)} from ${manifest.thresholdsSource}`);
      return execute(dir, apiKey, {});
    }
    case 'resume': {
      if (!target) throw new UsageError('resume needs <runId>');
      return execute(runDir(runsRoot, target), requireKey(), {
        ...(maxUsd !== undefined ? { maxUsdOverride: maxUsd } : {}),
        allowTaskChange: values['allow-task-change'] ?? false,
      });
    }
    case 'report': {
      if (!target) throw new UsageError('report needs <runId>');
      const dir = runDir(runsRoot, target);
      const { manifest, st, outcomes, overrides, folded } = await loadReport(dir);
      printSummary(summarize(outcomes, st, values.label ?? manifest.labelColumn, overrides));
      if (values.write) {
        writeOutputs(dir, folded, manifest.inputColumns);
        console.log(`wrote ${join(dir, 'enriched.csv')}, ${join(dir, 'review.csv')}`);
      }
      return 0;
    }
    case 'calibrate': {
      if (!target || !values.models) throw new UsageError(`calibrate needs <runId> and --models (aliases: ${ALIAS_HELP})`);
      const { Budget } = await import('./budget.ts');
      const { path, calibration, spentUsd } = await calibrateRun(runDir(runsRoot, target), {
        apiKey: requireKey(),
        models: values.models.split(',').map((m) => alias(m)!),
        target: values.target ? toNumber(values.target, 'target') : 0.95,
        budget: new Budget(maxUsd ?? 5),
        log,
      });
      log(`\nthresholds for ≥${calibration.target} precision on ${calibration.rows} rows (spent $${spentUsd.toFixed(4)}):`);
      log('model                          stage    n     AUC    ECE raw→cal     threshold  accepts  precision');
      for (const [model, fits] of Object.entries(calibration.models)) {
        for (const stage of STAGES) {
          const f = fits[stage] as StageCalibration | undefined;
          if (!f) continue;
          log(
            [
              model.padEnd(30),
              stage.padEnd(8),
              String(f.n).padEnd(5),
              f.auc.toFixed(3).padEnd(6),
              `${f.eceRaw.toFixed(3)}→${f.eceCalibrated.toFixed(3)}`.padEnd(15),
              (f.fit.threshold > 1 ? 'never' : f.fit.threshold.toFixed(3)).padEnd(10),
              `${(100 * f.fit.coverage).toFixed(0)}%`.padEnd(8),
              f.fit.accepted ? `${(100 * f.fit.precision).toFixed(1)}%` : '—',
            ].join(' '),
          );
        }
      }
      log(`\nwrote ${path}`);
      return 0;
    }
    case 'bench': {
      if (target !== 'banking77') throw new UsageError('bench supports one dataset: banking77');
      if (maxUsd === undefined) throw new UsageError('bench needs --max-usd. A full run costs about $10.');
      const { reportPath } = await runBench({
        apiKey: requireKey(),
        runsRoot,
        dataDir: resolve(values.data ?? 'data'),
        maxUsd,
        configs: parseConfigs(values.configs ?? 'jev,clef,luna,jev+clef'),
        baseline: values.baseline ?? 'anthropic/claude-opus-5.5:batch',
        calibrationSize: toInt(values['calibration-size'] ?? '1000', 'calibration-size'),
        ...(values['test-size'] ? { testSize: toInt(values['test-size'], 'test-size') } : {}),
        ...(values['baseline-size'] ? { baselineSize: toInt(values['baseline-size'], 'baseline-size') } : {}),
        ...(values['max-batch-rows'] ? { maxRowsPerBatch: toInt(values['max-batch-rows'], 'max-batch-rows') } : {}),
        target: values.target ? toNumber(values.target, 'target') : 0.95,
        seed: toInt(values.seed ?? '11', 'seed'),
        ...(values.id ? { id: values.id } : {}),
        log,
      });
      log(`\nreport: ${reportPath}`);
      const benches = listBenches(runsRoot);
      if (benches.length > 1) log(`other benches: ${benches.slice(1).join(', ')}`);
      return 0;
    }
    case 'ui':
      return ui(runsRoot, values.port === undefined ? 4777 : toPort(values.port), !values['no-open']);
    default:
      throw new UsageError(`Unknown command "${command}"`);
  }
}

async function ui(runsRoot: string, port: number, open: boolean): Promise<number> {
  const { startUiServer, uiIsBuilt, defaultDistDir } = await import('./ui/server.ts');
  if (!uiIsBuilt()) {
    console.error(`The UI is not built (${defaultDistDir()}/index.html is missing). Run: pnpm build`);
    return 1;
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  const server = await startUiServer({ runsRoot, port, ...(apiKey ? { apiKey } : {}) });
  console.log(`twopass ui: ${server.url}  (runs: ${runsRoot})`);
  if (!apiKey) console.log('  OPENROUTER_API_KEY is not set: the balance card stays empty.');
  console.log('  Ctrl-C stops it.');
  if (open) openBrowser(server.url);
  await new Promise<void>((done) => {
    process.once('SIGINT', () => {
      console.log('\nstopped');
      void server.close().then(done);
    });
  });
  return 0;
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  import('node:child_process')
    .then(({ spawn }) => {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.on('error', () => console.log(`  open ${url} in your browser`));
      child.unref();
    })
    .catch(() => {});
}

async function execute(
  dir: string,
  apiKey: string,
  o: { maxUsdOverride?: number; allowTaskChange?: boolean },
): Promise<number> {
  const runId = dir.split('/').pop();
  process.once('SIGINT', () => {
    console.error(`\ninterrupted. Nothing is lost: twopass resume ${runId}`);
    process.exit(130);
  });
  try {
    const { outcomes, st, manifest } = await executeRun(dir, { apiKey, ...o, log: (m) => console.log(m) });
    printSummary(summarize(outcomes, st, manifest.labelColumn, readOverrides(dir)));
    console.log(`outputs: ${join(dir, 'enriched.csv')}, ${join(dir, 'review.csv')}`);
    return 0;
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      console.error(`${err.message}\nRaise the cap and continue: twopass resume ${runId} --max-usd <n>`);
      return 2;
    }
    if (err instanceof TaskChangedError || err instanceof TruncatedOutputError || err instanceof BatchFailedError) {
      console.error(err.message);
      return 1;
    }
    console.error(`${err instanceof Error ? err.message : String(err)}\nProgress is saved: twopass resume ${runId}`);
    return 1;
  }
}

function printSummary(s: ReturnType<typeof summarize>) {
  console.log(`\n${summaryLine(s)}`);
  const review = reviewLine(s.review);
  if (review) console.log(`  review: ${review}`);
  for (const r of s.rounds) {
    console.log(`  round ${r.round}: ${r.batches} batch(es), median ${r.medianMinutes.toFixed(1)} min, worst ${r.worstMinutes.toFixed(1)} min`);
  }
  if (s.costCheck) console.log(`  ${costCheckLine(s.costCheck)}`);
}

function pickThresholds(
  values: Record<string, unknown>,
  models: { triage: string; verify: string },
): { values: Thresholds; source: string } | undefined {
  const flags = ['t0', 't1', 't2'] as const;
  const byHand = flags.some((k) => values[k] !== undefined);
  if (byHand && values.calibration) throw new UsageError('Use --calibration or --t0/--t1/--t2, not both.');
  if (values.calibration) {
    const c = readCalibration(values.calibration as string);
    return {
      values: thresholdsFromCalibration(c, models.triage, models.verify),
      source: `calibration ${c.runId} (target precision ${c.target})`,
    };
  }
  if (!byHand) return undefined; // the task file's thresholds
  if (!flags.every((k) => values[k] !== undefined)) throw new UsageError('Pass all of --t0, --t1 and --t2, or none.');
  const t = Object.fromEntries(flags.map((k) => [k, toNumber(values[k] as string, k)])) as unknown as Thresholds;
  validateThresholds(t);
  return { values: t, source: 'command line' };
}

const fmtThresholds = (t: Thresholds) => [t.t0, t.t1, t.t2].map((x) => (x >= NEVER ? 'never' : x.toFixed(3))).join(' / ');

function requireKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new UsageError('Set OPENROUTER_API_KEY first.');
  return key;
}

class UsageError extends Error {}

function parseDelimiter(v: string | undefined): 'auto' | Delimiter {
  if (v === undefined || v === 'auto') return 'auto';
  const named: Record<string, Delimiter> = { tab: '\t', '\\t': '\t', pipe: '|', comma: ',', semicolon: ';' };
  const d = named[v] ?? v;
  if (!(DELIMITERS as readonly string[]).includes(d)) throw new UsageError('--delimiter must be auto, ",", ";", tab or pipe');
  return d as Delimiter;
}

const toNumber = (v: string, name: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number`);
  return n;
};
const toPort = (v: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new UsageError('--port must be 0–65535');
  return n;
};
const toInt = (v: string, name: string): number => {
  const n = toNumber(v, name);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--${name} must be a positive integer`);
  return n;
};

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof CheckFailedError) console.error(err.message);
    else console.error(err instanceof UsageError ? `${err.message}\n\n${USAGE}` : err);
    process.exit(1);
  },
);
