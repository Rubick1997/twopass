# AGENTS.md

Guide for coding agents (and people) setting up or changing TwoPass.

## What this is

TwoPass is a TypeScript CLI for repetitive LLM work over a CSV. A cheap **decision model** checks every row:

```
CSV ──► round 0: triage    decision model picks the answer itself (closed-choice tasks only)
          │ confident ──► ACCEPTED
          ▼
        round 1: batch write   cheap writer model (OpenRouter Batch API)
        verify                 decision model: supported / unsupported / cannot_tell
          │ supported & confident ──► ACCEPTED
          ▼
        round 2: batch re-run  stronger model, rejected rows only
        verify ──► ACCEPTED or FLAGGED (human review)
```

All model calls go through OpenRouter, using `OPENROUTER_API_KEY`. There is no database: run state is JSONL on disk.

## Setup

Requirements: **Node ≥ 22.18** (runs `.ts` files directly through type stripping) and **pnpm**.

```bash
pnpm install
pnpm test            # unit tests, all HTTP mocked, no key needed
pnpm typecheck
pnpm build           # optional: compiles to dist/ (the npm bin)
export OPENROUTER_API_KEY=sk-or-...   # only for commands that call models
```

Never write the key to a file in the repo. Ask the user for it, or have them export it themselves.

## Commands

Run from the repo root with `node src/cli.ts <command>` (or `pnpm twopass <command>`):

| Command | What it does | Costs money |
|---|---|---|
| `run <csv> --task <file> [--sample N] [--label col] [--max-usd N]` | New run in `runs/<runId>/` | yes |
| `resume <runId>` | Continue a stopped run; nothing is repeated or paid twice | yes |
| `report <runId>` | Summary line from the ledger | no |
| `calibrate <runId> --models jev,clef,luna` | Fit thresholds on a labeled `--collect` run | yes |
| `bench banking77 --max-usd N` | Full benchmark: downloads data, calibrates on train, runs configs on test | yes (~$20–30 full) |

Decision-model aliases: `jev` = `typesafe/jev-1.14`, `clef` = `cloudflare/clef`, `luna` = `openai/gpt-6-luna-decisions`.

**Always pass `--max-usd`** on anything that calls models, and confirm the amount with the user before running a
bench. For a cheap end-to-end check, use `bench banking77 --calibration-size 60 --test-size 40 --max-usd 1`.
If the OpenRouter balance is low, add `--max-batch-rows 500` (see "Provider rules" below).

## Layout

```
src/
  cli.ts            argument parsing only
  runner.ts         start / execute / calibrate a run (shared by cli and bench)
  pipeline.ts       the rounds; normal | collect | baseline modes; computeOutcomes (pure)
  ledger.ts         append-only JSONL event log + replay() → RunState
  batch/            BatchProvider interface + OpenRouter Batch API client
  decide/           DecisionModel interface + OpenRouter Decisions API client
  task.ts           task definition (prompt, schema, verify question, models, thresholds)
  calibrate.ts      threshold fitting, isotonic calibration, ECE/Brier/AUC (pure)
  score.ts          ledger → (score, p, correct) points per model and stage
  bench.ts          benchmark orchestration + report
  datasets/         Banking77 download
tasks/              task files (banking77.task.ts)
test/               vitest, HTTP mocked through test/helpers.ts
runs/  data/        local only, gitignored
```

## Invariants: keep these true

- **Resumability.** Every stage reads the ledger first and only does work that isn't recorded yet. `run` and `resume`
  are the same code path. Append to the ledger *before* doing anything that depends on it, and keep appends synchronous.
  A test kills the pipeline mid-batch and mid-verify. Keep it passing.
- **`computeOutcomes` is pure.** Outcomes are derived from the ledger and thresholds, never stored. That lets a `collect`
  run be replayed under any thresholds (calibration, the results explorer).
- **Every decision `choice` question includes `cannot_tell`.** It's enforced in `assertHasCannotTell`.
- **Thresholds come from `calibrate` on held-out data**, never from vendor defaults. `1.01` (`NEVER`) means the stage never
  auto-accepts.
- **A changed task file blocks `resume`** unless `--allow-task-change` is passed; the change is recorded in the manifest.
- **Strict TypeScript, erasable syntax only**: no enums, no parameter properties, no namespaces. Relative imports use
  `.ts` extensions. zod v4 (`z.looseObject`, two-argument `z.record`).

## Provider rules (found the hard way; the code handles each)

| Rule | Where handled |
|---|---|
| Anthropic batch `custom_id` allows only `[A-Za-z0-9_-]` (422 otherwise) | `customId()` in `ledger.ts` |
| A new batch can 404 for a short while after creation | `waitForTerminal` grace period |
| Batch results come back inline and **out of order**; match by `custom_id` | `collectBatch` |
| Over 50,000 requests per batch → 413; split | `OpenRouterBatchProvider.submit` |
| Haiku 5.5 thinks by default and can spend all of `max_tokens` on it → set `reasoning: {enabled: false}` | task file |
| Sonnet 5.5 and Opus 5.5 **cannot** disable reasoning (the whole batch fails) → `effort: "minimal"` plus room in `max_tokens` | task `escalation` |
| Without a strict JSON-schema `response_format`, Sonnet explains instead of answering | task `responseFormat` |
| OpenRouter reserves each batch's **worst case** (all rows at `max_tokens`) from the balance → 402 if short | `--max-batch-rows` |
| Bulk `finish_reason: length` is a settings error, not flaky rows → the run stops | `TruncatedOutputError` |

## Adding a task

Copy `tasks/banking77.task.ts`. Define `state`, the `writer` prompt with `{{column}}` placeholders, `outputSchema`
(zod), the `verify` instructions, and the models. Add `triage` only for closed-choice tasks. Writer and escalation
model IDs must end in `:batch`.

## Before committing

`pnpm test && pnpm typecheck`. Don't commit `runs/`, `data/`, `dist/`, `.env`, or anything containing an API key.
