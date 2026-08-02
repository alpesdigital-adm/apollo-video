CREATE TABLE "ui_sessions" (
  "nonceHash" CHAR(64) PRIMARY KEY,
  "workspaceId" VARCHAR(128) NOT NULL,
  "clientId" VARCHAR(80) NOT NULL,
  "subjectHash" CHAR(64) NOT NULL,
  "issuedAt" TIMESTAMPTZ(3) NOT NULL,
  "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
  "idleExpiresAt" TIMESTAMPTZ(3) NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "revokedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ui_sessions_time_check" CHECK (
    "lastSeenAt" >= "issuedAt" AND "idleExpiresAt" > "lastSeenAt" AND
    "expiresAt" > "issuedAt" AND "idleExpiresAt" <= "expiresAt" AND
    ("revokedAt" IS NULL OR "revokedAt" >= "issuedAt")
  )
);

ALTER TABLE "ui_sessions" ADD CONSTRAINT "ui_sessions_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ui_sessions" ADD CONSTRAINT "ui_sessions_clientId_workspaceId_fkey"
  FOREIGN KEY ("clientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "ui_sessions_workspaceId_clientId_expiresAt_idx" ON "ui_sessions"("workspaceId", "clientId", "expiresAt");
CREATE INDEX "ui_sessions_expiresAt_idx" ON "ui_sessions"("expiresAt");

CREATE TABLE "ui_login_throttles" (
  "keyHash" CHAR(64) PRIMARY KEY,
  "windowStartedAt" TIMESTAMPTZ(3) NOT NULL,
  "attemptCount" INTEGER NOT NULL,
  "blockedUntil" TIMESTAMPTZ(3),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ui_login_throttles_count_check" CHECK ("attemptCount" >= 0 AND "attemptCount" <= 100000),
  CONSTRAINT "ui_login_throttles_block_check" CHECK ("blockedUntil" IS NULL OR "blockedUntil" > "windowStartedAt")
);
CREATE INDEX "ui_login_throttles_blockedUntil_idx" ON "ui_login_throttles"("blockedUntil");

CREATE TABLE "ui_login_attempts" (
  "id" UUID PRIMARY KEY,
  "keyHash" CHAR(64) NOT NULL,
  "subjectHash" CHAR(64) NOT NULL,
  "requestId" VARCHAR(100) NOT NULL,
  "outcome" VARCHAR(32) NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "settledAt" TIMESTAMPTZ(3),
  CONSTRAINT "ui_login_attempts_outcome_check" CHECK ("outcome" IN ('pending', 'succeeded', 'invalid', 'blocked', 'configuration-error')),
  CONSTRAINT "ui_login_attempts_settlement_check" CHECK (("outcome" = 'pending') = ("settledAt" IS NULL) AND ("settledAt" IS NULL OR "settledAt" >= "occurredAt"))
);
CREATE INDEX "ui_login_attempts_keyHash_occurredAt_idx" ON "ui_login_attempts"("keyHash", "occurredAt" DESC);
CREATE INDEX "ui_login_attempts_outcome_occurredAt_idx" ON "ui_login_attempts"("outcome", "occurredAt" DESC);
