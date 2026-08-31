-- Synthetic critic reports: the immutable, content-addressed verdict on one
-- take of one block.
--
-- Shape, and why. The canonical aggregate lives in "reportJson" because the
-- report hash is calculated over the whole body: rehydration recomputes that
-- hash, so the blob is the only thing that can prove the report was not edited
-- behind the application. The measurements, the evaluators and the issues are
-- ALSO written as rows, in the same transaction, for two reasons a JSON column
-- cannot give:
--   * they can be queried by dimension and by block through a plain index,
--     without a jsonb path scan;
--   * PostgreSQL itself can refuse a dishonest row. A dimension that was not
--     measured cannot carry a value or a confidence here, an approval cannot
--     recommend an action, and an issue cannot claim an action that is not one
--     of retry, fallback or manual-review. Those are the aggregate's own
--     invariants, restated where the data actually lives.
-- Rehydration cross-checks the rows against the blob, so neither copy can drift
-- from the other without the read failing closed.

CREATE TABLE "synthetic_critic_reports" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "blockId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "capability" VARCHAR(64) NOT NULL,
  "adapterId" VARCHAR(128) NOT NULL,
  "adapterVersion" VARCHAR(128) NOT NULL,
  "artifactId" VARCHAR(128) NOT NULL,
  "artifactSha256" CHAR(64) NOT NULL,
  "audioArtifactId" VARCHAR(128),
  "alignmentArtifactId" VARCHAR(128),
  "scriptHash" CHAR(64) NOT NULL,
  "profileSnapshotId" VARCHAR(128) NOT NULL,
  "expectedIdentityRef" VARCHAR(256) NOT NULL,
  "decision" VARCHAR(24) NOT NULL,
  "recommendedAction" VARCHAR(16) NOT NULL,
  "thresholdsVersion" VARCHAR(128) NOT NULL,
  "reportJson" TEXT NOT NULL,
  "reportHash" CHAR(64) NOT NULL,
  "decidedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "synthetic_critic_reports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "synthetic_critic_reports_decision_check"
    CHECK ("decision" IN ('approved', 'rejected', 'needs-review', 'evidence-unavailable')),
  CONSTRAINT "synthetic_critic_reports_action_check"
    CHECK ("recommendedAction" IN ('retry', 'fallback', 'manual-review', 'none')),
  -- An approval never asks for anything to be done, and anything else always
  -- says what to do. A verdict without an instruction is not a verdict.
  CONSTRAINT "synthetic_critic_reports_decision_action_check"
    CHECK (("decision" = 'approved') = ("recommendedAction" = 'none')),
  CONSTRAINT "synthetic_critic_reports_schema_check"
    CHECK ("schemaVersion" = 'synthetic-critic-report/v1'),
  CONSTRAINT "synthetic_critic_reports_hash_check"
    CHECK ("reportHash" ~ '^[a-f0-9]{64}$' AND "artifactSha256" ~ '^[a-f0-9]{64}$' AND "scriptHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "synthetic_critic_reports_identity_check"
    CHECK (char_length("expectedIdentityRef") BETWEEN 1 AND 256
      AND char_length("thresholdsVersion") BETWEEN 3 AND 128),
  CONSTRAINT "synthetic_critic_reports_body_check"
    CHECK (left("reportJson", 1) = '{' AND char_length("reportJson") > 2)
);

CREATE UNIQUE INDEX "synthetic_critic_reports_id_workspace_key"
  ON "synthetic_critic_reports"("id", "workspaceId");
-- Lets a measurement row carry the block it belongs to without that copy ever
-- being able to drift from the report's own block.
CREATE UNIQUE INDEX "synthetic_critic_reports_id_workspace_block_key"
  ON "synthetic_critic_reports"("id", "workspaceId", "blockId");
-- Content-addressed: the same verdict on the same bytes is stored once.
CREATE UNIQUE INDEX "synthetic_critic_reports_workspace_hash_key"
  ON "synthetic_critic_reports"("workspaceId", "reportHash");
-- One verdict per take per published policy. Re-judging under a new thresholds
-- version is a new question and gets its own report; re-judging under the same
-- one must return the stored answer instead of minting a second opinion.
CREATE UNIQUE INDEX "synthetic_critic_reports_workspace_take_key"
  ON "synthetic_critic_reports"("workspaceId", "blockId", "artifactId", "thresholdsVersion");

CREATE INDEX "synthetic_critic_reports_workspace_block_idx"
  ON "synthetic_critic_reports"("workspaceId", "blockId");
CREATE INDEX "synthetic_critic_reports_workspace_artifact_idx"
  ON "synthetic_critic_reports"("workspaceId", "artifactId");
