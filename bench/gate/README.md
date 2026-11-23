# Eval gate: Phase 0 findings

Checked 23 Nov 2026 on branch `ci-eval-gate` (from `main` at 7b4ca31). Probe spend: **$0.11** (list price), with a hard
cap of $0.30 built into the script. 50 Banking77 train rows outside the part 1 calibration set were each sent 3 times.

## 1. Sync path

There is none. The writer and escalation models only run through batches (`OpenRouterBatchProvider`,
`AnthropicBatchProvider`). Decision-model calls are already synchronous (`OpenRouterDecisionModel`, concurrency 16).
Part 1 batches took 5–8 minutes each, and a run has two writer rounds, so CI needs a sync `BatchProvider`.

## 2. Determinism

Neither checker is deterministic. Neither is the writer.

| Model | Stage | Rows whose choice changed (of 50, over 3 passes) | Max confidence swing | p50 / p95 latency |
|---|---|---|---|---|
| `cloudflare/clef` | triage | 1 | 0.29 | 518 / 2,743 ms |
| `cloudflare/clef` | verify | 1 | 0.29 | 405 / 2,218 ms |
| `typesafe/jev-1.14` | triage | 3 | 0.14 | 150 / 200 ms |
| `typesafe/jev-1.14` | verify | 0 | 0.14 | 150 / 237 ms |
| `claude-haiku-5-5` (writer, sync, Anthropic direct) | round 1 | 4 different labels (26 more differ only in JSON whitespace) | – | 982 / 1,838 ms |

- Clef's confidence swings by up to 0.29 on identical input. Its fitted t1 is 0.79, so rows near the cut can flip
  between accepted and flagged on a re-run. The noise runs are needed, and per-row flips at unchanged `main` are expected.
- The writer's temperature can't be pinned. Haiku 5.5 and Sonnet 5.5 reject a non-default `temperature` (400), and
  Opus 5.5 rejects the parameter outright. The code already never sends it.

## 3. Cost and runtime of one CI run (list price, sync)

Measured per call: Clef triage $4.04e-4, Clef verify $1.28e-4, Jev triage $7.2e-5, Jev verify $4.2e-5, Haiku writer
$5.0e-5 (system prompt cached). The rate of rows sent to the writer comes from the part 1 test runs.

| Config on the slice | Rows | Per side | Base + head |
|---|---|---|---|
| Clef (part 1 headline: 3% of rows reach the writer) | 1,540 (20/intent) | ≈ $0.70 | **≈ $1.40** |
| Clef | 924 (12/intent) | ≈ $0.42 | ≈ $0.84 |
| Jev (43% reach the writer, then Sonnet round 2) | 1,540 | ≈ $2.30 | – |
| Clef base + Jev head (changes 1 and 3) | 1,540 | – | **≈ $3.00** |

Sonnet 5.5 sync at about $0.003 per round-2 row is the main cost wherever the writer runs. Runtime with a sync path:
about 1,540 Clef calls at concurrency 16 ≈ 1–2 minutes per side, plus the writer. That is far under 15 minutes.

## 4. Calibration rows

The part 1 calibration run is `runs/202611062131-banking77-0a3c-calib` (bench `bench-2026-11-06-f417`): 1,000 train
rows, seed 11. Every train row any Banking77 run has touched is in that set; the dev benches drew subsets of the same
seed-11 sample. Without them, every intent still has 30–171 train rows, so 20 per intent is available. `runs/` is
gitignored, so the IDs need to be committed for the slice exclusion (to be added as `bench/gate/calibration-ids.json`).

## 5. Packaging

`twopass` is **not on npm**. The name is free (404), and `package.json` has version 0.0.1 with the bin at
`dist/src/cli.js`. A git install (`github:Rubick1997/twopass#<tag>`) wouldn't work as-is because `dist/` isn't
committed; it would need a `prepare` build. Publishing is Rustam's call.

## 6. How the classification task is defined

