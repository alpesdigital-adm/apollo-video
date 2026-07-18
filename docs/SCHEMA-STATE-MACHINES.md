# Versioned schemas and state machines

Canonical source types live in `src/v2/domain/canonical-types.ts`. OpenAPI, JSON Schemas and MCP tools are generated from the Public Capability registry and validated by `api:v1:validate`.

Project, version, asset, upload, job, public operation, webhook, localization and synthetic workflows reject unknown states and invalid jumps. Durable effects use before/after checkpoints. The generated catalog is refreshed when a schema/state meaning changes, together with the glossary, PRD, relevant spec and traceability matrix.
