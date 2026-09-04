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
-- **A capture session is an immutable chain plus a mutable pointer.** Every
-- operation on a session returns version + 1 with the hash of the version it
-- replaced, so the chain can be walked back to the ingest that started it.
-- `capture_session_versions` holds the chain and is never updated;
-- `capture_session_heads` holds the one row that says which version is
-- current. Collapsing the two into an updatable row would mean an added track
-- silently rewrote what the previous version said, which is the exact question
-- an editor asks when a cut stops matching the rushes.
--
-- Nested collections that the database never queries on their own — a track's
-- parts, a sync record's assessments — are stored as canonical JSON beside the
-- hash that covers them, and rehydration rebuilds the aggregate and compares
-- hashes. Collections the database *does* reason about — clock map pieces,
-- drift anchors, synthesis ranges — are real rows, because constraints have to
-- see them.
--
-- The CHECK and EXCLUDE constraints are not defensive duplication of the domain
-- modules. They are the same invariants written where a migration, a backfill
-- script or a future repository cannot route around them:
--
-- 1. ADR-130, in SQL. A mapping that claims an offset or a drift must name the
--    anchors and evidence it was measured from. A mapping that claims nothing
--    is the reference track against itself, true by definition, and needs no
--    justification. Without this, an unjustified 45,000-tick offset is a
--    perfectly valid row.
-- 2. `insufficient-evidence` emits no clock map. "We could not tell" and "we
--    measured zero" are different answers, and a nullable column is the only
--    honest way to keep them different.
-- 3. Pieces of a piecewise clock map, and ranges of a synthesis, never overlap.
--    Two laws over one tick make the answer depend on which was consulted, and
--    both would be defensible. An EXCLUDE constraint refuses the second row.
-- 4. A splice carries a justification and a reordering carries a reason. Both
--    are assertions the source never made; the record of why is what makes
--    them reviewable months later.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- F4.002 / FR-140 — CaptureSession: the immutable chain
-- ---------------------------------------------------------------------------

CREATE TABLE "capture_session_versions" (
  "id"                    VARCHAR(160) NOT NULL,
  "workspaceId"           VARCHAR(128) NOT NULL,
  "projectId"             VARCHAR(128) NOT NULL,
  "sessionId"             VARCHAR(128) NOT NULL,
  "schemaVersion"         VARCHAR(64) NOT NULL,
  "version"               INTEGER NOT NULL,
  "previousVersionHash"   CHAR(64),
  "status"                VARCHAR(24) NOT NULL,
  "clockTimebaseNum"      BIGINT NOT NULL,
  "clockTimebaseDen"      BIGINT NOT NULL,
  "clockRounding"         VARCHAR(24) NOT NULL,
  "referenceTrackId"      VARCHAR(128) NOT NULL,
  "referenceEpoch"        INTEGER NOT NULL,
  "tracksJson"            TEXT NOT NULL,
  "trackCount"            INTEGER NOT NULL,
  "staleDerivationsJson"  TEXT NOT NULL DEFAULT '[]',
  "commandId"             VARCHAR(128) NOT NULL,
  "operation"             VARCHAR(32) NOT NULL,
  "actorKind"             VARCHAR(16) NOT NULL,
  "actorId"               VARCHAR(128) NOT NULL,
  "occurredAt"            TIMESTAMPTZ(3) NOT NULL,
  "note"                  VARCHAR(1024),
  "sessionHash"           CHAR(64) NOT NULL,
  "createdAt"             TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "capture_session_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "capture_session_versions_status_check"
    CHECK ("status" IN ('draft', 'analyzing', 'needs-input', 'synced', 'partial', 'failed')),
  CONSTRAINT "capture_session_versions_operation_check"
    CHECK ("operation" IN ('create-session', 'add-track', 'add-track-part',
                           'change-reference-track', 'change-status')),
  CONSTRAINT "capture_session_versions_actor_check"
    CHECK ("actorKind" IN ('human', 'api-client', 'director')),
  CONSTRAINT "capture_session_versions_rounding_check"
    CHECK ("clockRounding" IN ('nearest-half-even', 'floor', 'ceil')),
  -- A timebase is a positive rational. A zero denominator is not a slow clock,
  -- it is not a clock.
  CONSTRAINT "capture_session_versions_timebase_check"
    CHECK ("clockTimebaseNum" > 0 AND "clockTimebaseDen" > 0),
  CONSTRAINT "capture_session_versions_counters_check"
    CHECK ("version" >= 1 AND "referenceEpoch" >= 1 AND "trackCount" >= 1),
  -- Version 1 is the only version with nothing before it. Every later version
  -- names the version it replaced, or the chain cannot be walked back — and a
  -- chain that cannot be walked back is a chain nobody can audit.
  CONSTRAINT "capture_session_versions_chain_check"
    CHECK (("version" = 1 AND "previousVersionHash" IS NULL) OR
           ("version" > 1 AND "previousVersionHash" IS NOT NULL)),
  -- Only creating a session can be version 1, and creating one can be nothing
  -- else. Otherwise "create-session" could appear halfway down a chain.
  CONSTRAINT "capture_session_versions_genesis_check"
    CHECK (("version" = 1) = ("operation" = 'create-session'))
);

