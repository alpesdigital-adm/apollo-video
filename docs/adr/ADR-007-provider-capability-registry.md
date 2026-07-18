# ADR-007 — Provider adapters and capability registry

Providers declare capability, price, limits, health, region and credential reference. Adapters normalize submit, poll, cancel, callback and result into durable provider jobs. Domain plans never contain vendor-specific types.

Routing considers policy, rights, region, health, quality and cost and records rejected alternatives. Fake adapters simulate success, delay, rate limit, transient and permanent failure; fallback changes provider without changing the domain brief.
