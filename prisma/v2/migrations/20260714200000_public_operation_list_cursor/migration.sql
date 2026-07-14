-- Stable workspace-scoped cursor pagination for the public operation list.
CREATE INDEX "public_operations_workspaceId_createdAt_id_idx"
ON "public_operations"("workspaceId", "createdAt" DESC, "id" DESC);
