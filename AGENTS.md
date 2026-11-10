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
pnpm build           # compiles to dist/ (the npm bin) and builds the UI into dist/ui
export OPENROUTER_API_KEY=sk-or-...   # only for commands that call models
```

Never write the key to a file in the repo. Ask the user for it, or have them export it themselves.

## Commands

Run from the repo root with `node src/cli.ts <command>` (or `pnpm twopass <command>`):

| Command | What it does | Costs money |
|---|---|---|
| `check <csv> --task <file> [--label col] [--delimiter auto\|,\|;\|tab\|pipe] [--out dir] [--json]` | Validate the CSV against the task; write `normalized.csv` + `check-report.json` (default `runs/checks/…`). Exit 1 on errors | no (only GET `/models`) |
| `run <csv> --task <file> [--sample N] [--label col] [--max-usd N]` | New run in `runs/<runId>/` | yes |
| `resume <runId>` | Continue a stopped run; nothing is repeated or paid twice | yes |
| `report <runId> [--write]` | Summary from the ledger plus the reviewer's `overrides.jsonl`: review progress and, with labels, accuracy without and with a human. `--write` rewrites `enriched.csv` and `review.csv` from them | no |
| `calibrate <runId> --models jev,clef,luna` | Fit thresholds on a labeled `--collect` run | yes |
| `bench banking77 --max-usd N [--calibration file]` | Full benchmark: downloads data, calibrates on train, runs configs on test. `--calibration` reuses an existing `calibration.json` (path recorded in `bench.json` with `calibrationReused: true`, no calibration run, its spend not counted) | yes (~$20–30 full) |
| `ui [--runs dir] [--port 4777] [--no-open]` | Local web app (127.0.0.1 only) with every run and bench, live, and the review queue for flagged rows. Needs `pnpm build` first | no (only GET `/credits` for the balance, if a key is set) |

**Runs normalize their input.** `run` and `bench` call `checkCsv` (`src/check.ts`) first and refuse to start on any
error. Everything except the context-length check runs before any network call; that check needs one GET `/models`,
which is reused for prices. A started run keeps `normalized.csv` and `check-report.json`, builds `rows.jsonl` from
the normalized rows, and records both file hashes under `input` in `manifest.json`. `resume` reads `rows.jsonl` only.
Row numbers in check messages are 1-based data rows (header excluded). Keep `check` model-free and never print matched
personal data, only row numbers.

Decision-model aliases: `jev` = `typesafe/jev-1.14`, `clef` = `cloudflare/clef`, `luna` = `openai/gpt-6-luna-decisions`.

**Always pass `--max-usd`** on anything that calls models, and confirm the amount with the user before running a
bench. For a cheap end-to-end check, use `bench banking77 --calibration-size 60 --test-size 40 --max-usd 1`.
If the OpenRouter balance is low, add `--max-batch-rows 500` (see "Provider rules" below).

## Local UI (`twopass ui`)

```bash
pnpm build                                # TS + the app (Vite + React) into dist/ui
node src/cli.ts ui                        # http://127.0.0.1:4777, opens the browser
node scripts/fake-live-run.ts             # a fake run that updates for ~4 min; no key, no cost
node scripts/fake-live-run.ts --instant   # the same run, finished at once, with flagged rows to review
pnpm dev:ui                               # Vite dev server; proxies /api to a running `ui --no-open` on 4777
```

- `src/ui/api.ts` holds all the logic as pure functions (runs folder in, plain objects out); `server.ts` only routes,
  sets headers and serves `dist/ui`. Response types live once in `src/ui/api-types.ts`, imported type-only by the app.
- The server binds to `127.0.0.1`, rejects any `Host` other than `127.0.0.1:<port>` / `localhost:<port>`, and validates
  IDs against `^[A-Za-z0-9_.-]+$` plus a resolved-path check. The OpenRouter key stays in the server process and is never
  sent to the browser or logged (a test searches every response for it).
- **Write endpoints.** Everything is GET/HEAD (405 otherwise) except exactly two routes, which are POST only:
  `POST /api/runs/:id/overrides` (appends one line to `overrides.jsonl`) and `POST /api/runs/:id/outputs` (rewrites
  `enriched.csv` and `review.csv`, same as `report --write`). Both also require `Origin` to be exactly
  `http://127.0.0.1:<port>` or `http://localhost:<port>` (403) and `Content-Type: application/json` (415): another site
  can't send that pair without a CORS preflight, which the server never approves, so this is the CSRF protection. Bodies
  are capped at 16 KB (413), parsed as JSON (400) and validated with zod (`decisionInputSchema`, strict: 400); the row must
  exist in the run (404) and an override must be allowed by the task (400). The server writes no other file in `runs/`,
  and never opens a `Ledger` (that would repair a torn tail a live run may be writing). Add a test for every new
  rejection. A new write endpoint needs the same checks; put it in `writeRoute()` in `server.ts`.
