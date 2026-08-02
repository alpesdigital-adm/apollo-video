CREATE TABLE "human_identities" (
  "id" UUID NOT NULL,
  "issuer" VARCHAR(512) NOT NULL,
  "subjectHash" CHAR(64) NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "human_identities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "human_identities_status_check" CHECK ("status" IN ('active', 'suspended')),
  CONSTRAINT "human_identities_subject_hash_check" CHECK ("subjectHash" ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX "human_identities_issuer_subjectHash_key" ON "human_identities"("issuer", "subjectHash");
CREATE INDEX "human_identities_status_idx" ON "human_identities"("status");

CREATE TABLE "workspace_members" (
  "id" UUID NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "identityId" UUID NOT NULL,
  "role" VARCHAR(32) NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workspace_members_role_check" CHECK ("role" IN ('administrator', 'director', 'operator', 'reviewer')),
  CONSTRAINT "workspace_members_status_check" CHECK ("status" IN ('active', 'suspended', 'removed'))
);

CREATE UNIQUE INDEX "workspace_members_workspaceId_identityId_key" ON "workspace_members"("workspaceId", "identityId");
CREATE UNIQUE INDEX "workspace_members_id_workspaceId_key" ON "workspace_members"("id", "workspaceId");
CREATE INDEX "workspace_members_workspaceId_status_role_idx" ON "workspace_members"("workspaceId", "status", "role");
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_identityId_fkey"
  FOREIGN KEY ("identityId") REFERENCES "human_identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ui_sessions" ADD COLUMN "memberId" UUID NOT NULL;
CREATE INDEX "ui_sessions_memberId_expiresAt_idx" ON "ui_sessions"("memberId", "expiresAt");
ALTER TABLE "ui_sessions" ADD CONSTRAINT "ui_sessions_memberId_workspaceId_fkey"
  FOREIGN KEY ("memberId", "workspaceId") REFERENCES "workspace_members"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
