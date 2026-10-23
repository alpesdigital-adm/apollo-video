-- ADR-160 F8. Compatibility graph v2: a context the requester did not state is unspecified, the check that needs it is not evaluable, and the
-- dimension that needs it is left out of the weighted score. A graph is sealed under one version; graphs made before keep v1 and stay readable.
-- Additive: only the version CHECK is widened (v1 or v2 as a whole, never a mix). Manual reversal: delete the v2 graph rows
-- (compatibility_graph_runs where "schemaVersion" = 'compatibility-graph/v2', which cascade to nodes and edges, after removing the recipes and
-- preflights that name them), then restore the v1-only CHECK of migration 20260728010000.
ALTER TABLE "compatibility_graph_runs" DROP CONSTRAINT "compatibility_graph_runs_versions_check";
ALTER TABLE "compatibility_graph_runs" ADD CONSTRAINT "compatibility_graph_runs_versions_check" CHECK (
  (
    "schemaVersion" = 'compatibility-graph/v1'
    AND "ruleVersion" = 'compatibility-rules/v1'
    AND "softScoreVersion" = 'compatibility-soft-score/v1'
  ) OR (
    "schemaVersion" = 'compatibility-graph/v2'
    AND "ruleVersion" = 'compatibility-rules/v2'
    AND "softScoreVersion" = 'compatibility-soft-score/v2'
  )
);
