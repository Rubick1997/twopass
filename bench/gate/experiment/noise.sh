#!/usr/bin/env bash
# N runs of the unchanged gate config on the CI slice, then the noise file.
# Usage: bench/gate/experiment/noise.sh [runs=8] [max-usd per run=1.00]
# Paid: ≈ $0.70 per run at list price (Clef on OpenRouter + Claude direct). Each run is capped.
set -euo pipefail
N="${1:-8}"
CAP="${2:-1.00}"
TASK=gates/banking77.task.yaml
OUT=runs/gate-noise
mkdir -p "$OUT"
files=()
for i in $(seq 1 "$N"); do
  f="$OUT/noise-$i.json"
  if [ -f "$f" ]; then echo "run $i: $f exists, reusing"; else
    echo "=== noise run $i of $N (cap \$$CAP) ==="
    node src/cli.ts gate run --task "$TASK" --ref "main-noise-$i" --out "$f" --max-usd "$CAP" | grep -Ev '^  [✓⚠→]|^checking '
  fi
  files+=("$f")
done
node src/cli.ts gate noise --task "$TASK" "${files[@]}"
