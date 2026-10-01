#!/usr/bin/env bash
# Sourceable phase primitive. The production entrypoint and its root/identity checks remain in batch.sh.
phase() {
  local label=$1 limit=$2 rc=0
  shift 2
  printf 'PHASE_START %s\n' "$label"
  timeout --signal=TERM --kill-after=15s "${limit}s" "$@" >"$LOG/$label.log" 2>&1 || rc=$?
  # No env or secrets in phase summaries. TAP and build logs remain outside source.
  printf '{"phase":"%s","exit_code":%d}\n' "$label" "$rc" >> "$EVID/batch-results.jsonl"
  printf 'PHASE_RESULT %s %d\n' "$label" "$rc"
  if (( rc != 0 )); then
    # Do not dump logs indiscriminately: Node/Prisma failure text may contain URL credentials.
    exit "$rc"
  fi
}
