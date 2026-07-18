# ADR-138 — Non-functional quality gates

Idempotency, checkpoint resume, redacted telemetry, isolated replay, performance budgets, queue backpressure, structural security, privacy deletion, schema compatibility, risk-based tests and external parity are executable release gates. Each gate returns evidence rather than relying on operational convention.

Incidents include duplicate external effects and artifact hash mismatches. Performance is measured p50/p95 across representative project classes. Privacy and security are fail-closed. Public sunset cannot proceed while active clients remain without a reviewed migration path.
