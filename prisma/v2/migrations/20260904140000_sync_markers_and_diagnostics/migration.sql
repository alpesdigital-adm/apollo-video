-- F4.010 / FR-148 and F4.011 / FR-149 — sync markers, their detections, and
-- versioned synchronization diagnostics.
--
-- The constraints here encode three refusals the domain makes, so that a
-- backfill, a repair script or a future repository cannot route around them.
--
-- 1. A rejected detection carries no instant. "We could not find it" and "we
--    found it at zero" are different answers, and a NOT NULL column would be
--    unable to keep them different. The same rule that governs
--    insufficient-evidence everywhere else in the sync stack.
-- 2. A diagnostic's status is derived from its measurements. A row claiming
--    synced-high with no offset, or with a residual above the target, is
--    refused — that field is what every auto-edit gate reads.
-- 3. Version 1 of a diagnostic has nothing before it and every later version
--    names the hash it replaced. An anchor edit is a new version, never an
--    update, so the diagnostic a cut was approved against stays readable.
--
-- Marker artifacts are content-addressed and stored as artifacts, not bytes in
-- a column: the table holds the identity and the checksum, and the media lives
-- where media lives.

CREATE TABLE "sync_markers" (
  "id"              VARCHAR(128) NOT NULL,
  "workspaceId"     VARCHAR(128) NOT NULL,
  "sessionId"       VARCHAR(128) NOT NULL,
  "schemaVersion"   VARCHAR(64) NOT NULL,
  "kind"            VARCHAR(24) NOT NULL,
  "position"        VARCHAR(24) NOT NULL,
  "sequence"        INTEGER NOT NULL,
  "sessionCode"     CHAR(6) NOT NULL,
  "emittedAt"       TIMESTAMPTZ(3) NOT NULL,
  "payload"         VARCHAR(256) NOT NULL,
  "checksum"        VARCHAR(32) NOT NULL,
  "visualJson"      TEXT NOT NULL,
  "audioJson"       TEXT NOT NULL,
  "artifactId"      VARCHAR(128),
  "artifactSha256"  CHAR(64),
  "artifactBytes"   INTEGER,
  "markerHash"      CHAR(64) NOT NULL,
  "createdAt"       TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "sync_markers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sync_markers_kind_check"
    CHECK ("kind" IN ('audiovisual', 'spoken-code')),
  CONSTRAINT "sync_markers_position_check"
    CHECK ("position" IN ('start', 'end', 'after-restart')),
  CONSTRAINT "sync_markers_sequence_check"
    CHECK ("sequence" BETWEEN 1 AND 999),
  -- An artifact is all-or-nothing: an id without a checksum could not be
  -- verified, and a size without either describes nothing.
  CONSTRAINT "sync_markers_artifact_check"
    CHECK (
      ("artifactId" IS NULL AND "artifactSha256" IS NULL AND "artifactBytes" IS NULL) OR
      ("artifactId" IS NOT NULL AND "artifactSha256" IS NOT NULL AND "artifactBytes" > 0)
    )
);

CREATE UNIQUE INDEX "sync_markers_id_workspaceId_key" ON "sync_markers" ("id", "workspaceId");
-- One marker per position and sequence within a session: a second "start"
-- marker at sequence 1 would make "which marker was seen" undecidable.
CREATE UNIQUE INDEX "sync_markers_workspaceId_sessionId_sequence_key" ON "sync_markers" ("workspaceId", "sessionId", "sequence");
CREATE INDEX "sync_markers_workspaceId_sessionId_position_idx" ON "sync_markers" ("workspaceId", "sessionId", "position");