- No model calls in the UI or server. The only outgoing request is `GET /api/v1/credits`, cached 30 s.
- React and Vite are devDependencies: users of the CLI install no frontend runtime.
- Spend by stage comes from `spendByStage` in `src/stats.ts`, shared with the bench report. Don't compute it anywhere else.

**The review queue** (`#/runs/:id/review`, `GET /api/runs/:id/review?filter=flagged|reviewed|all`) is built from
`computeOutcomes` plus `foldOverrides`; the keyboard map and optimistic-update maths are pure helpers in `ui/src/review.ts`.

**The results explorer** (`#/benches/:id/explore[?tab=try|results|method]`, linked from the bench page and the home list;
`GET /api/benches/:id/explore` → `getBenchExplore` in `api.ts`) is written for non-technical readers: three tabs (`role=tablist`,
arrow keys, the tab in the URL hash so links and Back work; `useRoute` parses the query). **Try it** picks a setup (bench config)
and one accuracy slider (80–99%, default = the bench target): the thresholds are refitted live in the browser with `fitThreshold`
from `src/calibrate.ts` (imported by the app; `ui/tsconfig.json` includes it) over points built from the `ExploreRow`s exactly as
`scoreRun` builds them (`stagePoints` / `refitThresholds` in `ui/src/explore.ts`), then replayed; a 100-square waffle and one
sentence show the outcome, the per-stage sliders live under "Fine-tune each step (advanced)". **At the bench target the refit
must reproduce the bench's calibrated thresholds** (`test/ui-explore.test.ts` checks it against `scoreRun` on a seeded 80-row
fixture; on the real bench-2026-11-06-f417 it reproduces calibration.json exactly). **Results** is the test-split table and cost
bars from `bench-report.json`; **How it was tested** holds the accuracy-at-coverage and reliability charts, each technical term
explained once. User-facing text uses plain names (`friendlyModel`, `friendlyConfig`, step names), raw model IDs only in titles
and the advanced section. The replay is `ui/src/explore.ts` (pure, runs in the browser) over compact `ExploreRow`s of the bench's
*calibration run* (a `collect` run on held-out train rows; found through `calibrationRunId`, or the `runId` inside `calibrationPath`
for a reused calibration; without the folder, `calibration: null` and a reason), and **must stay equivalent to `computeOutcomes`**:
`test/ui-explore.test.ts` replays a fixture ledger both ways. Pricing-note rule: if the calibration run's `batch_result`s carry no
`usage`, its writer costs were recorded without prompt caching, so `pricingNote` is set and the page marks every cost figure with
an asterisk pointing at one footnote.

**The run lock.** `executeRun` writes `runs/<id>/run.lock` (`{ pid, startedAt, heartbeatAt }`), refreshes the heartbeat
every 15 s, and removes it on normal exit, on errors and on SIGINT. A run counts as *running* only if the heartbeat is
under 60 s old and the pid is alive. The lock is advisory: nothing refuses to start because of it, so a crash (which
leaves a stale file) never blocks `resume`. Keep it that way.

## Layout

```
src/
  cli.ts            argument parsing only
  check.ts          CSV preflight: decode, detect delimiter, normalize, validate against the task (no models)
  runner.ts         start / execute / calibrate a run (shared by cli and bench)
  pipeline.ts       the rounds; normal | collect | baseline modes; computeOutcomes (pure)
  ledger.ts         append-only JSONL event log + replay() → RunState
  overrides.ts      the reviewer's decisions (overrides.jsonl): read, append, validate, foldOverrides (pure)
  report.ts         summary, review summary and accuracy, enriched.csv / review.csv
  batch/            BatchProvider interface + OpenRouter Batch API client
  decide/           DecisionModel interface + OpenRouter Decisions API client
  cost/             usage.ts: raw usage → uncached / cache read / cache write / output; price.ts: price those buckets
  task.ts           task definition (prompt, schema, verify question, models, thresholds)
  calibrate.ts      threshold fitting, isotonic calibration, ECE/Brier/AUC (pure)
  score.ts          ledger → (score, p, correct) points per model and stage
  bench.ts          benchmark orchestration + report
  stats.ts          spend by stage, medians (shared by the bench report and the UI)
  lock.ts           run.lock heartbeat (advisory; tells the UI a run is alive)
  ui/               `twopass ui`: api.ts (pure), server.ts (node:http), api-types.ts, models.ts
  datasets/         Banking77 download
tasks/              task files (banking77.task.ts)
ui/                 the browser app (Vite + React, own tsconfig), built to dist/ui
  ui/src/explore.ts        threshold replay + live refit, waffle counts and plain names for the results explorer (pure)
  ui/src/pages/Explore.tsx results explorer page: three tabs, inline SVG charts, no chart library
scripts/            dataset fetch, contamination check, fake-live-run.ts (UI demo, no cost)
test/               vitest, HTTP mocked through test/helpers.ts
docs-public/        images for the README (docs/ is local-only and gitignored)
runs/  data/        local only, gitignored
```

## Invariants: keep these true

