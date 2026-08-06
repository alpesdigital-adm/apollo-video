ALTER TABLE "projects"
  ADD COLUMN "administrationRevision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "archivedFromStatus" VARCHAR(32);

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_administration_revision_check"
    CHECK ("administrationRevision" >= 1),
  ADD CONSTRAINT "projects_archived_source_check"
    CHECK (
      ("status" = 'archived' AND
        ("archivedFromStatus" IS NULL OR "archivedFromStatus" IN (
          'draft', 'completed', 'failed', 'canceled'
        ))) OR
      ("status" <> 'archived' AND "archivedFromStatus" IS NULL)
    );

CREATE TABLE "project_administration_commands" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "action" VARCHAR(16) NOT NULL,
  "beforeName" VARCHAR(120) NOT NULL,
  "afterName" VARCHAR(120) NOT NULL,
  "beforeStatus" VARCHAR(32) NOT NULL,
  "afterStatus" VARCHAR(32) NOT NULL,
  "beforeArchivedFromStatus" VARCHAR(32),
  "afterArchivedFromStatus" VARCHAR(32),
  "baseRevision" INTEGER NOT NULL,
  "resultRevision" INTEGER NOT NULL,
  "confirmation" VARCHAR(16) NOT NULL,
  "actorClientId" VARCHAR(80) NOT NULL,
  "actorCredentialId" VARCHAR(128) NOT NULL,
  "actorEnvironment" VARCHAR(16) NOT NULL,
  "actorAuthenticationKind" VARCHAR(16) NOT NULL,
  "actorContextHash" CHAR(64) NOT NULL,
  "delegatedUserId" VARCHAR(128),
  "delegatedIdentityId" VARCHAR(128),
  "workspaceRole" VARCHAR(32),
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "resultHash" CHAR(64) NOT NULL,
  "commandHash" CHAR(64) NOT NULL,
  "eventId" UUID NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "project_administration_commands_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_administration_commands_action_check"
    CHECK ("action" IN ('rename', 'archive', 'restore')),
  CONSTRAINT "project_administration_commands_name_check"
    CHECK (
      CHAR_LENGTH(BTRIM("beforeName")) BETWEEN 1 AND 120 AND
      CHAR_LENGTH(BTRIM("afterName")) BETWEEN 1 AND 120
    ),
  CONSTRAINT "project_administration_commands_status_check"
    CHECK (
      "beforeStatus" IN (
        'draft', 'ingesting', 'perceiving', 'planning', 'generating',
        'reviewing-assets', 'rendering-proxy', 'reviewing-proxy', 'revising',
        'rendering-final', 'completed', 'failed', 'canceled', 'archived'
      ) AND
      "afterStatus" IN (
        'draft', 'ingesting', 'perceiving', 'planning', 'generating',
        'reviewing-assets', 'rendering-proxy', 'reviewing-proxy', 'revising',
        'rendering-final', 'completed', 'failed', 'canceled', 'archived'
      ) AND
      ("beforeArchivedFromStatus" IS NULL OR "beforeArchivedFromStatus" IN (
        'draft', 'completed', 'failed', 'canceled'
      )) AND
      ("afterArchivedFromStatus" IS NULL OR "afterArchivedFromStatus" IN (
        'draft', 'completed', 'failed', 'canceled'
      ))
    ),
  CONSTRAINT "project_administration_commands_revision_check"
    CHECK ("baseRevision" >= 1 AND "resultRevision" = "baseRevision" + 1),
  CONSTRAINT "project_administration_commands_confirmation_check"
    CHECK (
      ("action" = 'archive' AND "confirmation" = 'explicit') OR
      ("action" <> 'archive' AND "confirmation" = 'not-required')
    ),
  CONSTRAINT "project_administration_commands_actor_check"
    CHECK (
      "actorEnvironment" IN ('sandbox', 'production') AND
      "actorAuthenticationKind" IN ('bearer', 'ui-session') AND
      (
        ("delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
          "workspaceRole" IS NULL) OR
        ("delegatedUserId" IS NOT NULL AND "delegatedIdentityId" IS NOT NULL AND
          "workspaceRole" IS NOT NULL)
      )
    ),
  CONSTRAINT "project_administration_commands_hash_check"
    CHECK (
      "actorContextHash" ~ '^[a-f0-9]{64}$' AND
      "requestFingerprint" ~ '^[a-f0-9]{64}$' AND
      "resultHash" ~ '^[a-f0-9]{64}$' AND
      "commandHash" ~ '^[a-f0-9]{64}$' AND
      CHAR_LENGTH("idempotencyKey") BETWEEN 8 AND 128
    ),
  CONSTRAINT "project_administration_commands_transition_check"
    CHECK (
      ("action" = 'rename' AND "beforeName" <> "afterName" AND
        "beforeStatus" = "afterStatus" AND
        "beforeArchivedFromStatus" IS NOT DISTINCT FROM "afterArchivedFromStatus") OR
      ("action" = 'archive' AND "beforeName" = "afterName" AND
        "beforeStatus" IN ('draft', 'completed', 'failed', 'canceled') AND
        "afterStatus" = 'archived' AND
        "afterArchivedFromStatus" = "beforeStatus") OR
      ("action" = 'restore' AND "beforeName" = "afterName" AND
        "beforeStatus" = 'archived' AND "beforeArchivedFromStatus" IS NOT NULL AND
        "afterStatus" = "beforeArchivedFromStatus" AND
        "afterArchivedFromStatus" IS NULL)
    )
);

CREATE UNIQUE INDEX "project_administration_commands_id_workspaceId_key"
  ON "project_administration_commands"("id", "workspaceId");
CREATE UNIQUE INDEX "project_administration_commands_eventId_key"
  ON "project_administration_commands"("eventId");
CREATE UNIQUE INDEX "project_administration_commands_eventId_workspaceId_key"
  ON "project_administration_commands"("eventId", "workspaceId");
CREATE UNIQUE INDEX "project_administration_commands_workspaceId_actorContextHas_key"
  ON "project_administration_commands"("workspaceId", "actorContextHash", "idempotencyKey");
CREATE UNIQUE INDEX "project_administration_commands_projectId_resultRevision_key"
  ON "project_administration_commands"("projectId", "resultRevision");
CREATE INDEX "project_administration_commands_workspaceId_projectId_occur_idx"
  ON "project_administration_commands"("workspaceId", "projectId", "occurredAt" DESC);
CREATE INDEX "project_administration_commands_workspaceId_actorContextHas_idx"
  ON "project_administration_commands"("workspaceId", "actorContextHash", "occurredAt" DESC);

ALTER TABLE "project_administration_commands"
  ADD CONSTRAINT "project_administration_commands_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_administration_commands_projectId_workspaceId_fkey"
    FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_administration_commands_actorClientId_workspaceId_fkey"
    FOREIGN KEY ("actorClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_administration_commands_eventId_workspaceId_fkey"
    FOREIGN KEY ("eventId", "workspaceId") REFERENCES "public_event_outbox"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
