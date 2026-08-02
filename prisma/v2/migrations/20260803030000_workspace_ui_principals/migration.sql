CREATE TABLE "workspace_ui_principals" (
  "workspaceId" VARCHAR(128) NOT NULL,
  "clientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "workspace_ui_principals_pkey" PRIMARY KEY ("workspaceId")
);

CREATE UNIQUE INDEX "workspace_ui_principals_clientId_key" ON "workspace_ui_principals"("clientId");
CREATE UNIQUE INDEX "workspace_ui_principals_clientId_workspaceId_key" ON "workspace_ui_principals"("clientId", "workspaceId");
ALTER TABLE "workspace_ui_principals" ADD CONSTRAINT "workspace_ui_principals_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workspace_ui_principals" ADD CONSTRAINT "workspace_ui_principals_clientId_workspaceId_fkey"
  FOREIGN KEY ("clientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Preserve an unambiguous active UI binding; ambiguous historical workspaces stay fail-closed.
INSERT INTO "workspace_ui_principals" ("workspaceId", "clientId", "createdAt", "updatedAt")
SELECT "workspaceId", MIN("clientId"), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "ui_sessions"
GROUP BY "workspaceId"
HAVING COUNT(DISTINCT "clientId") = 1;
