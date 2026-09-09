CREATE TABLE "synthetic_phase_gates" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "projectVersionId" VARCHAR(128) NOT NULL,
  "projectVersionHash" CHAR(64) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "approved" BOOLEAN NOT NULL,
  "covered" INTEGER NOT NULL,
  "passed" INTEGER NOT NULL,
  "total" INTEGER NOT NULL,
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
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "synthetic_phase_gates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "synthetic_phase_gates_schema_check" CHECK (
    "schemaVersion" = 'synthetic-phase-gate/v1'
  ),
  CONSTRAINT "synthetic_phase_gates_hashes_check" CHECK (
    "projectVersionHash" ~ '^[a-f0-9]{64}$'
    AND "reportFingerprint" ~ '^[a-f0-9]{64}$'
    AND "recordHash" ~ '^[a-f0-9]{64}$'
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
    AND "actorContextHash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "synthetic_phase_gates_result_check" CHECK (
    "total" = 4
    AND "covered" BETWEEN 0 AND 4
    AND "passed" BETWEEN 0 AND "covered"
    AND (("approved" = TRUE AND "covered" = 4 AND "passed" = 4) OR "approved" = FALSE)
  ),
  CONSTRAINT "synthetic_phase_gates_report_bounds_check" CHECK (
    length("reportJson") BETWEEN 2 AND 1000000
  ),
  CONSTRAINT "synthetic_phase_gates_actor_check" CHECK (
    "createdByType" = 'api-client'
    AND "actorAuthenticationKind" IN ('bearer', 'ui-session')
    AND "actorEnvironment" IN ('development', 'staging', 'production')
  ),
  CONSTRAINT "synthetic_phase_gates_delegation_check" CHECK (
    ("delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND "workspaceRole" IS NULL)
    OR
    ("delegatedUserId" IS NOT NULL AND "delegatedIdentityId" IS NOT NULL AND "workspaceRole" IS NOT NULL)
  )
);

CREATE TABLE "synthetic_phase_gate_evidence" (
  "gateId" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "criterion" VARCHAR(32) NOT NULL,
  "checkCode" VARCHAR(96) NOT NULL,
  "passed" BOOLEAN NOT NULL,
  "evidenceType" VARCHAR(48) NOT NULL,
  "resourceId" VARCHAR(192) NOT NULL,
  "resourceHash" CHAR(64) NOT NULL,
  "ordinal" INTEGER NOT NULL,

  CONSTRAINT "synthetic_phase_gate_evidence_pkey"
    PRIMARY KEY ("gateId", "criterion", "checkCode", "ordinal"),
  CONSTRAINT "synthetic_phase_gate_evidence_criterion_check" CHECK (
    "criterion" IN ('F3-GATE-001', 'F3-GATE-002', 'F3-GATE-003', 'F3-GATE-004')
  ),
  CONSTRAINT "synthetic_phase_gate_evidence_check_code_check" CHECK (
    "checkCode" IN (
      'elevenlabs-audio-alignment-live',
      'heygen-generated-audio-avatar-live',
      'heygen-ready-audio-avatar-live',
      'approved-blocks-catalogued',
      'cross-project-reuse-with-zero-provider-work',
      'transformation-rejected-before-fallback',
      'fallback-result-approved',
      'provider-swap-keeps-plan-and-renderer-contracts'
    )
  ),
  CONSTRAINT "synthetic_phase_gate_evidence_type_check" CHECK (
    "evidenceType" IN (
      'provider-job',
      'provider-result-artifact',
      'alignment-artifact',
      'synthetic-audio-master',
      'synthetic-master',
      'speech-segment',
      'cache-decision',
      'project',
      'transformation-fallback-ledger',
      'transformation-critic-report',
      'edit-plan',
      'render-manifest',
      'build-attestation'
    )
  ),
  CONSTRAINT "synthetic_phase_gate_evidence_hash_check" CHECK (
    "resourceHash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "synthetic_phase_gate_evidence_ordinal_check" CHECK (
    "ordinal" BETWEEN 0 AND 15
  ),
  CONSTRAINT "synthetic_phase_gate_evidence_identity_check" CHECK (
    length("resourceId") BETWEEN 3 AND 192
    AND "resourceId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  )
);

CREATE UNIQUE INDEX "synthetic_phase_gates_id_workspaceId_key"
  ON "synthetic_phase_gates"("id", "workspaceId");
CREATE UNIQUE INDEX "synthetic_phase_gates_workspace_actor_key"
  ON "synthetic_phase_gates"("workspaceId", "projectId", "createdById", "actorContextHash", "idempotencyKey");
CREATE INDEX "synthetic_phase_gates_workspace_project_created_idx"
  ON "synthetic_phase_gates"("workspaceId", "projectId", "createdAt" DESC);
CREATE INDEX "synthetic_phase_gates_workspace_version_idx"
  ON "synthetic_phase_gates"("workspaceId", "projectVersionId");
CREATE INDEX "synthetic_phase_gates_workspace_approved_idx"
  ON "synthetic_phase_gates"("workspaceId", "approved", "createdAt" DESC);
CREATE INDEX "synthetic_phase_gates_workspace_actor_created_idx"
  ON "synthetic_phase_gates"("workspaceId", "actorContextHash", "createdAt" DESC);

CREATE UNIQUE INDEX "synthetic_phase_gate_evidence_resource_key"
  ON "synthetic_phase_gate_evidence"("gateId", "criterion", "checkCode", "evidenceType", "resourceId", "resourceHash");
CREATE INDEX "synthetic_phase_gate_evidence_workspace_resource_idx"
  ON "synthetic_phase_gate_evidence"("workspaceId", "evidenceType", "resourceId");
CREATE INDEX "synthetic_phase_gate_evidence_workspace_check_idx"
  ON "synthetic_phase_gate_evidence"("workspaceId", "criterion", "checkCode");

ALTER TABLE "synthetic_phase_gates"
  ADD CONSTRAINT "synthetic_phase_gates_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_phase_gates"
  ADD CONSTRAINT "synthetic_phase_gates_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_phase_gates"
  ADD CONSTRAINT "synthetic_phase_gates_projectVersionId_workspaceId_fkey"
  FOREIGN KEY ("projectVersionId", "workspaceId")
  REFERENCES "project_versions"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_phase_gates"
  ADD CONSTRAINT "synthetic_phase_gates_createdById_workspaceId_fkey"
  FOREIGN KEY ("createdById", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "synthetic_phase_gate_evidence"
  ADD CONSTRAINT "synthetic_phase_gate_evidence_gateId_workspaceId_fkey"
  FOREIGN KEY ("gateId", "workspaceId")
  REFERENCES "synthetic_phase_gates"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "synthetic_phase_gate_evidence"
  ADD CONSTRAINT "synthetic_phase_gate_evidence_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
