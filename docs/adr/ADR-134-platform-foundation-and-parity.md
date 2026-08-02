# ADR-134 — Platform foundation and parity

Development infrastructure uses isolated PostgreSQL 16, MinIO S3-compatible storage and the same durable operation/checkpoint model as production. A deterministic vertical smoke crosses upload, normalization, static plan, proxy render and reconstruction with shared trace/workspace/project/job context.

Local PostgreSQL and MinIO publish only on explicit loopback ports and require
operator-supplied secrets. PostgreSQL uses a dedicated volume and a bounded
Prisma pool. MinIO initializes one declared bucket idempotently and enables
object versioning before the environment is considered ready. A dependency-free
`infra:validate` gate protects these invariants in CI even when Docker is not
available; passing that gate does not claim that containers, migrations or S3
I/O were executed. CI uses that exact pinned PostgreSQL 16 + pgvector image so
the clean migration run cannot silently drift to a server without `vector`.

The disposable local runtime composes that database and versioned bucket with
one immutable application image. A one-shot migration service must complete
before the API and the ingest, render, webhook and long-form workers start.
Every long-running process has PID 1 supervision, restart policy, graceful stop
and shared persistent artifact/work volumes. Static validation proves the
topology contract; it is not evidence that Docker boot or lease recovery ran.

OIDC-verified identities become signed, expiring workspace sessions; production never trusts an unverified local identity. Workspace switching invalidates caches and subscriptions. Architecture imports are enforced by a CI boundary check. UI actions, REST endpoints and tests map through capability IDs, while sensitive internals have explicit deny-only reasons.

Public operations generalize across ingest, Director, provider, sync, batch, render and export. Public conventions, deprecation/sunset headers, client kill switches and transition outbox events are stable application contracts.