CREATE UNIQUE INDEX "capture_session_versions_id_workspaceId_key" ON "capture_session_versions" ("id", "workspaceId");
CREATE UNIQUE INDEX "capture_session_versions_workspaceId_sessionId_version_key" ON "capture_session_versions" ("workspaceId", "sessionId", "version");
CREATE UNIQUE INDEX "capture_session_versions_workspaceId_sessionHash_key" ON "capture_session_versions" ("workspaceId", "sessionHash");
CREATE INDEX "capture_session_versions_workspaceId_projectId_idx" ON "capture_session_versions" ("workspaceId", "projectId");

-- The mutable pointer: exactly one row per session, saying which version of the
-- immutable chain is current. Advancing it is the only write that ever happens
-- to a session that already exists.
CREATE TABLE "capture_session_heads" (
  "id"            VARCHAR(128) NOT NULL,
  "workspaceId"   VARCHAR(128) NOT NULL,
  "projectId"     VARCHAR(128) NOT NULL,
  "sessionId"     VARCHAR(128) NOT NULL,
  "version"       INTEGER NOT NULL,
  "sessionHash"   CHAR(64) NOT NULL,
  "status"        VARCHAR(24) NOT NULL,
  "createdAt"     TIMESTAMPTZ(3) NOT NULL,
  "updatedAt"     TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "capture_session_heads_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "capture_session_heads_version_check" CHECK ("version" >= 1),
  CONSTRAINT "capture_session_heads_status_check"
    CHECK ("status" IN ('draft', 'analyzing', 'needs-input', 'synced', 'partial', 'failed'))
);

CREATE UNIQUE INDEX "capture_session_heads_id_workspaceId_key" ON "capture_session_heads" ("id", "workspaceId");
CREATE UNIQUE INDEX "capture_session_heads_sessionId_workspaceId_key" ON "capture_session_heads" ("sessionId", "workspaceId");
CREATE INDEX "capture_session_heads_workspaceId_projectId_updatedAt_idx" ON "capture_session_heads" ("workspaceId", "projectId", "updatedAt" DESC);
CREATE INDEX "capture_session_heads_workspaceId_status_idx" ON "capture_session_heads" ("workspaceId", "status");

-- ---------------------------------------------------------------------------
-- F4.003 / FR-141 — the session clock
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
  "establishedAt"       TIMESTAMPTZ(3) NOT NULL,
  "clockHash"           CHAR(64) NOT NULL,
  "createdAt"           TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "capture_session_clocks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "capture_session_clocks_rate_check"
    CHECK ("timebaseNum" > 0 AND "timebaseDen" > 0 AND "frameRateNum" > 0 AND "frameRateDen" > 0),
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

-- ---------------------------------------------------------------------------
-- F4.007 / FR-145 — piecewise source → session maps
-- ---------------------------------------------------------------------------

