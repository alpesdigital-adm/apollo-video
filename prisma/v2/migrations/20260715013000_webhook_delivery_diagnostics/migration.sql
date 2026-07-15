CREATE INDEX "webhook_deliveries_workspaceId_createdAt_id_idx"
ON "webhook_deliveries"("workspaceId", "createdAt" DESC, "id" DESC);

CREATE INDEX "webhook_deliveries_workspaceId_eventId_createdAt_id_idx"
ON "webhook_deliveries"("workspaceId", "eventId", "createdAt" DESC, "id" DESC);

CREATE INDEX "webhook_deliveries_workspaceId_subscriptionId_createdAt_id_idx"
ON "webhook_deliveries"("workspaceId", "subscriptionId", "createdAt" DESC, "id" DESC);
