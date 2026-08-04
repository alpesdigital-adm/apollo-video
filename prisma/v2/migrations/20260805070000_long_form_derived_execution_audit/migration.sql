-- Derived long-form analyses retain the initiating external identity and the
-- exact durable stage that was allowed to publish them. Historical rows stay
-- explicitly unattributed and fail closed in application hydration.

ALTER TABLE "speaker_diarization_runs"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32),
  ADD COLUMN "executionKind" VARCHAR(32),
  ADD COLUMN "originOperationId" VARCHAR(128),
  ADD COLUMN "originWorkflowId" VARCHAR(128),
  ADD COLUMN "originStage" VARCHAR(32),
  ADD COLUMN "originStageInputHash" CHAR(64),
  ADD COLUMN "originStageIdempotencyKey" VARCHAR(256),
  ADD CONSTRAINT "speaker_diarization_runs_execution_audit_check" CHECK (
    (
      "actorCredentialId" IS NULL AND "actorEnvironment" IS NULL AND
      "actorAuthenticationKind" IS NULL AND "actorContextHash" IS NULL AND
      "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
      "workspaceRole" IS NULL AND "executionKind" IS NULL AND
      "originOperationId" IS NULL AND "originWorkflowId" IS NULL AND
      "originStage" IS NULL AND "originStageInputHash" IS NULL AND
      "originStageIdempotencyKey" IS NULL
    ) OR (
      "actorCredentialId" IS NOT NULL AND "actorEnvironment" IS NOT NULL AND
      "actorEnvironment" IN ('sandbox', 'production') AND
      "actorAuthenticationKind" IS NOT NULL AND
      "actorAuthenticationKind" IN ('bearer', 'ui-session') AND
      "actorContextHash" IS NOT NULL AND "actorContextHash" ~ '^[a-f0-9]{64}$' AND
      "executionKind" = 'long-form-stage' AND
      "originOperationId" IS NOT NULL AND "originWorkflowId" IS NOT NULL AND
      "originWorkflowId" = "workflowId" AND
      "originStage" = 'diarization' AND
      "originStageInputHash" IS NOT NULL AND
      "originStageInputHash" ~ '^[a-f0-9]{64}$' AND
      "originStageIdempotencyKey" IS NOT NULL AND
      (
        ("actorAuthenticationKind" = 'bearer' AND
          "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
          "workspaceRole" IS NULL) OR
        ("actorAuthenticationKind" = 'ui-session' AND
          "delegatedUserId" IS NOT NULL AND "delegatedIdentityId" IS NOT NULL AND
          "workspaceRole" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
      )
    )
  ),
  ADD CONSTRAINT "speaker_diarization_runs_origin_operation_fkey"
    FOREIGN KEY ("originOperationId", "workspaceId")
    REFERENCES "public_operations"("id", "workspaceId") ON DELETE RESTRICT,
  ADD CONSTRAINT "speaker_diarization_runs_origin_workflow_fkey"
    FOREIGN KEY ("originWorkflowId", "workspaceId", "projectId")
    REFERENCES "long_form_index_workflows"("id", "workspaceId", "projectId") ON DELETE RESTRICT;

CREATE INDEX "speaker_diarization_runs_actor_context_idx"
  ON "speaker_diarization_runs"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "contiguous_evidence_runs"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32),
  ADD COLUMN "executionKind" VARCHAR(32),
  ADD COLUMN "originOperationId" VARCHAR(128),
  ADD COLUMN "originWorkflowId" VARCHAR(128),
  ADD COLUMN "originStage" VARCHAR(32),
  ADD COLUMN "originStageInputHash" CHAR(64),
  ADD COLUMN "originStageIdempotencyKey" VARCHAR(256),
  ADD CONSTRAINT "contiguous_evidence_runs_execution_audit_check" CHECK (
    (
      "actorCredentialId" IS NULL AND "actorEnvironment" IS NULL AND
      "actorAuthenticationKind" IS NULL AND "actorContextHash" IS NULL AND
      "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
      "workspaceRole" IS NULL AND "executionKind" IS NULL AND
      "originOperationId" IS NULL AND "originWorkflowId" IS NULL AND
      "originStage" IS NULL AND "originStageInputHash" IS NULL AND
      "originStageIdempotencyKey" IS NULL
    ) OR (
      "actorCredentialId" IS NOT NULL AND "actorEnvironment" IS NOT NULL AND
      "actorEnvironment" IN ('sandbox', 'production') AND
      "actorAuthenticationKind" IS NOT NULL AND
      "actorAuthenticationKind" IN ('bearer', 'ui-session') AND
      "actorContextHash" IS NOT NULL AND "actorContextHash" ~ '^[a-f0-9]{64}$' AND
      "executionKind" = 'long-form-stage' AND
      "originOperationId" IS NOT NULL AND "originWorkflowId" IS NOT NULL AND
      "originStage" = 'moments' AND
      "originStageInputHash" IS NOT NULL AND
      "originStageInputHash" ~ '^[a-f0-9]{64}$' AND
      "originStageIdempotencyKey" IS NOT NULL AND
      (
        ("actorAuthenticationKind" = 'bearer' AND
          "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
          "workspaceRole" IS NULL) OR
        ("actorAuthenticationKind" = 'ui-session' AND
          "delegatedUserId" IS NOT NULL AND "delegatedIdentityId" IS NOT NULL AND
          "workspaceRole" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
      )
    )
  ),
  ADD CONSTRAINT "contiguous_evidence_runs_origin_operation_fkey"
    FOREIGN KEY ("originOperationId", "workspaceId")
    REFERENCES "public_operations"("id", "workspaceId") ON DELETE RESTRICT,
  ADD CONSTRAINT "contiguous_evidence_runs_origin_workflow_fkey"
    FOREIGN KEY ("originWorkflowId", "workspaceId", "projectId")
    REFERENCES "long_form_index_workflows"("id", "workspaceId", "projectId") ON DELETE RESTRICT;

CREATE INDEX "contiguous_evidence_runs_actor_context_idx"
  ON "contiguous_evidence_runs"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "contiguous_evaluation_runs"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32),
  ADD COLUMN "executionKind" VARCHAR(32),
  ADD COLUMN "originOperationId" VARCHAR(128),
  ADD COLUMN "originWorkflowId" VARCHAR(128),
  ADD COLUMN "originStage" VARCHAR(32),
  ADD COLUMN "originStageInputHash" CHAR(64),
  ADD COLUMN "originStageIdempotencyKey" VARCHAR(256),
  ADD CONSTRAINT "contiguous_evaluation_runs_execution_audit_check" CHECK (
    (
      "actorCredentialId" IS NULL AND "actorEnvironment" IS NULL AND
      "actorAuthenticationKind" IS NULL AND "actorContextHash" IS NULL AND
      "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
      "workspaceRole" IS NULL AND "executionKind" IS NULL AND
      "originOperationId" IS NULL AND "originWorkflowId" IS NULL AND
      "originStage" IS NULL AND "originStageInputHash" IS NULL AND
      "originStageIdempotencyKey" IS NULL
    ) OR (
      "actorCredentialId" IS NOT NULL AND "actorEnvironment" IS NOT NULL AND
      "actorEnvironment" IN ('sandbox', 'production') AND
      "actorAuthenticationKind" IS NOT NULL AND
      "actorAuthenticationKind" IN ('bearer', 'ui-session') AND
      "actorContextHash" IS NOT NULL AND "actorContextHash" ~ '^[a-f0-9]{64}$' AND
      "executionKind" = 'long-form-stage' AND
      "originOperationId" IS NOT NULL AND "originWorkflowId" IS NOT NULL AND
      "originStage" = 'moments' AND
      "originStageInputHash" IS NOT NULL AND
      "originStageInputHash" ~ '^[a-f0-9]{64}$' AND
      "originStageIdempotencyKey" IS NOT NULL AND
      (
        ("actorAuthenticationKind" = 'bearer' AND
          "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
          "workspaceRole" IS NULL) OR
        ("actorAuthenticationKind" = 'ui-session' AND
          "delegatedUserId" IS NOT NULL AND "delegatedIdentityId" IS NOT NULL AND
          "workspaceRole" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
      )
    )
  ),
  ADD CONSTRAINT "contiguous_evaluation_runs_origin_operation_fkey"
    FOREIGN KEY ("originOperationId", "workspaceId")
    REFERENCES "public_operations"("id", "workspaceId") ON DELETE RESTRICT,
  ADD CONSTRAINT "contiguous_evaluation_runs_origin_workflow_fkey"
    FOREIGN KEY ("originWorkflowId", "workspaceId", "projectId")
    REFERENCES "long_form_index_workflows"("id", "workspaceId", "projectId") ON DELETE RESTRICT;

CREATE INDEX "contiguous_evaluation_runs_actor_context_idx"
  ON "contiguous_evaluation_runs"("workspaceId", "actorContextHash", "createdAt" DESC);
