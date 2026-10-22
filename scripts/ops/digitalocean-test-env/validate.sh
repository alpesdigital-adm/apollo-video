#!/usr/bin/env bash
# CI-faithful validation of the Apollo disposable TEST ENVIRONMENT (run as the unprivileged user "apollo", after provision.sh).
#
#   validate.sh <case> [label]       cases: unit | deploy-fake-docker | host-safety | runtime-safety | editor
#
# Every case runs the same command and the same variables as the matching step of .github/workflows/ci.yml:
#   - /opt/apollo/env/test-env.sh WITHOUT the APOLLO_V2_PIXEL_ORACLE_* / APOLLO_V2_FACE_V9_* variables (the CI does not set them);
#   - ffmpeg is the pinned ffmpeg-static, ffprobe is the distribution one (FFPROBE_PATH), exactly as the CI;
#   - `unit` goes through the CI wrapper (perception-consumer-cgroup.mjs unit), which defines APOLLO_PERCEPTION_CONSUMER_RUN_ID;
#   - the process is pinned to CPUs 0-3 (the GitHub runner has 4 vCPU); on a 4 vCPU host this is a no-op.
# Logs, `vmstat 2` (st = steal), the ffmpeg binaries actually executed and, for runtime-safety, the proxy-render time of every
# journey go to /opt/apollo/logs/<case>-<label>/. Nothing is loosened: no timeout, threshold or retry is changed here.
set -uo pipefail

case_name="${1:?case}"; label="${2:-$(date -u +%H%M%S)}"
out="/opt/apollo/logs/$case_name-$label"; mkdir -p "$out"
. /opt/apollo/env/test-env.sh
for v in $(compgen -e | grep -E '^APOLLO_V2_(PIXEL_ORACLE|FACE_V9)_'); do unset "$v"; done
cd /opt/apollo/apollo-video

pgdb() { docker exec -e PGPASSWORD=apollo-ci apollo-postgres psql -U apollo -d postgres -v ON_ERROR_STOP=1 -c "$1"; }
mkdb() { # <db> <application_name>
  pgdb "DROP DATABASE IF EXISTS $1" && pgdb "CREATE DATABASE $1" &&
    V2_DATABASE_URL="postgresql://apollo:apollo-ci@127.0.0.1:5432/$1?schema=public&application_name=$2-migrate&connection_limit=5&pool_timeout=10&connect_timeout=10" npm run db:v2:migrate:deploy
}
url() { echo "postgresql://apollo:apollo-ci@127.0.0.1:5432/$1?schema=public&application_name=$2&connection_limit=5&pool_timeout=10&connect_timeout=10"; }

run_case() {
  case "$case_name" in
    unit) node scripts/validation/perception-consumer-cgroup.mjs unit ;;
    deploy-fake-docker) APOLLO_DEPLOY_FAKE_DOCKER_E2E=1 npm run test:e2e:deploy-fake-docker ;;
    host-safety) APOLLO_HOST_SAFETY_LINUX_E2E=1 npm run test:e2e:host-safety-linux ;;
    runtime-safety)
      rm -rf "$RUNNER_TEMP/runtime-safety-local"; mkdir -p "$RUNNER_TEMP/runtime-safety-local"
      mkdb apollo_v2_e2e_runtime_safety apollo-video-e2e-runtime-safety || return 1
      TMPDIR="$RUNNER_TEMP/runtime-safety-local" APOLLO_RUNTIME_SAFETY_E2E=1 APOLLO_API_ENVIRONMENT=production \
        APOLLO_PROTECTED_PAYLOAD_KEY_ID=ci-protected-payload APOLLO_PROTECTED_PAYLOAD_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA \
        APOLLO_V2_ARTIFACT_STORAGE_DRIVER=local \
        APOLLO_RUNTIME_SAFETY_DATABASE_URL="$(url apollo_v2_e2e_runtime_safety apollo-video-e2e-runtime-safety)" \
        npm run test:e2e:runtime-safety-workers ;;
    editor)
      mkdb apollo_v2_e2e_capture apollo-video-e2e-capture || return 1
      V2_DATABASE_URL="$(url apollo_v2_e2e_capture apollo-video-e2e-editor-reliability-ci)" APOLLO_EDITOR_RELIABILITY_E2E=1 \
        APOLLO_EDITOR_RELIABILITY_EVIDENCE_DIR="$RUNNER_TEMP/editor-reliability" APOLLO_EDITOR_RELIABILITY_KEEP_EVIDENCE=1 \
        npm run test:e2e:editor-reliability ;;
    *) echo "unknown case: $case_name" >&2; return 2 ;;
  esac
}

