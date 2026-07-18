# ADR-134 — Platform foundation and parity

Development infrastructure uses isolated PostgreSQL 16, MinIO S3-compatible storage and the same durable operation/checkpoint model as production. A deterministic vertical smoke crosses upload, normalization, static plan, proxy render and reconstruction with shared trace/workspace/project/job context.

OIDC-verified identities become signed, expiring workspace sessions; production never trusts an unverified local identity. Workspace switching invalidates caches and subscriptions. Architecture imports are enforced by a CI boundary check. UI actions, REST endpoints and tests map through capability IDs, while sensitive internals have explicit deny-only reasons.

Public operations generalize across ingest, Director, provider, sync, batch, render and export. Public conventions, deprecation/sunset headers, client kill switches and transition outbox events are stable application contracts.