CREATE TABLE "capture_clock_maps" (
  "id"                    VARCHAR(128) NOT NULL,
  "workspaceId"           VARCHAR(128) NOT NULL,
  "sessionId"             VARCHAR(128) NOT NULL,
  "sourceId"              VARCHAR(128) NOT NULL,
  "schemaVersion"         VARCHAR(64) NOT NULL,
  "derivedSessionVersion" INTEGER NOT NULL,
  "derivedReferenceEpoch" INTEGER NOT NULL,
  "sourceBoundsStart"     BIGINT NOT NULL,
  "sourceBoundsEnd"       BIGINT NOT NULL,
  "uncoveredJson"         TEXT NOT NULL DEFAULT '[]',
  "boundariesJson"        TEXT NOT NULL DEFAULT '[]',
  "pieceCount"            INTEGER NOT NULL,
  "mapHash"               CHAR(64) NOT NULL,
  "createdAt"             TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "capture_clock_maps_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "capture_clock_maps_bounds_check"
    CHECK ("sourceBoundsEnd" > "sourceBoundsStart"),
  CONSTRAINT "capture_clock_maps_derivation_check"
    CHECK ("derivedSessionVersion" >= 1 AND "derivedReferenceEpoch" >= 1 AND "pieceCount" >= 1)
);

CREATE UNIQUE INDEX "capture_clock_maps_id_workspaceId_key" ON "capture_clock_maps" ("id", "workspaceId");
CREATE UNIQUE INDEX "capture_clock_maps_workspaceId_sessionId_sourceId_key" ON "capture_clock_maps" ("workspaceId", "sessionId", "sourceId");

CREATE TABLE "capture_clock_map_pieces" (
  "id"                 VARCHAR(160) NOT NULL,
  "workspaceId"        VARCHAR(128) NOT NULL,
  "mapId"              VARCHAR(128) NOT NULL,
  "pieceId"            VARCHAR(128) NOT NULL,
  "ordinal"            INTEGER NOT NULL,
  "sourceStartTicks"   BIGINT NOT NULL,
  "sourceEndTicks"     BIGINT NOT NULL,
  "sessionStartTicks"  BIGINT NOT NULL,
  "sessionEndTicks"    BIGINT NOT NULL,
  "rateNum"            BIGINT NOT NULL,
  "rateDen"            BIGINT NOT NULL,
  "offsetTicks"        BIGINT NOT NULL,
  "rounding"           VARCHAR(24) NOT NULL,
  "driftPpm"           INTEGER NOT NULL,
  "confidence"         VARCHAR(16) NOT NULL,
  "residualBoundTicks" BIGINT NOT NULL,
  "openedBy"           VARCHAR(32),
  "openedByDetail"     VARCHAR(512),
  "anchorIdsJson"      TEXT NOT NULL DEFAULT '[]',
  "evidenceRefsJson"   TEXT NOT NULL DEFAULT '[]',
  "anchorCount"        INTEGER NOT NULL DEFAULT 0,
  "evidenceCount"      INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT "capture_clock_map_pieces_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "capture_clock_map_pieces_interval_check"
    CHECK ("sourceEndTicks" > "sourceStartTicks" AND "sessionEndTicks" > "sessionStartTicks"),
  CONSTRAINT "capture_clock_map_pieces_rate_check"
    CHECK ("rateNum" > 0 AND "rateDen" > 0),
  CONSTRAINT "capture_clock_map_pieces_ordinal_check"
    CHECK ("ordinal" >= 0 AND "residualBoundTicks" >= 0),
  CONSTRAINT "capture_clock_map_pieces_confidence_check"
    CHECK ("confidence" IN ('high', 'medium', 'low')),
  CONSTRAINT "capture_clock_map_pieces_rounding_check"
    CHECK ("rounding" IN ('nearest-half-even', 'floor', 'ceil')),
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
  "id"                    VARCHAR(128) NOT NULL,
  "workspaceId"           VARCHAR(128) NOT NULL,
  "sessionId"             VARCHAR(128) NOT NULL,
  "trackId"               VARCHAR(128) NOT NULL,
  "schemaVersion"         VARCHAR(64) NOT NULL,
  "derivedSessionVersion" INTEGER NOT NULL,
  "derivedReferenceEpoch" INTEGER NOT NULL,
  "timebaseNum"           BIGINT NOT NULL,
  "timebaseDen"           BIGINT NOT NULL,
  "boundsStart"           BIGINT NOT NULL,
  "boundsEnd"             BIGINT NOT NULL,
  "availableJson"         TEXT NOT NULL DEFAULT '[]',
  "gapsJson"              TEXT NOT NULL DEFAULT '[]',
  "corruptJson"           TEXT NOT NULL DEFAULT '[]',
  "unverifiedJson"        TEXT NOT NULL DEFAULT '[]',
  "overlapsJson"          TEXT NOT NULL DEFAULT '[]',
  "recorderSplitsJson"    TEXT NOT NULL DEFAULT '[]',
  "coveredTicks"          BIGINT NOT NULL,
  "gapTicks"              BIGINT NOT NULL,
  "minConfidenceBps"      INTEGER NOT NULL,
  "autoEditable"          BOOLEAN NOT NULL,
  "unresolvedOverlaps"    INTEGER NOT NULL DEFAULT 0,
  "coverageHash"          CHAR(64) NOT NULL,
  "createdAt"             TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "capture_track_coverages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "capture_track_coverages_bounds_check"
    CHECK ("boundsEnd" > "boundsStart"),
  CONSTRAINT "capture_track_coverages_ticks_check"
    CHECK ("coveredTicks" >= 0 AND "gapTicks" >= 0 AND "unresolvedOverlaps" >= 0),
  CONSTRAINT "capture_track_coverages_timebase_check"
    CHECK ("timebaseNum" > 0 AND "timebaseDen" > 0),
  CONSTRAINT "capture_track_coverages_confidence_check"
    CHECK ("minConfidenceBps" BETWEEN 0 AND 10000),
  CONSTRAINT "capture_track_coverages_derivation_check"
    CHECK ("derivedSessionVersion" >= 1 AND "derivedReferenceEpoch" >= 1),
  -- Auto-editing means cutting from this track unattended. Below the
  -- confidence floor, or with an overlap a human still has to rule on, the
  -- unattended cut is the one nobody would have approved.
  CONSTRAINT "capture_track_coverages_auto_edit_check"
    CHECK (NOT "autoEditable" OR ("minConfidenceBps" >= 7000 AND "unresolvedOverlaps" = 0))
);