# Samplers: CPU steal (vmstat) and every ffmpeg executable that actually ran.
vmstat 2 > "$out/vmstat.log" 2>&1 & vm_pid=$!
( while :; do ps -eo args= | awk '/ffmpeg/ && !/awk/ {print $1}' >> "$out/ffmpeg-seen.raw"; sleep 0.5; done ) & ps_pid=$!
{ echo "host: $(hostname) nproc=$(nproc) cpu=$(lscpu | sed -n 's/^Model name: *//p')"; echo "start: $(date -u +%FT%TZ)"; } > "$out/meta.txt"

taskset -c 0-3 bash -c "$(declare -f run_case pgdb mkdb url); case_name='$case_name'; run_case" > "$out/test.log" 2>&1
code=$?

kill "$vm_pid" "$ps_pid" 2>/dev/null; wait "$vm_pid" "$ps_pid" 2>/dev/null
sort "$out/ffmpeg-seen.raw" 2>/dev/null | uniq -c > "$out/ffmpeg-seen.txt"
{ echo "end: $(date -u +%FT%TZ)"; echo "exit=$code"
  grep -E '^# (tests|pass|fail|cancelled|skipped|duration_ms)' "$out/test.log"
  echo "steal(st) over the run: $(awk 'NR>2 {n++; s+=$17+0; if ($17+0>m) m=$17+0} END {if (n) printf "mean=%.2f%% max=%d%% samples=%d\n", s/n, m, n}' "$out/vmstat.log")"
  echo "ffmpeg executables seen:"; cat "$out/ffmpeg-seen.txt"
} >> "$out/meta.txt"

if [ "$case_name" = runtime-safety ]; then
  node -e '
    const fs = require("fs"), path = require("path")
    const base = process.env.RUNNER_TEMP + "/runtime-safety-local/apollo-runtime-safety"
    const run = fs.readdirSync(base).sort().at(-1), dir = path.join(base, run, "evidence")
    const rows = []
    for (const file of fs.readdirSync(dir).filter((f) => /^render-worker-.*\.stdout\.log$/.test(f)).sort()) {
      const events = []
      for (const line of fs.readFileSync(path.join(dir, file), "utf8").split("\n")) {
        const m = line.match(/"event":"([a-z.-]+)","occurredAt":"([^"]+)"/); if (m) events.push([m[1], Date.parse(m[2])])
      }
      const claims = events.filter((e) => e[0] === "operation.claimed")
      if (claims.length === 0) { rows.push(`${file.replace(/^render-worker-|-\d+\.stdout\.log$/g, "")}: no claim`); continue }
      const real = events.filter((e) => e[0] !== "operation.heartbeat"), last = events.at(-1), lastReal = real.at(-1)
      rows.push(`${file.replace(/^render-worker-|-\d+\.stdout\.log$/g, "")}: claims=${claims.length} first-claim->last-event=${((last[1] - claims[0][1]) / 1000).toFixed(1)} s (last: ${last[0]}); first-claim->last-non-heartbeat=${((lastReal[1] - claims[0][1]) / 1000).toFixed(1)} s (${lastReal[0]})`)
    }
    console.log(rows.join("\n"))' >> "$out/render-times.txt" 2>&1
  { echo "proxy render time per journey (worker telemetry, first claim to last event, heartbeats included and excluded):"; cat "$out/render-times.txt"; } >> "$out/meta.txt"
fi
cat "$out/meta.txt"
exit "$code"
