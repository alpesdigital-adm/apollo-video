ALTER TABLE "asset_use_decisions"
  ADD COLUMN "policySnapshotId" VARCHAR(128),
  ADD COLUMN "policySnapshotHash" CHAR(64);

UPDATE "asset_use_decisions" AS decision
SET
  "policySnapshotId" = rights.id,
  "policySnapshotHash" = rights."snapshotHash"
FROM "asset_rights_snapshots" AS rights
WHERE decision."rightsSnapshotId" = rights.id
  AND decision."workspaceId" = rights."workspaceId";

ALTER TABLE "asset_use_decisions"
  ADD CONSTRAINT "asset_use_decisions_policy_identity_check"
  CHECK (
    ("policySnapshotId" IS NULL AND "policySnapshotHash" IS NULL)
    OR
    ("policySnapshotId" IS NOT NULL AND "policySnapshotHash" ~ '^[a-f0-9]{64}$')
  );

ALTER TABLE "asset_use_decisions"
  ADD CONSTRAINT "asset_use_decisions_lut_media_rights_check"
  CHECK ("assetKind" <> 'lut' OR "rightsSnapshotId" IS NULL);

CREATE INDEX "asset_use_decisions_workspaceId_policySnapshotId_idx"
  ON "asset_use_decisions"("workspaceId", "policySnapshotId");
