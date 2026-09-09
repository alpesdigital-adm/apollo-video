ALTER TABLE "project_proxy_render_operations"
  ADD COLUMN "renderablePlanHash" CHAR(64),
  ADD COLUMN "renderablePlanId" VARCHAR(200),
  ADD COLUMN "renderableOrigin" VARCHAR(32),
  ADD COLUMN "renderableSourceId" VARCHAR(160),
  ADD COLUMN "renderableSourceHash" CHAR(64),
  ADD COLUMN "renderableVariantId" VARCHAR(160),
  ADD COLUMN "renderableFormat" VARCHAR(16);

ALTER TABLE "project_proxy_render_operations"
  ADD CONSTRAINT "project_proxy_render_operations_workspaceId_renderablePlan_fkey"
  FOREIGN KEY ("workspaceId", "renderablePlanHash")
  REFERENCES "renderable_plan_snapshots"("workspaceId", "planHash")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_proxy_render_operations"
  ADD CONSTRAINT "project_proxy_render_operations_source_authority_check"
  CHECK (
    ("renderablePlanHash" IS NULL AND "renderablePlanId" IS NULL)
    OR
    ("renderablePlanHash" IS NOT NULL AND "renderablePlanId" IS NOT NULL
      AND "renderableOrigin" IS NOT NULL AND "renderableSourceId" IS NOT NULL
      AND "renderableSourceHash" IS NOT NULL AND "renderableVariantId" IS NOT NULL
      AND "renderableFormat" IS NOT NULL)
  );