CREATE INDEX "synthetic_critic_reports_workspace_decision_idx"
  ON "synthetic_critic_reports"("workspaceId", "decision");
CREATE INDEX "synthetic_critic_reports_workspace_decided_idx"
  ON "synthetic_critic_reports"("workspaceId", "decidedAt" DESC);
CREATE INDEX "synthetic_critic_reports_workspace_project_idx"
  ON "synthetic_critic_reports"("workspaceId", "projectId", "decidedAt" DESC, "id" DESC);

ALTER TABLE "synthetic_critic_reports" ADD CONSTRAINT "synthetic_critic_reports_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_critic_reports" ADD CONSTRAINT "synthetic_critic_reports_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "synthetic_critic_reports" ADD CONSTRAINT "synthetic_critic_reports_blockId_workspaceId_fkey"
  FOREIGN KEY ("blockId", "workspaceId") REFERENCES "synthetic_script_blocks"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "synthetic_critic_reports" ADD CONSTRAINT "synthetic_critic_reports_artifactId_workspaceId_fkey"
  FOREIGN KEY ("artifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Truncated to PostgreSQL's 63-byte identifier limit exactly as Prisma names it.
ALTER TABLE "synthetic_critic_reports" ADD CONSTRAINT "synthetic_critic_reports_audioArtifactId_workspaceId_fkey"
  FOREIGN KEY ("audioArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_critic_reports" ADD CONSTRAINT "synthetic_critic_reports_alignmentArtifactId_workspaceId_fkey"
  FOREIGN KEY ("alignmentArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_critic_reports" ADD CONSTRAINT "synthetic_critic_reports_profileSnapshotId_workspaceId_fkey"
  FOREIGN KEY ("profileSnapshotId", "workspaceId") REFERENCES "synthetic_presenter_profiles"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Who looked, and with what standing. `kind` is the whole point of this table:
-- a controlled stand-in must never be readable as production validation.
CREATE TABLE "synthetic_critic_evaluators" (
  "reportId" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "evaluatorId" VARCHAR(128) NOT NULL,
  "version" VARCHAR(64) NOT NULL,
  "kind" VARCHAR(16) NOT NULL,
  "scope" TEXT NOT NULL,
  CONSTRAINT "synthetic_critic_evaluators_pkey" PRIMARY KEY ("reportId", "evaluatorId"),
  CONSTRAINT "synthetic_critic_evaluators_kind_check"
    CHECK ("kind" IN ('measured', 'controlled')),
  -- An evaluator that does not say what it can answer is not an evaluator.
  CONSTRAINT "synthetic_critic_evaluators_scope_check"
    CHECK (char_length(btrim("scope")) > 0 AND char_length(btrim("version")) > 0)
);

CREATE INDEX "synthetic_critic_evaluators_workspace_kind_idx"
  ON "synthetic_critic_evaluators"("workspaceId", "kind");

ALTER TABLE "synthetic_critic_evaluators" ADD CONSTRAINT "synthetic_critic_evaluators_reportId_workspaceId_fkey"
  FOREIGN KEY ("reportId", "workspaceId") REFERENCES "synthetic_critic_reports"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- One row per dimension per report, so "what was measured" is queryable and
-- "what was not" is impossible to dress up as a number.
CREATE TABLE "synthetic_critic_measurements" (
  "reportId" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "blockId" VARCHAR(128) NOT NULL,
  "dimension" VARCHAR(32) NOT NULL,
  "status" VARCHAR(16) NOT NULL,
  "evaluatorId" VARCHAR(128),
  "value" DOUBLE PRECISION,
  "unit" VARCHAR(32),
  "threshold" DOUBLE PRECISION,
  "confidence" DOUBLE PRECISION,
  "evidenceRefsJson" TEXT NOT NULL,
  "startMs" INTEGER,
  "endMs" INTEGER,
  "note" TEXT,
  CONSTRAINT "synthetic_critic_measurements_pkey" PRIMARY KEY ("reportId", "dimension"),
  CONSTRAINT "synthetic_critic_measurements_dimension_check"
    CHECK ("dimension" IN (
      'lip-sync', 'identity', 'pronunciation', 'visual-artifacts', 'framing',
      'continuity', 'eyes', 'teeth', 'hands', 'temporal-integrity',
      'audiovisual-integrity'
    )),
  CONSTRAINT "synthetic_critic_measurements_status_check"
    CHECK ("status" IN ('measured', 'not-applicable', 'unavailable')),
  -- A measured dimension names its instrument, its number, its unit and its
  -- evidence. Anything less is a score without a measurement.
  CONSTRAINT "synthetic_critic_measurements_measured_check"
    CHECK ("status" <> 'measured' OR (
      "evaluatorId" IS NOT NULL AND "value" IS NOT NULL AND "unit" IS NOT NULL
      AND "evidenceRefsJson" <> '[]'
    )),
  -- Nothing was measured, so nothing may look like a measurement, and the row
  -- has to say why in plain words.
  CONSTRAINT "synthetic_critic_measurements_unmeasured_check"
    CHECK ("status" = 'measured' OR (
      "value" IS NULL AND "confidence" IS NULL AND "threshold" IS NULL
      AND "note" IS NOT NULL AND char_length(btrim("note")) > 0
    )),
  CONSTRAINT "synthetic_critic_measurements_confidence_check"
    CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1)),
  CONSTRAINT "synthetic_critic_measurements_range_check"
    CHECK (("startMs" IS NULL) = ("endMs" IS NULL)
      AND ("startMs" IS NULL OR ("startMs" >= 0 AND "endMs" > "startMs"))),
  CONSTRAINT "synthetic_critic_measurements_evidence_json_check"
    CHECK (left("evidenceRefsJson", 1) = '[')
);

CREATE INDEX "synthetic_critic_measurements_workspace_dimension_idx"
  ON "synthetic_critic_measurements"("workspaceId", "dimension", "status");
CREATE INDEX "synthetic_critic_measurements_workspace_block_idx"
  ON "synthetic_critic_measurements"("workspaceId", "blockId", "dimension");

-- Exactly 63 bytes, which is how Prisma names it at PostgreSQL's identifier limit.
ALTER TABLE "synthetic_critic_measurements" ADD CONSTRAINT "synthetic_critic_measurements_reportId_workspaceId_blockId_fkey"
  FOREIGN KEY ("reportId", "workspaceId", "blockId") REFERENCES "synthetic_critic_reports"("id", "workspaceId", "blockId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Where the problem is, and what to do about it. The action is stored per issue
-- because it is derived from that issue's cause, never from a report-wide score.
CREATE TABLE "synthetic_critic_issues" (
  "reportId" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "blockId" VARCHAR(128) NOT NULL,
  "dimension" VARCHAR(32) NOT NULL,
  "severity" VARCHAR(16) NOT NULL,
  "startMs" INTEGER,
  "endMs" INTEGER,
  "evidence" TEXT NOT NULL,
  "action" VARCHAR(16) NOT NULL,
  CONSTRAINT "synthetic_critic_issues_pkey" PRIMARY KEY ("reportId", "ordinal"),
  CONSTRAINT "synthetic_critic_issues_ordinal_check" CHECK ("ordinal" >= 0),
  CONSTRAINT "synthetic_critic_issues_dimension_check"
    CHECK ("dimension" IN (
      'lip-sync', 'identity', 'pronunciation', 'visual-artifacts', 'framing',
      'continuity', 'eyes', 'teeth', 'hands', 'temporal-integrity',
      'audiovisual-integrity'
    )),
  CONSTRAINT "synthetic_critic_issues_severity_check"
    CHECK ("severity" IN ('blocking', 'major', 'minor')),
  -- 'none' is not an issue's answer: an issue exists precisely because
  -- something has to happen.
  CONSTRAINT "synthetic_critic_issues_action_check"
    CHECK ("action" IN ('retry', 'fallback', 'manual-review')),
  CONSTRAINT "synthetic_critic_issues_evidence_check"
    CHECK (char_length(btrim("evidence")) > 0),
  CONSTRAINT "synthetic_critic_issues_range_check"
    CHECK (("startMs" IS NULL) = ("endMs" IS NULL)
      AND ("startMs" IS NULL OR ("startMs" >= 0 AND "endMs" > "startMs")))
);

CREATE INDEX "synthetic_critic_issues_workspace_block_idx"
  ON "synthetic_critic_issues"("workspaceId", "blockId", "dimension");
CREATE INDEX "synthetic_critic_issues_workspace_dimension_idx"
  ON "synthetic_critic_issues"("workspaceId", "dimension", "severity");

ALTER TABLE "synthetic_critic_issues" ADD CONSTRAINT "synthetic_critic_issues_reportId_workspaceId_fkey"
  FOREIGN KEY ("reportId", "workspaceId") REFERENCES "synthetic_critic_reports"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "synthetic_critic_issues" ADD CONSTRAINT "synthetic_critic_issues_blockId_workspaceId_fkey"
  FOREIGN KEY ("blockId", "workspaceId") REFERENCES "synthetic_script_blocks"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
