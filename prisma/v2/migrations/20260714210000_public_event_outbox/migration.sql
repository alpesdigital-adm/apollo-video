-- Persist public events atomically with the domain mutation that produced them.
CREATE TABLE "public_event_outbox" (
    "id" UUID NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "type" VARCHAR(96) NOT NULL,
    "version" VARCHAR(32) NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "sequence" INTEGER,
    "actorClientId" VARCHAR(128),
    "actorUserId" VARCHAR(128),
    "resourceType" VARCHAR(32) NOT NULL,
    "resourceId" VARCHAR(128) NOT NULL,
    "dataJson" TEXT NOT NULL,
    "publishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "public_event_outbox_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "public_event_outbox_type_check" CHECK (
      "type" ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$'
    ),
    CONSTRAINT "public_event_outbox_version_check" CHECK (
      "version" ~ '^[1-9][0-9]*\.[0-9]+\.[0-9]+$'
    ),
    CONSTRAINT "public_event_outbox_sequence_check" CHECK (
      "sequence" IS NULL OR "sequence" > 0
    ),
    CONSTRAINT "public_event_outbox_actor_check" CHECK (
      ("actorClientId" IS NULL OR "actorClientId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$')
      AND ("actorUserId" IS NULL OR "actorUserId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$')
    ),
    CONSTRAINT "public_event_outbox_resource_check" CHECK (
      "resourceType" IN (
        'project', 'project-version', 'operation', 'annotation', 'quality-report',
        'approval', 'media-artifact', 'workspace', 'api-client'
      )
      AND "resourceId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
    ),
    CONSTRAINT "public_event_outbox_data_check" CHECK (
      octet_length("dataJson") <= 65536
      AND jsonb_typeof("dataJson"::jsonb) = 'object'
    ),
    CONSTRAINT "public_event_outbox_dates_check" CHECK (
      "publishedAt" IS NULL OR "publishedAt" >= "occurredAt"
    )
);

CREATE UNIQUE INDEX "public_event_outbox_id_workspaceId_key"
ON "public_event_outbox"("id", "workspaceId");

CREATE INDEX "public_event_outbox_publishedAt_occurredAt_id_idx"
ON "public_event_outbox"("publishedAt", "occurredAt", "id");

CREATE INDEX "public_event_outbox_workspaceId_occurredAt_id_idx"
ON "public_event_outbox"("workspaceId", "occurredAt" ASC, "id" ASC);

CREATE INDEX "public_event_outbox_workspaceId_resourceType_resourceId_occ_idx"
ON "public_event_outbox"("workspaceId", "resourceType", "resourceId", "occurredAt" ASC);

ALTER TABLE "public_event_outbox"
ADD CONSTRAINT "public_event_outbox_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