CREATE UNIQUE INDEX "capture_track_coverages_id_workspaceId_key" ON "capture_track_coverages" ("id", "workspaceId");
CREATE UNIQUE INDEX "capture_track_coverages_workspaceId_trackId_key" ON "capture_track_coverages" ("workspaceId", "trackId");
CREATE INDEX "capture_track_coverages_workspaceId_sessionId_idx" ON "capture_track_coverages" ("workspaceId", "sessionId");

-- ---------------------------------------------------------------------------
-- F4.004 / FR-142 — the evidence cascade
-- ---------------------------------------------------------------------------

CREATE TABLE "capture_sync_evidence" (
  "id"                  VARCHAR(128) NOT NULL,
  "workspaceId"         VARCHAR(128) NOT NULL,
  "sessionId"           VARCHAR(128) NOT NULL,
  "trackId"             VARCHAR(128) NOT NULL,
  "referenceTrackId"    VARCHAR(128) NOT NULL,
  "schemaVersion"       VARCHAR(64) NOT NULL,
  "outcome"             VARCHAR(32) NOT NULL,
  "manualRequired"      BOOLEAN NOT NULL,
  "selectedSignalId"    VARCHAR(128),
  "selectedMethod"      VARCHAR(24),
  "mapRateNum"          BIGINT,
  "mapRateDen"          BIGINT,
  "mapOffsetTicks"      BIGINT,
  "mapRounding"         VARCHAR(24),
  "sessionTimebaseNum"  BIGINT NOT NULL,
  "sessionTimebaseDen"  BIGINT NOT NULL,
  "sessionFrameRateNum" BIGINT NOT NULL,
  "sessionFrameRateDen" BIGINT NOT NULL,
  "sessionBoundsStart"  BIGINT NOT NULL,
  "sessionBoundsEnd"    BIGINT NOT NULL,
  "assessmentsJson"     TEXT NOT NULL DEFAULT '[]',
  "discardedJson"       TEXT NOT NULL DEFAULT '[]',
  "contradictionsJson"  TEXT NOT NULL DEFAULT '[]',
  "corroborationsJson"  TEXT NOT NULL DEFAULT '[]',
  "outcomeReasonsJson"  TEXT NOT NULL DEFAULT '[]',
  "thresholdsJson"      TEXT NOT NULL,
  "evidenceHash"        CHAR(64) NOT NULL,
  "createdAt"           TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "capture_sync_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "capture_sync_evidence_outcome_check"
    CHECK ("outcome" IN ('auto-apply', 'review', 'insufficient-evidence')),
  CONSTRAINT "capture_sync_evidence_method_check"
    CHECK ("selectedMethod" IS NULL OR "selectedMethod" IN ('shared-timecode', 'trusted-metadata',
      'apollo-marker', 'audio-fingerprint', 'visual-event', 'transcript-lip', 'manual-anchor')),
  CONSTRAINT "capture_sync_evidence_rounding_check"
    CHECK ("mapRounding" IS NULL OR "mapRounding" IN ('nearest-half-even', 'floor', 'ceil')),
  CONSTRAINT "capture_sync_evidence_session_check"
    CHECK ("sessionTimebaseNum" > 0 AND "sessionTimebaseDen" > 0
           AND "sessionFrameRateNum" > 0 AND "sessionFrameRateDen" > 0
           AND "sessionBoundsEnd" > "sessionBoundsStart"),
  -- A track cannot be synchronized against itself: the answer would be true by
  -- construction and would prove nothing about the recording.
  CONSTRAINT "capture_sync_evidence_reference_check"
    CHECK ("trackId" <> "referenceTrackId"),
  -- "We could not tell" must not be stored as an offset of zero. The cascade
  -- emits a whole clock map when it decided anything at all -- whether it can
  -- be applied unattended (auto-apply) or needs a human to look (review) -- and
  -- emits none of it when the evidence never got there.
  CONSTRAINT "capture_sync_evidence_resolution_check"
    CHECK (
      ("outcome" <> 'insufficient-evidence' AND "selectedMethod" IS NOT NULL
        AND "selectedSignalId" IS NOT NULL AND "mapRateNum" IS NOT NULL
        AND "mapRateDen" IS NOT NULL AND "mapOffsetTicks" IS NOT NULL
        AND "mapRounding" IS NOT NULL) OR
      ("outcome" = 'insufficient-evidence' AND "selectedMethod" IS NULL
        AND "selectedSignalId" IS NULL AND "mapRateNum" IS NULL
        AND "mapRateDen" IS NULL AND "mapOffsetTicks" IS NULL AND "mapRounding" IS NULL)
    ),
  -- Only a review outcome can require a human; the other two have already
  -- decided, and "decided, but also needs a decision" is not a state.
  CONSTRAINT "capture_sync_evidence_manual_check"
    CHECK (NOT "manualRequired" OR "outcome" <> 'auto-apply'),
  CONSTRAINT "capture_sync_evidence_map_rate_check"
    CHECK ("mapRateNum" IS NULL OR ("mapRateNum" > 0 AND "mapRateDen" > 0))
);

