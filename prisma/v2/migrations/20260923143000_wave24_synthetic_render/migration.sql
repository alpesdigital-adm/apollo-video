ALTER TABLE "provider_result_artifacts"
  DROP CONSTRAINT "provider_result_artifacts_role_check",
  DROP CONSTRAINT "provider_result_artifacts_media_check",
  ADD CONSTRAINT "provider_result_artifacts_role_check"
    CHECK ("role" IN ('primary-audio', 'primary-video', 'alignment-evidence', 'output-speech-evidence')),
  ADD CONSTRAINT "provider_result_artifacts_media_check" CHECK (
    ("role" = 'primary-audio' AND "mediaType" = 'audio') OR
    ("role" = 'primary-video' AND "mediaType" = 'video') OR
    ("role" IN ('alignment-evidence', 'output-speech-evidence') AND "mediaType" = 'data')
  );

ALTER TABLE "provider_execution_receipt_results"
  DROP CONSTRAINT "provider_execution_receipt_results_role_check",
  ADD CONSTRAINT "provider_execution_receipt_results_role_check"
    CHECK ("role" IN ('primary-audio', 'primary-video', 'alignment-evidence', 'output-speech-evidence'));

-- A controlled or otherwise zero-priced source can still be a real reuse.
-- A hit must name a durable candidate, while the general amount constraint
-- continues to reject negative values and non-hits must still record zero avoided cost.
ALTER TABLE "synthetic_cache_decisions"
  DROP CONSTRAINT "synthetic_cache_decisions_hit_check",
  ADD CONSTRAINT "synthetic_cache_decisions_hit_check"
    CHECK ("outcome" <> 'hit' OR (
      "candidateGenerationId" IS NOT NULL OR "candidateMasterId" IS NOT NULL
    ));

ALTER TABLE "public_operations"
  DROP CONSTRAINT "public_operations_type_check",
  DROP CONSTRAINT "public_operations_type_target_check",
  DROP CONSTRAINT "public_operations_project_scope_check";

ALTER TABLE "public_operations"
  ADD CONSTRAINT "public_operations_type_check"
  CHECK ("type" IN ('artifact-render', 'synthetic-production-render', 'media-ingest', 'project-proxy-render', 'project-final-export', 'source-cleanup', 'long-form-index', 'project-director-run')),
  ADD CONSTRAINT "public_operations_type_target_check"
  CHECK (
    ("type" IN ('project-director-run', 'synthetic-production-render') AND "targetType" = 'project-version')
    OR
    ("type" NOT IN ('project-director-run', 'synthetic-production-render') AND "targetType" = 'media-artifact')
  ),
  ADD CONSTRAINT "public_operations_project_scope_check"
  CHECK (
    ("type" = 'artifact-render' AND "projectId" IS NULL)
    OR
    (
      "type" IN ('media-ingest', 'project-proxy-render', 'project-final-export', 'source-cleanup', 'long-form-index', 'project-director-run', 'synthetic-production-render')
      AND "projectId" IS NOT NULL
    )
  );

ALTER TABLE "synthetic_production_runs"
  ADD COLUMN "audioMasterId" VARCHAR(128),
  ADD COLUMN "audioMasterHash" CHAR(64),
  ADD COLUMN "audioOriginProjectId" VARCHAR(128),
  ADD CONSTRAINT "synthetic_runs_audio_master_fields_check"
  CHECK (
    ("audioMasterId" IS NULL AND "audioMasterHash" IS NULL AND "audioOriginProjectId" IS NULL)
    OR
    ("audioMasterId" IS NOT NULL AND "audioMasterHash" IS NOT NULL AND "audioOriginProjectId" IS NOT NULL)
  ),
  ADD CONSTRAINT "synthetic_runs_audio_master_fkey"
  FOREIGN KEY ("audioMasterId", "workspaceId") REFERENCES "synthetic_audio_masters"("id", "workspaceId") ON DELETE RESTRICT;

CREATE INDEX "synthetic_production_runs_workspace_audio_master_idx"
  ON "synthetic_production_runs"("workspaceId", "audioMasterId");

