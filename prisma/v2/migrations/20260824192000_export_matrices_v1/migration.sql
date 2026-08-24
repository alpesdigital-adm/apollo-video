CREATE TABLE "export_matrix_preflights" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "definitionHash" CHAR(64) NOT NULL,
  "preflightHash" CHAR(64) NOT NULL,
  "snapshotHash" CHAR(64) NOT NULL,
  "costFingerprint" CHAR(64) NOT NULL,
  "preflightJson" TEXT NOT NULL,
  "allowed" BOOLEAN NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "actorCredentialId" VARCHAR(128) NOT NULL,
  "actorEnvironment" VARCHAR(16) NOT NULL,
  "actorAuthenticationKind" VARCHAR(16) NOT NULL,
  "actorContextHash" CHAR(64) NOT NULL,
  "delegatedUserId" VARCHAR(128),
  "delegatedIdentityId" VARCHAR(128),
  "workspaceRole" VARCHAR(32),
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "export_matrix_preflights_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "export_matrices" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "preflightId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "definitionHash" CHAR(64) NOT NULL,
  "preflightHash" CHAR(64) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "actorCredentialId" VARCHAR(128) NOT NULL,
  "actorEnvironment" VARCHAR(16) NOT NULL,
  "actorAuthenticationKind" VARCHAR(16) NOT NULL,
  "actorContextHash" CHAR(64) NOT NULL,
  "delegatedUserId" VARCHAR(128),
  "delegatedIdentityId" VARCHAR(128),
  "workspaceRole" VARCHAR(32),
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "export_matrices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "export_matrix_cells" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "matrixId" VARCHAR(128) NOT NULL,
  "sequence" INTEGER NOT NULL,
  "address" VARCHAR(300) NOT NULL,
  "recipeId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "projectVersionId" VARCHAR(128) NOT NULL,
  "projectVersionHash" CHAR(64) NOT NULL,
  "outputAspectRatio" VARCHAR(16) NOT NULL,
  "locale" VARCHAR(35) NOT NULL,
  "outputFileName" VARCHAR(240) NOT NULL,
  "manifestFileName" VARCHAR(240) NOT NULL,
  "cellHash" CHAR(64) NOT NULL,
  "dispatchStatus" VARCHAR(32) NOT NULL,
  "operationId" VARCHAR(128),
  "dispatchErrorCode" VARCHAR(128),
  "dispatchErrorMessage" VARCHAR(500),
  "dispatchRetryable" BOOLEAN,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "export_matrix_cells_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "export_matrix_preflights_id_workspaceId_key" ON "export_matrix_preflights"("id", "workspaceId");
CREATE UNIQUE INDEX "export_matrix_preflights_workspaceId_createdByClientId_idem_key" ON "export_matrix_preflights"("workspaceId", "createdByClientId", "idempotencyKey");
CREATE INDEX "export_matrix_preflights_workspaceId_actorContextHash_creat_idx" ON "export_matrix_preflights"("workspaceId", "actorContextHash", "createdAt" DESC);
CREATE INDEX "export_matrix_preflights_workspaceId_allowed_expiresAt_idx" ON "export_matrix_preflights"("workspaceId", "allowed", "expiresAt");
CREATE UNIQUE INDEX "export_matrices_preflightId_key" ON "export_matrices"("preflightId");
CREATE UNIQUE INDEX "export_matrices_id_workspaceId_key" ON "export_matrices"("id", "workspaceId");
CREATE UNIQUE INDEX "export_matrices_preflightId_workspaceId_key" ON "export_matrices"("preflightId", "workspaceId");
CREATE INDEX "export_matrices_workspaceId_createdAt_id_idx" ON "export_matrices"("workspaceId", "createdAt" DESC, "id" DESC);
CREATE INDEX "export_matrices_workspaceId_actorContextHash_createdAt_idx" ON "export_matrices"("workspaceId", "actorContextHash", "createdAt" DESC);
CREATE UNIQUE INDEX "export_matrix_cells_operationId_key" ON "export_matrix_cells"("operationId");
CREATE UNIQUE INDEX "export_matrix_cells_matrixId_sequence_key" ON "export_matrix_cells"("matrixId", "sequence");
CREATE UNIQUE INDEX "export_matrix_cells_matrixId_address_key" ON "export_matrix_cells"("matrixId", "address");
CREATE UNIQUE INDEX "export_matrix_cells_operationId_workspaceId_key" ON "export_matrix_cells"("operationId", "workspaceId");
CREATE UNIQUE INDEX "export_matrix_cells_id_workspaceId_matrixId_key" ON "export_matrix_cells"("id", "workspaceId", "matrixId");
CREATE INDEX "export_matrix_cells_workspaceId_matrixId_dispatchStatus_seq_idx" ON "export_matrix_cells"("workspaceId", "matrixId", "dispatchStatus", "sequence");
CREATE INDEX "export_matrix_cells_workspaceId_projectId_projectVersionId_idx" ON "export_matrix_cells"("workspaceId", "projectId", "projectVersionId");

ALTER TABLE "export_matrix_preflights" ADD CONSTRAINT "export_matrix_preflights_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "export_matrix_preflights" ADD CONSTRAINT "export_matrix_preflights_createdByClientId_workspaceId_fkey" FOREIGN KEY ("createdByClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "export_matrices" ADD CONSTRAINT "export_matrices_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "export_matrices" ADD CONSTRAINT "export_matrices_preflightId_workspaceId_fkey" FOREIGN KEY ("preflightId", "workspaceId") REFERENCES "export_matrix_preflights"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "export_matrices" ADD CONSTRAINT "export_matrices_createdByClientId_workspaceId_fkey" FOREIGN KEY ("createdByClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "export_matrix_cells" ADD CONSTRAINT "export_matrix_cells_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "export_matrix_cells" ADD CONSTRAINT "export_matrix_cells_matrixId_workspaceId_fkey" FOREIGN KEY ("matrixId", "workspaceId") REFERENCES "export_matrices"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "export_matrix_cells" ADD CONSTRAINT "export_matrix_cells_operationId_workspaceId_fkey" FOREIGN KEY ("operationId", "workspaceId") REFERENCES "public_operations"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
