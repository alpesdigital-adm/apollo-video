CREATE INDEX "webhook_deliveries_workspaceId_status_nextAttemptAt_id_idx"
ON "webhook_deliveries"("workspaceId", "status", "nextAttemptAt", "id");

CREATE INDEX "webhook_deliveries_workspaceId_status_leaseExpiresAt_id_idx"
ON "webhook_deliveries"("workspaceId", "status", "leaseExpiresAt", "id");
