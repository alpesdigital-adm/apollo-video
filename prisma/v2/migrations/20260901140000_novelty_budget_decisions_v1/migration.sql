-- F3.014 / FR-114 — narrative novelty budget decisions.
--
-- The decision is content-addressed and immutable: its id is derived from the
-- hash of its own body, so the same candidates under the same policy converge
-- on the same row instead of accumulating near-duplicates.
--
-- Every stored number is an integer in *novelty units*. That is load-bearing
-- rather than tidy: the policy must produce the same verdict no matter what
-- order rows come back in, and floating-point addition is not associative, so a
-- float column could flip a candidate across a threshold purely because of a
-- different ORDER BY.
--
-- Two amounts are stored per line and they are deliberately not the same
-- number. `chargedUnits` is what the budget pays — zero for a cache hit.
-- `densityUnits` is how much of the screen the effect occupies — identical
-- whether it was generated or reused. Collapsing them into one column is how a
-- video ends up visually exhausting and technically under budget.

CREATE TABLE "novelty_budget_policies" (
  "id"                      VARCHAR(128) NOT NULL,
  "workspaceId"             VARCHAR(128) NOT NULL,
  "schemaVersion"           VARCHAR(64) NOT NULL,
  "totalUnits"              INTEGER NOT NULL,
  "windowUnits"             INTEGER NOT NULL,
  "windowFrames"            INTEGER NOT NULL,
  "cooldownFrames"          INTEGER NOT NULL,
  "minimumSeparationFrames" INTEGER NOT NULL,
  "maximumPerGroup"         INTEGER NOT NULL,
  "diversityFloor"          INTEGER NOT NULL,
  "baseUnitsJson"           TEXT NOT NULL,
  "unitsPerSecond"          INTEGER NOT NULL,
  "proximityPenaltyBps"     INTEGER NOT NULL,
  "repetitionPenaltyBps"    INTEGER NOT NULL,
  "policyHash"              CHAR(64) NOT NULL,
  "createdAt"               TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "novelty_budget_policies_pkey" PRIMARY KEY ("id", "workspaceId"),
  CONSTRAINT "novelty_budget_policies_units_check"
    CHECK (
      "totalUnits" >= 0 AND "windowUnits" >= 0 AND "windowUnits" <= "totalUnits" AND
      "windowFrames" > 0 AND "cooldownFrames" >= 0 AND "minimumSeparationFrames" >= 0 AND
      "maximumPerGroup" >= 1 AND "diversityFloor" >= 0 AND "unitsPerSecond" >= 0 AND
      "proximityPenaltyBps" >= 0 AND "repetitionPenaltyBps" >= 0
    )
);

CREATE UNIQUE INDEX "novelty_budget_policies_workspaceId_policyHash_key"
  ON "novelty_budget_policies" ("workspaceId", "policyHash");

CREATE TABLE "novelty_budget_decisions" (
  "id"               VARCHAR(128) NOT NULL,
  "workspaceId"      VARCHAR(128) NOT NULL,
  "projectId"        VARCHAR(128) NOT NULL,
  "projectVersionId" VARCHAR(128) NOT NULL,
  "schemaVersion"    VARCHAR(64) NOT NULL,
  "treatmentPlanId"  VARCHAR(128) NOT NULL,
  "storyPlanId"      VARCHAR(128) NOT NULL,
  "policyId"         VARCHAR(128) NOT NULL,
  "policyHash"       CHAR(64) NOT NULL,
  "acceptedUnits"    INTEGER NOT NULL,
  "penalizedUnits"   INTEGER NOT NULL,
  "blockedCount"     INTEGER NOT NULL,
  "densityUnits"     INTEGER NOT NULL,
  "treatment"        VARCHAR(16) NOT NULL,
  "decisionHash"     CHAR(64) NOT NULL,
  "evaluatedAt"      TIMESTAMPTZ(3) NOT NULL,
  "createdAt"        TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "novelty_budget_decisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "novelty_budget_decisions_treatment_check"
    CHECK ("treatment" IN ('sober', 'balanced', 'intense')),
  CONSTRAINT "novelty_budget_decisions_units_check"
    CHECK ("acceptedUnits" >= 0 AND "penalizedUnits" >= 0 AND "blockedCount" >= 0 AND "densityUnits" >= 0)
);

CREATE UNIQUE INDEX "novelty_budget_decisions_id_workspaceId_key"
  ON "novelty_budget_decisions" ("id", "workspaceId");
