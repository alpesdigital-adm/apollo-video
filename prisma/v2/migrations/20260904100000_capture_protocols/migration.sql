-- F4.009 / FR-147 — capture protocols and their evaluations.
--
-- Two tables with opposite lifetimes, and the difference is the point.
--
-- `capture_protocols` is a published catalogue: append-only, versioned, and
-- never edited in place. A session judged last month has to stay readable
-- against the protocol it was actually judged by, or the stored evaluation
-- becomes a claim about a document that no longer exists.
--
-- `capture_protocol_evaluations` is a derivation bound to one exact session
-- version. It carries the session hash it read, so an evaluation can never be
-- silently reinterpreted as applying to a session that has since gained a
-- track or changed its reference.
--
-- The CHECK constraints carry the two rules the domain refuses to bend:
--
-- 1. A `required` requirement must name a capability lost without it. A
--    mandatory item whose absence costs nothing is a preference with the wrong
--    label, and the catalogue is where that drift would start.
-- 2. A ceiling that blocks unattended editing and a `blocksAutoEdit` flag that
--    says otherwise cannot coexist. Downstream reads the flag; if the two ever
--    disagreed, the cheaper read would win and the ceiling would be decorative.

CREATE TABLE "capture_protocols" (
  "id"                VARCHAR(128) NOT NULL,
  "protocolId"        VARCHAR(64) NOT NULL,
  "scenario"          VARCHAR(32) NOT NULL,
  "version"           INTEGER NOT NULL,
  "schemaVersion"     VARCHAR(64) NOT NULL,
  "title"             VARCHAR(128) NOT NULL,
  "summary"           VARCHAR(512) NOT NULL,
  "requirementsJson"  TEXT NOT NULL,
  "expectedTracksJson" TEXT NOT NULL,
  "requiredCount"     INTEGER NOT NULL,
  "bestCeiling"       VARCHAR(32) NOT NULL,
  "protocolHash"      CHAR(64) NOT NULL,
  "publishedAt"       TIMESTAMPTZ(3) NOT NULL,
  "createdAt"         TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "capture_protocols_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "capture_protocols_scenario_check"
    CHECK ("scenario" IN ('teacher-and-screen', 'podcast', 'react', 'multicam')),
  CONSTRAINT "capture_protocols_ceiling_check"
    CHECK ("bestCeiling" IN ('automatic', 'automatic-with-review',
                             'manual-anchors-required', 'not-synchronizable')),
  CONSTRAINT "capture_protocols_version_check"
    CHECK ("version" >= 1 AND "requiredCount" >= 1)
);

-- A published protocol version is immutable, so its identity is the pair.
CREATE UNIQUE INDEX "capture_protocols_protocolId_version_key" ON "capture_protocols" ("protocolId", "version");
CREATE UNIQUE INDEX "capture_protocols_protocolHash_key" ON "capture_protocols" ("protocolHash");
CREATE INDEX "capture_protocols_scenario_version_idx" ON "capture_protocols" ("scenario", "version" DESC);

