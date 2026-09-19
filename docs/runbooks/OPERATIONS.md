# Operations runbook

## Hosting decision — 2026-09-19

Apollo uses DigitalOcean only, including production. Do not access or use the former Hostinger host (`srv1512423.hstgr.cloud` / `187.77.245.144`) for Apollo through SSH, API, browser, database, storage or workers. Historical incident records remain evidence, not permission to reuse it. Do not delete or stop residual/shared services without a separately authorised, exact-target operation.

The deployment entrypoint now requires the `digitalocean-production` profile and `APOLLO_HOSTING_PROVIDER=digitalocean` for production; the previous profile is rejected, not aliased. `APOLLO_DOCKER_NETWORK` must identify an existing network on the confirmed target, with the needed reverse proxy and PostgreSQL connectivity. This script does not provision that network, Traefik, a droplet or DNS. The backup entrypoint has the same hosting guard; the guard is not a resource supervisor for backups.

Before the first DigitalOcean production deployment, establish a separate production droplet and isolated test environment; confirm region/size/cost, access, persistent media, PostgreSQL, storage, backup and restore, image delivery, network/TLS and DNS cutover. Configure the approved budget and observation thresholds for that actual droplet. Never reuse an old droplet ID/IP/snapshot without revalidation. No migration, remote stop or DNS change has been performed as part of the policy change. Host safety, explicit resumption and release gates remain mandatory on the new provider.

## Stuck job

Inspect correlation/workflow IDs, heartbeat age and the last before/after-effect checkpoint. Reconcile an after-effect receipt before retrying. Use the public cancel/retry controls; never edit workflow rows manually.

## Degraded provider

Open its circuit, preserve in-flight job state, route new compatible briefs to healthy alternatives and compare normalized error/cost/quality metrics. Do not change the domain brief to fit a vendor.

## Inconsistent render

Stop promotion, compare manifest/RenderInput/tool/asset hashes, revalidate rights and replay in isolation. Preserve the staged artifact for diagnostics without exposing storage paths.

## DigitalOcean production operation (Wave 23 mechanisms; see ADR-159 and spec 11)

Before anything mutable on the production host: `apollo-vps.sh status` (lock, latch, gate, each container's status and limits) and `apollo-vps.sh plan --with-budget` (targets, image id/digests, quotas, steps; performs no mutation). `deploy` acquires the lock, refuses a latch, resolves the aggregate budget, proves cgroup enforcement, starts its own monitor, waits 60 s of real preflight samples, then replaces one container at a time, confirming terminal state, PID 0 and zero PostgreSQL backends before the next. Any inconclusive step engages `latch.json`, keeps the first cause in `journal/<runId>.ndjson` and stops; do not retry, do not stack commands, do not start containers as a rollback. Release only with `apollo-vps.sh latch release --reason "<owner text>"`; the next deploy then needs five stable minutes. A stale `gate.json` left by a dead monitor keeps the workers idle until `apollo-vps.sh gate open --reason "<text>"`, after checking that no operation is running. The shared profile refuses to run until the owner sets `sampleFreshnessMs`, `healthLatencyMs` and `oomRecentWindowMs` and approves a budget document; image import (`docker load`/pull) is never done by this script.

## Worker stopped mid-work

A SIGTERM'd worker hands its attempt back as `retrying` with the lease cleared and an immediate `nextAttemptAt` (no backoff); the row carries no error code while retrying, so tell a shutdown hand-back from a render failure by the schedule. Another worker claims it without waiting for the lease. On the final attempt it dead-letters exactly like lease expiry: use the public retry route. A worker that logs `worker-shutdown-deadline` exited (code 2) with a branch still running; the container's `--init` reaps the child and the lease expires as before. Provider jobs left in `submitting` are never resubmitted automatically — reconcile with the provider first.