CREATE INDEX "novelty_budget_decisions_workspaceId_projectId_evaluatedAt_idx"
  ON "novelty_budget_decisions" ("workspaceId", "projectId", "evaluatedAt" DESC);
CREATE INDEX "novelty_budget_decisions_workspaceId_projectVersionId_idx"
  ON "novelty_budget_decisions" ("workspaceId", "projectVersionId");

CREATE TABLE "novelty_budget_decision_lines" (
  "id"                   VARCHAR(128) NOT NULL,
  "workspaceId"          VARCHAR(128) NOT NULL,
  "decisionId"           VARCHAR(128) NOT NULL,
  "sequence"             INTEGER NOT NULL,
  "candidateId"          VARCHAR(128) NOT NULL,
  "briefId"              VARCHAR(128) NOT NULL,
  "effectGroup"          VARCHAR(16) NOT NULL,
  "outcome"              VARCHAR(16) NOT NULL,
  "chargedUnits"         INTEGER NOT NULL,
  "grossUnits"           INTEGER NOT NULL,
  "penaltyUnits"         INTEGER NOT NULL,
  "consumedBeforeUnits"  INTEGER NOT NULL,
  "remainingUnits"       INTEGER NOT NULL,
  "densityUnits"         INTEGER NOT NULL,
  "reason"               VARCHAR(300) NOT NULL,
  "blockedBecause"       VARCHAR(32),

  CONSTRAINT "novelty_budget_decision_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "novelty_budget_decision_lines_outcome_check"
    CHECK (
      "outcome" IN ('accepted', 'penalized', 'blocked') AND
      -- A block is never charged, and a block always says why. An unexplained
      -- refusal is indistinguishable from a bug.
      (("outcome" = 'blocked') = ("blockedBecause" IS NOT NULL)) AND
      ("outcome" <> 'blocked' OR ("chargedUnits" = 0 AND "densityUnits" = 0))
    ),
  CONSTRAINT "novelty_budget_decision_lines_reason_check"
    CHECK ("blockedBecause" IS NULL OR "blockedBecause" IN (
      'total-budget-exhausted', 'window-budget-exhausted', 'cooldown-active',
      'group-repetition-exceeded', 'proximity-too-close', 'diversity-floor-unmet',
      'budget-is-zero'
    )),
  CONSTRAINT "novelty_budget_decision_lines_group_check"
    CHECK ("effectGroup" IN ('world', 'style', 'insert', 'camera', 'light')),
  -- A penalized line has a penalty; an unpenalized one does not. Otherwise
  -- "penalized" would be a label nobody could act on.
  CONSTRAINT "novelty_budget_decision_lines_penalty_check"
    CHECK (("outcome" = 'penalized') = ("penaltyUnits" > 0 AND "outcome" <> 'blocked')),
  CONSTRAINT "novelty_budget_decision_lines_units_check"
    CHECK (
      "chargedUnits" >= 0 AND "grossUnits" >= 0 AND "penaltyUnits" >= 0 AND
      "consumedBeforeUnits" >= 0 AND "densityUnits" >= 0 AND "sequence" >= 0
    )
);

CREATE UNIQUE INDEX "novelty_budget_decision_lines_id_workspaceId_key"
  ON "novelty_budget_decision_lines" ("id", "workspaceId");
CREATE UNIQUE INDEX "novelty_budget_decision_lines_decisionId_sequence_key"
  ON "novelty_budget_decision_lines" ("decisionId", "sequence");
-- The lookup the submission gate makes: is this brief accepted anywhere?
CREATE INDEX "novelty_budget_decision_lines_workspaceId_briefId_idx"
  ON "novelty_budget_decision_lines" ("workspaceId", "briefId");

ALTER TABLE "novelty_budget_policies"
  ADD CONSTRAINT "novelty_budget_policies_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "novelty_budget_decisions"
  ADD CONSTRAINT "novelty_budget_decisions_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "novelty_budget_decisions"
  ADD CONSTRAINT "novelty_budget_decisions_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "novelty_budget_decisions"
  ADD CONSTRAINT "novelty_budget_decisions_policyId_workspaceId_fkey"
  FOREIGN KEY ("policyId", "workspaceId")
  REFERENCES "novelty_budget_policies"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "novelty_budget_decision_lines"
  ADD CONSTRAINT "novelty_budget_decision_lines_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "novelty_budget_decision_lines"
  ADD CONSTRAINT "novelty_budget_decision_lines_decisionId_workspaceId_fkey"
  FOREIGN KEY ("decisionId", "workspaceId")
  REFERENCES "novelty_budget_decisions"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
