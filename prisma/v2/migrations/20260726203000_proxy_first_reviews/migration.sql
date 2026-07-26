CREATE TABLE "proxy_reviews" (
    "id" VARCHAR(128) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "projectId" VARCHAR(128) NOT NULL,
    "projectVersionId" VARCHAR(128) NOT NULL,
    "operationId" VARCHAR(128) NOT NULL,
    "proxyArtifactId" VARCHAR(128) NOT NULL,
    "proxyManifestId" VARCHAR(128) NOT NULL,
    "inputHash" CHAR(64) NOT NULL,
    "rangeCacheKey" CHAR(64) NOT NULL,
    "specJson" TEXT NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "technicalIssuesJson" TEXT NOT NULL,
    "criticIssuesJson" TEXT NOT NULL,
    "warningsAcknowledged" BOOLEAN NOT NULL DEFAULT false,
    "finalAllowed" BOOLEAN NOT NULL DEFAULT false,
    "reviewHash" CHAR(64) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "uploadReceivedAt" TIMESTAMPTZ(3) NOT NULL,
    "renderCompletedAt" TIMESTAMPTZ(3) NOT NULL,
    "timeToFirstProxyMs" BIGINT NOT NULL,
    "acknowledgedByType" VARCHAR(32),
    "acknowledgedById" VARCHAR(128),
    "acknowledgedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "proxy_reviews_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "proxy_reviews_status_check" CHECK ("status" IN ('blocked', 'warning-ack-required', 'ready-for-final')),
    CONSTRAINT "proxy_reviews_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "proxy_reviews_metric_check" CHECK ("timeToFirstProxyMs" >= 0 AND "renderCompletedAt" >= "uploadReceivedAt"),
    CONSTRAINT "proxy_reviews_authorization_check" CHECK (
        ("status" = 'blocked' AND "finalAllowed" = false) OR
        ("status" = 'warning-ack-required' AND "warningsAcknowledged" = false AND "finalAllowed" = false) OR
        ("status" = 'ready-for-final' AND "finalAllowed" = true)
    ),
    CONSTRAINT "proxy_reviews_acknowledgement_check" CHECK (
        ("warningsAcknowledged" = false AND "acknowledgedByType" IS NULL AND "acknowledgedById" IS NULL AND "acknowledgedAt" IS NULL) OR
        ("warningsAcknowledged" = true AND "acknowledgedByType" = 'api-client' AND "acknowledgedById" IS NOT NULL AND "acknowledgedAt" IS NOT NULL)
    )
);

CREATE TABLE "proxy_review_decisions" (
    "id" VARCHAR(128) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "projectId" VARCHAR(128) NOT NULL,
    "proxyReviewId" VARCHAR(128) NOT NULL,
    "action" VARCHAR(32) NOT NULL,
    "actorType" VARCHAR(32) NOT NULL,
    "actorId" VARCHAR(80) NOT NULL,
    "baseReviewHash" CHAR(64) NOT NULL,
    "resultReviewHash" CHAR(64) NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "requestFingerprint" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "proxy_review_decisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "proxy_review_decisions_action_check" CHECK ("action" = 'acknowledge-warnings'),
    CONSTRAINT "proxy_review_decisions_actor_type_check" CHECK ("actorType" = 'api-client')
);

CREATE UNIQUE INDEX "proxy_reviews_operationId_key" ON "proxy_reviews"("operationId");
CREATE UNIQUE INDEX "proxy_reviews_id_workspaceId_key" ON "proxy_reviews"("id", "workspaceId");
CREATE UNIQUE INDEX "proxy_reviews_operationId_workspaceId_key" ON "proxy_reviews"("operationId", "workspaceId");
CREATE UNIQUE INDEX "proxy_reviews_workspaceId_projectVersionId_inputHash_key" ON "proxy_reviews"("workspaceId", "projectVersionId", "inputHash");
CREATE INDEX "proxy_reviews_workspaceId_projectId_createdAt_idx" ON "proxy_reviews"("workspaceId", "projectId", "createdAt" DESC);
CREATE INDEX "proxy_reviews_workspaceId_projectVersionId_status_idx" ON "proxy_reviews"("workspaceId", "projectVersionId", "status");
CREATE INDEX "proxy_reviews_workspaceId_proxyArtifactId_idx" ON "proxy_reviews"("workspaceId", "proxyArtifactId");
CREATE INDEX "proxy_reviews_workspaceId_finalAllowed_updatedAt_idx" ON "proxy_reviews"("workspaceId", "finalAllowed", "updatedAt" DESC);

CREATE UNIQUE INDEX "proxy_review_decisions_id_workspaceId_key" ON "proxy_review_decisions"("id", "workspaceId");
CREATE UNIQUE INDEX "proxy_review_decisions_workspaceId_projectId_idempotencyKey_key" ON "proxy_review_decisions"("workspaceId", "projectId", "idempotencyKey");
CREATE INDEX "proxy_review_decisions_workspaceId_proxyReviewId_createdAt_idx" ON "proxy_review_decisions"("workspaceId", "proxyReviewId", "createdAt" DESC);
CREATE INDEX "proxy_review_decisions_workspaceId_actorId_createdAt_idx" ON "proxy_review_decisions"("workspaceId", "actorId", "createdAt" DESC);

ALTER TABLE "proxy_reviews" ADD CONSTRAINT "proxy_reviews_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proxy_reviews" ADD CONSTRAINT "proxy_reviews_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "proxy_reviews" ADD CONSTRAINT "proxy_reviews_projectVersionId_workspaceId_fkey" FOREIGN KEY ("projectVersionId", "workspaceId") REFERENCES "project_versions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proxy_reviews" ADD CONSTRAINT "proxy_reviews_operationId_workspaceId_fkey" FOREIGN KEY ("operationId", "workspaceId") REFERENCES "project_proxy_render_operations"("operationId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proxy_reviews" ADD CONSTRAINT "proxy_reviews_proxyArtifactId_workspaceId_fkey" FOREIGN KEY ("proxyArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proxy_reviews" ADD CONSTRAINT "proxy_reviews_proxyManifestId_workspaceId_fkey" FOREIGN KEY ("proxyManifestId", "workspaceId") REFERENCES "media_artifact_manifests"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "proxy_review_decisions" ADD CONSTRAINT "proxy_review_decisions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proxy_review_decisions" ADD CONSTRAINT "proxy_review_decisions_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "proxy_review_decisions" ADD CONSTRAINT "proxy_review_decisions_proxyReviewId_workspaceId_fkey" FOREIGN KEY ("proxyReviewId", "workspaceId") REFERENCES "proxy_reviews"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proxy_review_decisions" ADD CONSTRAINT "proxy_review_decisions_actorId_workspaceId_fkey" FOREIGN KEY ("actorId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
