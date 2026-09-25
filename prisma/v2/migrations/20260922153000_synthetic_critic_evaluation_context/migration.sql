ALTER TABLE "synthetic_critic_reports"
  ADD COLUMN "evaluationContextHash" CHAR(64);

DROP INDEX "synthetic_critic_reports_workspace_take_key";

CREATE UNIQUE INDEX "synthetic_critic_reports_workspace_context_key"
  ON "synthetic_critic_reports"("workspaceId", "evaluationContextHash");
