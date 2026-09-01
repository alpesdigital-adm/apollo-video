-- F3.013 / FR-113 — durable transport state and inbound provider callbacks.
--
-- Two shapes of fact live around a provider job and they are deliberately not
-- in the same row.
--
-- `provider_jobs` stays content-addressed: its `jobHash` covers the whole body,
-- so anything that changes on every poll cannot live there without destroying
-- the meaning of the hash. What IS immutable about the transport — which one
-- carries the job, which brief and routing selection it serves — is added to
-- the job itself as nullable columns, so every synthetic job written by Waves
-- 13 and 14 keeps the exact hash it already has.
--
-- `provider_job_transport_states` holds the mutable schedule: next attempt,
-- deadline, Retry-After, cancellation and resume intents, MCP session. One row
-- per job, compare-and-swap on `revision`.
--
-- `provider_callback_events` is the durable replacement for what used to be a
-- `Set<string>` of consumed nonces held in memory: a process restart made every
-- replayed callback look new again. Persisted, uniquely keyed by
-- (workspace, provider, event id), and carrying the sha256 of the exact bytes
-- received so a repeated event id with different content is recognised as a
-- replay attempt rather than a duplicate delivery.

ALTER TABLE "provider_jobs"
  ADD COLUMN "transport" VARCHAR(16),
  ADD COLUMN "transformationBriefId" VARCHAR(128),
  ADD COLUMN "transformationBriefHash" CHAR(64),
  ADD COLUMN "transformationSelectionId" VARCHAR(128),
  ADD COLUMN "transformationSelectionHash" CHAR(64),
  ADD COLUMN "transformationProviderId" VARCHAR(128),
  ADD COLUMN "transformationCapabilityId" VARCHAR(128),
  ADD COLUMN "observedCostCurrency" CHAR(3),
  ADD COLUMN "observedCostMinorUnits" INTEGER,
  ADD COLUMN "deadlineAt" TIMESTAMPTZ(3);

ALTER TABLE "provider_jobs"
  ADD CONSTRAINT "provider_jobs_transport_check"
    CHECK ("transport" IS NULL OR "transport" IN ('api', 'polling', 'webhook', 'mcp')),
  -- A transformation binding is all-or-nothing. A job that knows its brief but
  -- not which selection routed it could never be audited back to a decision.
  ADD CONSTRAINT "provider_jobs_transformation_complete_check"
    CHECK (
      (
        "transformationBriefId" IS NULL AND "transformationBriefHash" IS NULL AND
        "transformationSelectionId" IS NULL AND "transformationSelectionHash" IS NULL AND
        "transformationProviderId" IS NULL AND "transformationCapabilityId" IS NULL
      ) OR (
        "transformationBriefId" IS NOT NULL AND "transformationBriefHash" IS NOT NULL AND
        "transformationSelectionId" IS NOT NULL AND "transformationSelectionHash" IS NOT NULL AND
        "transformationProviderId" IS NOT NULL AND "transformationCapabilityId" IS NOT NULL AND
        "transport" IS NOT NULL
      )
    ),
  ADD CONSTRAINT "provider_jobs_observed_cost_check"
    CHECK (
      ("observedCostCurrency" IS NULL AND "observedCostMinorUnits" IS NULL) OR
      ("observedCostCurrency" IS NOT NULL AND "observedCostMinorUnits" IS NOT NULL AND "observedCostMinorUnits" >= 0)
    );

CREATE INDEX "provider_jobs_workspaceId_transformationBriefId_createdAt_idx"
  ON "provider_jobs" ("workspaceId", "transformationBriefId", "createdAt" DESC);

