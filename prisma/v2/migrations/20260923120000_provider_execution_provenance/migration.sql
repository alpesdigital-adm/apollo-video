ALTER TABLE "provider_result_artifacts"
  ADD COLUMN "recordJson" TEXT,
  ADD COLUMN "recordHash" CHAR(64),
  ADD CONSTRAINT "provider_result_artifacts_record_pair_check" CHECK (("recordJson" IS NULL) = ("recordHash" IS NULL)),
  ADD CONSTRAINT "provider_result_artifacts_record_hash_check" CHECK ("recordHash" IS NULL OR "recordHash" ~ '^[a-f0-9]{64}$');

CREATE TABLE "provider_transport_evidence" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "jobId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "attempt" INTEGER NOT NULL,
  "phase" VARCHAR(16) NOT NULL,
  "runtimeClass" VARCHAR(16) NOT NULL,
  "adapterId" VARCHAR(128) NOT NULL,
  "adapterVersion" VARCHAR(128) NOT NULL,
  "adapterConfigHash" CHAR(64) NOT NULL,
  "endpointClass" VARCHAR(128) NOT NULL,
  "method" VARCHAR(16) NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  "responseHash" CHAR(64) NOT NULL,
  "responseStatus" INTEGER NOT NULL,
  "providerJobRef" VARCHAR(256),
  "observedAt" TIMESTAMPTZ(3) NOT NULL,
  "observationHash" CHAR(64) NOT NULL,
  "inputHash" CHAR(64) NOT NULL,
  "authorizationHash" CHAR(64) NOT NULL,
  "jobHash" CHAR(64) NOT NULL,
  "leaseOwner" VARCHAR(128) NOT NULL,
  "leaseToken" VARCHAR(128) NOT NULL,
  "evidenceHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "provider_transport_evidence_pkey" PRIMARY KEY ("id")
  ,CONSTRAINT "provider_transport_evidence_schema_check" CHECK ("schemaVersion" = 'provider-transport-evidence/v1')
  ,CONSTRAINT "provider_transport_evidence_attempt_check" CHECK ("attempt" >= 1)
  ,CONSTRAINT "provider_transport_evidence_phase_check" CHECK ("phase" IN ('submit', 'retrieve'))
  ,CONSTRAINT "provider_transport_evidence_runtime_check" CHECK ("runtimeClass" IN ('controlled', 'live'))
  ,CONSTRAINT "provider_transport_evidence_method_check" CHECK ("method" ~ '^[A-Z]{3,10}$')
  ,CONSTRAINT "provider_transport_evidence_status_check" CHECK ("responseStatus" BETWEEN 100 AND 599)
  ,CONSTRAINT "provider_transport_evidence_hashes_check" CHECK ("adapterConfigHash" ~ '^[a-f0-9]{64}$' AND "requestHash" ~ '^[a-f0-9]{64}$' AND "responseHash" ~ '^[a-f0-9]{64}$' AND "observationHash" ~ '^[a-f0-9]{64}$' AND "inputHash" ~ '^[a-f0-9]{64}$' AND "authorizationHash" ~ '^[a-f0-9]{64}$' AND "jobHash" ~ '^[a-f0-9]{64}$' AND "evidenceHash" ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX "provider_transport_evidence_id_workspace_key" ON "provider_transport_evidence"("id", "workspaceId");
CREATE UNIQUE INDEX "provider_transport_evidence_attempt_phase_key" ON "provider_transport_evidence"("workspaceId", "jobId", "attempt", "phase", "observationHash");
CREATE INDEX "provider_transport_evidence_job_phase_idx" ON "provider_transport_evidence"("workspaceId", "projectId", "jobId", "phase", "observedAt");

CREATE TABLE "provider_execution_receipts" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "jobId" VARCHAR(128) NOT NULL,
  "attempt" INTEGER NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "runtimeClass" VARCHAR(16) NOT NULL,
  "adapterId" VARCHAR(128) NOT NULL,
  "adapterVersion" VARCHAR(128) NOT NULL,
  "adapterConfigHash" CHAR(64) NOT NULL,
  "inputHash" CHAR(64) NOT NULL,
  "authorizationHash" CHAR(64) NOT NULL,
  "providerJobRef" VARCHAR(256) NOT NULL,
  "leaseOwner" VARCHAR(128) NOT NULL,
  "leaseToken" VARCHAR(128) NOT NULL,
  "submitEvidenceId" VARCHAR(128) NOT NULL,
  "submitEvidenceHash" CHAR(64) NOT NULL,
  "retrieveEvidenceId" VARCHAR(128),
  "retrieveEvidenceHash" CHAR(64),
  "receiptJson" TEXT NOT NULL,
  "receiptHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "provider_execution_receipts_pkey" PRIMARY KEY ("id")
  ,CONSTRAINT "provider_execution_receipts_schema_check" CHECK ("schemaVersion" = 'provider-execution-receipt/v1')
  ,CONSTRAINT "provider_execution_receipts_attempt_check" CHECK ("attempt" >= 1)
  ,CONSTRAINT "provider_execution_receipts_runtime_check" CHECK ("runtimeClass" IN ('controlled', 'live'))
  ,CONSTRAINT "provider_execution_receipts_retrieve_pair_check" CHECK (("retrieveEvidenceId" IS NULL) = ("retrieveEvidenceHash" IS NULL))
  ,CONSTRAINT "provider_execution_receipts_hashes_check" CHECK ("adapterConfigHash" ~ '^[a-f0-9]{64}$' AND "inputHash" ~ '^[a-f0-9]{64}$' AND "authorizationHash" ~ '^[a-f0-9]{64}$' AND "submitEvidenceHash" ~ '^[a-f0-9]{64}$' AND ("retrieveEvidenceHash" IS NULL OR "retrieveEvidenceHash" ~ '^[a-f0-9]{64}$') AND "receiptHash" ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX "provider_execution_receipts_id_workspace_key" ON "provider_execution_receipts"("id", "workspaceId");
CREATE UNIQUE INDEX "provider_execution_receipts_id_workspace_project_key" ON "provider_execution_receipts"("id", "workspaceId", "projectId");
CREATE UNIQUE INDEX "provider_execution_receipts_id_workspace_project_job_key" ON "provider_execution_receipts"("id", "workspaceId", "projectId", "jobId");
CREATE UNIQUE INDEX "provider_execution_receipts_job_key" ON "provider_execution_receipts"("jobId", "workspaceId", "projectId");
CREATE INDEX "provider_execution_receipts_project_created_idx" ON "provider_execution_receipts"("workspaceId", "projectId", "createdAt" DESC);

CREATE TABLE "provider_execution_receipt_results" (
  "receiptId" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "jobId" VARCHAR(128) NOT NULL,
  "resultRecordId" VARCHAR(128) NOT NULL,
  "resultRecordHash" CHAR(64) NOT NULL,
  "role" VARCHAR(32) NOT NULL,
  "artifactId" VARCHAR(128) NOT NULL,
  "artifactSha256" CHAR(64) NOT NULL,
  "byteSize" BIGINT NOT NULL,
  CONSTRAINT "provider_execution_receipt_results_pkey" PRIMARY KEY ("receiptId", "resultRecordId")
  ,CONSTRAINT "provider_execution_receipt_results_role_check" CHECK ("role" IN ('primary-audio', 'primary-video', 'alignment-evidence'))
  ,CONSTRAINT "provider_execution_receipt_results_size_check" CHECK ("byteSize" > 0)
  ,CONSTRAINT "provider_execution_receipt_results_hashes_check" CHECK ("resultRecordHash" ~ '^[a-f0-9]{64}$' AND "artifactSha256" ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX "provider_execution_receipt_results_role_key" ON "provider_execution_receipt_results"("receiptId", "role");
CREATE INDEX "provider_execution_receipt_results_artifact_idx" ON "provider_execution_receipt_results"("workspaceId", "projectId", "artifactId");

ALTER TABLE "provider_transport_evidence" ADD CONSTRAINT "provider_transport_evidence_workspace_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_transport_evidence" ADD CONSTRAINT "provider_transport_evidence_project_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "provider_transport_evidence" ADD CONSTRAINT "provider_transport_evidence_job_fkey" FOREIGN KEY ("jobId", "workspaceId", "projectId") REFERENCES "provider_jobs"("id", "workspaceId", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "provider_execution_receipts" ADD CONSTRAINT "provider_execution_receipts_workspace_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_execution_receipts" ADD CONSTRAINT "provider_execution_receipts_project_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "provider_execution_receipts" ADD CONSTRAINT "provider_execution_receipts_job_fkey" FOREIGN KEY ("jobId", "workspaceId", "projectId") REFERENCES "provider_jobs"("id", "workspaceId", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "provider_execution_receipts" ADD CONSTRAINT "provider_execution_receipts_submit_fkey" FOREIGN KEY ("submitEvidenceId", "workspaceId") REFERENCES "provider_transport_evidence"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_execution_receipts" ADD CONSTRAINT "provider_execution_receipts_retrieve_fkey" FOREIGN KEY ("retrieveEvidenceId", "workspaceId") REFERENCES "provider_transport_evidence"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "provider_execution_receipt_results" ADD CONSTRAINT "provider_execution_receipt_results_workspace_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_execution_receipt_results" ADD CONSTRAINT "provider_execution_receipt_results_project_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "provider_execution_receipt_results" ADD CONSTRAINT "provider_execution_receipt_results_receipt_fkey" FOREIGN KEY ("receiptId", "workspaceId", "projectId", "jobId") REFERENCES "provider_execution_receipts"("id", "workspaceId", "projectId", "jobId") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "provider_result_artifacts_id_workspace_project_job_key" ON "provider_result_artifacts"("id", "workspaceId", "projectId", "jobId");
ALTER TABLE "provider_execution_receipt_results" ADD CONSTRAINT "provider_execution_receipt_results_result_fkey" FOREIGN KEY ("resultRecordId", "workspaceId", "projectId", "jobId") REFERENCES "provider_result_artifacts"("id", "workspaceId", "projectId", "jobId") ON DELETE RESTRICT ON UPDATE CASCADE;
