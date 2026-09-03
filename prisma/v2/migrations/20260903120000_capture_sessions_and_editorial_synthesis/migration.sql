-- Wave 18 — F4.001–F4.008: capture sessions, session time, and multi-range
-- editorial synthesis.
--
-- Every temporal column here is BIGINT holding integer ticks. A double
-- represents every integer only up to 2^53, which a nanosecond timebase
-- exhausts in fourteen weeks, and the failure mode is silent: two distinct
-- instants compare equal. Rates are stored as a numerator and a denominator,
-- never a decimal, because 30000/1001 is exactly two integers and is not
-- representable as a float at all.
--
-- The CHECK constraints below are not defensive duplication of the domain
-- modules. They are the same invariants written where a migration, a backfill
-- script or a future repository cannot route around them:
--
-- 1. ADR-130, in SQL. A mapping that claims an offset or a drift must name the
--    anchors and evidence it was measured from. A mapping that claims nothing
--    is the reference track against itself, true by definition, and needs no
--    justification. Without this, an unjustified 45,000-tick offset is a
--    perfectly valid row.
-- 2. `insufficient-evidence` emits no offset. "We could not tell" and "we
--    measured zero" are different answers, and a nullable column is the only
--    honest way to keep them different.
-- 3. Pieces of a piecewise clock map never overlap. Two laws over one source
--    tick make conversion depend on which was consulted, and both answers
--    would be defensible. An EXCLUDE constraint refuses the second row rather
--    than leaving the ambiguity to whoever reads first.
-- 4. A splice carries a justification and a reordering carries a reason.
--    Both are assertions the source never made; the record of why is what
--    makes them reviewable months later.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- F4.002 / FR-140 — CaptureSession
-- ---------------------------------------------------------------------------

CREATE TABLE "capture_sessions" (
  "id"                    VARCHAR(128) NOT NULL,
  "workspaceId"           VARCHAR(128) NOT NULL,
  "projectId"             VARCHAR(128) NOT NULL,
  "schemaVersion"         VARCHAR(64) NOT NULL,
  "label"                 VARCHAR(256) NOT NULL,
  "status"                VARCHAR(24) NOT NULL,
  "version"               INTEGER NOT NULL,
  "previousVersionHash"   CHAR(64),
  "referenceTrackId"      VARCHAR(128),
  "referenceEpoch"        INTEGER NOT NULL,
  "staleDerivationsJson"  TEXT NOT NULL DEFAULT '[]',
  "recordedAt"            TIMESTAMPTZ(3) NOT NULL,
  "sessionHash"           CHAR(64) NOT NULL,
  "createdAt"             TIMESTAMPTZ(3) NOT NULL,
  "updatedAt"             TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "capture_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "capture_sessions_status_check"
    CHECK ("status" IN ('draft', 'analyzing', 'needs-input', 'synced', 'partial', 'failed')),
  CONSTRAINT "capture_sessions_version_check"
    CHECK ("version" >= 1 AND "referenceEpoch" >= 1),
  -- Version 1 is the only version with nothing before it. Every later version
  -- must name the version it replaced, or the chain cannot be walked back.
  CONSTRAINT "capture_sessions_chain_check"
    CHECK (("version" = 1 AND "previousVersionHash" IS NULL) OR ("version" > 1 AND "previousVersionHash" IS NOT NULL)),
  -- A synced session has a reference track by definition: "synced" means
  -- "measured against something", and there is nothing else to measure against.
  CONSTRAINT "capture_sessions_reference_check"
    CHECK ("status" NOT IN ('synced', 'partial') OR "referenceTrackId" IS NOT NULL)
);

CREATE UNIQUE INDEX "capture_sessions_id_workspaceId_key" ON "capture_sessions" ("id", "workspaceId");
CREATE INDEX "capture_sessions_workspaceId_projectId_idx" ON "capture_sessions" ("workspaceId", "projectId");
CREATE INDEX "capture_sessions_workspaceId_status_updatedAt_idx" ON "capture_sessions" ("workspaceId", "status", "updatedAt" DESC);

