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
relationships without changing `manual-edits.apply/v1`. The initial runtime
adapter still covers `manual-edit` only.
Until range rendering and stale resolution are implemented, the endpoint
continues to enqueue its compatible full proxy; normalized stale state must not
be reported as partial rendering already delivered.
