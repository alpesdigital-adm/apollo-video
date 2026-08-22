ALTER TABLE "project_proxy_render_operations"
ADD COLUMN "colorPipelineBindingsJson" TEXT NOT NULL DEFAULT '[]';

ALTER TABLE "project_proxy_render_operations"
ALTER COLUMN "colorPipelineBindingsJson" DROP DEFAULT;

ALTER TABLE "project_final_export_operations"
ADD COLUMN "colorPipelineBindingsJson" TEXT NOT NULL DEFAULT '[]';

ALTER TABLE "project_final_export_operations"
ALTER COLUMN "colorPipelineBindingsJson" DROP DEFAULT;