CREATE TABLE "capture_tracks" (
  "id"                  VARCHAR(128) NOT NULL,
  "workspaceId"         VARCHAR(128) NOT NULL,
  "sessionId"           VARCHAR(128) NOT NULL,
  "role"                VARCHAR(24) NOT NULL,
  "label"               VARCHAR(256) NOT NULL,
  "sourceId"            VARCHAR(128) NOT NULL,
  "timebaseNum"         BIGINT NOT NULL,
  "timebaseDen"         BIGINT NOT NULL,
  "provenance"          VARCHAR(32) NOT NULL,
  "carriesAudio"        BOOLEAN NOT NULL,
  "carriesSpeech"       BOOLEAN NOT NULL,
  "syncAudioPolicy"     VARCHAR(24) NOT NULL,
  "includeInFinalMix"   BOOLEAN NOT NULL,
  "trackHash"           CHAR(64) NOT NULL,
  "createdAt"           TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "capture_tracks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "capture_tracks_role_check"
    CHECK ("role" IN ('camera-main', 'camera-alt', 'screen', 'phone', 'reaction',
                      'reference-video', 'microphone', 'master-audio', 'scratch-audio')),
  CONSTRAINT "capture_tracks_provenance_check"
    CHECK ("provenance" IN ('original-capture', 'normalized-rendition', 'synthetic')),
  CONSTRAINT "capture_tracks_sync_audio_policy_check"
    CHECK ("syncAudioPolicy" IN ('none', 'sync-only', 'sync-and-mix')),
  -- A timebase is a positive rational. A zero denominator is not a slow clock,
  -- it is not a clock.
  CONSTRAINT "capture_tracks_timebase_check"
    CHECK ("timebaseNum" > 0 AND "timebaseDen" > 0),
  -- A track with no audio cannot carry speech and cannot be synced by audio.
  CONSTRAINT "capture_tracks_audio_check"
    CHECK ("carriesAudio" OR (NOT "carriesSpeech" AND "syncAudioPolicy" = 'none')),
  -- Audio kept out of the sync path cannot be mixed into the master: it was
  -- never measured against the session clock, so its offset is unknown.
  CONSTRAINT "capture_tracks_mix_check"
    CHECK (NOT "includeInFinalMix" OR "syncAudioPolicy" = 'sync-and-mix')
);

CREATE UNIQUE INDEX "capture_tracks_id_workspaceId_key" ON "capture_tracks" ("id", "workspaceId");
CREATE UNIQUE INDEX "capture_tracks_workspaceId_sessionId_sourceId_key" ON "capture_tracks" ("workspaceId", "sessionId", "sourceId");
CREATE INDEX "capture_tracks_workspaceId_sessionId_role_idx" ON "capture_tracks" ("workspaceId", "sessionId", "role");

CREATE TABLE "capture_track_parts" (
  "id"                VARCHAR(128) NOT NULL,
  "workspaceId"       VARCHAR(128) NOT NULL,
  "sessionId"         VARCHAR(128) NOT NULL,
  "trackId"           VARCHAR(128) NOT NULL,
  "ordinal"           INTEGER NOT NULL,
  "artifactId"        VARCHAR(128) NOT NULL,
  "artifactSha256"    CHAR(64) NOT NULL,
  "startTicks"        BIGINT NOT NULL,
  "endTicks"          BIGINT NOT NULL,
  "ptsOffsetTicks"    BIGINT NOT NULL DEFAULT 0,
  "openedBy"          VARCHAR(32),
  "partHash"          CHAR(64) NOT NULL,
  "createdAt"         TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "capture_track_parts_pkey" PRIMARY KEY ("id"),
  -- Half-open, [start, end). An empty part is not a short recording, it is a
  -- row asserting the recorder produced nothing while claiming a span.
  CONSTRAINT "capture_track_parts_interval_check"
    CHECK ("endTicks" > "startTicks"),
  CONSTRAINT "capture_track_parts_ordinal_check"
    CHECK ("ordinal" >= 0),
  CONSTRAINT "capture_track_parts_opened_by_check"
    CHECK ("openedBy" IS NULL OR "openedBy" IN ('recorder-restart', 'pts-regression', 'seek',
                                                'rewind', 'file-split', 'coverage-gap',
                                                'residual-exceeded', 'manual-anchor-conflict'))
);

CREATE UNIQUE INDEX "capture_track_parts_id_workspaceId_key" ON "capture_track_parts" ("id", "workspaceId");
CREATE UNIQUE INDEX "capture_track_parts_workspaceId_trackId_ordinal_key" ON "capture_track_parts" ("workspaceId", "trackId", "ordinal");
CREATE INDEX "capture_track_parts_workspaceId_sessionId_idx" ON "capture_track_parts" ("workspaceId", "sessionId");

-- Two parts of one track cannot claim the same source ticks. A track is one
-- recorder's timeline, and a recorder is in one place at a time.
ALTER TABLE "capture_track_parts"
  ADD CONSTRAINT "capture_track_parts_no_overlap_excl"
  EXCLUDE USING gist (
    "workspaceId" WITH =,
    "trackId" WITH =,
    int8range("startTicks", "endTicks") WITH &&
  );

-- ---------------------------------------------------------------------------
-- F4.003 / FR-141 — session clock and source → session mappings
-- ---------------------------------------------------------------------------

