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
relationships. The crop addition deliberately evolves
`apollo.projects.manual-edits.apply` to capability/schema major v2 while the
v1 schema references remain immutable.

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

Manual crop is not encoded as an inspector/layout string. It is a typed,
normalized source rectangle on one clip, scoped by the Command to one format.
The immutable impact records `crop`, visual dependency and the exact clip
range; the renderer preserves the crop through partial slicing, converts it to
encodable source pixels before composition and emits matching element bounds.
The shared FFmpeg renderer and proxy/final recipe identities are versioned when
this pixel behavior changes. A real red/blue FFmpeg golden proves that only the
stale middle range is cropped while the base proxy prefix and suffix remain
valid. PostgreSQL/API E2E coverage is prepared but not executed locally, so
crop and FR-233 remain unaccepted.

Manual subtitle text follows the same path without treating the whole clip as
stale. A text-only `inspect.text` materializes the overlapping cue in the immutable
EditPlan; impact derivation compares before/after subtitle cues, requires
exactly one changed cue and uses its frame range. A real FFmpeg golden proves
that only this interval changes pixels and that proxy-base prefix/suffix remain
identical at sampled frames. This is local evidence only: PostgreSQL execution,
deploy and acceptance remain open.
Combined inspector patches retain the clip range so another visual or audio
field cannot be under-invalidated.

B-roll replacement evidence now begins with the production `replace`
materializer instead of hand-built renderer clips. The resulting EditPlan
retains the master audio artifact and exact source frames, while
`command-impact/v1` supplies the central range and hash to partial rendering.
The real MP4 shows only the replacement source in that range, keeps neighboring
base pixels, AAC audio and total duration. Remote PostgreSQL execution and
acceptance are still required.

Source transcript replacement is an explicit API-first Command, not an implicit
"latest row" lookup. `replace-source-transcript` binds the requested transcript
ID and expected content hash to the same source master, retimes its words over
the current audio timeline and creates a new immutable EditPlan/ProjectVersion.
Its content-addressed impact covers the full timeline and every completed
proxy/final variant from the base version. Render is deliberately blocked: the
response requires a new `run-director`, because perception, treatment, story
and edit decisions all depend on the replaced evidence. The Director repository
therefore resolves the transcript selected by the current EditPlan and verifies
its optional hash, even when a newer unselected transcript exists. Domain tests
pass and PostgreSQL/API coverage is prepared, but not executable on this host;
the case remains unaccepted until that E2E, deploy and visual acceptance run.