ALTER TABLE "provider_jobs"
  ADD COLUMN "fallbackLedgerId" VARCHAR(128),
  ADD COLUMN "fallbackLedgerHash" CHAR(64),
  ADD COLUMN "fallbackRung" VARCHAR(24),
  ADD COLUMN "fallbackRejectedJobId" VARCHAR(128),
  ADD COLUMN "fallbackRejectedReportHash" CHAR(64),
  ADD COLUMN "fallbackDispatchRequestHash" CHAR(64),
  ADD CONSTRAINT "provider_jobs_fallback_fields_check"
  CHECK (
    ("fallbackLedgerId" IS NULL AND "fallbackLedgerHash" IS NULL AND "fallbackRung" IS NULL AND "fallbackRejectedJobId" IS NULL AND "fallbackRejectedReportHash" IS NULL AND "fallbackDispatchRequestHash" IS NULL)
    OR
    ("fallbackLedgerId" IS NOT NULL AND "fallbackLedgerHash" IS NOT NULL AND "fallbackRung" IS NOT NULL AND "fallbackRejectedJobId" IS NOT NULL AND "fallbackRejectedReportHash" IS NOT NULL AND "fallbackDispatchRequestHash" IS NOT NULL)
  );

CREATE UNIQUE INDEX "transformation_critic_reports_workspace_hash_key"
  ON "transformation_critic_reports"("workspaceId", "reportHash");

ALTER TABLE "provider_jobs"
  ADD CONSTRAINT "provider_jobs_fallback_ledger_fkey"
    FOREIGN KEY ("fallbackLedgerId", "workspaceId") REFERENCES "transformation_fallback_ledgers"("id", "workspaceId") ON DELETE RESTRICT,
  ADD CONSTRAINT "provider_jobs_fallback_rejected_job_fkey"
    FOREIGN KEY ("fallbackRejectedJobId", "workspaceId", "projectId") REFERENCES "provider_jobs"("id", "workspaceId", "projectId") ON DELETE RESTRICT,
  ADD CONSTRAINT "provider_jobs_fallback_rejected_report_fkey"
    FOREIGN KEY ("workspaceId", "fallbackRejectedReportHash") REFERENCES "transformation_critic_reports"("workspaceId", "reportHash") ON DELETE RESTRICT;

CREATE INDEX "provider_jobs_workspace_fallback_ledger_created_idx"
  ON "provider_jobs"("workspaceId", "fallbackLedgerId", "createdAt" DESC);
CREATE UNIQUE INDEX "provider_jobs_fallback_dispatch_key"
  ON "provider_jobs"("workspaceId", "projectId", "fallbackLedgerId", "fallbackRung")
  WHERE "fallbackLedgerId" IS NOT NULL;

ALTER TABLE "transformation_provider_selections"
  ADD COLUMN "requestedOperation" VARCHAR(32);

