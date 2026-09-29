#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=${1:?root}
RUN=${2:?run id}
[[ $RUN =~ ^[a-z0-9]([a-z0-9-]{0,27}[a-z0-9])?$ && $ROOT == "/opt/apollo-validation/$RUN" ]] || exit 64
SRC="$ROOT/source"
STATE="$ROOT/state"
EVID="$ROOT/evidence"
LOG="$ROOT/logs"
for dir in "$SRC" "$STATE" "$EVID" "$LOG"; do
  [[ -d $dir && ! -L $dir ]] || exit 65
done
[[ -w $STATE && -w $EVID && -w $LOG ]] || exit 65
# Probe actual writes rather than trusting root's -w result or a stale mount.
for dir in "$STATE" "$EVID" "$LOG"; do
  probe="$dir/.apollo-write-probe-$$"
  ( umask 077; : > "$probe" ) || exit 65
  rm -f -- "$probe" || exit 65
done
cd "$SRC"
export CI=1 APOLLO_RESOURCE_PROFILE=isolated-ci
# The W24 opt-in is deliberately absent for the focused unit/contract regressions.
unset APOLLO_SYNTHETIC_WAVE24_JOURNEY_E2E || :
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
node --version > "$EVID/node-version.txt"
npm --version > "$EVID/npm-version.txt"
git rev-parse HEAD > "$EVID/head.txt"
ffmpeg -version | sed -n '1p' > "$EVID/ffmpeg-version.txt"
phase whitespace 90 npm run lint:whitespace
phase npm-ci 1200 npm ci
phase remotion-ci 900 npm ci --prefix remotion
phase prisma-generate 180 npm run db:v2:generate
phase security-audit 300 npm run security:audit
phase security-audit-remotion 300 npm run security:audit:remotion
phase architecture 90 npm run lint
phase eslint 300 npm run lint:code
phase domain 90 npm run domain-language:validate
phase infra-contracts 90 npm run infra:validate
phase platform 90 npm run platform:validate
phase public-api 90 npm run api:v1:validate
phase parity 90 npm run api:parity:validate
phase migration-validation 120 npm run db:v2:validate
phase typecheck 450 npm run typecheck
# Focused W28 regressions; this does not represent the repository's full suite.
phase focused-w28-regressions 450 node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test \
  tests/v2/capability-registry.test.mjs \
  tests/v2/project-editor-ui.test.mjs \
  tests/v2/synthetic-phase-gate-addresses.test.mjs \
  tests/v2/transformation-critic-report-view.test.mjs \
  tests/v2/editor-reads.test.mjs \
  tests/v2/ip-address-security.test.mjs
phase migration 180 npm run db:v2:migrate:deploy
phase remotion-bundle 750 npm run remotion:build
phase browser-presence 15 test -x /usr/local/bin/playwright-chromium
phase next-build 1500 npm run build
phase remotion-browser 300 bash -c 'cd remotion && node -e "require('\''@remotion/renderer'\'').ensureBrowser({logLevel:'\''error'\''}).catch((error)=>{console.error(error);process.exit(1)})"'
export APOLLO_SYNTHETIC_WAVE24_JOURNEY_E2E=1
export APOLLO_WAVE24_RUN_ID="$RUN"
export APOLLO_WAVE24_EVIDENCE_ROOT="$EVID/journey"
export APOLLO_API_ENVIRONMENT=production
export APOLLO_V2_ARTIFACT_STORAGE_DRIVER=local
phase synthetic-wave24-journey 1600 npm run test:e2e:synthetic-wave24-journey
printf '%s\n' "$RUN" > "$EVID/batch.complete"
printf 'BATCH_COMPLETE\n'
