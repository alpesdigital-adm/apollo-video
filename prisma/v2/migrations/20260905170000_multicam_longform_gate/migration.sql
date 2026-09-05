-- F4.016 / ADR-135 — multicamera and long-form phase gate.
--
-- One immutable, content-addressed record per evaluation plus a row per
-- criterion, per check and per evidence reference. ADR-135 requires each of
-- the phase conditions to be "independently visible"; a single JSON blob is
-- visible only to whoever parses it, so the conditions are rows here and the
-- CHECK constraints below are the domain's own refusals restated where the
-- database can apply them.
--
-- What each CHECK encodes:
--   * gates_result_check       — approved means all ten criteria satisfied, and
--                                a criterion can only be satisfied if it was
--                                evaluated (satisfied <= evaluated).
--   * gates_hashes_check       — every hash column is a lowercase SHA-256.
--   * gates_actor_check        — the record names a complete API-client audit
--                                context: a bearer actor delegates to nobody, a
--                                ui-session actor names user and workspace role.
--   * criteria_criterion_check — the ten criteria of the domain constant
--                                MULTICAM_LONGFORM_CRITERION_CHECKS.
--   * criteria_counts_check    — passed is derived from failedCheckCount, so a
--                                row cannot claim to pass while listing failures.
--   * checks_code_check        — the thirty-six check codes of that same constant.
--   * checks_reason_check      — failureReason is present exactly when the check
--                                failed, and comes from the domain's five reasons.
--   * checks_evidence_check    — a passing check read at least one reference and
--                                none of them unverified; only 'evidence-missing'
--                                may read nothing. This is the tampering rule: a
--                                row whose hash did not recompute cannot back an
--                                approval.
--   * evidence_hash_check      — a reference without a stored hash cannot claim
--                                it verified; there was nothing to recompute.
--
-- No foreign key points from the evidence rows to the twenty-four tables they
-- can name. A composite FK would either cascade this record away when the row it
-- observed is deleted — erasing the reason the gate said yes — or restrict that
-- deletion forever, letting an audit record own a capture session's lifecycle.
-- The stored hash is what lets a later reader tell whether the evidence still
-- exists and still says the same thing. "sessionId" is a plain column for the
-- same reason.

CREATE TABLE "multicam_longform_gates" (
    "id" VARCHAR(128) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "projectId" VARCHAR(128) NOT NULL,
    "sessionId" VARCHAR(128),
    "projectVersionId" VARCHAR(128),
    "projectVersionHash" CHAR(64),
    "schemaVersion" VARCHAR(64) NOT NULL,
    "gate" VARCHAR(64) NOT NULL,
    "approved" BOOLEAN NOT NULL,
    "satisfied" INTEGER NOT NULL,
    "evaluated" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "blockingCount" INTEGER NOT NULL DEFAULT 0,
    "reportJson" TEXT NOT NULL,
    "reportFingerprint" CHAR(64) NOT NULL,
    "recordHash" CHAR(64) NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "requestFingerprint" CHAR(64) NOT NULL,
    "createdByType" VARCHAR(32) NOT NULL,
    "createdById" VARCHAR(80) NOT NULL,
    "actorCredentialId" VARCHAR(128) NOT NULL,
    "actorEnvironment" VARCHAR(16) NOT NULL,
    "actorAuthenticationKind" VARCHAR(16) NOT NULL,
    "actorContextHash" CHAR(64) NOT NULL,
    "delegatedUserId" VARCHAR(128),
    "delegatedIdentityId" VARCHAR(128),
    "workspaceRole" VARCHAR(32),
    "evaluatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "multicam_longform_gates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "multicam_longform_gates_schema_check" CHECK (
      "schemaVersion" = 'multicam-longform-gate/v1'
      AND "gate" = 'multicam-longform/v1'
    ),
    CONSTRAINT "multicam_longform_gates_result_check" CHECK (
      "total" = 10
      AND "evaluated" BETWEEN 0 AND 10
      AND "satisfied" BETWEEN 0 AND "evaluated"
      AND "blockingCount" >= 0
      AND "approved" = ("satisfied" = 10)
      AND ("approved" = FALSE OR "blockingCount" = 0)
    ),
    CONSTRAINT "multicam_longform_gates_hashes_check" CHECK (
      "reportFingerprint" ~ '^[a-f0-9]{64}$'
      AND "recordHash" ~ '^[a-f0-9]{64}$'
      AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
      AND "actorContextHash" ~ '^[a-f0-9]{64}$'
      AND ("projectVersionHash" IS NULL OR "projectVersionHash" ~ '^[a-f0-9]{64}$')
    ),
    CONSTRAINT "multicam_longform_gates_version_check" CHECK (
      ("projectVersionId" IS NULL AND "projectVersionHash" IS NULL)
      OR ("projectVersionId" IS NOT NULL AND "projectVersionHash" IS NOT NULL)
    ),
    CONSTRAINT "multicam_longform_gates_report_bounds_check" CHECK (
      length("reportJson") BETWEEN 2 AND 4000000
    ),
    CONSTRAINT "multicam_longform_gates_actor_check" CHECK (
      "createdByType" = 'api-client'
      AND "actorEnvironment" IN ('sandbox', 'production')
      AND "actorAuthenticationKind" IN ('bearer', 'ui-session')
      AND (
        ("actorAuthenticationKind" = 'bearer'
          AND "delegatedUserId" IS NULL
          AND "delegatedIdentityId" IS NULL
          AND "workspaceRole" IS NULL)
        OR
        ("actorAuthenticationKind" = 'ui-session'
          AND "delegatedUserId" IS NOT NULL
          AND "workspaceRole" IS NOT NULL)
      )
    )
);