ALTER TABLE "transformation_fallback_attempts"
  ADD COLUMN "dispatchRequestHash" CHAR(64),
  ADD COLUMN "actorClientId" VARCHAR(80),
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32),
  ADD CONSTRAINT "transformation_fallback_attempts_dispatch_audit_check" CHECK (
    ("dispatchRequestHash" IS NULL AND "actorClientId" IS NULL AND "actorCredentialId" IS NULL AND "actorEnvironment" IS NULL AND "actorAuthenticationKind" IS NULL AND "actorContextHash" IS NULL AND "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND "workspaceRole" IS NULL)
    OR
    ("dispatchRequestHash" IS NOT NULL AND "actorClientId" IS NOT NULL AND "actorCredentialId" IS NOT NULL AND "actorEnvironment" IS NOT NULL AND "actorAuthenticationKind" IS NOT NULL AND "actorContextHash" IS NOT NULL)
  ),
  ADD CONSTRAINT "transformation_fallback_attempts_dispatch_actor_fkey"
    FOREIGN KEY ("actorClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT;

ALTER TABLE "synthetic_critic_reports"
  ADD COLUMN "providerJobId" VARCHAR(128),
  ADD COLUMN "outputSpeechEvidenceArtifactId" VARCHAR(128),
  ADD COLUMN "sourceAudioArtifactId" VARCHAR(128),
  ADD COLUMN "sourceAudioRangeHash" CHAR(64),
  ADD COLUMN "sourceAudioPcmSha256" CHAR(64),
  ADD COLUMN "outputAudioPcmSha256" CHAR(64),
  ADD COLUMN "outputSpeechEvidenceHash" CHAR(64),
  ADD COLUMN "audioSampleRateHz" INTEGER,
  ADD COLUMN "alignedLagSamples" INTEGER,
  ADD COLUMN "sourceRmsBps" INTEGER,
  ADD COLUMN "outputRmsBps" INTEGER,
  ADD COLUMN "audioPassed" BOOLEAN,
  ADD COLUMN "sourceAudioDurationMs" INTEGER,
  ADD COLUMN "outputAudioDurationMs" INTEGER,
  ADD COLUMN "audioComparisonPolicyVersion" VARCHAR(128),
  ADD COLUMN "audioCorrelationBps" INTEGER,
  ADD COLUMN "audioNormalizedErrorBps" INTEGER,
  ADD COLUMN "audioComparedSampleCount" INTEGER,
  ADD COLUMN "sourceCoverageBps" INTEGER,
  ADD COLUMN "outputCoverageBps" INTEGER,
  ADD COLUMN "worstWindowCorrelationBps" INTEGER,
  ADD COLUMN "worstWindowNormalizedErrorBps" INTEGER,
  ADD COLUMN "failedWindowCount" INTEGER,
  ADD COLUMN "comparedWindowCount" INTEGER,
  ADD COLUMN "outputSpeechEvidenceKind" VARCHAR(16),
  ADD COLUMN "outputSpeechEvaluatorId" VARCHAR(128),
  ADD COLUMN "outputSpeechEvaluatorVersion" VARCHAR(128),
  ADD COLUMN "outputTranscriptHash" CHAR(64),
  ADD COLUMN "observedIdentityRef" VARCHAR(256),
  ADD CONSTRAINT "synthetic_critic_output_speech_artifact_fkey"
    FOREIGN KEY ("outputSpeechEvidenceArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT,
  ADD CONSTRAINT "synthetic_critic_source_audio_artifact_fkey"
    FOREIGN KEY ("sourceAudioArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT;

ALTER TABLE "synthetic_critic_reports"
  ADD CONSTRAINT "synthetic_critic_reports_provider_job_fkey"
    FOREIGN KEY ("providerJobId", "workspaceId", "projectId") REFERENCES "provider_jobs"("id", "workspaceId", "projectId") ON DELETE RESTRICT;

CREATE INDEX "synthetic_critic_reports_workspace_provider_job_idx"
  ON "synthetic_critic_reports"("workspaceId", "providerJobId");

CREATE TABLE "transformation_fallback_dispatch_claims" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "actorClientId" VARCHAR(80) NOT NULL,
  "actorCredentialId" VARCHAR(128),
  "actorEnvironment" VARCHAR(16),
  "actorAuthenticationKind" VARCHAR(16),
  "actorContextHash" CHAR(64) NOT NULL,
  "delegatedUserId" VARCHAR(128),
  "delegatedIdentityId" VARCHAR(128),
  "workspaceRole" VARCHAR(32),
  "dispatchRequestHash" CHAR(64) NOT NULL,
  "requestedLedgerId" VARCHAR(128) NOT NULL,
  "requestedLedgerHash" CHAR(64) NOT NULL,
  "briefId" VARCHAR(128) NOT NULL,
  "rung" VARCHAR(24) NOT NULL,
  "outcome" VARCHAR(16) NOT NULL,
  "providerJobId" VARCHAR(128),
  "resultLedgerId" VARCHAR(128),
  "resultLedgerHash" CHAR(64),
  "reason" VARCHAR(300),
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "settledAt" TIMESTAMPTZ(3),
  CONSTRAINT "transformation_fallback_dispatch_claims_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transformation_fallback_claims_outcome_check" CHECK (
    ("outcome" = 'pending' AND "providerJobId" IS NULL AND "resultLedgerId" IS NULL AND "resultLedgerHash" IS NULL AND "reason" IS NULL AND "settledAt" IS NULL)
    OR
    ("outcome" = 'enqueued' AND "providerJobId" IS NOT NULL AND "resultLedgerId" IS NULL AND "resultLedgerHash" IS NULL AND "reason" IS NULL AND "settledAt" IS NOT NULL)
    OR
    ("outcome" = 'skipped' AND "providerJobId" IS NULL AND "resultLedgerId" IS NOT NULL AND "resultLedgerHash" IS NOT NULL AND "reason" IS NOT NULL AND "settledAt" IS NOT NULL)
  )
);

ALTER TABLE "transformation_fallback_dispatch_claims"
  ADD CONSTRAINT "transformation_fallback_claims_workspace_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "transformation_fallback_claims_project_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE RESTRICT,
  ADD CONSTRAINT "transformation_fallback_claims_actor_fkey" FOREIGN KEY ("actorClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT,
  ADD CONSTRAINT "transformation_fallback_claims_requested_ledger_fkey" FOREIGN KEY ("requestedLedgerId", "workspaceId") REFERENCES "transformation_fallback_ledgers"("id", "workspaceId") ON DELETE RESTRICT,
  ADD CONSTRAINT "transformation_fallback_claims_result_ledger_fkey" FOREIGN KEY ("resultLedgerId", "workspaceId") REFERENCES "transformation_fallback_ledgers"("id", "workspaceId") ON DELETE RESTRICT,
  ADD CONSTRAINT "transformation_fallback_claims_job_fkey" FOREIGN KEY ("providerJobId", "workspaceId", "projectId") REFERENCES "provider_jobs"("id", "workspaceId", "projectId") ON DELETE RESTRICT;

CREATE UNIQUE INDEX "transformation_fallback_claims_id_workspace_key" ON "transformation_fallback_dispatch_claims"("id", "workspaceId");
CREATE UNIQUE INDEX "transformation_fallback_claims_ledger_rung_key" ON "transformation_fallback_dispatch_claims"("workspaceId", "projectId", "requestedLedgerId", "rung");
CREATE INDEX "transformation_fallback_claims_project_idx" ON "transformation_fallback_dispatch_claims"("workspaceId", "projectId", "createdAt" DESC);

CREATE TABLE "transformation_fallback_dispatch_requests" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "actorClientId" VARCHAR(80) NOT NULL,
  "actorCredentialId" VARCHAR(128),
  "actorEnvironment" VARCHAR(16),
  "actorAuthenticationKind" VARCHAR(16),
  "actorContextHash" CHAR(64) NOT NULL,
  "delegatedUserId" VARCHAR(128),
  "delegatedIdentityId" VARCHAR(128),
  "workspaceRole" VARCHAR(32),
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "claimId" VARCHAR(128) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "transformation_fallback_dispatch_requests_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "transformation_fallback_dispatch_requests"
  ADD CONSTRAINT "transformation_fallback_requests_workspace_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "transformation_fallback_requests_project_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE RESTRICT,
  ADD CONSTRAINT "transformation_fallback_requests_actor_fkey" FOREIGN KEY ("actorClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT,
  ADD CONSTRAINT "transformation_fallback_requests_claim_fkey" FOREIGN KEY ("claimId", "workspaceId") REFERENCES "transformation_fallback_dispatch_claims"("id", "workspaceId") ON DELETE RESTRICT;

CREATE UNIQUE INDEX "transformation_fallback_requests_id_workspace_key" ON "transformation_fallback_dispatch_requests"("id", "workspaceId");
CREATE UNIQUE INDEX "transformation_fallback_requests_actor_key" ON "transformation_fallback_dispatch_requests"("workspaceId", "actorClientId", "idempotencyKey");
CREATE INDEX "transformation_fallback_requests_project_idx" ON "transformation_fallback_dispatch_requests"("workspaceId", "projectId", "createdAt" DESC);

CREATE TABLE "synthetic_production_render_operations" (
  "operationId" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "projectVersionId" VARCHAR(128) NOT NULL,
  "projectVersionHash" CHAR(64) NOT NULL,
  "productionRunId" VARCHAR(128) NOT NULL,
  "editPlanSnapshotId" VARCHAR(128) NOT NULL,
  "editPlanSnapshotHash" CHAR(64) NOT NULL,
  "planHash" CHAR(64) NOT NULL,
  "outputKind" VARCHAR(16) NOT NULL,
  "aspectRatio" VARCHAR(16) NOT NULL,
  "renderInputRef" VARCHAR(128) NOT NULL,
  "renderInputHash" CHAR(64) NOT NULL,
  "propsHash" CHAR(64) NOT NULL,
  "outputArtifactId" VARCHAR(128) NOT NULL,
  "outputManifestId" VARCHAR(128) NOT NULL,
  "contextJson" TEXT NOT NULL,
  "contextHash" CHAR(64) NOT NULL,
  "runtimeCommitSha" VARCHAR(64),
  "runtimeTreeHash" CHAR(64),
  "runtimeContractGraphHash" CHAR(64),
  "runtimeToolchainHash" CHAR(64),
  "runtimeRenderBundleHash" CHAR(64),
  "runtimeIdentityHash" CHAR(64),
  "checkpointAttempt" INTEGER,
  "checkpointOutputKey" TEXT,
  "checkpointOutputSha256" CHAR(64),
  "checkpointByteSize" BIGINT,
  "checkpointWidth" INTEGER,
  "checkpointHeight" INTEGER,
  "checkpointFps" DOUBLE PRECISION,
  "checkpointDurationFrames" INTEGER,
  "checkpointCodec" VARCHAR(32),
  "checkpointAudioCodec" VARCHAR(32),
  "checkpointContainer" VARCHAR(32),
  "checkpointCommittedAt" TIMESTAMPTZ(3),
  "checkpointRecordedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "synthetic_production_render_operations_pkey" PRIMARY KEY ("operationId"),
  CONSTRAINT "synthetic_render_output_kind_check" CHECK ("outputKind" IN ('proxy', 'final')),
  CONSTRAINT "synthetic_render_aspect_ratio_check" CHECK ("aspectRatio" IN ('9:16', '16:9', '4:5', '1:1', '21:9')),
  CONSTRAINT "synthetic_render_runtime_fields_check" CHECK (
    ("runtimeCommitSha" IS NULL AND "runtimeTreeHash" IS NULL AND "runtimeContractGraphHash" IS NULL AND "runtimeToolchainHash" IS NULL AND "runtimeRenderBundleHash" IS NULL AND "runtimeIdentityHash" IS NULL)
    OR
    ("runtimeCommitSha" IS NOT NULL AND "runtimeTreeHash" IS NOT NULL AND "runtimeContractGraphHash" IS NOT NULL AND "runtimeToolchainHash" IS NOT NULL AND "runtimeRenderBundleHash" IS NOT NULL AND "runtimeIdentityHash" IS NOT NULL)
  ),
  CONSTRAINT "synthetic_render_checkpoint_fields_check" CHECK (
    ("checkpointAttempt" IS NULL AND "checkpointOutputKey" IS NULL AND "checkpointOutputSha256" IS NULL AND "checkpointByteSize" IS NULL AND "checkpointWidth" IS NULL AND "checkpointHeight" IS NULL AND "checkpointFps" IS NULL AND "checkpointDurationFrames" IS NULL AND "checkpointCodec" IS NULL AND "checkpointAudioCodec" IS NULL AND "checkpointContainer" IS NULL AND "checkpointCommittedAt" IS NULL AND "checkpointRecordedAt" IS NULL)
    OR
    ("runtimeIdentityHash" IS NOT NULL AND "checkpointAttempt" IS NOT NULL AND "checkpointAttempt" > 0 AND "checkpointOutputKey" IS NOT NULL AND "checkpointOutputSha256" IS NOT NULL AND "checkpointByteSize" IS NOT NULL AND "checkpointByteSize" > 0 AND "checkpointWidth" IS NOT NULL AND "checkpointWidth" > 0 AND "checkpointHeight" IS NOT NULL AND "checkpointHeight" > 0 AND "checkpointFps" IS NOT NULL AND "checkpointFps" > 0 AND "checkpointDurationFrames" IS NOT NULL AND "checkpointDurationFrames" > 0 AND "checkpointCodec" IS NOT NULL AND "checkpointCodec" = 'h264' AND "checkpointAudioCodec" IS NOT NULL AND "checkpointAudioCodec" = 'aac' AND "checkpointContainer" IS NOT NULL AND "checkpointContainer" = 'mp4' AND "checkpointCommittedAt" IS NOT NULL AND "checkpointRecordedAt" IS NOT NULL AND "checkpointRecordedAt" >= "checkpointCommittedAt")
  )
);

CREATE UNIQUE INDEX "synthetic_render_ops_operation_workspace_key" ON "synthetic_production_render_operations"("operationId", "workspaceId");
CREATE UNIQUE INDEX "synthetic_render_ops_run_kind_ratio_key" ON "synthetic_production_render_operations"("workspaceId", "productionRunId", "outputKind", "aspectRatio");
CREATE UNIQUE INDEX "synthetic_render_ops_workspace_input_hash_key" ON "synthetic_production_render_operations"("workspaceId", "renderInputHash");
CREATE INDEX "synthetic_render_ops_workspace_project_created_idx" ON "synthetic_production_render_operations"("workspaceId", "projectId", "createdAt" DESC);
CREATE INDEX "synthetic_render_ops_workspace_run_idx" ON "synthetic_production_render_operations"("workspaceId", "productionRunId");

CREATE TABLE "synthetic_production_render_quality_reports" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "projectVersionId" VARCHAR(128) NOT NULL,
  "productionRunId" VARCHAR(128) NOT NULL,
  "operationId" VARCHAR(128) NOT NULL,
  "outputArtifactId" VARCHAR(128) NOT NULL,
  "outputManifestId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "reportJson" TEXT NOT NULL,
  "reportHash" CHAR(64) NOT NULL,
  "passed" BOOLEAN NOT NULL,
  "evaluatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "synthetic_production_render_quality_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "synthetic_render_quality_operation_workspace_key" ON "synthetic_production_render_quality_reports"("operationId", "workspaceId");
CREATE UNIQUE INDEX "synthetic_render_quality_id_workspace_key" ON "synthetic_production_render_quality_reports"("id", "workspaceId");
CREATE UNIQUE INDEX "synthetic_render_quality_workspace_hash_key" ON "synthetic_production_render_quality_reports"("workspaceId", "reportHash");
CREATE INDEX "synthetic_render_quality_workspace_run_idx" ON "synthetic_production_render_quality_reports"("workspaceId", "productionRunId");

CREATE TABLE "synthetic_build_attestations" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "projectVersionId" VARCHAR(128) NOT NULL,
  "projectVersionHash" CHAR(64) NOT NULL,
  "productionRunId" VARCHAR(128) NOT NULL,
  "publicOperationId" VARCHAR(128) NOT NULL,
  "planSnapshotId" VARCHAR(128) NOT NULL,
  "planSnapshotHash" CHAR(64) NOT NULL,
  "renderManifestId" VARCHAR(128) NOT NULL,
  "renderManifestHash" CHAR(64) NOT NULL,
  "runtimeCommitSha" VARCHAR(64) NOT NULL,
  "runtimeTreeHash" CHAR(64) NOT NULL,
  "runtimeContractGraphHash" CHAR(64) NOT NULL,
  "runtimeToolchainHash" CHAR(64) NOT NULL,
  "runtimeRenderBundleHash" CHAR(64) NOT NULL,
  "checksJson" TEXT NOT NULL,
  "startedAt" TIMESTAMPTZ(3) NOT NULL,
  "completedAt" TIMESTAMPTZ(3) NOT NULL,
  "attestationJson" TEXT NOT NULL,
  "attestationHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "synthetic_build_attestations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "synthetic_build_attestation_operation_workspace_key" ON "synthetic_build_attestations"("publicOperationId", "workspaceId");
CREATE UNIQUE INDEX "synthetic_build_attestations_id_workspace_key" ON "synthetic_build_attestations"("id", "workspaceId");
CREATE UNIQUE INDEX "synthetic_build_attestations_workspace_actor_key" ON "synthetic_build_attestations"("workspaceId", "projectId", "idempotencyKey");
CREATE UNIQUE INDEX "synthetic_build_attestations_workspace_hash_key" ON "synthetic_build_attestations"("workspaceId", "attestationHash");
CREATE INDEX "synthetic_build_attestations_workspace_run_idx" ON "synthetic_build_attestations"("workspaceId", "productionRunId");

CREATE TABLE "synthetic_master_consumptions" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "consumerProjectId" VARCHAR(128) NOT NULL,
  "consumerProjectVersionId" VARCHAR(128) NOT NULL,
  "productionRunId" VARCHAR(128) NOT NULL,
  "sourceMasterId" VARCHAR(128) NOT NULL,
  "sourceMasterHash" CHAR(64) NOT NULL,
  "sourceProjectId" VARCHAR(128) NOT NULL,
  "sourceProjectVersionId" VARCHAR(128) NOT NULL,
  "sourceProviderJobId" VARCHAR(128) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL,
  "sourceArtifactSha256" CHAR(64) NOT NULL,
  "cacheDecisionId" VARCHAR(128) NOT NULL,
  "cacheDecisionHash" CHAR(64) NOT NULL,
  "productionPlanHash" CHAR(64) NOT NULL,
  "observationOpenedAt" TIMESTAMPTZ(3) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "consumptionHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "synthetic_master_consumptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "synthetic_master_consumptions_id_workspace_key" ON "synthetic_master_consumptions"("id", "workspaceId");
CREATE UNIQUE INDEX "synthetic_master_consumption_run_workspace_project_key" ON "synthetic_master_consumptions"("productionRunId", "workspaceId", "consumerProjectId");
CREATE UNIQUE INDEX "synthetic_master_consumption_decision_workspace_key" ON "synthetic_master_consumptions"("cacheDecisionId", "workspaceId");
CREATE UNIQUE INDEX "synthetic_master_consumptions_workspace_hash_key" ON "synthetic_master_consumptions"("workspaceId", "consumptionHash");
CREATE INDEX "synthetic_master_consumptions_source_master_idx" ON "synthetic_master_consumptions"("workspaceId", "sourceMasterId");
CREATE INDEX "synthetic_master_consumptions_source_version_idx" ON "synthetic_master_consumptions"("workspaceId", "sourceProjectId", "sourceProjectVersionId");
CREATE INDEX "synthetic_master_consumptions_consumer_opened_idx" ON "synthetic_master_consumptions"("workspaceId", "consumerProjectId", "observationOpenedAt");

ALTER TABLE "synthetic_production_render_operations"
  ADD CONSTRAINT "synthetic_render_ops_workspace_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "synthetic_render_ops_project_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE RESTRICT,
  ADD CONSTRAINT "synthetic_render_ops_version_fkey" FOREIGN KEY ("projectVersionId", "projectId", "workspaceId") REFERENCES "project_versions"("id", "projectId", "workspaceId") ON DELETE RESTRICT,
  ADD CONSTRAINT "synthetic_render_ops_run_fkey" FOREIGN KEY ("productionRunId", "workspaceId", "projectId") REFERENCES "synthetic_production_runs"("id", "workspaceId", "projectId") ON DELETE RESTRICT,
  ADD CONSTRAINT "synthetic_render_ops_snapshot_fkey" FOREIGN KEY ("editPlanSnapshotId", "projectId", "workspaceId") REFERENCES "project_snapshots"("id", "projectId", "workspaceId") ON DELETE RESTRICT,
  ADD CONSTRAINT "synthetic_render_ops_operation_fkey" FOREIGN KEY ("operationId", "workspaceId") REFERENCES "public_operations"("id", "workspaceId") ON DELETE CASCADE,
  ADD CONSTRAINT "synthetic_render_ops_input_fkey" FOREIGN KEY ("workspaceId", "renderInputRef") REFERENCES "render_input_payloads"("workspaceId", "ref") ON DELETE RESTRICT;

ALTER TABLE "synthetic_production_render_quality_reports"
  ADD CONSTRAINT "synthetic_render_quality_workspace_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "synthetic_render_quality_project_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE RESTRICT,
  ADD CONSTRAINT "synthetic_render_quality_version_fkey" FOREIGN KEY ("projectVersionId", "projectId", "workspaceId") REFERENCES "project_versions"("id", "projectId", "workspaceId") ON DELETE RESTRICT,
  ADD CONSTRAINT "synthetic_render_quality_run_fkey" FOREIGN KEY ("productionRunId", "workspaceId", "projectId") REFERENCES "synthetic_production_runs"("id", "workspaceId", "projectId") ON DELETE RESTRICT,
  ADD CONSTRAINT "synthetic_render_quality_operation_fkey" FOREIGN KEY ("operationId", "workspaceId") REFERENCES "synthetic_production_render_operations"("operationId", "workspaceId") ON DELETE CASCADE,
  ADD CONSTRAINT "synthetic_render_quality_artifact_fkey" FOREIGN KEY ("outputArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT,
  ADD CONSTRAINT "synthetic_render_quality_manifest_fkey" FOREIGN KEY ("outputManifestId", "outputArtifactId", "workspaceId") REFERENCES "media_artifact_manifests"("id", "artifactId", "workspaceId") ON DELETE RESTRICT;

ALTER TABLE "synthetic_build_attestations"
  ADD CONSTRAINT "synthetic_build_attestations_workspace_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "synthetic_build_attestations_project_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE RESTRICT,
  ADD CONSTRAINT "synthetic_build_attestations_version_fkey" FOREIGN KEY ("projectVersionId", "projectId", "workspaceId") REFERENCES "project_versions"("id", "projectId", "workspaceId") ON DELETE RESTRICT,
  ADD CONSTRAINT "synthetic_build_attestations_run_fkey" FOREIGN KEY ("productionRunId", "workspaceId", "projectId") REFERENCES "synthetic_production_runs"("id", "workspaceId", "projectId") ON DELETE RESTRICT,
  ADD CONSTRAINT "synthetic_build_attestations_operation_fkey" FOREIGN KEY ("publicOperationId", "workspaceId") REFERENCES "synthetic_production_render_operations"("operationId", "workspaceId") ON DELETE RESTRICT,
  ADD CONSTRAINT "synthetic_build_attestations_manifest_fkey" FOREIGN KEY ("renderManifestId", "workspaceId") REFERENCES "media_artifact_manifests"("id", "workspaceId") ON DELETE RESTRICT;

ALTER TABLE "synthetic_master_consumptions"
  ADD CONSTRAINT "synthetic_master_consumptions_workspace_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "synthetic_master_consumptions_consumer_project_fkey" FOREIGN KEY ("consumerProjectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE RESTRICT,
  ADD CONSTRAINT "synthetic_master_consumptions_consumer_version_fkey" FOREIGN KEY ("consumerProjectVersionId", "consumerProjectId", "workspaceId") REFERENCES "project_versions"("id", "projectId", "workspaceId") ON DELETE RESTRICT,
  ADD CONSTRAINT "synthetic_master_consumptions_run_fkey" FOREIGN KEY ("productionRunId", "workspaceId", "consumerProjectId") REFERENCES "synthetic_production_runs"("id", "workspaceId", "projectId") ON DELETE RESTRICT,
  ADD CONSTRAINT "synthetic_master_consumptions_source_master_fkey" FOREIGN KEY ("sourceMasterId", "workspaceId") REFERENCES "synthetic_master_assets"("id", "workspaceId") ON DELETE RESTRICT,
  ADD CONSTRAINT "synthetic_master_consumptions_source_project_fkey" FOREIGN KEY ("sourceProjectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE RESTRICT,
  ADD CONSTRAINT "synthetic_master_consumptions_source_version_fkey" FOREIGN KEY ("sourceProjectVersionId", "sourceProjectId", "workspaceId") REFERENCES "project_versions"("id", "projectId", "workspaceId") ON DELETE RESTRICT,
  ADD CONSTRAINT "synthetic_master_consumptions_source_job_fkey" FOREIGN KEY ("sourceProviderJobId", "workspaceId", "sourceProjectId") REFERENCES "provider_jobs"("id", "workspaceId", "projectId") ON DELETE RESTRICT,
  ADD CONSTRAINT "synthetic_master_consumptions_source_artifact_fkey" FOREIGN KEY ("sourceArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT,
  ADD CONSTRAINT "synthetic_master_consumptions_cache_decision_fkey" FOREIGN KEY ("cacheDecisionId", "workspaceId") REFERENCES "synthetic_cache_decisions"("id", "workspaceId") ON DELETE RESTRICT;
