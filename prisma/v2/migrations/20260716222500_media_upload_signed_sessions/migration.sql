ALTER TABLE "media_uploads"
  ADD COLUMN "sessionMode" VARCHAR(16),
  ADD COLUMN "partSize" BIGINT,
  ADD COLUMN "sessionExpiresAt" TIMESTAMP(3);

ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_session_check" CHECK (
  ("sessionMode" IS NULL AND "partSize" IS NULL AND "sessionExpiresAt" IS NULL) OR
  ("sessionMode" = 'single' AND "partSize" IS NULL AND "sessionExpiresAt" IS NOT NULL) OR
  ("sessionMode" = 'multipart' AND "partSize" > 0 AND "sessionExpiresAt" IS NOT NULL)
);

CREATE INDEX "media_uploads_workspaceId_sessionExpiresAt_idx"
ON "media_uploads"("workspaceId", "sessionExpiresAt");