CREATE TABLE "multicam_longform_gate_criteria" (
    "id" VARCHAR(200) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "gateId" VARCHAR(128) NOT NULL,
    "criterion" VARCHAR(64) NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "checkCount" INTEGER NOT NULL,
    "failedCheckCount" INTEGER NOT NULL,
    "missingCheckCount" INTEGER NOT NULL,
    "unverifiedReferenceCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "multicam_longform_gate_criteria_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "multicam_longform_gate_criteria_criterion_check" CHECK (
      "criterion" IN (
        'podcast-multicam-synchronised',
        'teacher-and-screen-synchronised',
        'insufficient-evidence-requires-manual',
        'react-edited-with-piecewise-map',
        'active-speaker-and-demonstration-directed',
        'contextual-multi-range-synthesis',
        'colour-match-precedes-creative-lut',
        'colour-critic-resolved',
        'final-mp4-inspectable',
        'no-legacy-runtime-dependency'
      )
    ),
    CONSTRAINT "multicam_longform_gate_criteria_counts_check" CHECK (
      "ordinal" BETWEEN 0 AND 9
      AND "checkCount" BETWEEN 1 AND 8
      AND "failedCheckCount" BETWEEN 0 AND "checkCount"
      AND "missingCheckCount" BETWEEN 0 AND "failedCheckCount"
      AND "unverifiedReferenceCount" >= 0
      AND "passed" = ("failedCheckCount" = 0)
      AND ("passed" = FALSE OR "unverifiedReferenceCount" = 0)
    )
);