- **Resumability.** Every stage reads the ledger first and only does work that isn't recorded yet. `run` and `resume`
  are the same code path. Append to the ledger *before* doing anything that depends on it, and keep appends synchronous.
  A test kills the pipeline mid-batch and mid-verify. Keep it passing.
- **`computeOutcomes` is pure.** Outcomes are derived from the ledger and thresholds, never stored. That lets a `collect`
  run be replayed under any thresholds (calibration, the results explorer).
- **Human decisions live in `runs/<id>/overrides.jsonl`, never in the ledger.** One JSON line per decision
  (`{rowId, action: accept|override|clear, answer, previous, note?, at, pipelineStatus}`), appended synchronously, last line
  per row wins, undo appends `clear`; a torn last line is skipped on read and repaired before the next append (the
  ledger's helpers). `foldOverrides(outcomes, overrides)` applies them on top of `computeOutcomes` and gives decided rows
  the status `reviewed`, so a human answer is never counted as one the pipeline accepted. **`resume` ignores the file
  completely**: the pipeline never reads it (tests check calls, ledger and outcomes are identical with and without it).
  Only the output files a run writes when it ends fold it in. Overrides are validated against the task: a closed-choice
  answer must be in the output schema's enum (`enumOptions`, as `check` reads it), an open one non-empty and at most
  2,000 characters.
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
| OpenRouter `prompt_tokens` **includes** cache reads (`cached_tokens`) and writes (`cache_write_tokens`); `prompt × input price` is then wrong (48% low on a cache write, 6.4× high on a hit) | `src/cost/` |
| Batch result rows carry tokens but **no cost**; only the batch has `usage.cost` (`GET /generation?id=` gives per-row cost) | per-row cost is computed, `report` checks it against the billed total |
| Anthropic caches only prefixes of 512+ tokens and silently skips shorter ones; the usage doesn't say which TTL was written | task `writer.cacheSystem` |

## Adding a task

Copy `tasks/banking77.task.ts`. Define `state`, the `writer` prompt with `{{column}}` placeholders, `outputSchema`
(zod), the `verify` instructions, and the models. List columns that only `state` or `verify.state` read in
`inputColumns`, so `check` can require them. Add `triage` only for closed-choice tasks. Writer and escalation
model IDs must end in `:batch`.

## Prompt caching

- A task opts in with `writer.cacheSystem: '5m' | '1h'`: `writerBody` sends `writer.system` as a text part with
  `cache_control` (ttl `1h` when asked). Every writer round uses it: round 1 (Haiku), round 2 (Sonnet escalation) and
  the baseline (Opus). Banking77 uses `'1h'`, because a batch can outlast the 5-minute cache.
- **Anthropic caches only prefixes of 512 tokens or more and silently skips shorter ones**: no error, the usage just
  shows no cache read or write. A short system prompt marked cacheable costs exactly what an unmarked one does. Check
  `cached_tokens` in a probe before you count on it.
- The usage doesn't say which TTL was written. Pricing uses the TTL the task asked for.
- The cache is per model and prefix, not per batch or run: within the TTL, every batch and run with the same system
  prompt reads what one of them wrote. In a bench, only the first batch per model pays the write; configs that run
  later, or a re-run within the hour, read from the start (bench-2026-11-07-ef50: Haiku and Sonnet batches with zero
  writes). Compare costs across configs with that in mind.

## Cost numbers: computed vs billed

- **Billed** is the source of truth. OpenRouter puts only a batch total on the batch (`usage.cost`), recorded on
  `batch_finished`. `spentUsd`, the budget, the summary's `$`, `spendByStage` for finished batches and the bench report
  all use it.
- **Computed** is per row: each `batch_result` keeps the provider's raw `usage` and a `costUsd` priced from it with
  `src/cost/` and the prices pinned in the manifest. `bucketsFromOpenRouter` splits `prompt_tokens` (which
  *includes* cache reads and writes) into uncached input, cache read and cache write, and `priceUsage` prices each
  bucket, with long-context tiers by total prompt length. Per-row costs go into `enriched.csv`, the UI's row view and
  `spendByStage` while a batch is unfinished. Decision calls (`decision` events) carry their own billed cost.
- `report` prints `cost check: per-row cost $X vs billed $Y over N batch(es) (±%)`. It should read +0.0%. A gap means
  the pricing code or the pinned prices are wrong, not the bill.
- Old manifests (before 2026-11-07) have no cache prices. A missing cache price falls back to the input price, which
  is the old math. Old ledgers have no `usage` and keep their stored `costUsd`.
- **Worst-case estimates use uncached prices**: the budget's pre-submit check (`estimateCost`) and the UI's reserve
  (`batchReserve`), because OpenRouter reserves before it knows about cache hits.

## Before committing

`pnpm test && pnpm typecheck && pnpm build` (`typecheck` covers both `src` and the `ui/` app). Don't commit `runs/`, `data/`, `dist/`, `.env`, or anything containing an API key.
