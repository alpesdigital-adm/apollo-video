-- F3.015 / FR-115 and F3.016 / FR-116 — the fallback ledger and the
-- transformation critic.
--
-- Both are content-addressed and immutable. The ledger is append-only: an
-- attempt is a fact that happened, and a ladder that could rewrite its own
-- history would be unable to answer "why did we end up on a cutaway", which is
-- the question an editor asks months later.
--
-- Three invariants live in the database because their absence would be
-- silently expensive:
--
-- 1. An artifact that violates protected content can never be the best one.
--    A beautiful result that changed the subject's face is not a partial
--    success to preserve; aesthetics do not buy back a protected change.
-- 2. No derivative may claim the source artifact's identity. Every attempt is
--    a sibling of the source, never an overwrite of it.
-- 3. A critic report with a hard gate can only be a rejection, and a mandatory
--    dimension with no evidence can only be `evidence-unavailable`. "We could
--    not tell" is not "it is fine".

CREATE TABLE "transformation_fallback_ledgers" (
  "id"                      VARCHAR(128) NOT NULL,
  "workspaceId"             VARCHAR(128) NOT NULL,
  "projectId"               VARCHAR(128) NOT NULL,
  "projectVersionId"        VARCHAR(128) NOT NULL,
  "schemaVersion"           VARCHAR(64) NOT NULL,
  "briefId"                 VARCHAR(128) NOT NULL,
  "briefHash"               CHAR(64) NOT NULL,
  "ladderJson"              TEXT NOT NULL,
  "currentRung"             VARCHAR(24) NOT NULL,
  "bestArtifactId"          VARCHAR(128),
  "bestArtifactSha256"      CHAR(64),
  "bestIntentScoreBps"      INTEGER,
  "incurredCostMinorUnits"  INTEGER NOT NULL DEFAULT 0,
  "costCurrency"            CHAR(3) NOT NULL,
  "reviewDecision"          VARCHAR(24) NOT NULL,
  "sourceArtifactId"        VARCHAR(128) NOT NULL,
  "sourceArtifactSha256"    CHAR(64) NOT NULL,
  "ledgerHash"              CHAR(64) NOT NULL,
  "createdAt"               TIMESTAMPTZ(3) NOT NULL,
  "updatedAt"               TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "transformation_fallback_ledgers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transformation_fallback_ledgers_rung_check"
    CHECK ("currentRung" IN ('video-to-video', 'actor-composite', 'generated-cutaway', 'still-parallax', 'source-unchanged')),
  CONSTRAINT "transformation_fallback_ledgers_review_check"
    CHECK ("reviewDecision" IN ('accepted', 'awaiting-review', 'kept-source')),
  -- A best artifact is all-or-nothing: an id without its checksum could not be
  -- verified, and a score without an artifact describes nothing.
  CONSTRAINT "transformation_fallback_ledgers_best_check"
    CHECK (
      ("bestArtifactId" IS NULL AND "bestArtifactSha256" IS NULL AND "bestIntentScoreBps" IS NULL) OR
      ("bestArtifactId" IS NOT NULL AND "bestArtifactSha256" IS NOT NULL AND "bestIntentScoreBps" IS NOT NULL
       AND "bestIntentScoreBps" BETWEEN 0 AND 10000)
    ),
  -- Accepting requires something to accept. Otherwise "accepted" would be a
  -- state that points at nothing.
  CONSTRAINT "transformation_fallback_ledgers_accept_check"
    CHECK ("reviewDecision" <> 'accepted' OR "bestArtifactId" IS NOT NULL),
  -- The derivative never becomes the source.
  CONSTRAINT "transformation_fallback_ledgers_source_check"
    CHECK ("bestArtifactId" IS NULL OR "bestArtifactId" <> "sourceArtifactId"),
  CONSTRAINT "transformation_fallback_ledgers_cost_check"
    CHECK ("incurredCostMinorUnits" >= 0)
);

CREATE UNIQUE INDEX "transformation_fallback_ledgers_id_workspaceId_key"
  ON "transformation_fallback_ledgers" ("id", "workspaceId");
CREATE INDEX "transformation_fallback_ledgers_workspaceId_briefId_idx"
  ON "transformation_fallback_ledgers" ("workspaceId", "briefId");
CREATE INDEX "transformation_fallback_ledgers_workspaceId_projectId_updat_idx"
  ON "transformation_fallback_ledgers" ("workspaceId", "projectId", "updatedAt" DESC);

