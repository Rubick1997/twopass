# Eval gate: keep the promise through every change

TwoPass auto-accepts the rows its checker is confident about and sends the rest to a person. The calibration behind
that makes a promise: **auto-accepted rows are at least 95% right** (or whatever target you set). The eval gate checks
that promise on every pull request that could move it. That includes a prompt edit, a model swap, a checker version
bump or a threshold change. When a change breaks it, the PR comment proposes thresholds that restore it and shows what
they cost in automation. It also lists the rows a reviewer should read.

Accuracy can stay flat while the promise breaks: a change can auto-accept different rows, some of them wrong, and send
right ones to a person. An accuracy gate passes that change. This one doesn't.

## Quick start

How much data: about 35+ labelled rows per label (15 for calibration, 20 for the CI slice) and at least ~200
calibration rows in total for stable thresholds. With fewer, `init` notes the short labels and the thresholds overfit.

You need a labelled CSV (one text column and one label column; an id column is optional), an
[OpenRouter](https://openrouter.ai) key for the checker, and optionally an Anthropic key for Claude models.

```bash
# 0. TwoPass is not on npm yet. Until it is, run it from a clone:
git clone https://github.com/Rubick1997/twopass && cd twopass && pnpm install && pnpm build && npm link
cd /path/to/your/repo

# 1. Write the task config, calibration rows, CI slice and workflow (no API calls)
twopass gate init --data data/labelled.csv --text message --label intent

# 2. Fit thresholds on the calibration rows (paid: a collect run with the writer and the checker)
export OPENROUTER_API_KEY=sk-or-...   # required
export ANTHROPIC_API_KEY=sk-ant-...   # optional: Claude models then go to Anthropic directly
twopass gate calibrate --task gates/labelled.task.yaml --collect --max-usd 5

# 3. Measure noise: run the unchanged config a few times (8 is good), then build the noise file
for i in 1 2 3 4 5 6 7 8; do twopass gate run --task gates/labelled.task.yaml --ref main-$i --out noise-$i.json --max-usd 1; done
twopass gate noise --task gates/labelled.task.yaml noise-*.json

# 4. Commit gates/ and .github/workflows/eval-gate.yml, add the secrets in GitHub, open a PR
```

`init` writes:

| File | What it is |
|---|---|
| `gates/<name>.task.yaml` | The task config: data, columns, labels, promise, models, file paths |
| `gates/<name>.calibration-rows.json` | Rows used only to fit thresholds (15 per label by default) |
| `gates/<name>.slice.json` | The CI slice: 20 rows per label, seeded, never a calibration row |
| `.github/workflows/eval-gate.yml` | The workflow; three marked lines are yours to change |

`calibrate` adds `gates/<name>.calibration-points.json` (each checker's scores on the calibration rows, so CI can
recalibrate without calling a model) and `gates/<name>.thresholds.json`. `gate run` refuses to start without
thresholds; there are no default ones.

## The promise, in plain words

The gate compares **base** (the PR's target branch) with **head** (the PR) on the same CI slice, in the same job.
The promise check fails when either is true:

1. Head's auto-accepted rows are less than 95% right (the point estimate), after allowing for how much that number
   moves between runs of unchanged code.
2. Head is clearly worse than base: the top of head's 95% confidence interval is below base's precision.

The comment also shows the interval. It doesn't require the *lower* bound to clear 95%: when true precision sits at
the target, the lower bound on a ~1,500-row slice lands near 94%, and unchanged code would fail every PR.

## The three gates

The checks in the first group block a merge. The other numbers are reported, but never block.

| Gate | What it checks | Role |
|---|---|---|
| **G3: promise** (enforced) | (1) the promise above, (2) no label loses more rows (net right→wrong) than unchanged code does, at least 2, (3) auto-accepted-but-wrong rows don't rise more than unchanged code moves | Blocks |
| G1: aggregate threshold | Head accuracy ≥ lowest noise run − 0.5 points | Reported ("what the other gates would say") |
| G2: aggregate paired delta | Bootstrap 95% lower bound of head − base accuracy ≥ −1 point | Reported |
| North Stars | Auto-accept share, sent to a person, accuracy, cost per 1,000 rows | Reported, never block |

Change the enforced gate with `gate: { enforce: g1 | g2 | g3 }` in the task config.

**Noise.** Decision models are not deterministic. Clef's confidence moved by up to 0.29 on identical input in a probe,
so every limit is "beyond what unchanged code does". Without a noise file, the limits assume unchanged code never
moves, and the comment says so.

## Reading a red comment

The first line states the promise and whether it held. If it broke, the comment includes a **recalibration
proposal**:

- thresholds fitted on 80% of the calibration rows at your target, with the same fitting code TwoPass's calibration uses;
- checked on the other 20% (held out): precision and its interval, and the auto-accept share before and after. That
  share is the price you pay for keeping the promise;
- the command that applies it: `twopass gate recalibrate --task <file> --run <head.json> --write`. That writes the
  thresholds file, and committing it is a separate change that goes through the gate like any other.

The proposal can't help in three cases, and the comment says which:
- **The writer changed.** The calibration points came from another writer, whose mistakes the checker was calibrated on.
  Run `gate calibrate --collect`.
- **The checker changed.** There are no scores for the new checker yet. Run `gate calibrate --models <checker>`. That
  costs decision calls only, because the writer's answers are reused.
- **No threshold reaches the target** on the calibration rows.

If fewer than 30 held-out rows are accepted, the comment warns that the check is a sanity check rather than evidence.

**Rows to read** lists up to 10 rows that flipped between base and head, or that head newly auto-accepts. Auto-accepted
rows with the lowest checker confidence come first. Gold labels are not shown; you judge.

## Providers and cost

- The checker (a decision model such as Clef or Jev) always runs on OpenRouter.
- Claude writer models go to Anthropic directly when `ANTHROPIC_API_KEY` is set, and to OpenRouter otherwise.
  Override it with `provider: { claude: anthropic | openrouter }`.
- Base and head must use the same routing. `compare` refuses mixed routing unless you pass `--allow-mixed-routing`.
- CI calls are synchronous (not batches) so a run finishes in minutes. Every cost shown is **list price**, computed
  from token usage with cache reads and writes priced separately. Credits don't change what is reported.
- `--max-usd` caps each run at list price. With Clef on 1,540 rows, a run costs about $0.70 per side and takes about
  2 minutes (measured on Banking77, Nov 2026). Most of that is checker calls: Clef settles about 97% of rows itself.
- Pull requests from forks get no secrets. The workflow skips them with a note and never uses `pull_request_target`.

## Not yet

- Extraction tasks (several fields per row). The gate handles classification only.
- Data that isn't a CSV.
- CI systems other than GitHub Actions. The commands are plain CLI calls, so porting the workflow is straightforward.
- An npm release. Until there is one, the template's `npm install --global twopass@<version>` line has to be replaced
  with an install from a clone.
