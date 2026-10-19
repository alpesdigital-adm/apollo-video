-- W63a: the server-owned perception snapshot of one ProjectVersion (server-perception-snapshot/v1).
-- Additive: no existing table changes. The snapshot is content-addressed (its id and uniqueness come from its SHA-256) and, once
-- written, never updated or deleted; its coverage per kind is also constrained here, so a database that holds a snapshot cannot
-- hold one that calls an unexamined kind complete, leaves an absent kind without a reason, or fills `object`.

-- CreateTable
CREATE TABLE "server_perception_snapshots" (
    "id" VARCHAR(128) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "projectId" VARCHAR(128) NOT NULL,
    "projectVersionId" VARCHAR(128) NOT NULL,
    "editPlanSnapshotId" VARCHAR(128) NOT NULL,
    "editPlanSnapshotHash" CHAR(64) NOT NULL,
    "durationFrames" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "schemaVersion" VARCHAR(64) NOT NULL,
    "snapshotJson" TEXT NOT NULL,
    "snapshotHash" CHAR(64) NOT NULL,
    "timelineHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "server_perception_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_perception_snapshot_coverage" (
    "snapshotId" VARCHAR(128) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "state" VARCHAR(8) NOT NULL,
    "observedMs" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "observationCount" INTEGER NOT NULL,
    "reasonCode" VARCHAR(64),

    CONSTRAINT "server_perception_snapshot_coverage_pkey" PRIMARY KEY ("snapshotId","kind")
);

-- CreateIndex
CREATE INDEX "server_perception_snapshots_workspaceId_projectId_projectVe_idx" ON "server_perception_snapshots"("workspaceId", "projectId", "projectVersionId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "server_perception_snapshots_id_workspaceId_key" ON "server_perception_snapshots"("id", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "server_perception_snapshots_id_workspaceId_durationMs_key" ON "server_perception_snapshots"("id", "workspaceId", "durationMs");

-- CreateIndex
CREATE UNIQUE INDEX "server_perception_snapshots_workspaceId_projectVersionId_sn_key" ON "server_perception_snapshots"("workspaceId", "projectVersionId", "snapshotHash");

-- CreateIndex
CREATE INDEX "server_perception_snapshot_coverage_workspaceId_snapshotId_idx" ON "server_perception_snapshot_coverage"("workspaceId", "snapshotId");

-- AddForeignKey
ALTER TABLE "server_perception_snapshots" ADD CONSTRAINT "server_perception_snapshots_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_perception_snapshots" ADD CONSTRAINT "server_perception_snapshots_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_perception_snapshots" ADD CONSTRAINT "server_perception_snapshots_projectVersionId_projectId_wor_fkey" FOREIGN KEY ("projectVersionId", "projectId", "workspaceId") REFERENCES "project_versions"("id", "projectId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_perception_snapshots" ADD CONSTRAINT "server_perception_snapshots_editPlanSnapshotId_projectId_w_fkey" FOREIGN KEY ("editPlanSnapshotId", "projectId", "workspaceId") REFERENCES "project_snapshots"("id", "projectId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_perception_snapshot_coverage" ADD CONSTRAINT "server_perception_snapshot_coverage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_perception_snapshot_coverage" ADD CONSTRAINT "server_perception_snapshot_coverage_snapshotId_workspaceId_fkey" FOREIGN KEY ("snapshotId", "workspaceId", "durationMs") REFERENCES "server_perception_snapshots"("id", "workspaceId", "durationMs") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The id IS the content address: it is derived from the snapshot's SHA-256, so two different snapshots can never share it.
ALTER TABLE "server_perception_snapshots"
  ADD CONSTRAINT "server_perception_snapshots_shape_check" CHECK (
    "schemaVersion" = 'server-perception-snapshot/v1'
    AND "durationFrames" > 0
    AND "durationMs" > 0
    AND "id" = 'perception-snapshot-' || substr("snapshotHash", 1, 40)
  );

-- Coverage per kind. `absent` examined nothing and says why; `complete` examined the whole duration and needs no reason; `partial`
-- examined something but not everything. A kind with no producer bound to a version can only be absent, and `object` can only be
-- absent for lack of a verified detector.
ALTER TABLE "server_perception_snapshot_coverage"
  ADD CONSTRAINT "server_perception_snapshot_coverage_kind_check" CHECK (
    "kind" IN ('transcript-word', 'speaker', 'silence', 'face', 'object', 'shot', 'motion', 'ocr', 'image-insert')
  ),
  ADD CONSTRAINT "server_perception_snapshot_coverage_bounds_check" CHECK (
    "observedMs" >= 0 AND "observedMs" <= "durationMs" AND "durationMs" > 0 AND "observationCount" >= 0
  ),
  ADD CONSTRAINT "server_perception_snapshot_coverage_reason_check" CHECK (
    "reasonCode" IS NULL OR "reasonCode" ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  ADD CONSTRAINT "server_perception_snapshot_coverage_state_check" CHECK (
    ("state" = 'absent' AND "observedMs" = 0 AND "observationCount" = 0 AND "reasonCode" IS NOT NULL)
    OR ("state" = 'partial' AND "observedMs" > 0 AND "observedMs" < "durationMs")
    OR ("state" = 'complete' AND "observedMs" = "durationMs" AND "reasonCode" IS NULL)
  ),
  ADD CONSTRAINT "server_perception_snapshot_coverage_object_check" CHECK (
    "kind" <> 'object'
    OR ("state" = 'absent' AND "reasonCode" = 'NO_VERIFIED_DETECTOR' AND "observationCount" = 0)
  ),
  ADD CONSTRAINT "server_perception_snapshot_coverage_unproduced_check" CHECK (
    "kind" NOT IN ('speaker', 'silence', 'image-insert')
    OR ("state" = 'absent' AND "observationCount" = 0)
  );

-- A snapshot is written once and read forever: no UPDATE, no DELETE, on either table.
CREATE FUNCTION server_perception_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'W63a immutable record: % %', TG_TABLE_NAME, TG_OP USING ERRCODE = '23514';
END $$;
CREATE TRIGGER server_perception_snapshots_immutable BEFORE UPDATE OR DELETE ON "server_perception_snapshots"
  FOR EACH ROW EXECUTE FUNCTION server_perception_snapshot_immutable();
CREATE TRIGGER server_perception_snapshot_coverage_immutable BEFORE UPDATE OR DELETE ON "server_perception_snapshot_coverage"
  FOR EACH ROW EXECUTE FUNCTION server_perception_snapshot_immutable();

-- Every snapshot declares all nine kinds exactly once. Checked at COMMIT: the snapshot and its nine rows are written together.
CREATE FUNCTION server_perception_snapshot_nine_kinds() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(DISTINCT c."kind") FROM "server_perception_snapshot_coverage" c
      WHERE c."snapshotId" = NEW."id" AND c."workspaceId" = NEW."workspaceId") <> 9 THEN
    RAISE EXCEPTION 'W63a a perception snapshot must declare all nine kinds' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER server_perception_snapshots_nine_kinds AFTER INSERT ON "server_perception_snapshots"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION server_perception_snapshot_nine_kinds();