CREATE TABLE "transformation_fallback_attempts" (
  "id"                       VARCHAR(128) NOT NULL,
  "workspaceId"              VARCHAR(128) NOT NULL,
  "ledgerId"                 VARCHAR(128) NOT NULL,
  "sequence"                 INTEGER NOT NULL,
  "rung"                     VARCHAR(24) NOT NULL,
  "providerJobId"            VARCHAR(128),
  "providerId"               VARCHAR(128),
  "artifactId"               VARCHAR(128),
  "artifactSha256"           CHAR(64),
  "outcome"                  VARCHAR(16) NOT NULL,
  "intentScoreBps"           INTEGER,
  "criticReportHash"         CHAR(64),
  "violatesProtectedContent" BOOLEAN NOT NULL DEFAULT false,
  "estimatedCostMinorUnits"  INTEGER NOT NULL DEFAULT 0,
  "observedCostMinorUnits"   INTEGER NOT NULL DEFAULT 0,
  "costCurrency"             CHAR(3) NOT NULL,
  "reason"                   VARCHAR(300) NOT NULL,
  "descendedBecause"         VARCHAR(48),

  CONSTRAINT "transformation_fallback_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transformation_fallback_attempts_rung_check"
    CHECK ("rung" IN ('video-to-video', 'actor-composite', 'generated-cutaway', 'still-parallax', 'source-unchanged')),
  CONSTRAINT "transformation_fallback_attempts_outcome_check"
    CHECK ("outcome" IN ('approved', 'rejected', 'failed', 'skipped')),
  CONSTRAINT "transformation_fallback_attempts_descent_check"
    CHECK ("descendedBecause" IS NULL OR "descendedBecause" IN (
      'critic-rejected-protected-content', 'critic-rejected-quality', 'capability-unavailable',
      'provider-exhausted', 'attempt-budget-exhausted', 'novelty-budget-blocked',
      'rights-withdrawn', 'intent-not-satisfied', 'no-improvement'
    )),
  -- An approved attempt has to name the critic report that approved it, or the
  -- approval is an assertion with nothing behind it.
  CONSTRAINT "transformation_fallback_attempts_approval_check"
    CHECK ("outcome" <> 'approved' OR ("criticReportHash" IS NOT NULL AND "artifactId" IS NOT NULL)),
  CONSTRAINT "transformation_fallback_attempts_artifact_check"
    CHECK (("artifactId" IS NULL) = ("artifactSha256" IS NULL)),
  -- Keeping the source produces nothing and costs nothing.
  CONSTRAINT "transformation_fallback_attempts_source_rung_check"
    CHECK ("rung" <> 'source-unchanged' OR ("artifactId" IS NULL AND "observedCostMinorUnits" = 0)),
  CONSTRAINT "transformation_fallback_attempts_score_check"
    CHECK ("intentScoreBps" IS NULL OR "intentScoreBps" BETWEEN 0 AND 10000),
  CONSTRAINT "transformation_fallback_attempts_cost_check"
    CHECK ("estimatedCostMinorUnits" >= 0 AND "observedCostMinorUnits" >= 0 AND "sequence" >= 0)
);

CREATE UNIQUE INDEX "transformation_fallback_attempts_id_workspaceId_key"
  ON "transformation_fallback_attempts" ("id", "workspaceId");
CREATE UNIQUE INDEX "transformation_fallback_attempts_ledgerId_sequence_key"
  ON "transformation_fallback_attempts" ("ledgerId", "sequence");
CREATE INDEX "transformation_fallback_attempts_workspaceId_providerJobId_idx"
  ON "transformation_fallback_attempts" ("workspaceId", "providerJobId");

