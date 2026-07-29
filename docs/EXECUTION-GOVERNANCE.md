# Execution governance

Every backlog item is ready only when its expected result, failure state, input/output owner, dependencies, fixture and impact on rights, consent, cost, lineage and invalidation are explicit. The linked FR, NFR, ADR or spec is checked before implementation.

Done means versioned contracts and migrations, workspace isolation, authorization, idempotency/retry, truthful UI states, redacted observability, unit and contract coverage, deterministic visual evidence, lineage, partial invalidation and a demonstrated acceptance criterion. Security must be enforced structurally, never only by prompts.

Work proceeds through F0 → F1 → F2 → F3 → F4 → F5 gates. Each slice crosses domain, persistence, provider/job, UI, observability and tests as applicable. Masters remain immutable; UI and AI emit the same command model; every operable capability has a public capability ID and contract. Uploaded transcripts, OCR and documents are always data, never owner instructions.

Defaults and thresholds are versioned configuration. Contract changes update the PRD/spec/traceability/schema/tests together, and architectural deviations require an ADR.

## Remote E2E lifecycle

Remote PostgreSQL is an exception, not the default test substrate. It may be
used only in a database/container isolated from production and only while the
host passes a read-only capacity check. No E2E command may call `dropdb` or
`DROP DATABASE` on a remote server.

### Preflight

1. Generate one run ID and use it in process metadata and
   `application_name=apollo-video-e2e-<run-id>`.
2. Acquire the single-run lease for the target database.
3. Refuse URLs whose database name is not explicitly E2E-only.
4. Bound every client URL to `connection_limit<=5`, `pool_timeout<=10` and
   `connect_timeout<=10`.
5. Read `pg_stat_activity`; refuse an old E2E session, unknown client, active
   DROP or another run.
6. Refuse the VPS when CPU steal is sustained above 10%, free RAM is below
   2 GiB, an OOM event is recent or occupied PostgreSQL connections exceed 50%
   of `max_connections`.

### Supervised execution

The harness owns every Next process, worker, browser and SSH tunnel it starts.
It records PID and run ID, imposes a maximum duration, never detaches without a
watchdog and registers cleanup before the first child starts. Browser-only work
does not start a second database pool when the API process already serves the
same run.

### Postflight

Cleanup runs even after failure, timeout, cancellation, permission change or
test assertion:

1. close browser contexts and processes;
2. stop Next and workers and wait for their exit;
3. disconnect every Prisma client;
4. stop only the SSH tunnel owned by the run;
5. verify zero `pg_stat_activity` rows for its `application_name`;
6. release the lease and record the postflight evidence.

The run is failed—not “cleaned up”—until the last verification succeeds.
Timeout is never evidence that a child or PostgreSQL backend exited.

### Incident response

When a database reset waits on clients, stop creating new work. Find and stop
the application/test process that owns or reopens the pool before touching the
waiting reset process. Do not stack `dropdb`, `docker exec`, browser or test
commands on an overloaded host. A cleanup whose server-side state cannot be
verified blocks further remote E2E and deployment.
