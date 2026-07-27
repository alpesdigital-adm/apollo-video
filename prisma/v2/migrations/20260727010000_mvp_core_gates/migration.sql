ALTER TABLE "projects"
  ADD COLUMN "duplicatedFromProjectId" VARCHAR(128);

ALTER TABLE "project_versions"
  ADD COLUMN "forkedFromProjectId" VARCHAR(128),
  ADD COLUMN "forkedFromVersionId" VARCHAR(128);

CREATE INDEX "projects_workspaceId_duplicatedFromProjectId_idx"
  ON "projects"("workspaceId", "duplicatedFromProjectId");

CREATE INDEX "project_versions_workspaceId_forkedFromProjectId_forkedFrom_idx"
  ON "project_versions"(
    "workspaceId",
    "forkedFromProjectId",
    "forkedFromVersionId"
  );

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_duplicatedFromProjectId_workspaceId_fkey"
  FOREIGN KEY ("duplicatedFromProjectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_versions"
  ADD CONSTRAINT "project_versions_fork_identity_check" CHECK (
    ("forkedFromProjectId" IS NULL AND "forkedFromVersionId" IS NULL)
    OR
    ("forkedFromProjectId" IS NOT NULL AND "forkedFromVersionId" IS NOT NULL)
  );

ALTER TABLE "project_versions"
  ADD CONSTRAINT "project_versions_forkedFromProjectId_workspaceId_fkey"
  FOREIGN KEY ("forkedFromProjectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_versions"
  ADD CONSTRAINT "project_versions_forkedFromVersionId_workspaceId_fkey"
  FOREIGN KEY ("forkedFromVersionId", "workspaceId")
  REFERENCES "project_versions"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "mvp_core_gates" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "primaryProjectId" VARCHAR(128) NOT NULL,
  "companionProjectId" VARCHAR(128) NOT NULL,
  "primaryVersionId" VARCHAR(128) NOT NULL,
  "companionVersionId" VARCHAR(128) NOT NULL,
  "primaryVersionHash" CHAR(64) NOT NULL,
  "companionVersionHash" CHAR(64) NOT NULL,
  "approved" BOOLEAN NOT NULL,
  "covered" INTEGER NOT NULL,
  "passed" INTEGER NOT NULL,
  "total" INTEGER NOT NULL,
  "reportJson" TEXT NOT NULL,
  "reportFingerprint" CHAR(64) NOT NULL,
  "recordHash" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "createdByType" VARCHAR(32) NOT NULL,
  "createdById" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "mvp_core_gates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mvp_core_gates_project_identity_check" CHECK (
    "primaryProjectId" <> "companionProjectId"
  ),
  CONSTRAINT "mvp_core_gates_hashes_check" CHECK (
    "primaryVersionHash" ~ '^[a-f0-9]{64}$'
    AND "companionVersionHash" ~ '^[a-f0-9]{64}$'
    AND "reportFingerprint" ~ '^[a-f0-9]{64}$'
    AND "recordHash" ~ '^[a-f0-9]{64}$'
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "mvp_core_gates_result_check" CHECK (
    "total" = 16
    AND "covered" BETWEEN 0 AND 16
    AND "passed" BETWEEN 0 AND "covered"
    AND (
      ("approved" = TRUE AND "covered" = 16 AND "passed" = 16)
      OR "approved" = FALSE
    )
  ),
  CONSTRAINT "mvp_core_gates_report_bounds_check" CHECK (
    length("reportJson") BETWEEN 2 AND 1000000
  ),
  CONSTRAINT "mvp_core_gates_actor_check" CHECK (
    "createdByType" = 'api-client'
  )
);

CREATE UNIQUE INDEX "mvp_core_gates_id_workspaceId_key"
  ON "mvp_core_gates"("id", "workspaceId");
CREATE UNIQUE INDEX "mvp_core_gates_workspaceId_primaryProjectId_idempotencyKey_key"
  ON "mvp_core_gates"("workspaceId", "primaryProjectId", "idempotencyKey");
CREATE INDEX "mvp_core_gates_workspaceId_primaryProjectId_createdAt_idx"
  ON "mvp_core_gates"("workspaceId", "primaryProjectId", "createdAt" DESC);
CREATE INDEX "mvp_core_gates_workspaceId_companionProjectId_createdAt_idx"
  ON "mvp_core_gates"("workspaceId", "companionProjectId", "createdAt" DESC);
CREATE INDEX "mvp_core_gates_workspaceId_approved_createdAt_idx"
  ON "mvp_core_gates"("workspaceId", "approved", "createdAt" DESC);
CREATE INDEX "mvp_core_gates_workspaceId_primaryVersionId_idx"
  ON "mvp_core_gates"("workspaceId", "primaryVersionId");
CREATE INDEX "mvp_core_gates_workspaceId_companionVersionId_idx"
  ON "mvp_core_gates"("workspaceId", "companionVersionId");

ALTER TABLE "mvp_core_gates"
  ADD CONSTRAINT "mvp_core_gates_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mvp_core_gates"
  ADD CONSTRAINT "mvp_core_gates_primaryProjectId_workspaceId_fkey"
  FOREIGN KEY ("primaryProjectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mvp_core_gates"
  ADD CONSTRAINT "mvp_core_gates_companionProjectId_workspaceId_fkey"
  FOREIGN KEY ("companionProjectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mvp_core_gates"
  ADD CONSTRAINT "mvp_core_gates_primaryVersionId_workspaceId_fkey"
  FOREIGN KEY ("primaryVersionId", "workspaceId")
  REFERENCES "project_versions"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mvp_core_gates"
  ADD CONSTRAINT "mvp_core_gates_companionVersionId_workspaceId_fkey"
  FOREIGN KEY ("companionVersionId", "workspaceId")
  REFERENCES "project_versions"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mvp_core_gates"
  ADD CONSTRAINT "mvp_core_gates_createdById_workspaceId_fkey"
  FOREIGN KEY ("createdById", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
