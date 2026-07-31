ALTER TABLE "project_proxy_render_operations"
ADD COLUMN "colorPipelineBindingsJson" TEXT NOT NULL;

ALTER TABLE "project_final_export_operations"
ADD COLUMN "colorPipelineBindingsJson" TEXT NOT NULL;
