# ADR-133 — Versioned editing kernel

EditPlan v2 is an immutable, validated graph of typed tracks, explicit source/timeline ranges, N immutable sources, OutputSpec and policy snapshot. Manual UI and Director tools submit the same idempotent Command envelope. Protected elements are enforced before patches, and deterministic dependency traversal computes the smallest stale set and render range.

Every confirmed change creates a ProjectVersion. Forks share media read-only and copy no bytes; commands remain isolated. Semantic diff and restore preserve history. Artifact lineage contains exact plan/source/job/tool hashes. Generic durable jobs checkpoint external effects and expose truthful state. Render materialization resolves assets, fonts and LUTs before the renderer receives a portable identity.

For Apollo composition props, portable `fontAssetId` and `renderDataAssetId`
are resolved only from the authorized materialized input. Auxiliary text uses
the closed `apollo-video-render-data/v1` schema; the worker rechecks byte size
and SHA-256 before parsing it as untrusted UTF-8 JSON. A materialized font is
served only by the private render process under the fixed
`ApolloResourceFont` family, and Remotion delays frames until `FontFace.load()`
completes. Missing, changed, wrongly typed or undeclared resources fail closed.

Reconstruction is manifest-first. The saved v4 manifest locates one canonical
protected RenderInput; a fresh authorization rechecks rights and asset identity
before materialization. Callers do not rebuild props. The local golden persists
and reloads this full fixture before two independent authorized renders and
compares every decoded video and audio frame. PostgreSQL/object-storage proof,
deployment, and acceptance remain required.

Public operation state is presented through the additive `visible-state/v1`
projection rather than UI-specific inference. Technical status remains the
source of truth. Determinate progress requires a real denominator; waiting and
scheduled retry are explicitly indeterminate. `running → waiting → running`
preserves attempt and progress and cannot resume behind its last known phase.
Artifact availability remains separate from version-scoped stale output edges.

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
base proxy fails closed instead of silently rendering. The adapter accepts up
to eight canonical disjoint ranges; overlap and adjacency are fused in the
domain, while malformed, excessive, or full-coverage sets fall back to a full
render. It interleaves reused base segments with freshly encoded ranges. Clips
use frame-first rate in `[0.25, 4]`, `setpts` for video and chained `atempo` for
audio; reverse fails closed. Fractional partial boundaries are mapped from both
absolute endpoints, never from an independently rounded length. Other Commands,
PostgreSQL execution, deployment, and acceptance still prevent claiming FR-233
complete.

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
also prove rate `[0.25, 4]` with the same frame-first rounding used by the
renderer. Mapping iterates audible clips in timeline order, so reordered source
material stays chronological and every repeated source occurrence retains its
own evidence; partially covered words are discarded rather than invented.
The immutable snapshot carrying those frames is read by the next DirectorRun.
A local FFmpeg golden now carries that snapshot through the real Director and
renderer, proving exact frame count, rates `1`, `2`, and `0.5`, retained audio,
discarded gaps, and visible subtitles at the retimed intervals. Persistence in
that golden remains in-memory; PostgreSQL/API execution, deployment, and visual
acceptance are still required.

`remove-spoken-content` is the next Command integrated into persisted
invalidation. It intentionally does not claim partial reuse: the handler
recompiles the complete EditPlan from aligned transcript evidence, so its
content-addressed `editorial-cut-impact/v1` covers the full base/result timeline,
all completed base proxy/final variants and audio/content/timing/visual
dependencies. The serializable commit re-reads that exact output set and writes
normal `command-artifact-invalidation/v1` relationships; no completed output
means no fabricated stale row. The public route then enqueues exactly one full
proxy through the shared durable V2 application service and returns its
operation. Domain/API evidence is green and PostgreSQL scenarios are prepared,
but remain unexecuted on this host; deploy and acceptance remain open.

`run-director` now follows the same atomic model with a distinct
`director-run-impact/v1`. A Director replan is conservatively full-timeline
because it can change composition, subtitles, transitions and policy decisions
together. Its content-addressed payload binds the selected transcript plus
planner/critic versions, declares audio/content/policy/timing/visual, lists only
completed base outputs and requests exactly one full proxy for the current
format. The serializable commit re-reads that output set, writes the normalized
stale relationships and rejects drift. Hydration compares payload, rows and
hash; no completed base output means no fabricated invalidation while the proxy
request remains. The public response exposes impact, invalidations and the
durable operation. PostgreSQL/API execution, deployment and acceptance remain
open, so this does not complete FR-233.

`set-project-lut-selection` also participates in the same atomic invalidation
model through `project-lut-selection-impact/v1`. A color-recipe selection is a
full-timeline visual change once a compiled timeline exists: the serializable
commit fences the exact completed base outputs, writes normalized stale edges,
and the public v2 capability enqueues one full proxy for the result version.
Selection is still valid before ingest, but its impact is explicitly deferred;
zero duration produces no range, variant, artifact, invalidation, or render
request. This avoids inventing render evidence while preserving the immutable
selection for later compilation. PostgreSQL execution, deployment, and
acceptance remain open, so FR-233 remains incomplete.

Canonical multi-range support does not make every edit sparse. A `move` or
other downstream timing change keeps one continuous envelope from the earliest
affected frame through the plan end: clips between the target's old and new
locations shift and their previous bytes are not reusable. Disjoint ranges are
accepted only when the producing Command can prove independent unchanged
regions.

`apply-review-patch` now joins the same persisted invalidation model. Proposal
ranges remain human-facing milliseconds, but application converts them with the
EditPlan FPS into positive frame-first ranges; point annotations receive exactly
one frame. `trim` and `move` conservatively extend from the first affected frame
through the timeline end. The serializable commit re-reads completed base
outputs before writing normalized stale relationships, and the proxy repository
accepts the stored impact for partial base reuse. Public capability v2 exposes
impact and invalidations. Local controlled-adapter tests are green, and a real
FFmpeg golden starts from the materialized PatchSet and changes subtitle pixels
only inside its frame-first range while reusing the base prefix/suffix. The
PostgreSQL/API E2E is prepared but unexecuted; deploy and acceptance remain open.