CREATE UNIQUE INDEX "capture_sync_evidence_id_workspaceId_key" ON "capture_sync_evidence" ("id", "workspaceId");
CREATE UNIQUE INDEX "capture_sync_evidence_workspaceId_sessionId_trackId_key" ON "capture_sync_evidence" ("workspaceId", "sessionId", "trackId");
CREATE INDEX "capture_sync_evidence_workspaceId_outcome_idx" ON "capture_sync_evidence" ("workspaceId", "outcome");

-- ---------------------------------------------------------------------------
-- F4.006 / FR-144 — drift fits and the anchors they were measured from
-- ---------------------------------------------------------------------------

CREATE TABLE "capture_drift_fits" (
  "id"                    VARCHAR(128) NOT NULL,
  "workspaceId"           VARCHAR(128) NOT NULL,
  "sessionId"             VARCHAR(128) NOT NULL,
  "trackId"               VARCHAR(128) NOT NULL,
  "sourceId"              VARCHAR(128) NOT NULL,
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
  "refusalDetail"         VARCHAR(512),
  "holdOutStatus"         VARCHAR(24) NOT NULL,
  "holdOutJson"           TEXT NOT NULL,
  "splitProposalJson"     TEXT,
  "residualsJson"         TEXT NOT NULL DEFAULT '[]',
  "distributionJson"      TEXT NOT NULL,
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
    CHECK (("driftRateNum" IS NULL AND "driftRateDen" IS NULL) OR
           ("driftRateNum" > 0 AND "driftRateDen" > 0)),
  -- A refusal emits no rate and no offset, and must name its reason. A fit
  -- emits both and names none. Storing a refusal with a rate would let a
  -- measurement that was never made read as one that was.
  CONSTRAINT "capture_drift_fits_outcome_check"
    CHECK (
      ("status" = 'fitted' AND "driftRateNum" IS NOT NULL AND "offsetTicks" IS NOT NULL
        AND "decision" IS NOT NULL AND "correctionAction" IS NOT NULL
        AND "refusalReason" IS NULL) OR
      ("status" = 'insufficient-evidence' AND "driftRateNum" IS NULL AND "offsetTicks" IS NULL
        AND "decision" IS NULL AND "refusalReason" IS NOT NULL)
    ),
  -- Stretching speech is the one correction that damages the thing it is
  -- correcting, so a refusal there must say so rather than reading as "none".
  CONSTRAINT "capture_drift_fits_speech_check"
    CHECK ("correctionAction" <> 'refused' OR "correctionReason" IS NOT NULL)
);