`tasks/banking77.task.ts` (`defineTask`):
- the triage question is a choice over the 77 labels, where each criterion is just the label with spaces
- the writer system prompt is the label list
- the verify instructions and criteria cover supported / unsupported / cannot_tell
- the state functions, models, and provisional thresholds also live here

The labels are in `tasks/banking77.labels.ts`, and they are names only, **with no descriptions**. So candidate changes
4 and 5 ("label descriptions") have nothing to edit today. They become: (4) shorter verify instructions, and
(5) added descriptions for confusable intents in the triage criteria. The task file is TypeScript; a YAML task config
has to produce the same `TaskDefinition`.

## 7. How Claude models are called today

- **Covered:** Message Batches direct to Anthropic (`src/batch/anthropic.ts`), pinned **batch** prices with
  `verifiedAt` 2026-11-14 (`src/prices-anthropic.ts`), and Anthropic usage buckets (`bucketsFromAnthropic`).
- **Routing goes by model-ID shape, not by key.** `claude-haiku-5-5` goes direct and `anthropic/…:batch` goes to
  OpenRouter, whether or not `ANTHROPIC_API_KEY` is set. There is no task-level override.
- **Missing:**
  - a sync path (Anthropic or OpenRouter)
  - prompt caching on direct calls: `toMessagesParams` flattens `system` to a string, so `cache_control` is dropped
  - sync list prices and cache prices for direct models
- **Verified against Anthropic's docs** (the claude-api skill reference, cached 2026-11-03):
  - IDs: `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`.
  - List prices: $0.10/$0.50 (Haiku 5.5, up to 100K prompt tokens), $2/$10 (Sonnet 5.5), $4/$20 (Opus 5.5); batch is
    50%. Cache read is 0.1× on Haiku and 0.05× on Sonnet/Opus 5.5. A cache write costs 1.25× (5 min) or 2× (1 h).
  - The minimum cacheable prefix is 512 tokens.
  - SDK `@anthropic-ai/sdk` 1.8.0.
  - The probe re-attached `cache_control` on the sync path: 142 of 150 calls read 1,941 cached tokens.
- **Routes behind the published numbers:** part 1 sent the writer and escalation models through **OpenRouter**
  (`anthropic/claude-haiku-5.5:batch`, `anthropic/claude-sonnet-5.5:batch`) and the checkers through OpenRouter
  Decisions. Part 2 (VRDU) sent Claude **direct** (`claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`).

## 8. Checker version pairs

| Checker | Pinnable versions | Notes |
|---|---|---|
| Jev | `typesafe/jev-1.13` (served `jev-1.13-20260917`) and `typesafe/jev-1.14` (`jev-1.14-20261014`, the part 1 version) | **A real pair at the same price.** The dated ID `typesafe/jev-1.14-20261014` is accepted and served as-is |
| Clef | `cloudflare/clef` only | No version or date in the served ID, and it is served by DeepInfra. Can't be pinned, and could change under the same ID |
| Luna | `openai/gpt-6-luna-decisions` (`-20261006`) | Single version |

Change 1 therefore uses Jev 1.13 ↔ 1.14. Other decision models on OpenRouter also have version pairs
(Perplexity Decider v1.2 → v1.3, Microsoft Decision 1 → 1.1, Liquid d1.1 → d1.2), but none of them was calibrated in part 1.

## 9. Calibration code

The calibration code can be called as a function. `fitThreshold(points, target, minAccepted = 10)` and
`calibrateStage(points, target)` in `src/calibrate.ts` are pure functions over `{score, p, correct}` points, so they
take any subset of rows; the 80/20 fit/check split just filters the points. The points come from `scoreRun`
(`src/score.ts`) over a `collect` run's ledger, with one point set per model and stage (triage → t0, verify1 → t1,
verify2 → t2).

The part 1 calibration ledger already holds Jev 1.14, Clef and Luna scores for all three stages, so a recalibration for
a checker-only change needs new decision calls on those 1,000 rows (≈ $0.15 for Jev 1.13). A writer change needs a new
`collect` run, because its writer outputs differ.
