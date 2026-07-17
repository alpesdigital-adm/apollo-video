# ADR-127 — Color pipeline and addressable export matrix

## Decision

Color processing has a fixed technical → match → creative → output order. The most specific source, camera or segment layer overrides a transform of the same kind, producing a versioned manifest key. LUTs are workspace assets with validation, ownership, licensing and immutable versions; projects may explicitly select `none`.

Every recipe × format × locale is an independently retryable export cell with deterministic naming. Preflight checks rights, readiness, cost and storage before rendering, while shared source plans and caches remain reusable without sharing final artifacts.

## Consequences

Local color changes cannot leak to sibling segments. One failed format does not invalidate successful outputs, and all operations are exposed through the external color and export APIs.
