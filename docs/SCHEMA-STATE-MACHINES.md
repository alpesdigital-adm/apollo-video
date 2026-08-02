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