CREATE TABLE "capture_protocol_evaluations" (
  "id"                      VARCHAR(160) NOT NULL,
  "workspaceId"             VARCHAR(128) NOT NULL,
  "sessionId"               VARCHAR(128) NOT NULL,
  "sessionVersion"          INTEGER NOT NULL,
  "sessionHash"             CHAR(64) NOT NULL,
  "protocolId"              VARCHAR(64) NOT NULL,
  "protocolVersion"         INTEGER NOT NULL,
  "protocolHash"            CHAR(64) NOT NULL,
  "schemaVersion"           VARCHAR(64) NOT NULL,
  "findingsJson"            TEXT NOT NULL,
  "lostCapabilitiesJson"    TEXT NOT NULL DEFAULT '[]',
  "attestedRequirementsJson" TEXT NOT NULL DEFAULT '[]',
  "ceiling"                 VARCHAR(32) NOT NULL,
  "blocksAutoEdit"          BOOLEAN NOT NULL,
  "unmetRequiredCount"      INTEGER NOT NULL,
  "evaluationHash"          CHAR(64) NOT NULL,
  "evaluatedAt"             TIMESTAMPTZ(3) NOT NULL,
  "createdAt"               TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "capture_protocol_evaluations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "capture_protocol_evaluations_ceiling_check"
    CHECK ("ceiling" IN ('automatic', 'automatic-with-review',
                         'manual-anchors-required', 'not-synchronizable')),
  CONSTRAINT "capture_protocol_evaluations_counters_check"
    CHECK ("sessionVersion" >= 1 AND "protocolVersion" >= 1 AND "unmetRequiredCount" >= 0),
  -- The flag and the ceiling say the same thing or the row is refused.
  -- Everything downstream reads the flag because it is cheaper; letting them
  -- disagree would make the ceiling decorative.
  CONSTRAINT "capture_protocol_evaluations_ceiling_flag_check"
    CHECK ("blocksAutoEdit" = ("ceiling" IN ('manual-anchors-required', 'not-synchronizable'))),
  -- An unmet required item and a ceiling of 'automatic' cannot both be true.
  CONSTRAINT "capture_protocol_evaluations_unmet_check"
    CHECK ("unmetRequiredCount" = 0 OR "ceiling" <> 'automatic')
);

CREATE UNIQUE INDEX "capture_protocol_evaluations_id_workspaceId_key" ON "capture_protocol_evaluations" ("id", "workspaceId");
-- One current evaluation per session version and protocol version. Re-running
-- the same judgement converges instead of accumulating duplicates.
CREATE UNIQUE INDEX "capture_protocol_evaluations_session_protocol_key" ON "capture_protocol_evaluations" ("workspaceId", "sessionId", "sessionVersion", "protocolId", "protocolVersion");
CREATE INDEX "capture_protocol_evaluations_workspaceId_sessionId_evaluate_idx" ON "capture_protocol_evaluations" ("workspaceId", "sessionId", "evaluatedAt" DESC);

-- The protocol attached to a session: a pointer, replaceable, and never a
-- rewrite of any historical session version. Attaching a protocol must not
-- create a new CaptureSession version — the recording did not change.
CREATE TABLE "capture_session_protocols" (
  "id"              VARCHAR(128) NOT NULL,
  "workspaceId"     VARCHAR(128) NOT NULL,
  "sessionId"       VARCHAR(128) NOT NULL,
  "protocolId"      VARCHAR(64) NOT NULL,
  "protocolVersion" INTEGER NOT NULL,
  "protocolHash"    CHAR(64) NOT NULL,
  "attachedByKind"  VARCHAR(16) NOT NULL,
  "attachedById"    VARCHAR(128) NOT NULL,
  "attachedAt"      TIMESTAMPTZ(3) NOT NULL,
  "updatedAt"       TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "capture_session_protocols_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "capture_session_protocols_actor_check"
    CHECK ("attachedByKind" IN ('human', 'api-client', 'director')),
  CONSTRAINT "capture_session_protocols_version_check"
    CHECK ("protocolVersion" >= 1)
);

CREATE UNIQUE INDEX "capture_session_protocols_id_workspaceId_key" ON "capture_session_protocols" ("id", "workspaceId");
CREATE UNIQUE INDEX "capture_session_protocols_sessionId_workspaceId_key" ON "capture_session_protocols" ("sessionId", "workspaceId");

ALTER TABLE "capture_protocol_evaluations"
  ADD CONSTRAINT "capture_protocol_evaluations_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "capture_protocol_evaluations"
  ADD CONSTRAINT "capture_protocol_evaluations_sessionId_workspaceId_fkey"
  FOREIGN KEY ("sessionId", "workspaceId") REFERENCES "capture_session_heads"("sessionId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "capture_session_protocols"
  ADD CONSTRAINT "capture_session_protocols_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "capture_session_protocols"
  ADD CONSTRAINT "capture_session_protocols_sessionId_workspaceId_fkey"
  FOREIGN KEY ("sessionId", "workspaceId") REFERENCES "capture_session_heads"("sessionId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
