# Compatibility and migration

Database, events, EditPlan, manifests, provider results and embeddings carry explicit versions. Readers accept only declared historical versions and migrate forward through pure transformations; unknown versions fail with actionable errors. Golden fixtures are reviewed and never auto-updated by CI.

Public v1 changes remain additive. Breaking changes require a new major, deprecation/sunset headers, a migration guide and active-client measurement before shutdown. UI, REST and MCP results are compared against the same capability/schema source and stable error catalog.
