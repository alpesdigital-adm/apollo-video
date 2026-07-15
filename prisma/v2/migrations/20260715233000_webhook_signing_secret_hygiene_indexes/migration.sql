CREATE INDEX "webhook_signing_secrets_workspaceId_status_usableUntil_idx"
  ON "webhook_signing_secrets"("workspaceId", "status", "usableUntil");

CREATE INDEX "webhook_signing_secret_rotations_workspaceId_status_expires_idx"
  ON "webhook_signing_secret_rotations"("workspaceId", "status", "expiresAt");
