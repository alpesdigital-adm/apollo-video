-- Workspace-scoped discovery of exhausted durable operations.
CREATE INDEX "public_operations_workspaceId_deadLetteredAt_createdAt_id_idx"
ON "public_operations"("workspaceId", "deadLetteredAt" DESC, "createdAt" DESC, "id" DESC);
