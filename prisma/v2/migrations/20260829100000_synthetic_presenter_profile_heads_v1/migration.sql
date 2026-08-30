CREATE TABLE "synthetic_presenter_profile_heads" (
  "workspaceId" VARCHAR(128) NOT NULL,
  "profileId" VARCHAR(128) NOT NULL,
  "currentVersion" INTEGER NOT NULL,
  "currentSnapshotId" VARCHAR(128) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "synthetic_presenter_profile_heads_pkey" PRIMARY KEY ("workspaceId", "profileId"),
  CONSTRAINT "synthetic_presenter_profile_heads_version_check" CHECK ("currentVersion" >= 1)
);

CREATE INDEX "synthetic_presenter_profile_heads_updated_idx"
  ON "synthetic_presenter_profile_heads"("workspaceId", "updatedAt" DESC);

ALTER TABLE "synthetic_presenter_profile_heads" ADD CONSTRAINT "synthetic_presenter_profile_heads_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_presenter_profile_heads" ADD CONSTRAINT "synthetic_presenter_profile_heads_currentSnapshotId_worksp_fkey"
  FOREIGN KEY ("currentSnapshotId", "workspaceId") REFERENCES "synthetic_presenter_profiles"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Every already persisted logical presenter gains its head, pointing at the
-- highest version that exists for it today.
INSERT INTO "synthetic_presenter_profile_heads"
  ("workspaceId", "profileId", "currentVersion", "currentSnapshotId", "createdAt", "updatedAt")
SELECT p."workspaceId", p."profileId", p."version", p."id", p."createdAt", p."createdAt"
FROM "synthetic_presenter_profiles" p
JOIN (
  SELECT "workspaceId", "profileId", max("version") AS latest
  FROM "synthetic_presenter_profiles"
  GROUP BY "workspaceId", "profileId"
) m ON m."workspaceId" = p."workspaceId" AND m."profileId" = p."profileId" AND m.latest = p."version";