CREATE TABLE "provider_job_transport_states" (
  "workspaceId"             VARCHAR(128) NOT NULL,
  "projectId"               VARCHAR(128) NOT NULL,
  "jobId"                   VARCHAR(128) NOT NULL,
  "schemaVersion"           VARCHAR(64) NOT NULL,
  "transport"               VARCHAR(16) NOT NULL,
  "completion"              VARCHAR(16) NOT NULL,
  "retryPolicyJson"         TEXT NOT NULL,
  "retryPolicyHash"         CHAR(64) NOT NULL,
  "waitKind"                VARCHAR(16) NOT NULL,
  "nextAttemptAt"           TIMESTAMPTZ(3),
  "deadlineAt"              TIMESTAMPTZ(3) NOT NULL,
  "transportAttempts"       INTEGER NOT NULL DEFAULT 0,
  "retryAfterMs"            INTEGER,
  "waitStartedAt"           TIMESTAMPTZ(3),
  "cancellation"            VARCHAR(16) NOT NULL DEFAULT 'none',
  "cancellationRequestedAt" TIMESTAMPTZ(3),
  "resume"                  VARCHAR(16) NOT NULL DEFAULT 'none',
  "resumeRequestedAt"       TIMESTAMPTZ(3),
  "mcpSessionId"            VARCHAR(128),
  "mcpSessionClosedAt"      TIMESTAMPTZ(3),
  "revision"                INTEGER NOT NULL DEFAULT 1,
  "createdAt"               TIMESTAMPTZ(3) NOT NULL,
  "updatedAt"               TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "provider_job_transport_states_pkey" PRIMARY KEY ("jobId", "workspaceId"),
  CONSTRAINT "provider_job_transport_states_transport_check"
    CHECK ("transport" IN ('api', 'polling', 'webhook', 'mcp')),
  CONSTRAINT "provider_job_transport_states_completion_check"
    CHECK ("completion" IN ('synchronous', 'polling', 'webhook', 'both')),
  -- The adapter declares how the provider finishes; the job declares how Apollo
  -- carries it. A synchronous provider cannot be driven by webhook and a
  -- webhook-only provider cannot be polled into completion. Enforced here so no
  -- code path can write an impossible pairing.
  CONSTRAINT "provider_job_transport_states_pairing_check"
    CHECK (
      ("completion" = 'synchronous' AND "transport" IN ('api', 'mcp')) OR
      ("completion" = 'polling' AND "transport" IN ('polling', 'mcp')) OR
      ("completion" = 'webhook' AND "transport" = 'webhook') OR
      ("completion" = 'both' AND "transport" IN ('polling', 'webhook', 'mcp'))
    ),
  CONSTRAINT "provider_job_transport_states_wait_kind_check"
    CHECK ("waitKind" IN ('none', 'poll', 'callback', 'retry')),
  -- A job that is waiting must know when to wake up, otherwise nothing reaps it.
  CONSTRAINT "provider_job_transport_states_wait_schedule_check"
    CHECK ("waitKind" = 'none' OR "nextAttemptAt" IS NOT NULL),
  CONSTRAINT "provider_job_transport_states_callback_wait_check"
    CHECK ("waitKind" <> 'callback' OR ("transport" = 'webhook' AND "waitStartedAt" IS NOT NULL)),
  CONSTRAINT "provider_job_transport_states_cancellation_check"
    CHECK (
      "cancellation" IN ('none', 'requested', 'acknowledged', 'unsupported') AND
      (("cancellation" = 'none') = ("cancellationRequestedAt" IS NULL))
    ),
  CONSTRAINT "provider_job_transport_states_resume_check"
    CHECK (
      "resume" IN ('none', 'requested', 'acknowledged') AND
      (("resume" = 'none') = ("resumeRequestedAt" IS NULL))
    ),
  -- Only an MCP-carried job has a session, and a session cannot close before it
  -- exists.
  CONSTRAINT "provider_job_transport_states_mcp_session_check"
    CHECK (
      ("mcpSessionId" IS NULL OR "transport" = 'mcp') AND
      ("mcpSessionClosedAt" IS NULL OR "mcpSessionId" IS NOT NULL)
    ),
  CONSTRAINT "provider_job_transport_states_attempts_check"
    CHECK ("transportAttempts" >= 0 AND "revision" >= 1),
  CONSTRAINT "provider_job_transport_states_retry_after_check"
    CHECK ("retryAfterMs" IS NULL OR ("retryAfterMs" >= 0 AND "retryAfterMs" <= 3600000)),
  CONSTRAINT "provider_job_transport_states_deadline_check"
    CHECK ("deadlineAt" > "createdAt")
);

