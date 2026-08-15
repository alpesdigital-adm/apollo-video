ALTER TABLE "proxy_reviews" ADD COLUMN "outputSpecId" VARCHAR(128) NOT NULL DEFAULT 'preset-unknown';
ALTER TABLE "proxy_reviews" ALTER COLUMN "outputSpecId" DROP DEFAULT;
ALTER TABLE "proxy_reviews" ADD COLUMN "formatQualityJson" TEXT;
CREATE INDEX "proxy_reviews_workspaceId_projectVersionId_outputSpecId_fin_idx"
ON "proxy_reviews"("workspaceId", "projectVersionId", "outputSpecId", "finalAllowed");
