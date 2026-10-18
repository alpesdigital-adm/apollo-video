-- A proxy render or a final export is made for ONE output of the project: the stable variant its sealed consumption named at enqueue.
-- Until now a render operation carried only the aspect ratio, so a project with two outputs could not tell which operation
-- belongs to which output (impact, stale outputs, sidecars). The column is nullable and application-enforced: the composite FK
-- keeps a stated variant inside the operation's own project and workspace, and no row, trigger or constraint is touched.
ALTER TABLE "project_proxy_render_operations" ADD COLUMN "outputVariantId" VARCHAR(128);
ALTER TABLE "project_final_export_operations" ADD COLUMN "outputVariantId" VARCHAR(128);

ALTER TABLE "project_proxy_render_operations"
  ADD CONSTRAINT "project_proxy_render_operations_outputVariantId_projectId__fkey"
  FOREIGN KEY ("outputVariantId", "projectId", "workspaceId")
  REFERENCES "output_variants"("id", "projectId", "workspaceId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "project_final_export_operations"
  ADD CONSTRAINT "project_final_export_operations_outputVariantId_projectId__fkey"
  FOREIGN KEY ("outputVariantId", "projectId", "workspaceId")
  REFERENCES "output_variants"("id", "projectId", "workspaceId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "pp_render_ops_variant_idx" ON "project_proxy_render_operations"("workspaceId", "projectId", "outputVariantId");
CREATE INDEX "pf_export_ops_variant_idx" ON "project_final_export_operations"("workspaceId", "projectId", "outputVariantId");
