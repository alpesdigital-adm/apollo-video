# ADR-133 — Versioned editing kernel

EditPlan v2 is an immutable, validated graph of typed tracks, explicit source/timeline ranges, N immutable sources, OutputSpec and policy snapshot. Manual UI and Director tools submit the same idempotent Command envelope. Protected elements are enforced before patches, and deterministic dependency traversal computes the smallest stale set and render range.

Every confirmed change creates a ProjectVersion. Forks share media read-only and copy no bytes; commands remain isolated. Semantic diff and restore preserve history. Artifact lineage contains exact plan/source/job/tool hashes. Generic durable jobs checkpoint external effects and expose truthful state. Render materialization resolves assets, fonts and LUTs before the renderer receives a portable identity.

Partial invalidation is recorded as `command-impact/v1` inside the immutable
Command payload, so it commits atomically without a parallel mutation model.
The record is content-addressed, frame-first and format-scoped; completed
proxy/final outputs are discovered from the exact base version and re-read in
the serializable commit. Historical artifacts remain valid for historical
versions. For `manual-edit`, the same transaction also creates content-addressed
`command-artifact-invalidation/v1` rows linked to the Command, base/result
versions and only the affected artifact/variant. This is version-scoped
dependency state; it never changes the global availability of historical
bytes. Replay rehydrates and compares the normalized rows against the immutable
impact payload, while the additive public
`apollo.projects.artifact-invalidations.read` capability returns those same
relationships without changing `manual-edits.apply/v1`.

The initial `manual-edit` runtime derives one persisted proxy range, validates a
completed base proxy, recomposes only that range and assembles a complete MP4
from the valid prefix/range/suffix. The renderer receives a materialized path
and immutable hashes, never persistence access. Missing reusable bytes or a
full-timeline impact deliberately selects the new V2 full render. Completion
records an immutable invalidation resolution linked to the replacement
operation/artifact/manifest; active-stale reads hide it only after that
operation is `succeeded`. A selection-only Command has zero render semantics:
the proxy request completes as an exact cache hit over the succeeded base
operation, creates no artifact, performs no color resolution and is never
claimed by a worker. The transaction revalidates Command/impact, current/base
versions, source, proxy operation, artifact and manifest, then records the
self-referential `reusedFromOperationId` plus Command/base-version FKs. Missing
base proxy fails closed instead of silently rendering. The current adapter is
intentionally limited to one merged range and unit-rate clips. Other Commands
and multiple ranges/rates remain open and prevent claiming FR-233 complete.
