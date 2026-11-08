# TwoPass

**Run repetitive LLM work at batch prices, with a cheap decision model checking every row.** Rows it trusts are
accepted. Rows it doubts are re-run on a stronger model, and whatever is still uncertain goes to a human.

On the full Banking77 test split, with Cloudflare's Clef as the controller:

> **3,080 rows · 3,002 auto-accepted at 96% precision · 80 re-run · 78 need a look · $1.47 · 17 min**

That's 94.2% end-to-end accuracy for $0.48 per 1,000 rows. A frontier model (Claude Opus 5.5) answering every row
got 88.3% for $4.13 per 1,000 rows. See [Results](#results), and the [caveats](#limitations) before quoting this.

## How it works

```
CSV ──► Round 0: triage       decision model picks the answer itself (closed-choice tasks only)
          │ confident ──────────────────────────────────────────────► ACCEPTED
          ▼
        Round 1: batch write  cheap writer model, OpenRouter Batch API
        Verify                decision model: supported / unsupported / cannot_tell
          │ supported & confident ──────────────────────────────────► ACCEPTED
          ▼
        Round 2: batch re-run stronger model, rejected rows only
        Verify ─────────────────────────────────────────────────────► ACCEPTED or FLAGGED → human
```

- **Decision models** (Jev, Clef, Luna Decisions on OpenRouter) don't generate text. They return a typed answer with
  probabilities, for fractions of a cent per call.
- **Thresholds are fitted, not guessed.** `twopass calibrate` fits each stage's threshold on held-out labeled data to
  reach a target precision. It also reports calibration error before and after isotonic calibration.
- **Every question offers `cannot_tell`.** Decision models rarely abstain unless they're given the option.
- **Nothing is lost or paid twice.** Every result is written to an append-only ledger as it arrives. Kill the
  process at any point, then run `twopass resume`.

This is a workflow with a learned controller, not an autonomous agent. The steps are fixed, and the decision model
only chooses which way each row goes.

## Quick start

Requirements: Node ≥ 22.18, pnpm, and an [OpenRouter](https://openrouter.ai) API key with credit.

```bash
git clone https://github.com/Rubick1997/twopass.git && cd twopass
pnpm install
export OPENROUTER_API_KEY=sk-or-...

# a small end-to-end benchmark: about $0.60 and 30–50 minutes, mostly waiting for batches
# (the first run also downloads Banking77, ~5 min)
node src/cli.ts bench banking77 --calibration-size 60 --test-size 40 --max-usd 1
```

To run your own CSV:

```bash
node src/cli.ts run my.csv --task tasks/my.task.ts --max-usd 2
node src/cli.ts resume <runId>       # after a crash, a cost-cap stop, or Ctrl-C
node src/cli.ts report <runId>
```

### Preparing your CSV

Check a CSV before spending anything. It calls no model (only OpenRouter's public model list, for context lengths):

```bash
node src/cli.ts check my.csv --task tasks/my.task.ts --label expected   # --label is optional
```

`run` and `bench` do the same check automatically and refuse to start on errors, before any network call.

**What the CSV needs:** a header row with unique, non-empty column names; every column the task reads (its
`{{placeholders}}`, `inputColumns` and `idColumn`); unique, non-empty ids; the same number of cells in every row; and
at least one data row.

**What `check` fixes, logging every change** (the input file is never modified; a normalized copy is written):
Windows-1252 → UTF-8, a byte-order mark, `,` `;` tab or `|` delimiters (auto-detected), CRLF line endings, Unicode
NFC, zero-width and control characters, surrounding whitespace, empty rows, and labels that differ only in case,
spaces or hyphens (`Card Arrival` → `card_arrival`) when exactly one allowed label matches.

**What it refuses:** undecodable or empty files, ragged rows, missing columns (with "did you mean" suggestions),
empty or duplicate ids, labels outside the task's output schema, and rows likely too long for a model's context.

**What it warns about** (the run proceeds): empty values, duplicate inputs, possible personal data (emails, phone
numbers, Luhn-valid card numbers, mod-97-valid IBANs; reported by row number only, never printed), too few labeled
rows for calibration, and cells a spreadsheet could run as formulas. TwoPass escapes those in its own output CSVs.

Each run writes `runs/<runId>/`:

| File | What it holds |
|---|---|
| `enriched.csv` | Your columns plus `answer, confidence, verdict, model, round, cost_usd, status`, and from review: `reviewed_by_human` (`accepted` / `overridden`), `final_answer` (yours where you decided, else the pipeline's) and `review_note`. `answer` stays the pipeline's |
| `review.csv` | Only the flagged rows nobody has reviewed yet |
| `overrides.jsonl` | Your review decisions, one line each (see below). Never part of the ledger |
| `manifest.json` | Pinned model IDs, thresholds, prices, the task file's and input's hashes |
| `normalized.csv`, `check-report.json` | The input as the run used it, and every change and warning from `check` |
| `ledger.jsonl` | Every call and result, in order |
| `run.lock` | Only while a process works on the run: its pid and a heartbeat (see below) |

### Watching a run

Batch rounds take minutes to hours. `twopass ui` opens a local page that shows every run and bench in your `runs/`
folder, updating every 3 seconds:

```bash
pnpm build                          # once: builds the CLI and the UI
node src/cli.ts ui                  # http://127.0.0.1:4777 [--runs <dir>] [--port <n>] [--no-open]
```

![The run monitor during round 2 of a fake run](docs-public/ui-run-monitor.png)

For each run: whether it's running, finished or stopped (with the exact `resume` command to copy), progress per stage,
every batch with its age, spend against the cap by stage, accepted / flagged / pending rows, a rough expected finish,
and, with `OPENROUTER_API_KEY` set, your OpenRouter balance next to our estimate of the worst case OpenRouter holds for
batches in flight. A bench shows its configurations side by side, plus its report.

It calls no model, binds to 127.0.0.1, and never sends your key to the browser. Apart from review decisions (below), it
only reads files. To try it without
a key or any spend, `node scripts/fake-live-run.ts` writes a fake run that progresses over about four minutes.

A run counts as running while its `run.lock` heartbeat is fresh (under 60 s) and its process is alive. A crashed run
leaves a stale lock behind; that's harmless, and `resume` ignores it.

### Reviewing flagged rows

Rows the pipeline can't vouch for are flagged for a person. Open a run in `twopass ui` and choose **Review N flagged
rows** (also linked from the run list), or go to `#/runs/<runId>/review`:

![The review queue on a fake run: the row list, the current row's message, the pipeline's answer and the round-0 top 3](docs-public/ui-review-queue.png)

For each row you see the input, the pipeline's answer, every round's answer with the verifier's verdict and
probabilities, and the decision model's round-0 top 3. The expected label, when the run has one, stays hidden until you
press `l`, so it doesn't bias you. It's built for the keyboard:

| Key | |
|---|---|
| `j` / `k` | next / previous row |
| `a` | accept the pipeline's answer |
| `o` | override: type to filter the labels, arrows and Enter to pick |
| `1`–`3` | pick one of the round-0 top 3 |
| `u` | undo the decision on this row |
| `n` | add a note |
| `f` | switch between flagged, reviewed and all rows |
| `?` | all shortcuts |

After each decision the next unreviewed row opens. With a label column, the page shows **accuracy, no human → with a
human** as you go. You can also change a row the pipeline accepted (switch to "all rows"); the record says so.

Each decision is one line appended to `runs/<runId>/overrides.jsonl`:

```json
{"rowId":"test-00276","action":"override","answer":"fiat_currency_support","previous":"exchange_via_app","at":"2026-11-08T20:56:39.120Z","pipelineStatus":"flagged"}
```

The last line for a row wins, and undo appends `{"action":"clear"}`, so nothing is ever edited in place. Answers are
checked against the task (one of its labels, or non-empty text for open-ended tasks). The file is never mixed into the
ledger, and `resume` ignores it, so the pipeline's own numbers don't change. Reviewed rows get the status `reviewed`,
never `accepted`.

```bash
node src/cli.ts report <runId>            # adds: 10 of 78 flagged rows reviewed … accuracy, no human 94.2% → with a human 94.2%
node src/cli.ts report <runId> --write    # rewrites enriched.csv and review.csv with your decisions (no model call)
```

The page's **Write output files** button does the same as `--write`. To try it without a key: `node scripts/fake-live-run.ts
--instant` writes a finished fake run with flagged rows.

The UI server writes only these files: `overrides.jsonl`, `enriched.csv` and `review.csv`. Its two write endpoints accept
only JSON requests from its own page (exact `Origin` and `Content-Type: application/json`, up to 16 KB), so another website
open in your browser can't write to them.

Coding agents: see [AGENTS.md](AGENTS.md).

## Results

Banking77 has 77 intent labels for customer messages to a bank. Thresholds were fitted on 1,000 held-out train rows
for ≥95% precision. Every number below is on the full test split (3,080 rows), except the Opus baseline, which ran on a
1,000-row sample. Run on 2026-11-06.

| Controller | Auto-accepted | Precision of auto-accepted | Sent to a human | Accuracy, no human | Cost / 1k rows |
|---|---|---|---|---|---|
| **Clef** (`cloudflare/clef`) | **97.5%** | **95.6%** | **2.5%** | **94.2%** | **$0.48** |
| Jev triage + Clef verify | 74.0% | 94.4% | 26.0% | 85.1% | $0.88 |
| Jev (`typesafe/jev-1.14`) | 57.4% | 95.4% | 42.6% | 84.4% | $1.14 |
| Luna (`openai/gpt-6-luna-decisions`) | 5.0% | 99.4% | 95.0% | 84.4% | $2.33 |
| Baseline: Opus 5.5 on every row | 100% | 88.3% | 0% | 88.3% | $4.13 |

Writer: Claude Haiku 5.5 (batch). Escalation: Claude Sonnet 5.5 (batch). All through OpenRouter.

What the numbers say:

- **Thresholds fitted on train held up on test.** Precision came in at 95.4–95.6% against a 95% target (94.4% for the mix).
- **The decision models are good at different jobs.** Clef is strong at picking the label itself (0.942 top-1). Jev
  is cheaper and less accurate at it (0.781). Jev's reported 0.870 on Banking77 did not replicate with this prompt
  format. Luna never reached 95% precision in round 0, so it sends almost everything to a human.
- **Judging an answer in isolation is weak.** A verifier that saw only the message and one label let close-but-wrong
  labels through at 0.95+ confidence. Showing it all 77 labels fixed that.
- **Escalation is where the money goes.** Sonnet re-runs are most of the cost in every configuration except Clef's,
  because Clef settles almost everything in round 0.

## Cost

Decision-model calls are cheap: about $0.07 (Jev), $0.10 (Luna) or $0.41 (Clef) per 1,000 rows for round 0. Haiku
batch writing costs about $0.05 per 1,000 rows. Sonnet escalation is about $2.13 per 1,000 rows re-run. A full
`bench banking77` (calibration plus four configurations and the baseline) cost about $22.

Always pass `--max-usd`. OpenRouter reserves each batch's worst case (every row at `max_tokens`) from your balance
when the batch is submitted. On a small balance, add `--max-batch-rows 500` to send batches one at a time.

## Limitations

- **Benchmark contamination: no sign of memorized test wording, but not ruled out entirely.** Banking77 is public
  and old, and Clef's 0.942 top-1 accuracy is close to fine-tuned state of the art. So we paraphrased 300 test
  messages (Claude Haiku, about 22% word overlap with the originals) and asked each decision model again
  ([`scripts/contamination-check.ts`](scripts/contamination-check.ts)):

  | Round-0 top-1 | Original wording | Paraphrased | Drop (95% CI) |
  |---|---|---|---|
  | Jev | 76.0% | 74.0% | 2.0 pts (−0.7 to 5.0) |
  | Clef | 93.3% | 89.7% | 3.7 pts (0.3 to 7.0) |
  | Luna | 76.0% | 71.7% | 4.3 pts (0.7 to 8.0) |

  Clef doesn't lose more than the others: the drop differences are all within ±2.3 points, and every 95% interval
  includes zero. Memorized test wording would show as a much larger drop for Clef. What this can't rule out is that Clef was trained on
  Banking77's *training* split or similar banking-intent data, which would help it here without transferring to
  your own label set. That's another reason to calibrate on your own data. With 300 rows, the test can detect a
  memorization effect of about 5 points or more. Sonnet also named the dataset in its reasoning, so the
  frontier baseline may know it too.
- **OpenRouter batch has no zero data retention and runs on US infrastructure only.** Use public or non-sensitive data.
- **Each batch round can take up to 24 hours.** In practice: 4–8 minutes per round.
- **The Decisions API is alpha** (`/api/alpha/decisions`). Model IDs and behaviour may change. Every run pins what it used.
- **One dataset.** Thresholds are per task: fit them on your own labeled data. Vendor defaults are never used.
- **Small samples in places.** The baseline ran on 1,000 rows, and Clef's verify stages saw fewer than 100 rows on test.

Non-goals: a hosted service, auth or billing; storing other people's keys; provider adapters (OpenRouter covers
them); Google Sheets; more than two batch rounds; automatic model selection; agent loops on batch.

## Development

```bash
pnpm test        # unit tests, HTTP mocked, no key needed
pnpm typecheck
pnpm build       # dist/ (npm bin) and dist/ui (the local UI)
pnpm dev:ui      # UI dev server with hot reload; run `node src/cli.ts ui --no-open` alongside for the API
```

## Credits

Banking77: Casanueva et al., *Efficient Intent Detection with Dual Sentence Encoders* (2020), PolyAI, licensed
[CC-BY-4.0](https://huggingface.co/datasets/PolyAI/banking77).

## License

[MIT](LICENSE) © 2026 Rustam Kolumbayev
