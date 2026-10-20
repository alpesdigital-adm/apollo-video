-- A Command scoped to ONE output creates a new ProjectVersion, and the OTHER output of the project would lose its render and its
-- approval although nothing it is drawn from changed. A render can now be carried to the new Version when its content identity is the
-- same, and the carry is recorded, never silent:
--   * `renderContentHash` is the Version-independent content address of the pre-render identity of a proxy (the same inputs as the
--     operation's `inputHash`, less the Version-bound identifiers). It is nullable and application-written: a row written before this
--     column has none and is never carried (nothing is assumed about it).
--   * a carried operation uses the `reusedFrom*` columns that already exist for a reused proxy, and the approval the source review had is
--     re-bound to the new review by a decision of its own kind, `carry-over-approval`, beside the human `acknowledge-warnings` one.
ALTER TABLE "project_proxy_render_operations" ADD COLUMN "renderContentHash" CHAR(64);

CREATE INDEX "pp_render_ops_content_idx" ON "project_proxy_render_operations"("workspaceId", "projectId", "outputVariantId", "renderContentHash");

ALTER TABLE "proxy_review_decisions" DROP CONSTRAINT "proxy_review_decisions_action_check";
ALTER TABLE "proxy_review_decisions"
  ADD CONSTRAINT "proxy_review_decisions_action_check" CHECK ("action" IN ('acknowledge-warnings', 'carry-over-approval'));
