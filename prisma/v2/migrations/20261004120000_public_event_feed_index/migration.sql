-- Dashboard event feed: workspace-scoped, database-clock ordered reads of persisted events.
CREATE INDEX "public_event_outbox_workspaceId_createdAt_id_idx"
ON "public_event_outbox"("workspaceId", "createdAt" ASC, "id" ASC);