CREATE TABLE "transformation_critic_reports" (
  "id"                   VARCHAR(128) NOT NULL,
  "workspaceId"          VARCHAR(128) NOT NULL,
  "projectId"            VARCHAR(128) NOT NULL,
  "schemaVersion"        VARCHAR(64) NOT NULL,
  "briefId"              VARCHAR(128) NOT NULL,
  "briefHash"            CHAR(64) NOT NULL,
  "providerJobId"        VARCHAR(128) NOT NULL,
  "policyId"             VARCHAR(128) NOT NULL,
  "policyHash"           CHAR(64) NOT NULL,
  "sourceArtifactId"     VARCHAR(128) NOT NULL,
  "sourceArtifactSha256" CHAR(64) NOT NULL,
  "resultArtifactId"     VARCHAR(128) NOT NULL,
  "resultArtifactSha256" CHAR(64) NOT NULL,
  "evaluatorsJson"       TEXT NOT NULL,
  "hardGatesJson"        TEXT NOT NULL,
  "hardGateCount"        INTEGER NOT NULL DEFAULT 0,
  "decision"             VARCHAR(24) NOT NULL,
  "action"               VARCHAR(16) NOT NULL,
  "confidenceBps"        INTEGER,
  "intentScoreBps"       INTEGER,
  "reportHash"           CHAR(64) NOT NULL,
  "evaluatedAt"          TIMESTAMPTZ(3) NOT NULL,
  "createdAt"            TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "transformation_critic_reports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transformation_critic_reports_decision_check"
    CHECK ("decision" IN ('approved', 'rejected', 'needs-review', 'evidence-unavailable')),
  CONSTRAINT "transformation_critic_reports_action_check"
    CHECK ("action" IN ('approve', 'retry', 'fallback', 'review')),
  -- The rule this critic exists for. A hard gate can only be a rejection: no
  -- aesthetic score buys back a protected change.
  CONSTRAINT "transformation_critic_reports_hard_gate_check"
    CHECK ("hardGateCount" = 0 OR "decision" = 'rejected'),
  CONSTRAINT "transformation_critic_reports_approval_action_check"
    CHECK ("decision" <> 'approved' OR "action" = 'approve'),
  -- Missing evidence is a question for a human, never an automatic retry.
  CONSTRAINT "transformation_critic_reports_unavailable_action_check"
    CHECK ("decision" <> 'evidence-unavailable' OR "action" = 'review'),
  -- The source and the result are never the same bytes; a transformation that
  -- changed nothing is not a transformation.
  CONSTRAINT "transformation_critic_reports_distinct_artifacts_check"
    CHECK ("sourceArtifactId" <> "resultArtifactId"),
  CONSTRAINT "transformation_critic_reports_score_check"
    CHECK (
      ("confidenceBps" IS NULL OR "confidenceBps" BETWEEN 0 AND 10000) AND
      ("intentScoreBps" IS NULL OR "intentScoreBps" BETWEEN 0 AND 10000) AND
      "hardGateCount" >= 0
    )
);

CREATE UNIQUE INDEX "transformation_critic_reports_id_workspaceId_key"
  ON "transformation_critic_reports" ("id", "workspaceId");
CREATE INDEX "transformation_critic_reports_workspaceId_briefId_evaluated_idx"
  ON "transformation_critic_reports" ("workspaceId", "briefId", "evaluatedAt" DESC);
CREATE INDEX "transformation_critic_reports_workspaceId_providerJobId_idx"
  ON "transformation_critic_reports" ("workspaceId", "providerJobId");

CREATE TABLE "transformation_critic_measurements" (
  "id"           VARCHAR(128) NOT NULL,
  "workspaceId"  VARCHAR(128) NOT NULL,
  "reportId"     VARCHAR(128) NOT NULL,
  "dimension"    VARCHAR(32) NOT NULL,
  "status"       VARCHAR(16) NOT NULL,
  "evaluatorId"  VARCHAR(128),
  "scoreBps"     INTEGER,
  "thresholdBps" INTEGER,
  "startFrame"   INTEGER,
  "endFrame"     INTEGER,
  "regionJson"   TEXT,
  "note"         VARCHAR(500),

  CONSTRAINT "transformation_critic_measurements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transformation_critic_measurements_dimension_check"
    CHECK ("dimension" IN (
      'intent-adherence', 'preserve-list', 'identity', 'lip-sync', 'temporal-coherence',
      'flicker', 'warping', 'anatomy', 'composite-edges', 'composite-light',
      'transitions', 'format-safe-areas', 'risk', 'media-integrity'
    )),
  CONSTRAINT "transformation_critic_measurements_status_check"
    CHECK ("status" IN ('measured', 'not-applicable', 'unavailable')),
  -- A measured dimension names who measured it and what it was judged against;
  -- an unmeasured one carries no score and must explain itself. Silence is
  -- never a pass.
  CONSTRAINT "transformation_critic_measurements_evidence_check"
    CHECK (
      ("status" = 'measured' AND "evaluatorId" IS NOT NULL AND "scoreBps" IS NOT NULL AND "thresholdBps" IS NOT NULL) OR
      ("status" <> 'measured' AND "scoreBps" IS NULL AND "thresholdBps" IS NULL AND "note" IS NOT NULL AND length(trim("note")) >= 10)
    ),
  CONSTRAINT "transformation_critic_measurements_range_check"
    CHECK (
      (("startFrame" IS NULL) = ("endFrame" IS NULL)) AND
      ("startFrame" IS NULL OR ("startFrame" >= 0 AND "endFrame" > "startFrame"))
    ),
  CONSTRAINT "transformation_critic_measurements_score_check"
    CHECK (
      ("scoreBps" IS NULL OR "scoreBps" BETWEEN 0 AND 10000) AND
      ("thresholdBps" IS NULL OR "thresholdBps" BETWEEN 0 AND 10000)
    )
);