CREATE UNIQUE INDEX "capture_drift_fits_id_workspaceId_key" ON "capture_drift_fits" ("id", "workspaceId");
CREATE UNIQUE INDEX "capture_drift_fits_workspaceId_sessionId_trackId_key" ON "capture_drift_fits" ("workspaceId", "sessionId", "trackId");

CREATE TABLE "capture_drift_anchors" (
  "id"            VARCHAR(160) NOT NULL,
  "workspaceId"   VARCHAR(128) NOT NULL,
  "fitId"         VARCHAR(128) NOT NULL,
  "anchorId"      VARCHAR(128) NOT NULL,
  "sourceTick"    BIGINT NOT NULL,
  "sessionTick"   BIGINT NOT NULL,
  "method"        VARCHAR(24) NOT NULL,
  "confidence"    VARCHAR(16) NOT NULL,
  "evidenceRef"   VARCHAR(512) NOT NULL,
  "residualTicks" BIGINT,
  "usedInFit"     BOOLEAN NOT NULL,
  "isOutlier"     BOOLEAN NOT NULL DEFAULT FALSE,
  "rejection"     VARCHAR(64),

  CONSTRAINT "capture_drift_anchors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "capture_drift_anchors_method_check"
    CHECK ("method" IN ('timecode', 'apollo-marker', 'audio', 'visual', 'transcript', 'manual')),
  CONSTRAINT "capture_drift_anchors_confidence_check"
    CHECK ("confidence" IN ('high', 'medium', 'low')),
  -- An anchor claims one instant of the source is one instant of the session.
  -- The evidence reference is what lets someone re-open that claim.
  CONSTRAINT "capture_drift_anchors_evidence_check"
    CHECK (char_length(btrim("evidenceRef")) > 0),
  -- An anchor left out of the fit must say why. Otherwise a discarded anchor
  -- and a used one are indistinguishable after the fact.
  CONSTRAINT "capture_drift_anchors_rejection_check"
    CHECK ("usedInFit" OR "rejection" IS NOT NULL),
  -- A residual only exists for anchors the fit actually measured against.
  CONSTRAINT "capture_drift_anchors_residual_check"
    CHECK ("usedInFit" OR "residualTicks" IS NULL)
);

CREATE UNIQUE INDEX "capture_drift_anchors_id_workspaceId_key" ON "capture_drift_anchors" ("id", "workspaceId");
CREATE UNIQUE INDEX "capture_drift_anchors_workspaceId_fitId_anchorId_key" ON "capture_drift_anchors" ("workspaceId", "fitId", "anchorId");

-- ---------------------------------------------------------------------------
-- F4.004/F4.006 — the durable synchronization run.
--
-- Synchronizing a session is long work over media, so it survives a restart of
-- whatever was running it. Three columns carry the whole safety argument:
--
-- `leaseTokenHash` — a worker claims by writing the hash of a token only it
-- holds. Settling requires presenting the token again, so a worker that paused
-- long enough for its lease to expire, and whose work was reclaimed, cannot
-- come back and write its stale result over the newer one.
--
-- `fencingToken` — strictly increasing per session. Even if two workers somehow
-- both believe they hold the lease, only the higher token may settle. This is
-- the guarantee a lease alone cannot give, because a lease is a timeout and a
-- paused process cannot be told it has been paused.
--
-- `baseVersionId` / `baseSessionHash` — the exact session version the run was
-- requested against. A result computed against version 4 must never be filed
-- against version 5: the tracks it measured may no longer be the tracks in the
-- session, and a map attributed to the wrong version is worse than no map.
-- ---------------------------------------------------------------------------

