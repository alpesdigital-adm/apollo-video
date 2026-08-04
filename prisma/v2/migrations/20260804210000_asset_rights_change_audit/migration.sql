CREATE TABLE "asset_rights_changes" (
    "id" VARCHAR(80) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "artifactId" VARCHAR(128) NOT NULL,
    "sequence" INTEGER NOT NULL,
    "snapshotId" VARCHAR(128) NOT NULL,
    "snapshotHash" CHAR(64) NOT NULL,
    "baseRevision" CHAR(64) NOT NULL,
    "resultRevision" CHAR(64) NOT NULL,
    "actorKind" VARCHAR(16) NOT NULL,
    "actorType" VARCHAR(32) NOT NULL,
    "actorId" VARCHAR(128) NOT NULL,
    "actorClientId" VARCHAR(80),
    "actorCredentialId" VARCHAR(80),
    "actorEnvironment" VARCHAR(16),
    "actorAuthenticationKind" VARCHAR(16),
    "actorDelegatedUserId" VARCHAR(128),
    "actorDelegatedIdentityId" VARCHAR(128),
    "actorWorkspaceRole" VARCHAR(32),
    "actorContextHash" CHAR(64),
    "requestFingerprint" CHAR(64) NOT NULL,
    "changedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "asset_rights_changes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "asset_rights_changes_sequence_check" CHECK ("sequence" >= 1),
    CONSTRAINT "asset_rights_changes_hashes_check" CHECK (
      "snapshotHash" ~ '^[a-f0-9]{64}$' AND
      "baseRevision" ~ '^[a-f0-9]{64}$' AND
      "resultRevision" ~ '^[a-f0-9]{64}$' AND
      "requestFingerprint" ~ '^[a-f0-9]{64}$'
    ),
    CONSTRAINT "asset_rights_changes_actor_check" CHECK (
      (
        "actorKind" = 'external' AND "actorType" = 'api-client' AND
        "actorClientId" = "actorId" AND "actorCredentialId" IS NOT NULL AND
        "actorEnvironment" IN ('sandbox', 'production') AND
        "actorAuthenticationKind" IN ('bearer', 'ui-session') AND
        "actorContextHash" ~ '^[a-f0-9]{64}$' AND
        (
          ("actorAuthenticationKind" = 'bearer' AND
            "actorDelegatedUserId" IS NULL AND "actorDelegatedIdentityId" IS NULL AND
            "actorWorkspaceRole" IS NULL) OR
          ("actorAuthenticationKind" = 'ui-session' AND
            "actorDelegatedUserId" IS NOT NULL AND "actorDelegatedIdentityId" IS NOT NULL AND
            "actorWorkspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
        )
      ) OR (
        "actorKind" = 'internal' AND "actorType" IN ('api-client', 'user', 'system') AND
        "actorClientId" IS NULL AND "actorCredentialId" IS NULL AND
        "actorEnvironment" IS NULL AND "actorAuthenticationKind" IS NULL AND
        "actorDelegatedUserId" IS NULL AND "actorDelegatedIdentityId" IS NULL AND
        "actorWorkspaceRole" IS NULL AND "actorContextHash" IS NULL
      )
    )
);

CREATE UNIQUE INDEX "asset_rights_changes_id_workspaceId_key"
  ON "asset_rights_changes"("id", "workspaceId");
CREATE UNIQUE INDEX "asset_rights_changes_artifactId_sequence_key"
  ON "asset_rights_changes"("artifactId", "sequence");
CREATE INDEX "asset_rights_changes_workspaceId_artifactId_changedAt_idx"
  ON "asset_rights_changes"("workspaceId", "artifactId", "changedAt" DESC);
CREATE INDEX "asset_rights_changes_workspaceId_actorClientId_changedAt_idx"
  ON "asset_rights_changes"("workspaceId", "actorClientId", "changedAt" DESC);

ALTER TABLE "asset_rights_changes"
  ADD CONSTRAINT "asset_rights_changes_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "asset_rights_changes"
  ADD CONSTRAINT "asset_rights_changes_artifactId_workspaceId_fkey"
  FOREIGN KEY ("artifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "asset_rights_changes"
  ADD CONSTRAINT "asset_rights_changes_snapshotId_workspaceId_fkey"
  FOREIGN KEY ("snapshotId", "workspaceId") REFERENCES "asset_rights_snapshots"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "asset_rights_changes"
  ADD CONSTRAINT "asset_rights_changes_actorClientId_workspaceId_fkey"
  FOREIGN KEY ("actorClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
