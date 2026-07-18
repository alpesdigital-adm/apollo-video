# ADR-005 — EditPlan v2

EditPlan is a versioned, immutable canonical timeline with explicit tracks, source/timeline ranges, protected elements and dependency references. Format and locale variants remain separate overlays. Pure migrations parse old schemas into the current representation.

The renderer receives only a portable RenderInput compiled from resolved references; it cannot query the application database. Golden fixtures cover parse, migration, serialization and deterministic compilation with invalid references, timing and overlap rejected before rendering.
