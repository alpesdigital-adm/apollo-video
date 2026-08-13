CREATE INDEX "media_segments_workspace_created_id_idx"
  ON "media_segments" ("workspaceId", "createdAt" DESC, "id" DESC);
