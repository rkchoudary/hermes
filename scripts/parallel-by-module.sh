#!/usr/bin/env bash
# parallel-by-module.sh — N-driver parallel orchestrator
#
# Splits TARGET_MODULES into N chunks; spawns N child drivers (each running
# scripts/serial-by-module.sh on its chunk) in parallel; waits for all to
# complete. Each chunk gets isolated log file. .agent-runs/ dir is shared
# (CAS locks per task pack guarantee no concurrent task-creation conflicts).
#
# Usage:
#   bash scripts/parallel-by-module.sh 4                  # 4-way split of all 87
#   bash scripts/parallel-by-module.sh 2 M01 M02 ... M44  # 2-way split of subset
#   bash scripts/parallel-by-module.sh 8 --frd-go-only    # 8-way of FRD-GO modules

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUNS_DIR="$HARNESS_ROOT/.agent-runs"
LOG_DIR="/tmp/harness-runs"
mkdir -p "$LOG_DIR"

if [ $# -lt 1 ]; then
  echo "Usage: $0 <num_workers> [module_id...]"
  echo "       $0 4              # 4-way split of all modules from your project's master list"
  echo "       $0 2 M01 M02 M03  # 2-way split of subset"
  exit 1
fi

N="$1"; shift
if ! [[ "$N" =~ ^[0-9]+$ ]] || [ "$N" -lt 1 ] || [ "$N" -gt 16 ]; then
  echo "ERROR: N must be 1-16 (got: $N)"; exit 1
fi

# Build module list
MODULES=()
if [ $# -gt 0 ]; then
  for arg in "$@"; do
    [[ "$arg" =~ ^M[0-9]+$ ]] && MODULES+=("$arg") || { echo "ERROR: invalid module id: $arg"; exit 1; }
  done
else
  while IFS= read -r m; do
    [ -n "$m" ] && MODULES+=("$m")
  done < <(grep -E "^## M[0-9]+" "$HARNESS_ROOT/${HERMES_MODULE_LIST_FILE:-MODULES.md}" 2>/dev/null | grep -oE "M[0-9]+" | sort -V | uniq || \
           grep -E "^## M[0-9]+" "${HERMES_PROJECT_ROOT:-$PWD}/${HERMES_MODULE_LIST_FILE:-MODULES.md}" | grep -oE "M[0-9]+" | sort -V | uniq)
fi

TOTAL=${#MODULES[@]}
if [ "$TOTAL" -eq 0 ]; then
  echo "ERROR: no modules to run"; exit 1
fi

echo "═══════════════════════════════════════════════════════════════"
echo "PARALLEL-BY-MODULE — $N workers, $TOTAL modules"
echo "  workers: $N | modules: $TOTAL | per-worker: ~$((TOTAL / N + (TOTAL % N > 0 ? 1 : 0)))"
echo "  log dir: $LOG_DIR"
echo "═══════════════════════════════════════════════════════════════"
date -u +"start=%FT%TZ"

# Round-robin distribute modules across workers (better than chunk-of-N because
# tier-1 modules tend to cluster — round-robin balances load).
declare -a CHUNKS
for i in $(seq 0 $((N - 1))); do CHUNKS[$i]=""; done
for i in "${!MODULES[@]}"; do
  worker=$((i % N))
  CHUNKS[$worker]="${CHUNKS[$worker]} ${MODULES[$i]}"
done

# Print plan
for i in $(seq 0 $((N - 1))); do
  count=$(echo ${CHUNKS[$i]} | wc -w | xargs)
  echo "  worker $i: $count modules → ${CHUNKS[$i]}"
done

# Spawn workers
PIDS=()
for i in $(seq 0 $((N - 1))); do
  if [ -n "${CHUNKS[$i]}" ]; then
    LOGFILE="$LOG_DIR/parallel-worker-$i-$(date -u +%Y%m%dT%H%M%SZ).log"
    cd "$SCRIPT_DIR/.."  # tools/autonomous-delivery
    # Each worker inherits Sprint K env (MODULE_TIMEOUT_SEC, SERIAL_DEFER_CODE_SPRINT, etc)
    # Pass --parallel-worker-id so worker can prefix its task IDs / log lines
    AUTO_PARALLEL_WORKER_ID=$i nohup bash scripts/serial-by-module.sh ${CHUNKS[$i]} > "$LOGFILE" 2>&1 &
    pid=$!
    PIDS+=($pid)
    echo "  worker $i started: pid=$pid log=$LOGFILE"
  fi
done

echo "═══════════════════════════════════════════════════════════════"
echo "All $N workers spawned. Monitoring..."
echo "  log files: ls -lat /tmp/harness-runs/parallel-worker-*.log"
echo "  Live status: tail -f $LOG_DIR/parallel-worker-*-*.log"
echo "═══════════════════════════════════════════════════════════════"

# Wait for all workers (or until any dies abnormally)
EXIT_CODES=()
for pid in "${PIDS[@]}"; do
  if wait "$pid"; then
    EXIT_CODES+=(0)
  else
    EXIT_CODES+=($?)
  fi
done

echo "═══════════════════════════════════════════════════════════════"
echo "PARALLEL-BY-MODULE COMPLETE"
for i in "${!PIDS[@]}"; do
  echo "  worker $i: exit=${EXIT_CODES[$i]}"
done
date -u +"end=%FT%TZ"
echo "═══════════════════════════════════════════════════════════════"
