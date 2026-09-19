# 11 — Host safety, serial operations and worker shutdown

Companion of ADR-159 and of the section "Infraestrutura DigitalOcean e operação segura" of `AGENTS.md`. This document specifies the executable mechanisms of Wave 23. It does not claim that any of them is deployed: the fifth state (implantado e aceito) remains false until the owner says otherwise.

Hosting amendment, 2026-09-19: DigitalOcean is the only remote hosting provider for Apollo, including production. The former Hostinger host is forbidden. Local development and isolated CI remain supported. The deploy and backup entrypoints reject the former host's known hostname/IP before Docker, PostgreSQL, locks or filesystem mutations. The production profile is now `digitalocean-production`, with no alias for `shared-production`, and requires `APOLLO_HOSTING_PROVIDER=digitalocean`. This declaration and the local denylist are guards against accidental reuse, not cloud identity attestation: the actual droplet must be independently confirmed before any deployment. The required `APOLLO_DOCKER_NETWORK` replaces the old implicit network. No VPS, DNS, database or remote service was migrated by this amendment.

## 1. Operational state directory

`APOLLO_OPS_STATE_DIR` — host: `/var/lib/apollo-ops`; inside every Apollo container: `/app/ops-state`, mounted read-only (the run's monitor is the only container that mounts it read-write). Ownership: the deploy, under the lock and immediately before it starts the monitor, makes the directory and `journal/` `root:1000` mode `1770` — group-writable and sticky — so the monitor (uid 1000 in the image) can create and replace its own entries (`gate.json`, `journal/<runId>.monitor.ndjson`) and cannot unlink or rename root's (`latch.json`, `lock/`, the operation journal). The first run against a real daemon (CI run 35453455143) failed with `EACCES` on a root-owned directory; handing the directory to uid 1000 outright was rejected because write permission on a directory is permission to delete the latch. `latch release` and `gate open` never change permissions. Contents, and nothing else:

| Path | Writer | Readers | Meaning |
|---|---|---|---|
| `gate.json` | the run's monitor (`scripts/ops/host-safety-monitor.mjs`) | workers, verdict container | admission decision of the current operation |
| `latch.json` | `apollo-vps.sh` (containment) | workers, verdict, deploy | incident latch; presence closes everything |
| `lock/owner.json` | `apollo-vps.sh` | `apollo-vps.sh` | the single mutable operation |
| `journal/<runId>.ndjson` | `apollo-vps.sh` | operator, tests | one line per step, never an environment value |
| `journal/<runId>.monitor.ndjson` | the monitor | verdict container | one line per sample (`host-sample`) |
| `journal/latch-<engagedAt>.released.json` (+ `.source`) | `apollo-vps.sh latch release` | operator | a released latch is archived, never deleted |

No job, operation, version or artifact appears in the directory. Product state lives in PostgreSQL only.

### gate.json (`apollo-ops-gate/v1`)

```json
{ "schemaVersion": "apollo-ops-gate/v1", "state": "closed", "reasons": ["cpu-busy-sustained"],
  "seq": 42, "issuedAtIso": "…", "issuedAtMonotonicMs": 123456.7, "ttlMs": 30000,
  "owner": { "runId": "deploy-…", "kind": "monitor", "pid": 4242 } }
```

Worker reading rules (`src/v2/infrastructure/ops-state/file-admission-gate.ts`): env absent ⇒ open with one logged note (`ops-state-not-configured`); env set but directory unreadable ⇒ closed; `latch.json` present ⇒ closed (`incident-latch:<reason>`); `gate.json` absent ⇒ open; unparseable, unknown schema or state, missing/non-positive `ttlMs` ⇒ closed; `state=closed` ⇒ closed with the reasons; `state=open` but file mtime older than `ttlMs` ⇒ closed (`stale-gate`). Freshness is judged by the file's mtime on the same host, never by the monitor's monotonic clock.

### latch.json (`apollo-ops-latch/v1`)

Engaged by the deploy on any inconclusive step (`stop-timeout`, `step-inconclusive`, `gate-closed`, `postflight-inconclusive`). Released only by `apollo-vps.sh latch release --reason "<text>"`, which archives the document into `journal/` with the operator's reason. After a release the next deploy still requires the stability window (30 samples covering 300 s). Container restart policies, supervisor restarts and reboots do not touch the latch.

### lock/

`mkdir` is the compare-and-set. `owner.json` records `runId`, `pid`, `startedAtIso`, `bootId`, `command`, `hostname`. An existing lock is an orphan only if its `bootId` differs from the current boot, or its PID is absent **and** it is older than ten minutes; an orphan is archived into `journal/` before the takeover. Age alone never breaks a lock.

## 2. Policy (`config/host-safety-policy.json`, `src/v2/infrastructure/host-safety/policy.ts`)

Thresholds reproduce `AGENTS.md` and are internal and conservative, not a budget to spend up to:

| Metric | Closes when | Reason code |
|---|---|---|
| CPU busy, sustained | ≥ 50 % across ≥ 30 s of real monotonic coverage | `cpu-busy-sustained` |
| CPU busy, peak | ≥ 70 % in any sample | `cpu-busy-peak` |
| load1 / host CPUs | ≥ 0.75 | `load-ratio` |
| steal | ≥ 10 % (judged on its own, never folded into busy) | `steal` |
| MemAvailable | < 2 GiB | `memory-available` |
| OOM | kill observed inside `oomRecentWindowMs` | `oom-recent` |
| PostgreSQL connections | > 50 % of `max_connections`, or unobtainable | `pg-connections` |
| health probe | non-2xx or no answer; latency above `healthLatencyMs` | `health-error`, `health-latency` |
| evidence | sample missing, stale, malformed, out of order, clock reset, window incomplete, catalog unconfigured, latch engaged | the corresponding code |

CPU formula, from the delta of the aggregate `cpu` line of `/proc/stat`: `total = user+nice+system+idle+iowait+irq+softirq+steal`; `busy = (user+nice+system+irq+softirq)/total`; `steal = steal/total`; `iowait = iowait/total`; `guest`/`guest_nice` are excluded because the kernel already counts them inside `user`/`nice`. The CPU count is the number of `cpuN` lines (the host, even inside a container), never the container quota.

Windows: preflight and postflight require ≥ 60 s of coverage at the 10 s cadence; the stability window after a latch release requires 30 samples covering ≥ 300 s; during work every sample is judged. Coverage = span of the samples + one cadence, computed on the monotonic clock. `sampleFreshnessMs`, `healthLatencyMs` and `oomRecentWindowMs` have no code default: the `digitalocean-production` profile ships without them and therefore answers `policy-unconfigured` until the owner sets them.

Collector (`linux-collector.ts`): four `/proc` files, one bounded HTTP GET (≤ 2 s) of `APOLLO_OPS_HEALTH_URL`, and three statements on one observation connection (`select count(*) from pg_stat_activity`, `show max_connections`, `select application_name, count(*) … group by 1`). No browser, worker or pool per sample. The first read primes the CPU delta and yields no sample.

## 3. Aggregate budget (`config/resource-budget.json`, `src/v2/infrastructure/resource-budget/`)

Profiles `isolated-ci` and `local-dev` carry numbers; `digitalocean-production` carries none and requires `APOLLO_RESOURCE_BUDGET_APPROVED_FILE` (`apollo-resource-budget-approval/v1`: `approvedBy`, `approvedAtIso`, `host`, `envelope`, `containers`, `auxiliaries`), whose envelope must leave ≥ 25 % of the host CPUs and ≥ 2 GiB of memory. Charged sum = enabled containers (the localization translation worker only when `APOLLO_LOCALIZATION_WORKER_ENABLED=true`) + concurrent auxiliaries (monitor) + the largest sequential auxiliary (config check, migrate). Enforcement per container: `--cpus`, `--memory`, `--memory-swap` = memory, `--pids-limit`, read back from `docker inspect`. Uncovered by construction: `docker load`, `docker pull`, image decompression, image hashing, backups.

## 4. Deploy (`infra/deploy/apollo-vps.sh`)

Commands: `plan [--with-budget]` (read-only), `deploy [--adopt-unlabelled <name>]`, `status`, `latch release --reason`, `gate open --reason`. Required environment, no defaults: `APOLLO_OPS_STATE_DIR`, `APOLLO_RESOURCE_PROFILE`, `APOLLO_ENV_FILE`, `APOLLO_IMAGE`, `APOLLO_OPS_HEALTH_URL` (+ `APOLLO_RESOURCE_BUDGET_APPROVED_FILE` on the shared profile).

Sequence of `deploy`: lock → no latch → image present (id/digests journaled; never imported) → budget resolved in a `--rm` container (exit 2 aborts) → cgroup v2 and no limit-support warning → policy observation values present → no Apollo container OOM-killed inside the recency window → monitor container started → preflight established (60 s of samples, monitor alive, gate seq advancing, decision ≤ 20 s old) → host directories → config-check container → migrate container → for each enabled role, one at a time (app first): identity by labels → `docker stop --timeout 30` → terminal status → PID 0 → zero backends for `apollo-video-<role>` → `docker rm` → `docker run -d` with labels, quotas, `-v $APOLLO_OPS_STATE_DIR:/app/ops-state:ro`, `APOLLO_OPS_STATE_DIR`, `APOLLO_PROCESS_ROLE` → limit readback → health → gate re-read → postflight (60 s) → `gate.json` removed → monitor stopped → lock released. Blocked identity ⇒ no mutation, no latch. Any inconclusive step ⇒ latch, journal, nothing else touched, exit ≠ 0, no rollback.

## 5. Workers

Every continuous entrypoint (`scripts/run-v2-*-worker.mjs`) and the one-shot render entrypoint use `createWorkerShutdown` (SIGINT/SIGTERM → one AbortController), check `admits()` before every claim (and before each of the render chain's five branches), pass the signal into `runNext`, bound the admitted branch with `awaitWithShutdownDeadline` (`APOLLO_V2_WORKER_SHUTDOWN_GRACE_MS`, default 20 000 ms, must stay below the 30 s container stop timeout; on expiry: `worker-shutdown-deadline` event, cleanups, exit code 2), and end with `runWithCleanup` (listeners disposed, Prisma disconnected, cleanup failures recorded next to the primary error). PostgreSQL backends are named `apollo-video-<APOLLO_PROCESS_ROLE>` unless the URL already declares an `application_name`.

Persisted outcome of a graceful shutdown of a PublicOperation attempt: `retrying`, lease cleared, `nextAttemptAt = failedAt + 1 ms` (no backoff) and **no error on the row** — the domain clears `error` on `retrying`, so the `worker_shutdown` code the worker reports is not visible there; it is persisted only when the final attempt dead-letters (`failed`, `error.code = worker_shutdown`), as lease expiry would have done; manual retry recovers. Provider jobs: `submitting` is never resubmitted.

## 6. What is covered and what is not

Covered by executable mechanisms: the deploy path of `apollo-vps.sh`; worker admission and shutdown in the ten entrypoints; budget resolution and readback; the policy's thresholds and windows. Not covered: the Compose workflow (CI/local) is not gated or quota-bound; image import on the shared host; host-wide kernel-log OOM detection; abortable webhook delivery HTTP; the director branch mid-work; capture-sync recovery after a hard kill (lease expiry). None of this is "proteção completa do servidor".

## 7. Controlled resumption and rollback — procedure, NOT executed

Written for a future, separately authorised operation; nothing below was run in Wave 23.

1. Owner's explicit release in writing; `apollo-vps.sh latch release --reason "<owner text>"` if a latch is engaged.
2. Owner sets the three observation values for `digitalocean-production` in `config/host-safety-policy.json` and approves a budget document; `apollo-vps.sh plan --with-budget` must print the exact targets, image id/digests and quotas, and refuse nothing.
3. Stability measured, not assumed: the monitor runs for five minutes with every sample inside the thresholds before any mutation.
4. One action at a time: `apollo-vps.sh deploy` replaces one container per step, confirming terminal state, PID 0 and zero backends before the next; the operator watches `apollo-vps.sh status` and the journal between steps.
5. Postflight of 60 s after the last replacement; only then is the gate removed.
6. Any anomaly — a closed gate, a stop timeout, a readback mismatch, a health failure — ends the operation as inconclusive with the latch engaged; the operator does not retry, does not stack commands and does not start containers to "roll back". Rollback, when decided by the owner, is a new, separately gated deploy of the previous image id recorded in the journal.
