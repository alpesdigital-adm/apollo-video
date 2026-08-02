# Versioned schemas and state machines

Canonical source types live in `src/v2/domain/canonical-types.ts`. OpenAPI, JSON Schemas and MCP tools are generated from the Public Capability registry and validated by `api:v1:validate`.

Project, version, asset, upload, job, public operation, webhook, localization and synthetic workflows reject unknown states and invalid jumps. Durable effects use before/after checkpoints. The generated catalog is refreshed when a schema/state meaning changes, together with the glossary, PRD, relevant spec and traceability matrix.

`PublicOperation` is the first aggregate using `visible-state/v1`. Its technical
state remains authoritative; the projection supplies semantic label, tone,
truthful progress mode, primary/available actions and terminality. `waiting`
may only be entered from `running` and resumed without incrementing attempt at
the same or a later running phase. The projection never invents a percentage
without a positive total.

`ProductionBatch` and each persisted batch item also receive a visible
projection. Percent is the ratio of completed canonical steps, never an
estimate. Mixed terminal outcomes are `partially-failed` when any item failed
and `partially-completed` otherwise; completed items and their artifacts remain
available while retry targets only failed work. Public v1 batch schemas remain
published and the six batch capabilities returning the aggregate use additive
v2 response schemas.

An unresolved `CommandArtifactInvalidation` is a relation state, not an
artifact lifecycle state. Its additive v2 presentation is `stale-output`, has
`availabilityEffect: none`, and exposes rebuild plus historical-open actions.
Exact proxy/final completion resolves the matching edge; the historical
artifact remains addressable under its source version.

The media artifact aggregate has a separate closed lifecycle:
`available|quarantined|deleted`. It never inherits `stale-output` from a
version edge and never invents progress. The Prisma adapter and v3 public
presenter share the domain allowlist and reject unknown persisted values.
The additive v4 detail exposes a monotonic lifecycle revision. The public
transition command persists a reason and immutable before/after audit record,
uses durable idempotency and fences the artifact row by workspace, status and
revision. Available and quarantined may move between each other or to deleted;
deleted is terminal except for a convergent self-transition. Deleted remains a
logical tombstone, so lifecycle change never physically discards retained bytes.

Project has a separate closed 14-phase enum and a canonical visible projection.
The public create v3, list v2, and workspace v6 responses expose it while
retaining their older schemas. Both workspace routes now return the same full
contract and nested operations carry their visible projection. Technical status
and visible label must match; active phases are indeterminate, review phases
request review, and only `completed` reports 100%. The public projection never
infers or performs a transition.

The canonical Project transition matrix is exhaustive over all 14 phases.
Self-transition is convergent, archived has no outgoing transition, and only
declared paths can reach completed or leave review. Current ingest, proxy
review, compare-decision and final-export writers put the allowed source state
inside the same persisted update and reject a zero-row result as a domain
conflict. Future writers must use the same matrix.

ProjectVersion remains immutable and has no writable lifecycle column. Its
visible relation is derived as `current` when its identity equals the Project
head and `superseded` otherwise. Review history v3 opens a historical output
only when persisted preview evidence exists; otherwise it offers history
inspection. Project create v4, duplicate v2 and workspace v7 expose their
current version through the same projection. Commands v7/result v6 also covers
remove-spoken-content, run-director and replace-source-transcript. Manual edit
v3 covers apply, undo, redo and restore. Individual and batch patch v3 responses
also use the same projector. LUT-selection read/set v3 covers renderable and
deferred selections. Comparison action v4 projects only the new restore head;
accept and reopen correctly remain version-preserving actions.