CREATE TABLE "capture_sync_runs" (
  "id"                  VARCHAR(128) NOT NULL,
  "workspaceId"         VARCHAR(128) NOT NULL,
  "projectId"           VARCHAR(128) NOT NULL,
  "sessionId"           VARCHAR(128) NOT NULL,
  "baseVersionId"       VARCHAR(160) NOT NULL,
  "baseSessionHash"     CHAR(64) NOT NULL,
  "baseVersion"         INTEGER NOT NULL,
  "status"              VARCHAR(24) NOT NULL,
  "fencingToken"        BIGINT NOT NULL,
  "attemptCount"        INTEGER NOT NULL DEFAULT 0,
  "maxAttempts"         INTEGER NOT NULL DEFAULT 3,
  "leaseOwner"          VARCHAR(128),
  "leaseTokenHash"      CHAR(64),
  "leaseExpiresAt"      TIMESTAMPTZ(3),
  "heartbeatAt"         TIMESTAMPTZ(3),
  "idempotencyKey"      VARCHAR(128) NOT NULL,
  "createdByClientId"   VARCHAR(80) NOT NULL,
  "trackCount"          INTEGER NOT NULL,
  "resolvedCount"       INTEGER,
  "reviewCount"         INTEGER,
  "insufficientCount"   INTEGER,
  "failureReason"       VARCHAR(512),
  "startedAt"           TIMESTAMPTZ(3),
  "settledAt"           TIMESTAMPTZ(3),
  "createdAt"           TIMESTAMPTZ(3) NOT NULL,
  "updatedAt"           TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "capture_sync_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "capture_sync_runs_status_check"
    CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed', 'superseded')),
  CONSTRAINT "capture_sync_runs_counters_check"
    CHECK ("fencingToken" > 0 AND "attemptCount" >= 0 AND "maxAttempts" >= 1
           AND "baseVersion" >= 1 AND "trackCount" >= 1),
  -- A running claim is all-or-nothing. An owner without an expiry is a lease
  -- nobody can reclaim; an expiry without a token hash is a lease anybody can
  -- settle.
  CONSTRAINT "capture_sync_runs_lease_check"
    CHECK (
      ("status" = 'running' AND "leaseOwner" IS NOT NULL AND "leaseTokenHash" IS NOT NULL
        AND "leaseExpiresAt" IS NOT NULL AND "startedAt" IS NOT NULL) OR
      ("status" <> 'running' AND "leaseOwner" IS NULL AND "leaseTokenHash" IS NULL
        AND "leaseExpiresAt" IS NULL)
    ),
  -- A settled run says when it settled, and a failed one says why. "Failed"
  -- with no reason is a result nobody can act on.
  CONSTRAINT "capture_sync_runs_settled_check"
    CHECK (
      ("status" IN ('succeeded', 'failed', 'superseded') AND "settledAt" IS NOT NULL) OR
      ("status" IN ('queued', 'running') AND "settledAt" IS NULL)
    ),
  CONSTRAINT "capture_sync_runs_failure_check"
    CHECK ("status" <> 'failed' OR "failureReason" IS NOT NULL),
  -- A run that succeeded reports how every track came out, and the three
  -- counts must add up to the tracks it was asked about. A run that has not
  -- succeeded reports none of them: partial counts read as a finished answer.
  CONSTRAINT "capture_sync_runs_outcome_check"
    CHECK (
      ("status" = 'succeeded' AND "resolvedCount" IS NOT NULL AND "reviewCount" IS NOT NULL
        AND "insufficientCount" IS NOT NULL
        AND "resolvedCount" + "reviewCount" + "insufficientCount" = "trackCount") OR
      ("status" <> 'succeeded' AND "resolvedCount" IS NULL AND "reviewCount" IS NULL
        AND "insufficientCount" IS NULL)
    )
);