CREATE TABLE "multicam_longform_gate_checks" (
    "id" VARCHAR(240) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "criterionRowId" VARCHAR(200) NOT NULL,
    "gateId" VARCHAR(128) NOT NULL,
    "criterion" VARCHAR(64) NOT NULL,
    "checkCode" VARCHAR(64) NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "failureReason" VARCHAR(32),
    "detail" VARCHAR(512) NOT NULL,
    "referenceCount" INTEGER NOT NULL,
    "unverifiedReferenceCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "multicam_longform_gate_checks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "multicam_longform_gate_checks_code_check" CHECK (
      "checkCode" IN (
        'active-speaker-rule-fired',
        'artifact-hash-matches-attempt',
        'clock-map-persisted',
        'context-proof-recorded',
        'coverage-derived',
        'critic-report-persisted',
        'decisions-carry-justification',
        'demonstration-rule-fired',
        'diagnostic-requires-manual',
        'diagnostic-synchronised',
        'direction-persisted',
        'duration-within-tolerance',
        'final-export-promoted',
        'interrupted-piece-present',
        'map-compiled-into-plan',
        'match-plan-persisted',
        'match-precedes-creative-lut',
        'module-graph-scanned',
        'multiple-ranges-preserved',
        'no-compatibility-persistence',
        'no-legacy-runtime-import',
        'no-open-hard-issue',
        'output-codec-recorded',
        'output-probe-measured',
        'participant-tracks-distinct',
        'playback-map-persisted',
        'podcast-protocol-evaluated',
        'protocol-ceiling-blocks-auto-edit',
        'reaction-duration-differs',
        'sync-evidence-insufficient',
        'synthesis-persisted',
        'target-duration-is-120s',
        'teacher-protocol-evaluated',
        'track-durations-unequal',
        'transforms-are-match-stage',
        'verdict-resolved'
      )
    ),
    CONSTRAINT "multicam_longform_gate_checks_reason_check" CHECK (
      ("passed" = TRUE AND "failureReason" IS NULL)
      OR (
        "passed" = FALSE
        AND "failureReason" IN (
          'evidence-missing',
          'evidence-unverified',
          'evidence-not-measured',
          'requirement-unmet',
          'evidence-stale'
        )
      )
    ),
    CONSTRAINT "multicam_longform_gate_checks_evidence_check" CHECK (
      "ordinal" BETWEEN 0 AND 7
      AND char_length(btrim("detail")) >= 1
      AND "referenceCount" BETWEEN 0 AND 16
      AND "unverifiedReferenceCount" BETWEEN 0 AND "referenceCount"
      -- `IS NOT DISTINCT FROM` rather than `=`: failureReason is NULL on a
      -- passing check, and `FALSE OR NULL` is NULL, which a CHECK accepts.
      AND ("referenceCount" > 0 OR "failureReason" IS NOT DISTINCT FROM 'evidence-missing')
      AND ("passed" = FALSE OR ("referenceCount" > 0 AND "unverifiedReferenceCount" = 0))
    )
);

CREATE TABLE "multicam_longform_gate_evidence" (
    "id" VARCHAR(300) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "checkRowId" VARCHAR(240) NOT NULL,
    "gateId" VARCHAR(128) NOT NULL,
    "criterion" VARCHAR(64) NOT NULL,
    "checkCode" VARCHAR(64) NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "resourceType" VARCHAR(32) NOT NULL,
    "resourceId" VARCHAR(240) NOT NULL,
    "resourceHash" CHAR(64),
    "verified" BOOLEAN NOT NULL,

    CONSTRAINT "multicam_longform_gate_evidence_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "multicam_longform_gate_evidence_resource_check" CHECK (
      "resourceType" IN (
        'workspace',
        'project',
        'project-version',
        'capture-session',
        'capture-protocol',
        'capture-protocol-evaluation',
        'sync-diagnostic',
        'sync-evidence',
        'track-coverage',
        'clock-map',
        'playback-map',
        'playback-piece',
        'multicam-direction',
        'shot-decision',
        'editorial-synthesis',
        'match-plan',
        'match-transform',
        'colour-plan',
        'colour-critic-report',
        'renderable-plan-snapshot',
        'final-export',
        'media-artifact',
        'media-manifest',
        'module-graph-audit'
      )
      AND "ordinal" BETWEEN 0 AND 15
      AND char_length(btrim("resourceId")) >= 3
    ),
    -- Written as CASE rather than as `(hash IS NULL AND NOT verified) OR hash ~
    -- '...'`, which is what this constraint said until PostgreSQL accepted a
    -- row it was meant to refuse: with a NULL hash the second disjunct
    -- evaluates to NULL, `FALSE OR NULL` is NULL, and a CHECK passes on NULL.
    CONSTRAINT "multicam_longform_gate_evidence_hash_check" CHECK (
      CASE
        WHEN "resourceHash" IS NULL THEN "verified" = FALSE
        ELSE "resourceHash" ~ '^[a-f0-9]{64}$'
      END
    )
);

CREATE INDEX "multicam_longform_gates_workspaceId_projectId_evaluatedAt_idx" ON "multicam_longform_gates"("workspaceId", "projectId", "evaluatedAt" DESC);

CREATE INDEX "multicam_longform_gates_workspaceId_approved_evaluatedAt_idx" ON "multicam_longform_gates"("workspaceId", "approved", "evaluatedAt" DESC);

CREATE INDEX "multicam_longform_gates_workspaceId_sessionId_idx" ON "multicam_longform_gates"("workspaceId", "sessionId");

CREATE INDEX "multicam_longform_gates_workspaceId_actorContextHash_create_idx" ON "multicam_longform_gates"("workspaceId", "actorContextHash", "createdAt" DESC);