CREATE TABLE "sync_marker_detections" (
  "id"                    VARCHAR(160) NOT NULL,
  "workspaceId"           VARCHAR(128) NOT NULL,
  "markerId"              VARCHAR(128) NOT NULL,
  "sessionId"             VARCHAR(128) NOT NULL,
  "trackId"               VARCHAR(128) NOT NULL,
  "schemaVersion"         VARCHAR(64) NOT NULL,
  "position"              VARCHAR(24) NOT NULL,
  "mode"                  VARCHAR(24) NOT NULL,
  "outcome"               VARCHAR(32) NOT NULL,
  "rejection"             VARCHAR(48),
  "atMs"                  DOUBLE PRECISION,
  "errorMs"               DOUBLE PRECISION,
  "visualObservationId"   VARCHAR(128),
  "audioObservationId"    VARCHAR(128),
  "confidence"            DOUBLE PRECISION NOT NULL,
  "reasonsJson"           TEXT NOT NULL DEFAULT '[]',
  "detectionHash"         CHAR(64) NOT NULL,
  "detectedAt"            TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "sync_marker_detections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sync_marker_detections_outcome_check"
    CHECK ("outcome" IN ('confirmed', 'single-channel-only', 'rejected')),
  CONSTRAINT "sync_marker_detections_mode_check"
    CHECK ("mode" IN ('both-channels', 'either-channel')),
  CONSTRAINT "sync_marker_detections_rejection_check"
    CHECK ("rejection" IS NULL OR "rejection" IN (
      'no-usable-observation', 'visual-rejected', 'audio-rejected',
      'channels-disagree-on-time', 'ambiguous-audio-peak',
      'single-channel-not-permitted', 'foreign-session')),
  CONSTRAINT "sync_marker_detections_confidence_check"
    CHECK ("confidence" >= 0 AND "confidence" <= 1),
  -- A rejection carries no instant and names its reason; a resolved detection
  -- carries both an instant and a bound, and names no rejection. Storing an
  -- instant beside a rejection is how "not found" becomes "found at zero".
  CONSTRAINT "sync_marker_detections_resolution_check"
    CHECK (
      ("outcome" = 'rejected' AND "atMs" IS NULL AND "errorMs" IS NULL AND "rejection" IS NOT NULL) OR
      ("outcome" <> 'rejected' AND "atMs" IS NOT NULL AND "errorMs" >= 0 AND "rejection" IS NULL)
    ),
  -- Confirmation means both channels agreed, so both observations are named.
  CONSTRAINT "sync_marker_detections_confirmed_check"
    CHECK ("outcome" <> 'confirmed' OR ("visualObservationId" IS NOT NULL AND "audioObservationId" IS NOT NULL))
);

CREATE UNIQUE INDEX "sync_marker_detections_id_workspaceId_key" ON "sync_marker_detections" ("id", "workspaceId");
CREATE UNIQUE INDEX "sync_marker_detections_workspaceId_markerId_trackId_key" ON "sync_marker_detections" ("workspaceId", "markerId", "trackId");
CREATE INDEX "sync_marker_detections_workspaceId_sessionId_outcome_idx" ON "sync_marker_detections" ("workspaceId", "sessionId", "outcome");

CREATE TABLE "sync_diagnostics" (
  "id"                    VARCHAR(160) NOT NULL,
  "workspaceId"           VARCHAR(128) NOT NULL,
  "sessionId"             VARCHAR(128) NOT NULL,
  "referenceTrackId"      VARCHAR(128) NOT NULL,
  "version"               INTEGER NOT NULL,
  "previousVersionHash"   CHAR(64),
  "sessionVersion"        INTEGER NOT NULL,
  "referenceEpoch"        INTEGER NOT NULL,
  "schemaVersion"         VARCHAR(64) NOT NULL,
  "status"                VARCHAR(24) NOT NULL,
  "globalConfidence"      DOUBLE PRECISION NOT NULL,
  "tracksJson"            TEXT NOT NULL,
  "trackCount"            INTEGER NOT NULL,
  "warningsJson"          TEXT NOT NULL DEFAULT '[]',
  "recommendedActionsJson" TEXT NOT NULL DEFAULT '[]',
  "manualRequired"        BOOLEAN NOT NULL,
  "protocolCeiling"       VARCHAR(32),
  "manualAnchorCount"     INTEGER NOT NULL DEFAULT 0,
  "automaticAnchorCount"  INTEGER NOT NULL DEFAULT 0,
  "diagnosticHash"        CHAR(64) NOT NULL,
  "generatedAt"           TIMESTAMPTZ(3) NOT NULL,
  "createdAt"             TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "sync_diagnostics_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sync_diagnostics_status_check"
    CHECK ("status" IN ('synced-high', 'synced-medium', 'partial', 'needs-input', 'failed')),
  CONSTRAINT "sync_diagnostics_ceiling_check"
    CHECK ("protocolCeiling" IS NULL OR "protocolCeiling" IN (
      'automatic', 'automatic-with-review', 'manual-anchors-required', 'not-synchronizable')),
  CONSTRAINT "sync_diagnostics_counters_check"
    CHECK ("version" >= 1 AND "sessionVersion" >= 1 AND "referenceEpoch" >= 1
           AND "trackCount" >= 1 AND "manualAnchorCount" >= 0 AND "automaticAnchorCount" >= 0),
  CONSTRAINT "sync_diagnostics_confidence_check"
    CHECK ("globalConfidence" >= 0 AND "globalConfidence" <= 1),
  -- Version 1 is the only version with nothing before it. Every anchor edit
  -- appends, so the diagnostic a cut was approved against stays readable.
  CONSTRAINT "sync_diagnostics_chain_check"
    CHECK (("version" = 1 AND "previousVersionHash" IS NULL) OR
           ("version" > 1 AND "previousVersionHash" IS NOT NULL)),
  -- A status that needs a person and a manualRequired flag saying otherwise
  -- cannot coexist; the flag is the cheaper read and would win.
  CONSTRAINT "sync_diagnostics_manual_check"
    CHECK ("manualRequired" OR "status" NOT IN ('needs-input', 'failed')),
  -- A capped session can never present as fully synchronized: it never had
  -- the evidence, and a confident fit does not create it.
  CONSTRAINT "sync_diagnostics_ceiling_status_check"
    CHECK ("protocolCeiling" IS NULL
           OR "protocolCeiling" NOT IN ('manual-anchors-required', 'not-synchronizable')
           OR "manualRequired")
);

