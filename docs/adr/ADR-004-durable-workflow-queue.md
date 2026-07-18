# ADR-004 — Durable workflow and queue

Postgres-backed public operations and worker leases are the canonical workflow mechanism. Jobs have idempotency keys, attempts, heartbeat, cancellation, exponential retry, checkpoints and dead-letter replay. Transactional outbox delivery prevents state/event divergence.

Local execution uses the same repository contracts as workers. Media work is claimed with fencing tokens; provider callbacks correlate to durable jobs. Default SLA, timeout and retry values are versioned configuration and every external effect is bracketed by checkpoints.