CREATE UNIQUE INDEX "multicam_longform_gates_id_workspaceId_key" ON "multicam_longform_gates"("id", "workspaceId");

CREATE UNIQUE INDEX "multicam_longform_gates_project_idempotency_key" ON "multicam_longform_gates"("workspaceId", "projectId", "idempotencyKey");

CREATE UNIQUE INDEX "multicam_longform_gates_workspaceId_recordHash_key" ON "multicam_longform_gates"("workspaceId", "recordHash");

CREATE INDEX "multicam_longform_gate_criteria_workspaceId_criterion_passe_idx" ON "multicam_longform_gate_criteria"("workspaceId", "criterion", "passed");

CREATE UNIQUE INDEX "multicam_longform_gate_criteria_id_workspaceId_key" ON "multicam_longform_gate_criteria"("id", "workspaceId");

CREATE UNIQUE INDEX "multicam_longform_gate_criteria_gate_criterion_key" ON "multicam_longform_gate_criteria"("workspaceId", "gateId", "criterion");

CREATE UNIQUE INDEX "multicam_longform_gate_criteria_gate_ordinal_key" ON "multicam_longform_gate_criteria"("workspaceId", "gateId", "ordinal");

CREATE INDEX "multicam_longform_gate_checks_workspaceId_checkCode_passed_idx" ON "multicam_longform_gate_checks"("workspaceId", "checkCode", "passed");

CREATE INDEX "multicam_longform_gate_checks_workspaceId_failureReason_idx" ON "multicam_longform_gate_checks"("workspaceId", "failureReason");

CREATE UNIQUE INDEX "multicam_longform_gate_checks_id_workspaceId_key" ON "multicam_longform_gate_checks"("id", "workspaceId");

CREATE UNIQUE INDEX "multicam_longform_gate_checks_gate_check_key" ON "multicam_longform_gate_checks"("workspaceId", "gateId", "criterion", "checkCode");

CREATE UNIQUE INDEX "multicam_longform_gate_checks_criterion_ordinal_key" ON "multicam_longform_gate_checks"("workspaceId", "criterionRowId", "ordinal");

CREATE INDEX "multicam_longform_gate_evidence_workspaceId_resourceType_re_idx" ON "multicam_longform_gate_evidence"("workspaceId", "resourceType", "resourceId");

CREATE INDEX "multicam_longform_gate_evidence_workspaceId_gateId_criterio_idx" ON "multicam_longform_gate_evidence"("workspaceId", "gateId", "criterion");

CREATE UNIQUE INDEX "multicam_longform_gate_evidence_id_workspaceId_key" ON "multicam_longform_gate_evidence"("id", "workspaceId");

CREATE UNIQUE INDEX "multicam_longform_gate_evidence_check_ordinal_key" ON "multicam_longform_gate_evidence"("workspaceId", "checkRowId", "ordinal");

ALTER TABLE "multicam_longform_gates" ADD CONSTRAINT "multicam_longform_gates_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "multicam_longform_gates" ADD CONSTRAINT "multicam_longform_gates_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "multicam_longform_gates" ADD CONSTRAINT "multicam_longform_gates_createdById_workspaceId_fkey" FOREIGN KEY ("createdById", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "multicam_longform_gate_criteria" ADD CONSTRAINT "multicam_longform_gate_criteria_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "multicam_longform_gate_criteria" ADD CONSTRAINT "multicam_longform_gate_criteria_gateId_workspaceId_fkey" FOREIGN KEY ("gateId", "workspaceId") REFERENCES "multicam_longform_gates"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "multicam_longform_gate_checks" ADD CONSTRAINT "multicam_longform_gate_checks_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "multicam_longform_gate_checks" ADD CONSTRAINT "multicam_longform_gate_checks_criterionRowId_workspaceId_fkey" FOREIGN KEY ("criterionRowId", "workspaceId") REFERENCES "multicam_longform_gate_criteria"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "multicam_longform_gate_evidence" ADD CONSTRAINT "multicam_longform_gate_evidence_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "multicam_longform_gate_evidence" ADD CONSTRAINT "multicam_longform_gate_evidence_checkRowId_workspaceId_fkey" FOREIGN KEY ("checkRowId", "workspaceId") REFERENCES "multicam_longform_gate_checks"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