CREATE UNIQUE INDEX "provider_job_transport_states_jobId_workspaceId_projectId_key"
  ON "provider_job_transport_states" ("jobId", "workspaceId", "projectId");
-- The claim query for the worker: due jobs, oldest first.
CREATE INDEX "provider_job_transport_states_workspaceId_waitKind_nextAtte_idx"
  ON "provider_job_transport_states" ("workspaceId", "waitKind", "nextAttemptAt");
CREATE INDEX "provider_job_transport_states_deadlineAt_idx"
  ON "provider_job_transport_states" ("deadlineAt");

CREATE TABLE "provider_callback_events" (
  "id"             VARCHAR(128) NOT NULL,
  "workspaceId"    VARCHAR(128) NOT NULL,
  "projectId"      VARCHAR(128) NOT NULL,
  "jobId"          VARCHAR(128) NOT NULL,
  "schemaVersion"  VARCHAR(64) NOT NULL,
  "providerId"     VARCHAR(128) NOT NULL,
  "eventId"        VARCHAR(128) NOT NULL,
  "providerJobId"  VARCHAR(256) NOT NULL,
  "status"         VARCHAR(24) NOT NULL,
  "outcome"        VARCHAR(16) NOT NULL,
  "rejectionReason" VARCHAR(32),
  "retryAfterMs"   INTEGER,
  -- sha256 of the exact bytes received. Never the bytes themselves: a provider
  -- payload is untrusted input and may carry signed URLs or tokens.
  "payloadSha256"  CHAR(64) NOT NULL,
  "eventHash"      CHAR(64) NOT NULL,
  "occurredAt"     TIMESTAMPTZ(3) NOT NULL,
  "receivedAt"     TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "provider_callback_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "provider_callback_events_status_check"
    CHECK ("status" IN ('queued', 'processing', 'retrieving', 'completed', 'failed', 'cancelled')),
  CONSTRAINT "provider_callback_events_outcome_check"
    CHECK (
      "outcome" IN ('accepted', 'duplicate', 'rejected') AND
      (("outcome" = 'rejected') = ("rejectionReason" IS NOT NULL))
    ),
  CONSTRAINT "provider_callback_events_retry_after_check"
    CHECK ("retryAfterMs" IS NULL OR ("retryAfterMs" >= 0 AND "retryAfterMs" <= 3600000))
);

-- The replay gate. Only accepted events claim the key: a rejected callback must
-- not be able to burn an event id and lock out the genuine delivery.
CREATE UNIQUE INDEX "provider_callback_events_accepted_key"
  ON "provider_callback_events" ("workspaceId", "providerId", "eventId")
  WHERE "outcome" = 'accepted';
CREATE UNIQUE INDEX "provider_callback_events_id_workspaceId_key"
  ON "provider_callback_events" ("id", "workspaceId");
CREATE INDEX "provider_callback_events_workspaceId_jobId_receivedAt_idx"
  ON "provider_callback_events" ("workspaceId", "jobId", "receivedAt" DESC);
CREATE INDEX "provider_callback_events_workspaceId_providerId_receivedAt_idx"
  ON "provider_callback_events" ("workspaceId", "providerId", "receivedAt" DESC);

-- Foreign keys as separate statements: this is the shape Prisma emits and the
-- shape `db:v2:validate` compares the committed migration against.
ALTER TABLE "provider_job_transport_states"
  ADD CONSTRAINT "provider_job_transport_states_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "provider_job_transport_states"
  ADD CONSTRAINT "provider_job_transport_states_jobId_workspaceId_projectId_fkey"
  FOREIGN KEY ("jobId", "workspaceId", "projectId")
  REFERENCES "provider_jobs"("id", "workspaceId", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "provider_callback_events"
  ADD CONSTRAINT "provider_callback_events_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "provider_callback_events"
  ADD CONSTRAINT "provider_callback_events_jobId_workspaceId_projectId_fkey"
  FOREIGN KEY ("jobId", "workspaceId", "projectId")
  REFERENCES "provider_jobs"("id", "workspaceId", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
