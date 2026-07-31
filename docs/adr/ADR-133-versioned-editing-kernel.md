# ADR-133 — Versioned editing kernel

EditPlan v2 is an immutable, validated graph of typed tracks, explicit source/timeline ranges, N immutable sources, OutputSpec and policy snapshot. Manual UI and Director tools submit the same idempotent Command envelope. Protected elements are enforced before patches, and deterministic dependency traversal computes the smallest stale set and render range.

Every confirmed change creates a ProjectVersion. Forks share media read-only and copy no bytes; commands remain isolated. Semantic diff and restore preserve history. Artifact lineage contains exact plan/source/job/tool hashes. Generic durable jobs checkpoint external effects and expose truthful state. Render materialization resolves assets, fonts and LUTs before the renderer receives a portable identity.

Partial invalidation is recorded as `command-impact/v1` inside the immutable
Command payload, so it commits atomically without a parallel mutation model.
The record is content-addressed, frame-first and format-scoped; completed
proxy/final outputs are discovered from the exact base version and re-read in
the serializable commit. Historical artifacts remain valid for historical
versions. The initial runtime adapter covers `manual-edit` only. Until stale
relations and range rendering are implemented, the existing public endpoint
continues to enqueue its compatible full proxy; an impact prediction must not
be reported as partial rendering already delivered.
