-- ADR-160 (F2). A Director run is planned from the policy resolution of the editorial request of its video, and says so in two additive columns:
--   * "policySnapshotId": the project snapshot (new kind 'policy-resolution') that holds the sealed resolution the run was planned and judged
--     against (a composite reference, like every other snapshot of a run);
--   * "requestHash": the SHA-256 of the editorial request the run answers, recomputed at admission from the Brief Snapshot of the Version.
-- Both are NULL on every run written before this migration, and stay NULL: such a run is never admitted to a final export (the admission
-- requires a v5 quality report bound to a request and a sealed resolution), so nothing is inherited and no row is rewritten.
-- The two are set together or not at all.

ALTER TABLE "project_snapshots"
  DROP CONSTRAINT "project_snapshots_kind_check";

ALTER TABLE "project_snapshots"
  ADD CONSTRAINT "project_snapshots_kind_check"
  CHECK ("kind" IN ('brief', 'perception', 'treatment', 'story', 'edit-plan', 'quality-report', 'policies', 'policy-resolution'));

ALTER TABLE "director_runs"
  ADD COLUMN "policySnapshotId" VARCHAR(128),
  ADD COLUMN "requestHash" CHAR(64);

ALTER TABLE "director_runs"
  ADD CONSTRAINT "director_runs_policySnapshotId_projectId_workspaceId_fkey"
    FOREIGN KEY ("policySnapshotId", "projectId", "workspaceId")
    REFERENCES "project_snapshots"("id", "projectId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "director_runs"
  ADD CONSTRAINT "director_runs_request_policy_pair_check"
  CHECK (("policySnapshotId" IS NULL) = ("requestHash" IS NULL));
