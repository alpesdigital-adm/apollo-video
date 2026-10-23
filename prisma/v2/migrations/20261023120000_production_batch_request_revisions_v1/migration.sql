-- ADR-160 F8. The editorial request of a production batch can be answered and changed after the batch exists.
-- The batch document is immutable (its definition hash covers the request it was created with), so every later request is a row here, and the
-- table is append-only: the current request of a batch is its highest revision, or the request it was created with when there is none.
CREATE TABLE "production_batch_request_revisions" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "batchId" VARCHAR(128) NOT NULL,
  "sequence" INTEGER NOT NULL,
  "previousRequestHash" CHAR(64),
  "requestHash" CHAR(64) NOT NULL,
  "briefingJson" TEXT NOT NULL,
  "changeJson" TEXT NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "actorClientId" VARCHAR(80) NOT NULL,
  "actorCredentialId" VARCHAR(128),
  "actorEnvironment" VARCHAR(16),
  "actorAuthenticationKind" VARCHAR(16),
  "actorContextHash" CHAR(64),
  "delegatedUserId" VARCHAR(128),
  "delegatedIdentityId" VARCHAR(128),
  "workspaceRole" VARCHAR(32),
  "createdAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "production_batch_request_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "production_batch_request_revisions_bounds_check" CHECK (
    "sequence" BETWEEN 1 AND 100000
    AND ("previousRequestHash" IS NULL OR "previousRequestHash" ~ '^[a-f0-9]{64}$')
    AND "requestHash" ~ '^[a-f0-9]{64}$'
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
    AND "requestHash" IS DISTINCT FROM "previousRequestHash"
    AND length("briefingJson") BETWEEN 2 AND 1000000
    AND length("changeJson") BETWEEN 2 AND 100000
  )
);

CREATE UNIQUE INDEX "production_batch_request_revisions_batch_sequence_key"
  ON "production_batch_request_revisions"("workspaceId", "batchId", "sequence");
CREATE UNIQUE INDEX "production_batch_request_revisions_idempotency_key"
  ON "production_batch_request_revisions"("workspaceId", "actorClientId", "idempotencyKey");

ALTER TABLE "production_batch_request_revisions"
  ADD CONSTRAINT "production_batch_request_revisions_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_batch_request_revisions"
  ADD CONSTRAINT "production_batch_request_revisions_batchId_workspaceId_fkey"
  FOREIGN KEY ("batchId", "workspaceId")
  REFERENCES "production_batches"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "production_batch_request_revisions"
  ADD CONSTRAINT "production_batch_request_revisions_actorClientId_workspace_fkey"
  FOREIGN KEY ("actorClientId", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION production_batch_request_revisions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'A revision of the request of a production batch is never changed: % %', TG_TABLE_NAME, TG_OP USING ERRCODE = '23514';
END $$;
CREATE TRIGGER production_batch_request_revisions_immutable
  BEFORE UPDATE OR DELETE ON "production_batch_request_revisions"
  FOR EACH ROW EXECUTE FUNCTION production_batch_request_revisions_append_only();
