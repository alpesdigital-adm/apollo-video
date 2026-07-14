CREATE INDEX "public_event_outbox_workspaceId_publishedAt_occurredAt_id_idx"
ON "public_event_outbox"("workspaceId", "publishedAt", "occurredAt", "id");
