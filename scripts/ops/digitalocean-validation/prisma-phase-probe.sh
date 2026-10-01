#!/usr/bin/env bash
# Focused CI experiment only. Never calls the remote guard or a provider.
set -Eeuo pipefail
[[ $# == 2 && $1 =~ ^[a-z0-9-]{1,30}$ && -d $2 ]] || exit 64
run=$1; evidence=$(realpath "$2")
[[ $evidence != "$PWD"* && -n ${RUNNER_TEMP:-} && $evidence == "$(realpath "$RUNNER_TEMP")"/* ]] || exit 65
name="apollo-prisma-probe-$run"
image="apollo-prisma-probe:$run"
raw="$RUNNER_TEMP/$name-raw"
mkdir -m 700 "$raw"
state=blocked
cleanup() {
  local work_exit_code=$? cleanup_verified=false names='' cleanup_error=false
  trap - EXIT INT TERM
  # Whitelist-only diagnostics, bounded input; never upload raw stdout/stderr.
  python3 - "$raw" "$evidence" <<'PY' || cleanup_error=true
import json, re, sys
from pathlib import Path
raw, evidence = map(Path, sys.argv[1:])
patterns = (r'Prisma schema loaded from prisma/v2/schema\.prisma',
            r'Error: P[0-9]{4}', r'npm error code E[A-Z0-9]{2,32}')
records = []
for path in sorted(raw.iterdir()):
    if path.name not in ('build', 'npm-ci', 'remotion-ci', 'prisma-generate'):
        continue
    size = path.stat().st_size
    source = [] if size > 65536 else path.read_text(errors='replace').splitlines()
    safe = [line for line in source if any(re.fullmatch(pattern, line) for pattern in patterns)]
    records.append({'stage': path.name, 'status': 'unavailable_oversized' if size > 65536 else 'filtered_excerpt',
                    'filter_category': 'exact_safe_lines_only', 'source_bytes': size,
                    'source_lines': None if size > 65536 else len(source),
                    'discarded_lines': None if size > 65536 else len(source) - min(32, len(safe)),
                    'lines': safe[:32]})
(evidence / 'diagnostics.json').write_text(json.dumps(records, sort_keys=True) + '\n')
PY
  # An empty, successful ps is explicit absence; daemon errors never imply absence.
  if names=$(docker ps -a --filter "label=apollo.probe=$run" --format '{{.Names}}'); then
    if [[ -z $names ]]; then
      cleanup_verified=true
    elif [[ $names == "$name" ]] &&
         [[ $(docker inspect --format '{{index .Config.Labels "apollo.probe"}}|{{.Name}}' "$name" 2>/dev/null) == "$run|/$name" ]]; then
      docker rm -f "$name" >/dev/null 2>&1 || cleanup_error=true
      if names=$(docker ps -a --filter "label=apollo.probe=$run" --format '{{.Names}}') && [[ -z $names ]]; then
        cleanup_verified=true
      fi
    fi
  fi
  rm -rf -- "$raw" || cleanup_error=true
  if [[ $cleanup_error == true ]]; then cleanup_verified=false; fi
  printf '{"result":"%s","work_exit_code":%d,"cleanup_verified":%s}\n' \
    "$state" "$work_exit_code" "$cleanup_verified" > "$evidence/outcome.json"
  if [[ $cleanup_verified != true ]]; then exit 1; fi
  exit "$work_exit_code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
# A capacity check does not establish aggregate quota parity.
python3 - <<'PY' > "$evidence/capacity.txt"
from pathlib import Path
import os
memory = int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemTotal:'))) * 1024
cpus = sorted(os.sched_getaffinity(0))
print(f'host_memory_bytes={memory}\naffinity={",".join(map(str, cpus))}')
if memory < 12 * 1024**3 or not {0, 1}.issubset(cpus):
    raise SystemExit('insufficient host capacity for 2 CPU / 12 GiB comparison')
PY
# Classic builder and daemon have no aggregate CPU quota here. Do not report controlled CPU.
printf 'builder_cpu_quota=uncontrolled\naggregate_parity=unproven\n' > "$evidence/scope.txt"
git archive HEAD > "$raw/source.tar"
printf 'source_sha256=%s\n' "$(sha256sum "$raw/source.tar" | cut -d' ' -f1)" > "$evidence/source.txt"
printf 'stage=build start_utc=%s\n' "$(date -u +%FT%TZ)" >> "$evidence/stages.txt"
build_rc=0
DOCKER_BUILDKIT=0 timeout --signal=TERM --kill-after=15s 500s docker build --cpuset-cpus=0,1 --memory=8g \
  -f scripts/ops/digitalocean-bootstrap/Dockerfile.runner \
  -t "$image" scripts/ops/digitalocean-bootstrap > "$raw/build" 2>&1 || build_rc=$?
printf 'stage=build exit=%s end_utc=%s\n' "$build_rc" "$(date -u +%FT%TZ)" >> "$evidence/stages.txt"
(( build_rc == 0 )) || exit "$build_rc"
# Do not copy the working tree or CI secrets: only files tracked at HEAD.
docker create --name "$name" --label "apollo.probe=$run" --network=host \
  --cpus=1.5 --memory=9g --memory-swap=9g --cpuset-cpus=0,1 \
  --pids-limit=1536 --shm-size=512m --init --restart=no --workdir /work "$image" sleep infinity >/dev/null
docker start "$name" >/dev/null
docker cp - "$name:/work" < "$raw/source.tar"
docker inspect --format '{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}|{{.HostConfig.MemorySwap}}|{{.HostConfig.CpusetCpus}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.PidsLimit}}|{{.HostConfig.ShmSize}}|{{.HostConfig.Init}}' "$name" > "$evidence/inspect.txt"
python3 - "$evidence/inspect.txt" <<'PY'
from pathlib import Path
import sys
assert Path(sys.argv[1]).read_text().strip() == '1500000000|9663676416|9663676416|0,1|host|1536|536870912|true', 'container readback mismatch'
PY
# cgroup v2 readback, not merely requested docker flags.
docker exec "$name" sh -c 'cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.swap.max /sys/fs/cgroup/cpuset.cpus.effective' > "$evidence/cgroup.txt"
python3 - "$evidence/cgroup.txt" <<'PY'
from pathlib import Path
import sys
cpu, mem, swap, cpuset = Path(sys.argv[1]).read_text().splitlines()
quota, period = map(int, cpu.split())
assert quota * 2 == period * 3 and int(mem) == 9 * 1024**3 and int(swap) == 0
assert cpuset == '0-1' or cpuset == '0,1', 'effective cpuset mismatch'
PY
capture() {
  local stage=$1 rc=0; shift
  printf 'stage=%s start_utc=%s\n' "$stage" "$(date -u +%FT%TZ)" >> "$evidence/stages.txt"
  snapshot "$stage" before
  docker exec -e CI=1 -e APOLLO_RESOURCE_PROFILE=isolated-ci "$name" \
    bash -c 'cd /work && exec "$@"' bash "$@" > "$raw/$stage" 2>&1 || rc=$?
  snapshot "$stage" after
  printf 'stage=%s exit=%s end_utc=%s\n' "$stage" "$rc" "$(date -u +%FT%TZ)" >> "$evidence/stages.txt"
  return "$rc"
}
snapshot() {
  local stage=$1 moment=$2
  docker exec "$name" sh -c 'for f in cpu.stat memory.current memory.peak memory.events; do printf "%s\n" "$f"; cat "/sys/fs/cgroup/$f"; done' |
    python3 -c 'import json,re,sys
lines=sys.stdin.read().splitlines(); keys=("cpu.stat","memory.current","memory.peak","memory.events")
sections={}; current=None
for line in lines:
    if line in keys: current=line; sections[current]={}; continue
    assert current is not None
    fields=line.split(); assert len(fields) in (1,2)
    assert fields[-1].isascii() and fields[-1].isdecimal()
    assert len(fields)==1 or re.fullmatch(r"[a-z][a-z0-9_.]*",fields[0],re.ASCII)
    sections[current][fields[0] if len(fields)==2 else "value"]=int(fields[-1])
assert set(sections)==set(keys) and all(sections.values())
print(json.dumps(sections,sort_keys=True))' > "$evidence/cgroup-$stage-$moment.json"
}
docker exec "$name" node --version | python3 -c 'import re,sys; s=sys.stdin.read().strip(); assert re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+",s); print(s)' > "$evidence/node-version.txt"
docker exec "$name" npm --version | python3 -c 'import re,sys; s=sys.stdin.read().strip(); assert re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+",s); print(s)' > "$evidence/npm-version.txt"
capture npm-ci timeout --signal=TERM --kill-after=15s 550s npm ci
capture remotion-ci timeout --signal=TERM --kill-after=15s 450s npm ci --prefix remotion
docker exec "$name" node -p "require('/work/node_modules/prisma/package.json').version" |
  python3 -c 'import re,sys; s=sys.stdin.read().strip(); assert re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+",s), "Prisma version unavailable"; print(s)' > "$evidence/prisma-version.txt"
# The original phase budget remains 180 seconds; no retry or altered Prisma runtime.
capture prisma-generate timeout --signal=TERM --kill-after=15s 180s npm run db:v2:generate
state=completed_focused_only
