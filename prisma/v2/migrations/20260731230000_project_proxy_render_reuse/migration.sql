ALTER TABLE "project_proxy_render_operations"
ADD COLUMN "reusedFromOperationId" VARCHAR(128);

ALTER TABLE "project_proxy_render_operations"
ADD COLUMN "reuseCommandId" VARCHAR(128),
ADD COLUMN "reuseImpactHash" CHAR(64),
ADD COLUMN "reuseBaseVersionId" VARCHAR(128);

CREATE INDEX "project_proxy_render_operations_workspaceId_reusedFromOpera_idx"
ON "project_proxy_render_operations"("workspaceId", "reusedFromOperationId");

ALTER TABLE "project_proxy_render_operations"
ADD CONSTRAINT "project_proxy_render_operations_reusedFromOperationId_work_fkey"
FOREIGN KEY ("reusedFromOperationId", "workspaceId")
REFERENCES "project_proxy_render_operations"("operationId", "workspaceId")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_proxy_render_operations"
ADD CONSTRAINT "project_proxy_render_operations_reuseCommandId_workspaceId_fkey"
FOREIGN KEY ("reuseCommandId", "workspaceId")
REFERENCES "edit_commands"("id", "workspaceId")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_proxy_render_operations"
ADD CONSTRAINT "project_proxy_render_operations_reuseBaseVersionId_workspa_fkey"
FOREIGN KEY ("reuseBaseVersionId", "workspaceId")
REFERENCES "project_versions"("id", "workspaceId")
ON DELETE RESTRICT ON UPDATE CASCADE;