CREATE UNIQUE INDEX "capture_sync_runs_id_workspaceId_key" ON "capture_sync_runs" ("id", "workspaceId");
-- Fencing tokens are unique per session and strictly increasing, so "is this
-- the newest claim" is a comparison rather than a judgement call.
CREATE UNIQUE INDEX "capture_sync_runs_workspaceId_sessionId_fencingToken_key" ON "capture_sync_runs" ("workspaceId", "sessionId", "fencingToken");
-- One run per idempotency key per client: a retried request rejoins the run it
-- already started rather than starting a second one over the same media.
CREATE UNIQUE INDEX "capture_sync_runs_workspaceId_client_idempotencyKey_key" ON "capture_sync_runs" ("workspaceId", "createdByClientId", "idempotencyKey");
CREATE INDEX "capture_sync_runs_status_leaseExpiresAt_createdAt_idx" ON "capture_sync_runs" ("status", "leaseExpiresAt", "createdAt");
CREATE INDEX "capture_sync_runs_workspaceId_sessionId_createdAt_idx" ON "capture_sync_runs" ("workspaceId", "sessionId", "createdAt" DESC);

ALTER TABLE "capture_sync_runs"
  ADD CONSTRAINT "capture_sync_runs_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "capture_sync_runs"
  ADD CONSTRAINT "capture_sync_runs_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "capture_sync_runs"
  ADD CONSTRAINT "capture_sync_runs_sessionId_workspaceId_fkey"
  FOREIGN KEY ("sessionId", "workspaceId") REFERENCES "capture_session_heads"("sessionId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

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
  -- The cut cannot be longer than the master it was cut from.
  CONSTRAINT "editorial_syntheses_source_check"
    CHECK ("synthesizedDurationMs" <= "sourceDurationMs"),
  CONSTRAINT "editorial_syntheses_dropped_check"
    CHECK ("droppedMs" = "sourceDurationMs" - "synthesizedDurationMs"),
  -- The result must hit the target it was asked for. Storing a miss would let
  -- a cut that failed its brief read as one that met it.
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
  "id"                    VARCHAR(160) NOT NULL,
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
  "id"                    VARCHAR(160) NOT NULL,
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
-- Foreign keys. Every one carries workspaceId, so a row cannot be joined to
-- another workspace's parent — structurally impossible rather than merely
-- unlikely.
-- ---------------------------------------------------------------------------

ALTER TABLE "capture_session_versions"
  ADD CONSTRAINT "capture_session_versions_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "capture_session_versions"
  ADD CONSTRAINT "capture_session_versions_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "capture_session_heads"
  ADD CONSTRAINT "capture_session_heads_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "capture_session_heads"
  ADD CONSTRAINT "capture_session_heads_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "capture_session_clocks"
  ADD CONSTRAINT "capture_session_clocks_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "capture_session_clocks"
  ADD CONSTRAINT "capture_session_clocks_sessionId_workspaceId_fkey"
  FOREIGN KEY ("sessionId", "workspaceId") REFERENCES "capture_session_heads"("sessionId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "capture_clock_maps"
  ADD CONSTRAINT "capture_clock_maps_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "capture_clock_maps"
  ADD CONSTRAINT "capture_clock_maps_sessionId_workspaceId_fkey"
  FOREIGN KEY ("sessionId", "workspaceId") REFERENCES "capture_session_heads"("sessionId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

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
  ADD CONSTRAINT "capture_track_coverages_sessionId_workspaceId_fkey"
  FOREIGN KEY ("sessionId", "workspaceId") REFERENCES "capture_session_heads"("sessionId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "capture_sync_evidence"
  ADD CONSTRAINT "capture_sync_evidence_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "capture_sync_evidence"
  ADD CONSTRAINT "capture_sync_evidence_sessionId_workspaceId_fkey"
  FOREIGN KEY ("sessionId", "workspaceId") REFERENCES "capture_session_heads"("sessionId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "capture_drift_fits"
  ADD CONSTRAINT "capture_drift_fits_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "capture_drift_fits"
  ADD CONSTRAINT "capture_drift_fits_sessionId_workspaceId_fkey"
  FOREIGN KEY ("sessionId", "workspaceId") REFERENCES "capture_session_heads"("sessionId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

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