CREATE TABLE "capture_session_clocks" (
  "id"                  VARCHAR(128) NOT NULL,
  "workspaceId"         VARCHAR(128) NOT NULL,
  "sessionId"           VARCHAR(128) NOT NULL,
  "schemaVersion"       VARCHAR(64) NOT NULL,
  "timebaseNum"         BIGINT NOT NULL,
  "timebaseDen"         BIGINT NOT NULL,
  "frameRateNum"        BIGINT NOT NULL,
  "frameRateDen"        BIGINT NOT NULL,
  "authorityOrigin"     VARCHAR(32) NOT NULL,
  "authoritySourceId"   VARCHAR(128),
  "authorityProvenance" VARCHAR(32) NOT NULL,
  "authorityEvidence"   VARCHAR(512) NOT NULL,
  "rounding"            VARCHAR(24) NOT NULL,
  "establishedAt"       TIMESTAMPTZ(3) NOT NULL,
  "clockHash"           CHAR(64) NOT NULL,
  "createdAt"           TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "capture_session_clocks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "capture_session_clocks_rate_check"
    CHECK ("timebaseNum" > 0 AND "timebaseDen" > 0 AND "frameRateNum" > 0 AND "frameRateDen" > 0),
  CONSTRAINT "capture_session_clocks_rounding_check"
    CHECK ("rounding" IN ('nearest-half-even', 'floor', 'ceil')),
  -- A normalized rendition is an output of the pipeline. Making it the timing
  -- authority means every timestamp in the session moves when a transcode
  -- setting changes, and nothing downstream can tell that it moved.
  CONSTRAINT "capture_session_clocks_provenance_check"
    CHECK ("authorityProvenance" IN ('original-capture', 'synthetic')),
  -- A synthetic clock is anchored to no source and has to say so; a clock read
  -- off a camera has to name the camera.
  CONSTRAINT "capture_session_clocks_authority_check"
    CHECK (
      ("authorityProvenance" = 'synthetic' AND "authoritySourceId" IS NULL) OR
      ("authorityProvenance" = 'original-capture' AND "authoritySourceId" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "capture_session_clocks_id_workspaceId_key" ON "capture_session_clocks" ("id", "workspaceId");
CREATE UNIQUE INDEX "capture_session_clocks_sessionId_workspaceId_key" ON "capture_session_clocks" ("sessionId", "workspaceId");

CREATE TABLE "capture_clock_maps" (
  "id"                  VARCHAR(128) NOT NULL,
  "workspaceId"         VARCHAR(128) NOT NULL,
  "sessionId"           VARCHAR(128) NOT NULL,
  "sourceId"            VARCHAR(128) NOT NULL,
  "schemaVersion"       VARCHAR(64) NOT NULL,
  "derivedSessionVersion" INTEGER NOT NULL,
  "derivedReferenceEpoch" INTEGER NOT NULL,
  "sourceBoundsStart"   BIGINT NOT NULL,
  "sourceBoundsEnd"     BIGINT NOT NULL,
  "uncoveredJson"       TEXT NOT NULL DEFAULT '[]',
  "mapHash"             CHAR(64) NOT NULL,
  "createdAt"           TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "capture_clock_maps_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "capture_clock_maps_bounds_check"
    CHECK ("sourceBoundsEnd" > "sourceBoundsStart"),
  CONSTRAINT "capture_clock_maps_derivation_check"
    CHECK ("derivedSessionVersion" >= 1 AND "derivedReferenceEpoch" >= 1)
);

CREATE UNIQUE INDEX "capture_clock_maps_id_workspaceId_key" ON "capture_clock_maps" ("id", "workspaceId");
CREATE UNIQUE INDEX "capture_clock_maps_workspaceId_sessionId_sourceId_key" ON "capture_clock_maps" ("workspaceId", "sessionId", "sourceId");

CREATE TABLE "capture_clock_map_pieces" (
  "id"                  VARCHAR(128) NOT NULL,
  "workspaceId"         VARCHAR(128) NOT NULL,
  "mapId"               VARCHAR(128) NOT NULL,
  "ordinal"             INTEGER NOT NULL,
  "sourceStartTicks"    BIGINT NOT NULL,
  "sourceEndTicks"      BIGINT NOT NULL,
  "sessionStartTicks"   BIGINT NOT NULL,
  "sessionEndTicks"     BIGINT NOT NULL,
  "rateNum"             BIGINT NOT NULL,
  "rateDen"             BIGINT NOT NULL,
  "offsetTicks"         BIGINT NOT NULL,
  "rounding"            VARCHAR(24) NOT NULL,
  "driftPpm"            INTEGER NOT NULL,
  "confidence"          VARCHAR(16) NOT NULL,
  "residualBoundTicks"  BIGINT NOT NULL,
  "openedBy"            VARCHAR(32),
  "openedByDetail"      VARCHAR(512),
  "anchorIdsJson"       TEXT NOT NULL DEFAULT '[]',
  "evidenceRefsJson"    TEXT NOT NULL DEFAULT '[]',
  "anchorCount"         INTEGER NOT NULL DEFAULT 0,
  "evidenceCount"       INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT "capture_clock_map_pieces_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "capture_clock_map_pieces_interval_check"
    CHECK ("sourceEndTicks" > "sourceStartTicks" AND "sessionEndTicks" > "sessionStartTicks"),
  CONSTRAINT "capture_clock_map_pieces_rate_check"
    CHECK ("rateNum" > 0 AND "rateDen" > 0),
  CONSTRAINT "capture_clock_map_pieces_ordinal_check"
    CHECK ("ordinal" >= 0),
  CONSTRAINT "capture_clock_map_pieces_confidence_check"
    CHECK ("confidence" IN ('high', 'medium', 'low')),
  CONSTRAINT "capture_clock_map_pieces_rounding_check"
    CHECK ("rounding" IN ('nearest-half-even', 'floor', 'ceil')),
  CONSTRAINT "capture_clock_map_pieces_residual_check"
    CHECK ("residualBoundTicks" >= 0),
  -- The first piece opens the map and has no boundary before it; every later
  -- piece must say what opened it, in words an operator can act on.
  CONSTRAINT "capture_clock_map_pieces_opened_check"
    CHECK (
      ("ordinal" = 0 AND "openedBy" IS NULL AND "openedByDetail" IS NULL) OR
      ("ordinal" > 0 AND "openedBy" IS NOT NULL AND char_length(btrim("openedByDetail")) >= 10)
    ),
  CONSTRAINT "capture_clock_map_pieces_opened_by_check"
    CHECK ("openedBy" IS NULL OR "openedBy" IN ('recorder-restart', 'pts-regression', 'seek',
                                                'rewind', 'file-split', 'coverage-gap',
                                                'residual-exceeded', 'manual-anchor-conflict')),
  -- ADR-130, in SQL. A piece that claims an offset or a drift is an assertion
  -- about where two recordings line up, and an assertion nobody can re-open is
  -- indistinguishable from a guess. A piece that claims neither is the
  -- reference track against itself: true by definition, needing no anchor.
  CONSTRAINT "capture_clock_map_pieces_evidence_check"
    CHECK (
      ("offsetTicks" = 0 AND "rateNum" = "rateDen") OR
      ("anchorCount" > 0 AND "evidenceCount" > 0)
    )
);

CREATE UNIQUE INDEX "capture_clock_map_pieces_id_workspaceId_key" ON "capture_clock_map_pieces" ("id", "workspaceId");
CREATE UNIQUE INDEX "capture_clock_map_pieces_workspaceId_mapId_ordinal_key" ON "capture_clock_map_pieces" ("workspaceId", "mapId", "ordinal");

-- Two pieces of one map cannot claim the same source tick. Refusing the second
-- row is the only outcome that does not leave the answer depending on which
-- law happened to be consulted first.
ALTER TABLE "capture_clock_map_pieces"
  ADD CONSTRAINT "capture_clock_map_pieces_no_overlap_excl"
  EXCLUDE USING gist (
    "workspaceId" WITH =,
    "mapId" WITH =,
    int8range("sourceStartTicks", "sourceEndTicks") WITH &&
  );

-- ---------------------------------------------------------------------------
-- F4.005 / FR-143 — TrackCoverage
-- ---------------------------------------------------------------------------

CREATE TABLE "capture_track_coverages" (
  "id"                  VARCHAR(128) NOT NULL,
  "workspaceId"         VARCHAR(128) NOT NULL,
  "sessionId"           VARCHAR(128) NOT NULL,
  "trackId"             VARCHAR(128) NOT NULL,
  "schemaVersion"       VARCHAR(64) NOT NULL,
  "derivedSessionVersion" INTEGER NOT NULL,
  "derivedReferenceEpoch" INTEGER NOT NULL,
  "spansJson"           TEXT NOT NULL,
  "coveredTicks"        BIGINT NOT NULL,
  "gapTicks"            BIGINT NOT NULL,
  "confidenceBps"       INTEGER NOT NULL,
  "autoEditable"        BOOLEAN NOT NULL,
  "overlapResolution"   VARCHAR(24),
  "coverageHash"        CHAR(64) NOT NULL,
  "createdAt"           TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "capture_track_coverages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "capture_track_coverages_ticks_check"
    CHECK ("coveredTicks" >= 0 AND "gapTicks" >= 0),
  CONSTRAINT "capture_track_coverages_confidence_check"
    CHECK ("confidenceBps" BETWEEN 0 AND 10000),
  CONSTRAINT "capture_track_coverages_overlap_check"
    CHECK ("overlapResolution" IS NULL OR "overlapResolution" IN ('prefer-part', 'trim-later-part', 'manual-review')),
  -- Auto-editing a track means cutting from it unattended. Below the
  -- confidence floor, or with an overlap a human still has to rule on, the
  -- unattended cut is the one nobody would have approved.
  CONSTRAINT "capture_track_coverages_auto_edit_check"
    CHECK (NOT "autoEditable" OR ("confidenceBps" >= 7000 AND "overlapResolution" IS DISTINCT FROM 'manual-review')),
  CONSTRAINT "capture_track_coverages_derivation_check"
    CHECK ("derivedSessionVersion" >= 1 AND "derivedReferenceEpoch" >= 1)
);

CREATE UNIQUE INDEX "capture_track_coverages_id_workspaceId_key" ON "capture_track_coverages" ("id", "workspaceId");
CREATE UNIQUE INDEX "capture_track_coverages_trackId_workspaceId_key" ON "capture_track_coverages" ("trackId", "workspaceId");
CREATE INDEX "capture_track_coverages_workspaceId_sessionId_idx" ON "capture_track_coverages" ("workspaceId", "sessionId");

-- ---------------------------------------------------------------------------
-- F4.004 / FR-142 — evidence cascade
-- ---------------------------------------------------------------------------

CREATE TABLE "capture_sync_evidence" (
  "id"                    VARCHAR(128) NOT NULL,
  "workspaceId"           VARCHAR(128) NOT NULL,
  "sessionId"             VARCHAR(128) NOT NULL,
  "trackId"               VARCHAR(128) NOT NULL,
  "schemaVersion"         VARCHAR(64) NOT NULL,
  "outcome"               VARCHAR(32) NOT NULL,
  "selectedMethod"        VARCHAR(24),
  "selectedTier"          INTEGER,
  "offsetTicks"           BIGINT,
  "confidence"            VARCHAR(16),
  "peakRatioBps"          INTEGER,
  "independenceGroup"     VARCHAR(64),
  "attemptsJson"          TEXT NOT NULL,
  "refusalReason"         VARCHAR(64),
  "evidenceHash"          CHAR(64) NOT NULL,
  "createdAt"             TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "capture_sync_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "capture_sync_evidence_outcome_check"
    CHECK ("outcome" IN ('resolved', 'insufficient-evidence', 'conflicting-evidence')),
  CONSTRAINT "capture_sync_evidence_method_check"
    CHECK ("selectedMethod" IS NULL OR "selectedMethod" IN ('shared-timecode', 'trusted-metadata',
      'apollo-marker', 'audio-fingerprint', 'visual-event', 'transcript-lip', 'manual-anchor')),
  CONSTRAINT "capture_sync_evidence_confidence_check"
    CHECK ("confidence" IS NULL OR "confidence" IN ('high', 'medium', 'low')),
  -- "We could not tell" is a first-class answer and must not be stored as an
  -- offset of zero. A resolved outcome, conversely, is nothing without the
  -- method and offset that resolved it.
  CONSTRAINT "capture_sync_evidence_resolution_check"
    CHECK (
      ("outcome" = 'resolved' AND "selectedMethod" IS NOT NULL AND "offsetTicks" IS NOT NULL
        AND "confidence" IS NOT NULL AND "selectedTier" IS NOT NULL) OR
      ("outcome" <> 'resolved' AND "selectedMethod" IS NULL AND "offsetTicks" IS NULL
        AND "refusalReason" IS NOT NULL)
    ),
  CONSTRAINT "capture_sync_evidence_peak_check"
    CHECK ("peakRatioBps" IS NULL OR "peakRatioBps" >= 0)
);

CREATE UNIQUE INDEX "capture_sync_evidence_id_workspaceId_key" ON "capture_sync_evidence" ("id", "workspaceId");
CREATE INDEX "capture_sync_evidence_workspaceId_sessionId_trackId_idx" ON "capture_sync_evidence" ("workspaceId", "sessionId", "trackId");

-- ---------------------------------------------------------------------------
-- F4.006 / FR-144 — drift fits and their anchors
-- ---------------------------------------------------------------------------

CREATE TABLE "capture_drift_fits" (
  "id"                    VARCHAR(128) NOT NULL,
  "workspaceId"           VARCHAR(128) NOT NULL,
  "sessionId"             VARCHAR(128) NOT NULL,
  "trackId"               VARCHAR(128) NOT NULL,
  "schemaVersion"         VARCHAR(64) NOT NULL,
  "status"                VARCHAR(24) NOT NULL,
  "driftRateNum"          BIGINT,
  "driftRateDen"          BIGINT,
  "driftPpm"              INTEGER,
  "offsetTicks"           BIGINT,
  "residualBoundTicks"    BIGINT,
  "residualMaxAbsTicks"   BIGINT,
  "withinTolerance"       BOOLEAN,
  "correctionAction"      VARCHAR(24),
  "correctionReason"      VARCHAR(64),
  "carriesSpeech"         BOOLEAN NOT NULL,
  "decision"              VARCHAR(24),
  "refusalReason"         VARCHAR(32),
  "holdOutStatus"         VARCHAR(24) NOT NULL,
  "splitProposalJson"     TEXT,
  "residualsJson"         TEXT NOT NULL DEFAULT '[]',
  "fitHash"               CHAR(64) NOT NULL,
  "createdAt"             TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "capture_drift_fits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "capture_drift_fits_status_check"
    CHECK ("status" IN ('fitted', 'insufficient-evidence')),
  CONSTRAINT "capture_drift_fits_refusal_check"
    CHECK ("refusalReason" IS NULL OR "refusalReason" IN ('too-few-anchors', 'anchors-outside-span',
      'anchors-clustered', 'conflicting-anchors', 'degenerate-source-span', 'non-positive-rate')),
  CONSTRAINT "capture_drift_fits_correction_check"
    CHECK ("correctionAction" IS NULL OR "correctionAction" IN ('none', 'applied', 'refused')),
  CONSTRAINT "capture_drift_fits_decision_check"
    CHECK ("decision" IS NULL OR "decision" IN ('auto-apply', 'new-piece', 'needs-review')),
  CONSTRAINT "capture_drift_fits_hold_out_check"
    CHECK ("holdOutStatus" IN ('validated', 'not-performed', 'failed')),
  -- A rate must be a positive rational or absent. A denominator of zero would
  -- be a clock that does not advance.
  CONSTRAINT "capture_drift_fits_rate_check"
    CHECK (("driftRateNum" IS NULL AND "driftRateDen" IS NULL) OR ("driftRateNum" > 0 AND "driftRateDen" > 0)),
  -- A refusal emits no rate and no offset, and must name its reason. A fit
  -- emits both and names none.
  CONSTRAINT "capture_drift_fits_outcome_check"
    CHECK (
      ("status" = 'fitted' AND "driftRateNum" IS NOT NULL AND "offsetTicks" IS NOT NULL
        AND "decision" IS NOT NULL AND "refusalReason" IS NULL) OR
      ("status" = 'insufficient-evidence' AND "driftRateNum" IS NULL AND "offsetTicks" IS NULL
        AND "refusalReason" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "capture_drift_fits_id_workspaceId_key" ON "capture_drift_fits" ("id", "workspaceId");
CREATE INDEX "capture_drift_fits_workspaceId_sessionId_trackId_idx" ON "capture_drift_fits" ("workspaceId", "sessionId", "trackId");

CREATE TABLE "capture_drift_anchors" (
  "id"                VARCHAR(128) NOT NULL,
  "workspaceId"       VARCHAR(128) NOT NULL,
  "fitId"             VARCHAR(128) NOT NULL,
  "anchorId"          VARCHAR(128) NOT NULL,
  "sourceTick"        BIGINT NOT NULL,
  "sessionTick"       BIGINT NOT NULL,
  "method"            VARCHAR(24) NOT NULL,
  "confidence"        VARCHAR(16) NOT NULL,
  "evidenceRef"       VARCHAR(512) NOT NULL,
  "residualTicks"     BIGINT,
  "usedInFit"         BOOLEAN NOT NULL,
  "isOutlier"         BOOLEAN NOT NULL DEFAULT FALSE,

  CONSTRAINT "capture_drift_anchors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "capture_drift_anchors_method_check"
    CHECK ("method" IN ('timecode', 'apollo-marker', 'audio', 'visual', 'transcript', 'manual')),
  CONSTRAINT "capture_drift_anchors_confidence_check"
    CHECK ("confidence" IN ('high', 'medium', 'low')),
  -- An anchor is a claim that one instant of the source is one instant of the
  -- session, and the evidence reference is what lets someone re-open it.
  CONSTRAINT "capture_drift_anchors_evidence_check"
    CHECK (char_length(btrim("evidenceRef")) > 0)
);

CREATE UNIQUE INDEX "capture_drift_anchors_id_workspaceId_key" ON "capture_drift_anchors" ("id", "workspaceId");
CREATE UNIQUE INDEX "capture_drift_anchors_workspaceId_fitId_anchorId_key" ON "capture_drift_anchors" ("workspaceId", "fitId", "anchorId");

-- ---------------------------------------------------------------------------
-- F4.001 / FR-135 — multi-range editorial synthesis
-- ---------------------------------------------------------------------------

CREATE TABLE "editorial_syntheses" (
  "id"                        VARCHAR(128) NOT NULL,
  "workspaceId"               VARCHAR(128) NOT NULL,
  "projectId"                 VARCHAR(128) NOT NULL,
  "schemaVersion"             VARCHAR(64) NOT NULL,
  "objective"                 VARCHAR(512) NOT NULL,
  "targetDurationMs"          INTEGER NOT NULL,
  "toleranceMs"               INTEGER NOT NULL,
  "synthesizedDurationMs"     INTEGER NOT NULL,
  "sourceDurationMs"          INTEGER NOT NULL,
  "droppedMs"                 INTEGER NOT NULL,
  "chronologyPreserved"       BOOLEAN NOT NULL,
  "reorderReason"             VARCHAR(512),
  "contextProofJson"          TEXT NOT NULL,
  "storyPlanId"               VARCHAR(128) NOT NULL,
  "editPlanId"                VARCHAR(128) NOT NULL,
  "editPlanJson"              TEXT NOT NULL,
  "editPlanSelectionHash"     CHAR(64) NOT NULL,
  "frameRateNum"              BIGINT NOT NULL,
  "frameRateDen"              BIGINT NOT NULL,
  "synthesisHash"             CHAR(64) NOT NULL,
  "createdAt"                 TIMESTAMPTZ(3) NOT NULL,
  "updatedAt"                 TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "editorial_syntheses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "editorial_syntheses_duration_check"
    CHECK ("targetDurationMs" > 0 AND "toleranceMs" >= 0 AND "synthesizedDurationMs" > 0
           AND "sourceDurationMs" > 0 AND "droppedMs" >= 0),
  CONSTRAINT "editorial_syntheses_frame_rate_check"
    CHECK ("frameRateNum" > 0 AND "frameRateDen" > 0),
  -- The synthesis cannot be longer than the master it was cut from.
  CONSTRAINT "editorial_syntheses_source_check"
    CHECK ("synthesizedDurationMs" <= "sourceDurationMs"),
  CONSTRAINT "editorial_syntheses_dropped_check"
    CHECK ("droppedMs" = "sourceDurationMs" - "synthesizedDurationMs"),
  -- The result must hit the target it was asked for. Storing a miss would let
  -- a cut that failed its brief read as a cut that met it.
  CONSTRAINT "editorial_syntheses_tolerance_check"
    CHECK (abs("synthesizedDurationMs" - "targetDurationMs") <= "toleranceMs"),
  -- Reordering changes what the material asserts about cause. It is allowed,
  -- and it is never allowed silently.
  CONSTRAINT "editorial_syntheses_reorder_check"
    CHECK ("chronologyPreserved" OR char_length(btrim("reorderReason")) >= 12)
);

CREATE UNIQUE INDEX "editorial_syntheses_id_workspaceId_key" ON "editorial_syntheses" ("id", "workspaceId");
CREATE INDEX "editorial_syntheses_workspaceId_projectId_updatedAt_idx" ON "editorial_syntheses" ("workspaceId", "projectId", "updatedAt" DESC);

CREATE TABLE "editorial_synthesis_ranges" (
  "id"                    VARCHAR(128) NOT NULL,
  "workspaceId"           VARCHAR(128) NOT NULL,
  "synthesisId"           VARCHAR(128) NOT NULL,
  "rangeId"               VARCHAR(128) NOT NULL,
  "ordinal"               INTEGER NOT NULL,
  "startMs"               INTEGER NOT NULL,
  "endMs"                 INTEGER NOT NULL,
  "sourceArtifactId"      VARCHAR(128) NOT NULL,
  "sourceArtifactSha256"  CHAR(64) NOT NULL,
  "sourceManifestId"      VARCHAR(128) NOT NULL,
  "sourceManifestHash"    CHAR(64) NOT NULL,
  "indexRunId"            VARCHAR(128) NOT NULL,
  "momentId"              VARCHAR(128) NOT NULL,
  "momentHash"            CHAR(64) NOT NULL,
  "evaluationId"          VARCHAR(128) NOT NULL,
  "evaluationHash"        CHAR(64) NOT NULL,
  "rightsSnapshotId"      VARCHAR(128) NOT NULL,
  "rightsStatus"          VARCHAR(16) NOT NULL,
  "consentStatus"         VARCHAR(16) NOT NULL,
  "claimIdsJson"          TEXT NOT NULL DEFAULT '[]',
  "qualifierIdsJson"      TEXT NOT NULL DEFAULT '[]',
  "proofContextIdsJson"   TEXT NOT NULL DEFAULT '[]',

  CONSTRAINT "editorial_synthesis_ranges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "editorial_synthesis_ranges_interval_check"
    CHECK ("endMs" > "startMs" AND "startMs" >= 0),
  CONSTRAINT "editorial_synthesis_ranges_ordinal_check"
    CHECK ("ordinal" >= 0),
  -- Rights are re-checked when the cut is assembled, not trusted from
  -- selection: a window can be chosen while approved and assembled after a
  -- revocation. A blocked range must never reach a persisted synthesis.
  CONSTRAINT "editorial_synthesis_ranges_rights_check"
    CHECK ("rightsStatus" = 'approved'),
  CONSTRAINT "editorial_synthesis_ranges_consent_check"
    CHECK ("consentStatus" IN ('approved', 'not-required'))
);

CREATE UNIQUE INDEX "editorial_synthesis_ranges_id_workspaceId_key" ON "editorial_synthesis_ranges" ("id", "workspaceId");
CREATE UNIQUE INDEX "editorial_synthesis_ranges_workspaceId_synthesisId_ordinal_key" ON "editorial_synthesis_ranges" ("workspaceId", "synthesisId", "ordinal");
CREATE INDEX "editorial_synthesis_ranges_workspaceId_momentId_idx" ON "editorial_synthesis_ranges" ("workspaceId", "momentId");

-- The same source milliseconds cannot appear twice in one cut. Repeating a
-- sentence is a stutter, and once compiled to frame numbers it is nearly
-- invisible in a plan.
ALTER TABLE "editorial_synthesis_ranges"
  ADD CONSTRAINT "editorial_synthesis_ranges_no_overlap_excl"
  EXCLUDE USING gist (
    "workspaceId" WITH =,
    "synthesisId" WITH =,
    "sourceArtifactId" WITH =,
    int4range("startMs", "endMs") WITH &&
  );

CREATE TABLE "editorial_synthesis_joins" (
  "id"                    VARCHAR(128) NOT NULL,
  "workspaceId"           VARCHAR(128) NOT NULL,
  "synthesisId"           VARCHAR(128) NOT NULL,
  "ordinal"               INTEGER NOT NULL,
  "beforeRangeId"         VARCHAR(128) NOT NULL,
  "afterRangeId"          VARCHAR(128) NOT NULL,
  "kind"                  VARCHAR(16) NOT NULL,
  "droppedMs"             INTEGER NOT NULL,
  "timelineMs"            INTEGER NOT NULL,
  "justification"         VARCHAR(1024) NOT NULL,
  "continuityRisksJson"   TEXT NOT NULL DEFAULT '[]',

  CONSTRAINT "editorial_synthesis_joins_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "editorial_synthesis_joins_kind_check"
    CHECK ("kind" IN ('contiguous', 'spliced')),
  CONSTRAINT "editorial_synthesis_joins_ordinal_check"
    CHECK ("ordinal" >= 0 AND "droppedMs" >= 0 AND "timelineMs" >= 0),
  CONSTRAINT "editorial_synthesis_joins_pair_check"
    CHECK ("beforeRangeId" <> "afterRangeId"),
  -- A contiguous join is one the source already made and drops nothing; a
  -- splice joins words the speaker never said consecutively and must justify
  -- it. Getting these two backwards is how a spliced claim passes for a quote.
  CONSTRAINT "editorial_synthesis_joins_contiguous_check"
    CHECK ("kind" <> 'contiguous' OR "droppedMs" = 0),
  CONSTRAINT "editorial_synthesis_joins_splice_check"
    CHECK ("kind" <> 'spliced' OR ("droppedMs" > 0 AND char_length(btrim("justification")) >= 12))
);

CREATE UNIQUE INDEX "editorial_synthesis_joins_id_workspaceId_key" ON "editorial_synthesis_joins" ("id", "workspaceId");
CREATE UNIQUE INDEX "editorial_synthesis_joins_workspaceId_synthesisId_ordinal_key" ON "editorial_synthesis_joins" ("workspaceId", "synthesisId", "ordinal");

-- ---------------------------------------------------------------------------
-- Foreign keys. Every one carries workspaceId so a row can never be joined to
-- another workspace's parent, which composite keys make structurally
-- impossible rather than merely unlikely.
-- ---------------------------------------------------------------------------

ALTER TABLE "capture_sessions"
  ADD CONSTRAINT "capture_sessions_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "capture_sessions"
  ADD CONSTRAINT "capture_sessions_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "capture_tracks"
  ADD CONSTRAINT "capture_tracks_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "capture_tracks"
  ADD CONSTRAINT "capture_tracks_sessionId_workspaceId_fkey"
  FOREIGN KEY ("sessionId", "workspaceId") REFERENCES "capture_sessions"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "capture_track_parts"
  ADD CONSTRAINT "capture_track_parts_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "capture_track_parts"
  ADD CONSTRAINT "capture_track_parts_trackId_workspaceId_fkey"
  FOREIGN KEY ("trackId", "workspaceId") REFERENCES "capture_tracks"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "capture_session_clocks"
  ADD CONSTRAINT "capture_session_clocks_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "capture_session_clocks"
  ADD CONSTRAINT "capture_session_clocks_sessionId_workspaceId_fkey"
  FOREIGN KEY ("sessionId", "workspaceId") REFERENCES "capture_sessions"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "capture_clock_maps"
  ADD CONSTRAINT "capture_clock_maps_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "capture_clock_maps"
  ADD CONSTRAINT "capture_clock_maps_sessionId_workspaceId_fkey"
  FOREIGN KEY ("sessionId", "workspaceId") REFERENCES "capture_sessions"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "capture_clock_map_pieces"
  ADD CONSTRAINT "capture_clock_map_pieces_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "capture_clock_map_pieces"
  ADD CONSTRAINT "capture_clock_map_pieces_mapId_workspaceId_fkey"
  FOREIGN KEY ("mapId", "workspaceId") REFERENCES "capture_clock_maps"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "capture_track_coverages"
  ADD CONSTRAINT "capture_track_coverages_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "capture_track_coverages"
  ADD CONSTRAINT "capture_track_coverages_trackId_workspaceId_fkey"
  FOREIGN KEY ("trackId", "workspaceId") REFERENCES "capture_tracks"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "capture_sync_evidence"
  ADD CONSTRAINT "capture_sync_evidence_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "capture_sync_evidence"
  ADD CONSTRAINT "capture_sync_evidence_trackId_workspaceId_fkey"
  FOREIGN KEY ("trackId", "workspaceId") REFERENCES "capture_tracks"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "capture_drift_fits"
  ADD CONSTRAINT "capture_drift_fits_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "capture_drift_fits"
  ADD CONSTRAINT "capture_drift_fits_trackId_workspaceId_fkey"
  FOREIGN KEY ("trackId", "workspaceId") REFERENCES "capture_tracks"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "capture_drift_anchors"
  ADD CONSTRAINT "capture_drift_anchors_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "capture_drift_anchors"
  ADD CONSTRAINT "capture_drift_anchors_fitId_workspaceId_fkey"
  FOREIGN KEY ("fitId", "workspaceId") REFERENCES "capture_drift_fits"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "editorial_syntheses"
  ADD CONSTRAINT "editorial_syntheses_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "editorial_syntheses"
  ADD CONSTRAINT "editorial_syntheses_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "editorial_synthesis_ranges"
  ADD CONSTRAINT "editorial_synthesis_ranges_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "editorial_synthesis_ranges"
  ADD CONSTRAINT "editorial_synthesis_ranges_synthesisId_workspaceId_fkey"
  FOREIGN KEY ("synthesisId", "workspaceId") REFERENCES "editorial_syntheses"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "editorial_synthesis_joins"
  ADD CONSTRAINT "editorial_synthesis_joins_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "editorial_synthesis_joins"
  ADD CONSTRAINT "editorial_synthesis_joins_synthesisId_workspaceId_fkey"
  FOREIGN KEY ("synthesisId", "workspaceId") REFERENCES "editorial_syntheses"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