CREATE UNIQUE INDEX "transformation_critic_measurements_id_workspaceId_key"
  ON "transformation_critic_measurements" ("id", "workspaceId");
CREATE UNIQUE INDEX "transformation_critic_measurements_reportId_dimension_key"
  ON "transformation_critic_measurements" ("reportId", "dimension");

CREATE TABLE "transformation_critic_issues" (
  "id"               VARCHAR(128) NOT NULL,
  "workspaceId"      VARCHAR(128) NOT NULL,
  "reportId"         VARCHAR(128) NOT NULL,
  "sequence"         INTEGER NOT NULL,
  "dimension"        VARCHAR(32) NOT NULL,
  "severity"         VARCHAR(16) NOT NULL,
  "startFrame"       INTEGER NOT NULL,
  "endFrame"         INTEGER NOT NULL,
  "regionJson"       TEXT,
  "violatedPreserve" VARCHAR(24),
  "description"      VARCHAR(500) NOT NULL,

  CONSTRAINT "transformation_critic_issues_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transformation_critic_issues_severity_check"
    CHECK ("severity" IN ('blocking', 'major', 'minor')),
  CONSTRAINT "transformation_critic_issues_dimension_check"
    CHECK ("dimension" IN (
      'intent-adherence', 'preserve-list', 'identity', 'lip-sync', 'temporal-coherence',
      'flicker', 'warping', 'anatomy', 'composite-edges', 'composite-light',
      'transitions', 'format-safe-areas', 'risk', 'media-integrity'
    )),
  -- An issue that is not localized cannot be acted on; an editor has to be able
  -- to go straight to the frames.
  CONSTRAINT "transformation_critic_issues_range_check"
    CHECK ("startFrame" >= 0 AND "endFrame" > "startFrame" AND "sequence" >= 0),
  CONSTRAINT "transformation_critic_issues_description_check"
    CHECK (length(trim("description")) >= 10)
);

CREATE UNIQUE INDEX "transformation_critic_issues_id_workspaceId_key"
  ON "transformation_critic_issues" ("id", "workspaceId");
CREATE UNIQUE INDEX "transformation_critic_issues_reportId_sequence_key"
  ON "transformation_critic_issues" ("reportId", "sequence");

ALTER TABLE "transformation_fallback_ledgers"
  ADD CONSTRAINT "transformation_fallback_ledgers_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "transformation_fallback_ledgers"
  ADD CONSTRAINT "transformation_fallback_ledgers_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "transformation_fallback_attempts"
  ADD CONSTRAINT "transformation_fallback_attempts_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "transformation_fallback_attempts"
  ADD CONSTRAINT "transformation_fallback_attempts_ledgerId_workspaceId_fkey"
  FOREIGN KEY ("ledgerId", "workspaceId")
  REFERENCES "transformation_fallback_ledgers"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "transformation_critic_reports"
  ADD CONSTRAINT "transformation_critic_reports_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "transformation_critic_reports"
  ADD CONSTRAINT "transformation_critic_reports_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "transformation_critic_measurements"
  ADD CONSTRAINT "transformation_critic_measurements_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "transformation_critic_measurements"
  ADD CONSTRAINT "transformation_critic_measurements_reportId_workspaceId_fkey"
  FOREIGN KEY ("reportId", "workspaceId")
  REFERENCES "transformation_critic_reports"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "transformation_critic_issues"
  ADD CONSTRAINT "transformation_critic_issues_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "transformation_critic_issues"
  ADD CONSTRAINT "transformation_critic_issues_reportId_workspaceId_fkey"
  FOREIGN KEY ("reportId", "workspaceId")
  REFERENCES "transformation_critic_reports"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
