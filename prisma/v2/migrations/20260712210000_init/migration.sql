-- CreateTable
CREATE TABLE "workspaces" (
    "id" VARCHAR(128) NOT NULL,
    "slug" VARCHAR(63) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workspaces_status_check" CHECK ("status" IN ('active', 'suspended', 'archived'))
);

-- CreateTable
CREATE TABLE "api_clients" (
    "id" VARCHAR(80) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'active',
    "environment" VARCHAR(32) NOT NULL DEFAULT 'sandbox',
    "scopesJson" TEXT NOT NULL,
    "secretSalt" VARCHAR(128) NOT NULL,
    "secretHash" VARCHAR(128) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastUsedAt" TIMESTAMPTZ(3),
    CONSTRAINT "api_clients_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "api_clients_status_check" CHECK ("status" IN ('active', 'suspended', 'revoked')),
    CONSTRAINT "api_clients_environment_check" CHECK ("environment" IN ('sandbox', 'production')),
    CONSTRAINT "api_clients_scopes_json_check" CHECK (jsonb_typeof("scopesJson"::jsonb) = 'array')
);

-- CreateTable
CREATE TABLE "projects" (
    "id" VARCHAR(128) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'draft',
    "currentVersionId" VARCHAR(128),
    "createdByType" VARCHAR(32) NOT NULL,
    "createdById" VARCHAR(128) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "projects_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "projects_status_check" CHECK (
      "status" IN (
        'draft', 'ingesting', 'perceiving', 'planning', 'generating',
        'reviewing-assets', 'rendering-proxy', 'reviewing-proxy', 'revising',
        'rendering-final', 'completed', 'failed', 'canceled', 'archived'
      )
    ),
    CONSTRAINT "projects_creator_type_check" CHECK ("createdByType" IN ('user', 'director', 'system', 'api-client'))
);

-- CreateTable
CREATE TABLE "project_snapshots" (
    "id" VARCHAR(128) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "projectId" VARCHAR(128) NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "contentJson" TEXT NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_snapshots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "project_snapshots_kind_check" CHECK ("kind" IN ('edit-plan', 'policies')),
    CONSTRAINT "project_snapshots_schema_version_check" CHECK ("schemaVersion" > 0),
    CONSTRAINT "project_snapshots_content_json_check" CHECK ("contentJson"::jsonb IS NOT NULL),
    CONSTRAINT "project_snapshots_hash_check" CHECK ("contentHash" ~ '^[a-f0-9]{64}$')
);

-- CreateTable
CREATE TABLE "project_versions" (
    "id" VARCHAR(128) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "projectId" VARCHAR(128) NOT NULL,
    "sequence" INTEGER NOT NULL,
    "parentVersionId" VARCHAR(128),
    "editPlanSnapshotId" VARCHAR(128) NOT NULL,
    "policiesSnapshotId" VARCHAR(128) NOT NULL,
    "baseHash" CHAR(64) NOT NULL,
    "createdBy" VARCHAR(128) NOT NULL,
    "commandId" VARCHAR(128),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "project_versions_sequence_check" CHECK ("sequence" > 0),
    CONSTRAINT "project_versions_hash_check" CHECK ("baseHash" ~ '^[a-f0-9]{64}$')
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" VARCHAR(128) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "clientId" VARCHAR(80) NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "requestFingerprint" CHAR(64) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "responseStatus" INTEGER,
    "responseJson" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "idempotency_records_status_check" CHECK ("status" IN ('processing', 'completed', 'failed-retryable', 'failed-final')),
    CONSTRAINT "idempotency_records_fingerprint_check" CHECK ("requestFingerprint" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "idempotency_records_response_status_check" CHECK ("responseStatus" IS NULL OR "responseStatus" BETWEEN 100 AND 599),
    CONSTRAINT "idempotency_records_response_json_check" CHECK ("responseJson" IS NULL OR "responseJson"::jsonb IS NOT NULL)
);

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");
CREATE INDEX "api_clients_workspaceId_status_idx" ON "api_clients"("workspaceId", "status");
CREATE INDEX "projects_workspaceId_createdAt_idx" ON "projects"("workspaceId", "createdAt" DESC);
CREATE INDEX "projects_workspaceId_status_idx" ON "projects"("workspaceId", "status");
CREATE UNIQUE INDEX "projects_id_workspaceId_key" ON "projects"("id", "workspaceId");
CREATE INDEX "project_snapshots_workspaceId_kind_idx" ON "project_snapshots"("workspaceId", "kind");
CREATE UNIQUE INDEX "project_snapshots_projectId_kind_contentHash_key" ON "project_snapshots"("projectId", "kind", "contentHash");
CREATE INDEX "project_versions_workspaceId_createdAt_idx" ON "project_versions"("workspaceId", "createdAt" DESC);
CREATE UNIQUE INDEX "project_versions_projectId_sequence_key" ON "project_versions"("projectId", "sequence");
CREATE UNIQUE INDEX "project_versions_id_workspaceId_key" ON "project_versions"("id", "workspaceId");
CREATE INDEX "idempotency_records_expiresAt_idx" ON "idempotency_records"("expiresAt");
CREATE UNIQUE INDEX "idempotency_records_workspaceId_clientId_key_key" ON "idempotency_records"("workspaceId", "clientId", "key");

-- AddForeignKey
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_snapshots" ADD CONSTRAINT "project_snapshots_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_snapshots" ADD CONSTRAINT "project_snapshots_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_versions" ADD CONSTRAINT "project_versions_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_versions" ADD CONSTRAINT "project_versions_parentVersionId_fkey" FOREIGN KEY ("parentVersionId") REFERENCES "project_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "project_versions" ADD CONSTRAINT "project_versions_editPlanSnapshotId_fkey" FOREIGN KEY ("editPlanSnapshotId") REFERENCES "project_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_versions" ADD CONSTRAINT "project_versions_policiesSnapshotId_fkey" FOREIGN KEY ("policiesSnapshotId") REFERENCES "project_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "projects" ADD CONSTRAINT "projects_currentVersionId_workspaceId_fkey" FOREIGN KEY ("currentVersionId", "workspaceId") REFERENCES "project_versions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
