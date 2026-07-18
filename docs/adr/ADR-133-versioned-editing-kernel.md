# ADR-133 — Versioned editing kernel

EditPlan v2 is an immutable, validated graph of typed tracks, explicit source/timeline ranges, N immutable sources, OutputSpec and policy snapshot. Manual UI and Director tools submit the same idempotent Command envelope. Protected elements are enforced before patches, and deterministic dependency traversal computes the smallest stale set and render range.

Every confirmed change creates a ProjectVersion. Forks share media read-only and copy no bytes; commands remain isolated. Semantic diff and restore preserve history. Artifact lineage contains exact plan/source/job/tool hashes. Generic durable jobs checkpoint external effects and expose truthful state. Render materialization resolves assets, fonts and LUTs before the renderer receives a portable identity.
