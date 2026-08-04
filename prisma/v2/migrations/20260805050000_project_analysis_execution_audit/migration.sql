-- Direct API requests and durable long-form stages share the initiating
-- authentication audit, while durable execution keeps its own operation and
-- workflow lineage. Historical rows remain explicitly unattributed.
ALTER TABLE "long_form_index_runs"
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
  ADD CONSTRAINT "long_form_index_runs_execution_audit_check" CHECK (
    (
      "actorCredentialId" IS NULL AND "actorEnvironment" IS NULL AND
      "actorAuthenticationKind" IS NULL AND "actorContextHash" IS NULL AND
      "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
      "workspaceRole" IS NULL AND "executionKind" IS NULL AND
      "originOperationId" IS NULL AND "originWorkflowId" IS NULL AND
      "originStage" IS NULL AND "originStageInputHash" IS NULL AND
      "originStageIdempotencyKey" IS NULL
    ) OR (
      "actorCredentialId" IS NOT NULL AND
      "actorEnvironment" IS NOT NULL AND
      "actorEnvironment" IN ('sandbox', 'production') AND
      "actorAuthenticationKind" IS NOT NULL AND
      "actorAuthenticationKind" IN ('bearer', 'ui-session') AND
      "actorContextHash" IS NOT NULL AND
      "actorContextHash" ~ '^[a-f0-9]{64}$' AND
      (
        ("actorAuthenticationKind" = 'bearer' AND
          "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
          "workspaceRole" IS NULL) OR
        ("actorAuthenticationKind" = 'ui-session' AND
          "delegatedUserId" IS NOT NULL AND "delegatedIdentityId" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
      ) AND "executionKind" IS NOT NULL AND (
        ("executionKind" = 'external-request' AND
          "originOperationId" IS NULL AND "originWorkflowId" IS NULL AND
          "originStage" IS NULL AND "originStageInputHash" IS NULL AND
          "originStageIdempotencyKey" IS NULL) OR
        ("executionKind" = 'long-form-stage' AND
          "originOperationId" IS NOT NULL AND "originWorkflowId" IS NOT NULL AND
          "originStage" IS NOT NULL AND
          "originStage" = 'moments' AND
          "originStageInputHash" IS NOT NULL AND
          "originStageInputHash" ~ '^[a-f0-9]{64}$' AND
          "originStageIdempotencyKey" IS NOT NULL)
      )
    )
  ),
  ADD CONSTRAINT "long_form_index_runs_origin_operation_fkey"
    FOREIGN KEY ("originOperationId", "workspaceId")
    REFERENCES "public_operations"("id", "workspaceId") ON DELETE RESTRICT,
  ADD CONSTRAINT "long_form_index_runs_origin_workflow_fkey"
    FOREIGN KEY ("originWorkflowId", "workspaceId", "projectId")
    REFERENCES "long_form_index_workflows"("id", "workspaceId", "projectId") ON DELETE RESTRICT;

CREATE INDEX "long_form_index_runs_actor_context_idx"
  ON "long_form_index_runs"("workspaceId", "actorContextHash", "createdAt" DESC);
CREATE INDEX "long_form_index_runs_origin_operation_idx"
  ON "long_form_index_runs"("workspaceId", "originOperationId");
CREATE INDEX "long_form_index_runs_origin_workflow_stage_idx"
  ON "long_form_index_runs"("workspaceId", "originWorkflowId", "originStage");

ALTER TABLE "hierarchical_processing_runs"
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
  ADD CONSTRAINT "hierarchical_processing_runs_execution_audit_check" CHECK (
    (
      "actorCredentialId" IS NULL AND "actorEnvironment" IS NULL AND
      "actorAuthenticationKind" IS NULL AND "actorContextHash" IS NULL AND
      "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
      "workspaceRole" IS NULL AND "executionKind" IS NULL AND
      "originOperationId" IS NULL AND "originWorkflowId" IS NULL AND
      "originStage" IS NULL AND "originStageInputHash" IS NULL AND
      "originStageIdempotencyKey" IS NULL
    ) OR (
      "actorCredentialId" IS NOT NULL AND
      "actorEnvironment" IS NOT NULL AND
      "actorEnvironment" IN ('sandbox', 'production') AND
      "actorAuthenticationKind" IS NOT NULL AND
      "actorAuthenticationKind" IN ('bearer', 'ui-session') AND
      "actorContextHash" IS NOT NULL AND
      "actorContextHash" ~ '^[a-f0-9]{64}$' AND
      (
        ("actorAuthenticationKind" = 'bearer' AND
          "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
          "workspaceRole" IS NULL) OR
        ("actorAuthenticationKind" = 'ui-session' AND
          "delegatedUserId" IS NOT NULL AND "delegatedIdentityId" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
      ) AND "executionKind" IS NOT NULL AND (
        ("executionKind" = 'external-request' AND
          "originOperationId" IS NULL AND "originWorkflowId" IS NULL AND
          "originStage" IS NULL AND "originStageInputHash" IS NULL AND
          "originStageIdempotencyKey" IS NULL) OR
        ("executionKind" = 'long-form-stage' AND
          "originOperationId" IS NOT NULL AND "originWorkflowId" IS NOT NULL AND
          "originStage" IS NOT NULL AND
          "originStage" = 'chunks' AND
          "originStageInputHash" IS NOT NULL AND
          "originStageInputHash" ~ '^[a-f0-9]{64}$' AND
          "originStageIdempotencyKey" IS NOT NULL)
      )
    )
  ),
  ADD CONSTRAINT "hierarchical_processing_runs_origin_operation_fkey"
    FOREIGN KEY ("originOperationId", "workspaceId")
    REFERENCES "public_operations"("id", "workspaceId") ON DELETE RESTRICT,
  ADD CONSTRAINT "hierarchical_processing_runs_origin_workflow_fkey"
    FOREIGN KEY ("originWorkflowId", "workspaceId", "projectId")
    REFERENCES "long_form_index_workflows"("id", "workspaceId", "projectId") ON DELETE RESTRICT;

CREATE INDEX "hierarchical_processing_runs_actor_context_idx"
  ON "hierarchical_processing_runs"("workspaceId", "actorContextHash", "createdAt" DESC);
CREATE INDEX "hierarchical_processing_runs_origin_operation_idx"
  ON "hierarchical_processing_runs"("workspaceId", "originOperationId");
CREATE INDEX "hierarchical_processing_runs_origin_workflow_stage_idx"
  ON "hierarchical_processing_runs"("workspaceId", "originWorkflowId", "originStage");