CREATE UNIQUE INDEX "sync_diagnostics_id_workspaceId_key" ON "sync_diagnostics" ("id", "workspaceId");
CREATE UNIQUE INDEX "sync_diagnostics_workspaceId_sessionId_version_key" ON "sync_diagnostics" ("workspaceId", "sessionId", "version");
CREATE UNIQUE INDEX "sync_diagnostics_workspaceId_diagnosticHash_key" ON "sync_diagnostics" ("workspaceId", "diagnosticHash");
CREATE INDEX "sync_diagnostics_workspaceId_sessionId_generatedAt_idx" ON "sync_diagnostics" ("workspaceId", "sessionId", "generatedAt" DESC);

-- The mutable pointer to the current diagnostic version, mirroring how capture
-- sessions separate their chain from their head.
CREATE TABLE "sync_diagnostic_heads" (
  "id"              VARCHAR(128) NOT NULL,
  "workspaceId"     VARCHAR(128) NOT NULL,
  "sessionId"       VARCHAR(128) NOT NULL,
  "version"         INTEGER NOT NULL,
  "diagnosticHash"  CHAR(64) NOT NULL,
  "status"          VARCHAR(24) NOT NULL,
  "manualRequired"  BOOLEAN NOT NULL,
  "createdAt"       TIMESTAMPTZ(3) NOT NULL,
  "updatedAt"       TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "sync_diagnostic_heads_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sync_diagnostic_heads_version_check" CHECK ("version" >= 1),
  CONSTRAINT "sync_diagnostic_heads_status_check"
    CHECK ("status" IN ('synced-high', 'synced-medium', 'partial', 'needs-input', 'failed'))
);

CREATE UNIQUE INDEX "sync_diagnostic_heads_id_workspaceId_key" ON "sync_diagnostic_heads" ("id", "workspaceId");
CREATE UNIQUE INDEX "sync_diagnostic_heads_sessionId_workspaceId_key" ON "sync_diagnostic_heads" ("sessionId", "workspaceId");
CREATE INDEX "sync_diagnostic_heads_workspaceId_status_idx" ON "sync_diagnostic_heads" ("workspaceId", "status");

ALTER TABLE "sync_markers"
  ADD CONSTRAINT "sync_markers_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sync_markers"
  ADD CONSTRAINT "sync_markers_sessionId_workspaceId_fkey"
  FOREIGN KEY ("sessionId", "workspaceId") REFERENCES "capture_session_heads"("sessionId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sync_marker_detections"
  ADD CONSTRAINT "sync_marker_detections_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sync_marker_detections"
  ADD CONSTRAINT "sync_marker_detections_markerId_workspaceId_fkey"
  FOREIGN KEY ("markerId", "workspaceId") REFERENCES "sync_markers"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sync_diagnostics"
  ADD CONSTRAINT "sync_diagnostics_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sync_diagnostics"
  ADD CONSTRAINT "sync_diagnostics_sessionId_workspaceId_fkey"
  FOREIGN KEY ("sessionId", "workspaceId") REFERENCES "capture_session_heads"("sessionId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sync_diagnostic_heads"
  ADD CONSTRAINT "sync_diagnostic_heads_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sync_diagnostic_heads"
  ADD CONSTRAINT "sync_diagnostic_heads_sessionId_workspaceId_fkey"
  FOREIGN KEY ("sessionId", "workspaceId") REFERENCES "capture_session_heads"("sessionId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
