-- F4.012 / FR-150, F4.013 / FR-151, F4.014 / FR-152 and F4.015 / FR-153 —
-- multicam direction, camera colour match, the colour critic and react
-- playback maps.
--
-- Four aggregates land together because they read one another: a direction
-- cites the sync diagnostic and the evidence set, a match plan cites the
-- colour measurements, the critic cites the match plan, and a playback map
-- cites the session clock. Splitting them across migrations would let a
-- database exist in which one half can name the other and the other cannot.
--
-- What the CHECK constraints encode, table by table, is written above each of
-- them. Four refusals run through all of them and are worth stating once:
--
-- 1. Not measured is NULL, never 0. A colour dimension that could not be read
--    carries no number, no unit and no evaluator, and says why in words; a
--    playback piece with no measured rate carries no rate rather than 1/1. A
--    zero would assert "measured, and worthless", which is a different claim.
-- 2. Derived flags equal their derivation. 'manualReviewRequired',
--    'humanReviewRequired', a shot's confidence band, a critic's action and a
--    playback map's status are all computed by the domain from things stored
--    beside them, so each is stored with the equality that recomputes it. A
--    repair script cannot flip the flag without flipping the evidence.
-- 3. A judgement names what it was made of. Shots cite evidence refs and cap
--    the list at 32 while recording how many were dropped; candidates keep
--    their rejection reasons so a rejected angle stays inspectable (ADR-118);
--    match transforms name the measurements they were derived from; manual
--    playback anchors carry the actor and the note, and the evidence string is
--    the actor plus the note rather than the note instead of the actor.
-- 4. Two rows cannot describe one instant twice. Shots within a direction and
--    pieces within a playback map are kept from overlapping by EXCLUDE
--    constraints over int8range of ticks, because "which one wins" is not a
--    question the reader of a timeline should have to answer.
--
-- Ticks are BIGINT columns and rates are numerator/denominator pairs, the same
-- as Wave 18: 30000/1001 is exactly two integers and is not a float at all.
-- Collections the database never reasons about on their own — policies,
-- warnings, opaque evidence values — live as canonical JSON beside the hash
-- that covers them; collections a constraint must see are rows.

-- The EXCLUDE constraints below need scalar equality and range overlap in one
-- GiST index. Wave 18 already created the extension; the guard makes this
-- migration applicable from an empty database on its own.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- F4.012 / FR-150 — multicam evidence, angle candidates, shots and directions
-- ---------------------------------------------------------------------------

CREATE TABLE "multicam_evidence_sets" (
    "id" VARCHAR(128) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "sessionId" VARCHAR(128) NOT NULL,
    "schemaVersion" VARCHAR(64) NOT NULL,
    "sessionVersion" INTEGER NOT NULL,
    "referenceEpoch" INTEGER NOT NULL,
    "observationCount" INTEGER NOT NULL,
    "generatedAt" TIMESTAMPTZ(3) NOT NULL,
    "evidenceHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "multicam_evidence_sets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "multicam_evidence_sets_counters_check"
        CHECK ("sessionVersion" >= 1 AND "referenceEpoch" >= 1 AND "observationCount" >= 0)
);

CREATE INDEX "multicam_evidence_sets_workspaceId_sessionId_generatedAt_idx" ON "multicam_evidence_sets"("workspaceId", "sessionId", "generatedAt" DESC);
CREATE UNIQUE INDEX "multicam_evidence_sets_id_workspaceId_key" ON "multicam_evidence_sets"("id", "workspaceId");
CREATE UNIQUE INDEX "multicam_evidence_sets_workspaceId_evidenceHash_key" ON "multicam_evidence_sets"("workspaceId", "evidenceHash");

CREATE TABLE "multicam_observations" (
    "id" VARCHAR(160) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "evidenceSetId" VARCHAR(128) NOT NULL,
    "observationId" VARCHAR(128) NOT NULL,
    "trackId" VARCHAR(128) NOT NULL,
    "rangeStartTicks" BIGINT NOT NULL,
    "rangeEndTicks" BIGINT NOT NULL,
    "kind" VARCHAR(24) NOT NULL,
    "valueJson" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "method" VARCHAR(128) NOT NULL,
    "evaluatorKind" VARCHAR(16) NOT NULL,
    "evidenceRef" VARCHAR(512) NOT NULL,
    "producedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "multicam_observations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "multicam_observations_kind_check"
        CHECK ("kind" IN ('active-speaker', 'concurrent-speech', 'silence', 'reaction',
                         'demonstration', 'screen-activity', 'technical-quality', 'attention')),
    CONSTRAINT "multicam_observations_evaluator_check"
        CHECK ("evaluatorKind" IN ('measured', 'controlled', 'declared')),
    CONSTRAINT "multicam_observations_confidence_check"
        CHECK ("confidence" >= 0 AND "confidence" <= 1 AND "rangeStartTicks" < "rangeEndTicks"),
    -- An observation nobody can re-open is indistinguishable from a guess.
    CONSTRAINT "multicam_observations_evidence_check"
        CHECK (char_length(btrim("evidenceRef")) >= 1 AND char_length(btrim("method")) >= 1),
    -- The declared kind and the kind inside the value are one fact said twice
    -- (multicam-evidence.ts assertValue).
    --
    -- COALESCE because a CHECK is violated only by FALSE: `->> 'kind'` on a
    -- document with no `kind` is NULL, `NULL = "kind"` is unknown, and unknown
    -- passes. Without it the constraint refused a value that names the WRONG
    -- kind and accepted one that names NO kind — which is the repair-script
    -- edit it exists to refuse.
    CONSTRAINT "multicam_observations_value_check"
        CHECK (jsonb_typeof("valueJson"::jsonb) = 'object'
              AND COALESCE("valueJson"::jsonb ->> 'kind' = "kind", FALSE))
);

CREATE INDEX "multicam_observations_workspaceId_evidenceSetId_kind_idx" ON "multicam_observations"("workspaceId", "evidenceSetId", "kind");
CREATE UNIQUE INDEX "multicam_observations_id_workspaceId_key" ON "multicam_observations"("id", "workspaceId");
CREATE UNIQUE INDEX "multicam_observations_set_observation_key" ON "multicam_observations"("workspaceId", "evidenceSetId", "observationId");

CREATE TABLE "multicam_directions" (
    "id" VARCHAR(160) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "sessionId" VARCHAR(128) NOT NULL,
    "schemaVersion" VARCHAR(64) NOT NULL,
    "version" INTEGER NOT NULL,
    "previousVersionHash" CHAR(64),
    "sessionVersion" INTEGER NOT NULL,
    "referenceEpoch" INTEGER NOT NULL,
    "diagnosticVersion" INTEGER NOT NULL,
    "diagnosticHash" CHAR(64) NOT NULL,
    "evidenceHash" CHAR(64) NOT NULL,
    "rangeStartTicks" BIGINT NOT NULL,
    "rangeEndTicks" BIGINT NOT NULL,
    "aspectRatio" VARCHAR(8) NOT NULL,
    "policyCalibrationVersion" VARCHAR(128) NOT NULL,
    "policyJson" TEXT NOT NULL,
    "audioTrackId" VARCHAR(128),
    "audioRejectedJson" TEXT NOT NULL DEFAULT '[]',
    "shotCount" INTEGER NOT NULL,
    "lowConfidenceShotCount" INTEGER NOT NULL DEFAULT 0,
    "uncoveredJson" TEXT NOT NULL DEFAULT '[]',
    "uncoveredCount" INTEGER NOT NULL DEFAULT 0,
    "warningsJson" TEXT NOT NULL DEFAULT '[]',
    "warningCount" INTEGER NOT NULL DEFAULT 0,
    "manualReviewRequired" BOOLEAN NOT NULL,
    "generatedAt" TIMESTAMPTZ(3) NOT NULL,
    "directionHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "multicam_directions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "multicam_directions_chain_check"
        CHECK (("version" = 1 AND "previousVersionHash" IS NULL) OR
              ("version" > 1 AND "previousVersionHash" IS NOT NULL)),
    CONSTRAINT "multicam_directions_counters_check"
        CHECK ("version" >= 1 AND "sessionVersion" >= 1 AND "referenceEpoch" >= 1
              AND "diagnosticVersion" >= 1 AND "shotCount" >= 0 AND "uncoveredCount" >= 0
              AND "warningCount" >= 0 AND "lowConfidenceShotCount" >= 0
              AND "lowConfidenceShotCount" <= "shotCount"),
    CONSTRAINT "multicam_directions_range_check"
        CHECK ("rangeStartTicks" < "rangeEndTicks"),
    CONSTRAINT "multicam_directions_format_check"
        CHECK ("aspectRatio" IN ('16:9', '9:16', '1:1', '4:5')),
    -- manualReviewRequired is derived, never declared: a warning, an uncovered
    -- stretch or a shot below the medium band forces it
    -- (multicam-direction.ts:1726-1728).
    CONSTRAINT "multicam_directions_manual_review_check"
        CHECK ("manualReviewRequired" = ("warningCount" > 0 OR "uncoveredCount" > 0 OR "lowConfidenceShotCount" > 0))
);

CREATE INDEX "multicam_directions_workspaceId_sessionId_generatedAt_idx" ON "multicam_directions"("workspaceId", "sessionId", "generatedAt" DESC);
CREATE INDEX "multicam_directions_workspaceId_sessionId_diagnosticHash_idx" ON "multicam_directions"("workspaceId", "sessionId", "diagnosticHash");
CREATE INDEX "multicam_directions_workspaceId_evidenceHash_idx" ON "multicam_directions"("workspaceId", "evidenceHash");
CREATE UNIQUE INDEX "multicam_directions_id_workspaceId_key" ON "multicam_directions"("id", "workspaceId");
CREATE UNIQUE INDEX "multicam_directions_workspaceId_sessionId_version_key" ON "multicam_directions"("workspaceId", "sessionId", "version");
CREATE UNIQUE INDEX "multicam_directions_workspaceId_directionHash_key" ON "multicam_directions"("workspaceId", "directionHash");

CREATE TABLE "multicam_direction_heads" (
    "id" VARCHAR(128) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "sessionId" VARCHAR(128) NOT NULL,
    "version" INTEGER NOT NULL,
    "directionHash" CHAR(64) NOT NULL,
    "shotCount" INTEGER NOT NULL,
    "manualReviewRequired" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "multicam_direction_heads_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "multicam_direction_heads_version_check"
        CHECK ("version" >= 1 AND "shotCount" >= 0)
);

CREATE INDEX "multicam_direction_heads_workspaceId_manualReviewRequired_idx" ON "multicam_direction_heads"("workspaceId", "manualReviewRequired");
CREATE UNIQUE INDEX "multicam_direction_heads_id_workspaceId_key" ON "multicam_direction_heads"("id", "workspaceId");
CREATE UNIQUE INDEX "multicam_direction_heads_sessionId_workspaceId_key" ON "multicam_direction_heads"("sessionId", "workspaceId");

CREATE TABLE "multicam_shot_decisions" (
    "id" VARCHAR(160) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "directionId" VARCHAR(160) NOT NULL,
    "sessionId" VARCHAR(128) NOT NULL,
    "shotId" VARCHAR(128) NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "schemaVersion" VARCHAR(64) NOT NULL,
    "sessionStartTicks" BIGINT NOT NULL,
    "sessionEndTicks" BIGINT NOT NULL,
    "trackId" VARCHAR(128) NOT NULL,
    "cameraId" VARCHAR(128) NOT NULL,
    "candidateId" VARCHAR(128) NOT NULL,
    "candidateHash" CHAR(64) NOT NULL,
    "sourcePieceId" VARCHAR(128),
    "sourcePartId" VARCHAR(128),
    "audioTrackId" VARCHAR(128),
    "rule" VARCHAR(32) NOT NULL,
    "reason" VARCHAR(1024) NOT NULL,
    "evidenceRefsJson" TEXT NOT NULL DEFAULT '[]',
    "evidenceRefCount" INTEGER NOT NULL,
    "evidenceRefsTruncated" INTEGER NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL,
    "confidenceBand" VARCHAR(16) NOT NULL,
    "alternativeCount" INTEGER NOT NULL DEFAULT 0,
    "decisionHash" CHAR(64) NOT NULL,

    CONSTRAINT "multicam_shot_decisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "multicam_shot_decisions_rule_check"
        CHECK ("rule" IN ('demonstration-prefers-screen', 'speech-prefers-active-speaker',
                         'reaction-cutaway', 'cutaway-return', 'redundant-angles-hold',
                         'minimum-shot-hold', 'jump-cut-avoided', 'protected-selection',
                         'conservative-hold')),
    -- The band is the confidence read through DIRECTION_CONFIDENCE_BAND_FLOORS
    -- (multicam-direction.ts:161-169). Both are stored so a reader can sort by
    -- band without re-deriving it; this equality is what keeps them one fact.
    CONSTRAINT "multicam_shot_decisions_confidence_check"
        CHECK ("confidence" >= 0 AND "confidence" <= 1
              AND "confidenceBand" = CASE
                WHEN "confidence" >= 0.85 THEN 'high'
                WHEN "confidence" >= 0.65 THEN 'medium'
                WHEN "confidence" >= 0.4 THEN 'low'
                ELSE 'insufficient'
              END),
    CONSTRAINT "multicam_shot_decisions_range_check"
        CHECK ("sessionStartTicks" < "sessionEndTicks" AND "ordinal" >= 0 AND "alternativeCount" >= 0),
    -- A shot that cannot say why it was cut is not reviewable.
    CONSTRAINT "multicam_shot_decisions_reason_check"
        CHECK (char_length(btrim("reason")) >= 10),
    -- SHOT_EVIDENCE_REF_CAP is 32 (multicam-direction.ts:1438): a dropped-ref
    -- count above zero is only possible once the list actually reached the cap.
    CONSTRAINT "multicam_shot_decisions_evidence_check"
        CHECK ("evidenceRefCount" BETWEEN 1 AND 32 AND "evidenceRefsTruncated" >= 0
              AND ("evidenceRefsTruncated" = 0 OR "evidenceRefCount" = 32))
);

CREATE INDEX "multicam_shot_decisions_workspaceId_sessionId_trackId_idx" ON "multicam_shot_decisions"("workspaceId", "sessionId", "trackId");
CREATE UNIQUE INDEX "multicam_shot_decisions_id_workspaceId_key" ON "multicam_shot_decisions"("id", "workspaceId");
CREATE UNIQUE INDEX "multicam_shot_decisions_workspaceId_directionId_ordinal_key" ON "multicam_shot_decisions"("workspaceId", "directionId", "ordinal");
CREATE UNIQUE INDEX "multicam_shot_decisions_workspaceId_directionId_shotId_key" ON "multicam_shot_decisions"("workspaceId", "directionId", "shotId");

-- Two shots of one direction cannot claim the same instant of the session.
-- A timeline that plays two angles at once is not a timeline, and the loser of
-- the race is the row that must be refused rather than the answer.
ALTER TABLE "multicam_shot_decisions"
    ADD CONSTRAINT "multicam_shot_decisions_no_overlap_excl"
    EXCLUDE USING gist (
        "workspaceId" WITH =,
        "directionId" WITH =,
        int8range("sessionStartTicks", "sessionEndTicks") WITH &&
    );

CREATE TABLE "multicam_shot_alternatives" (
    "id" VARCHAR(160) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "shotId" VARCHAR(160) NOT NULL,
    "directionId" VARCHAR(160) NOT NULL,
    "candidateId" VARCHAR(128) NOT NULL,
    "trackId" VARCHAR(128) NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "scoreTotal" DOUBLE PRECISION NOT NULL,
    "rejectedBecause" VARCHAR(512) NOT NULL,

    CONSTRAINT "multicam_shot_alternatives_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "multicam_shot_alternatives_ordinal_check"
        CHECK ("ordinal" >= 0),
    -- rejectedBecause is a sentence, not a code: alternativesOf
    -- (multicam-direction.ts:1415-1417) writes either "scored 0.812 under
    -- speech-prefers-active-speaker" or the comma-joined rejection list, so an
    -- IN () here would refuse every eligible-but-outscored alternative.
    CONSTRAINT "multicam_shot_alternatives_reason_check"
        CHECK (char_length(btrim("rejectedBecause")) >= 1)
);

CREATE INDEX "multicam_shot_alternatives_workspaceId_directionId_idx" ON "multicam_shot_alternatives"("workspaceId", "directionId");
CREATE UNIQUE INDEX "multicam_shot_alternatives_id_workspaceId_key" ON "multicam_shot_alternatives"("id", "workspaceId");
CREATE UNIQUE INDEX "multicam_shot_alternatives_workspaceId_shotId_candidateId_key" ON "multicam_shot_alternatives"("workspaceId", "shotId", "candidateId");

CREATE TABLE "multicam_angle_candidates" (
    "id" VARCHAR(160) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "shotId" VARCHAR(160) NOT NULL,
    "directionId" VARCHAR(160) NOT NULL,
    "candidateId" VARCHAR(128) NOT NULL,
    "schemaVersion" VARCHAR(64) NOT NULL,
    "trackId" VARCHAR(128) NOT NULL,
    "sourceAssetId" VARCHAR(128) NOT NULL,
    "role" VARCHAR(24) NOT NULL,
    "context" VARCHAR(24) NOT NULL,
    "sessionStartTicks" BIGINT NOT NULL,
    "sessionEndTicks" BIGINT NOT NULL,
    "sourceStartTicks" BIGINT,
    "sourceEndTicks" BIGINT,
    "sourcePieceId" VARCHAR(128),
    "sourcePartId" VARCHAR(128),
    "sourcePartAssetId" VARCHAR(128),
    "coverageAvailability" VARCHAR(16) NOT NULL,
    "coverageConfidenceBps" INTEGER,
    "syncStatus" VARCHAR(16),
    "syncConfidence" DOUBLE PRECISION,
    "previousTrackId" VARCHAR(128),
    "sameAngleTicks" BIGINT NOT NULL,
    "spatialRelation" VARCHAR(16) NOT NULL,
    "protectedSelectionId" VARCHAR(128),
    "protectedReason" VARCHAR(512),
    "eligible" BOOLEAN NOT NULL,
    "rejectionReasonsJson" TEXT NOT NULL DEFAULT '[]',
    "rejectionCount" INTEGER NOT NULL DEFAULT 0,
    "scoreTotal" DOUBLE PRECISION NOT NULL,
    "candidateHash" CHAR(64) NOT NULL,

    CONSTRAINT "multicam_angle_candidates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "multicam_angle_candidates_role_check"
        CHECK ("role" IN ('camera-main', 'camera-alt', 'screen', 'phone', 'reaction',
                         'reference-video', 'microphone', 'master-audio', 'scratch-audio')
              AND "context" IN ('speaker', 'reaction', 'screen', 'wide', 'reference-video')),
    CONSTRAINT "multicam_angle_candidates_coverage_check"
        CHECK ("coverageAvailability" IN ('available', 'gap', 'corrupt', 'unverified',
                                         'out-of-bounds', 'unmeasured')
              AND ("coverageConfidenceBps" IS NULL OR
                   ("coverageConfidenceBps" >= 0 AND "coverageConfidenceBps" <= 10000))),
    CONSTRAINT "multicam_angle_candidates_sync_check"
        CHECK (("syncStatus" IS NULL OR "syncStatus" IN ('synced-high', 'synced-medium', 'partial',
                                                        'needs-input', 'failed', 'reference'))
              AND ("syncConfidence" IS NULL OR ("syncConfidence" >= 0 AND "syncConfidence" <= 1))),
    CONSTRAINT "multicam_angle_candidates_continuity_check"
        CHECK ("spatialRelation" IN ('same', 'adjacent', 'opposite', 'unknown') AND "sameAngleTicks" >= 0),
    -- A source range is all-or-nothing: a start without an end places nothing.
    CONSTRAINT "multicam_angle_candidates_range_check"
        CHECK ("sessionStartTicks" < "sessionEndTicks"
              AND ("sourceStartTicks" IS NULL) = ("sourceEndTicks" IS NULL)
              AND ("sourceStartTicks" IS NULL OR "sourceStartTicks" < "sourceEndTicks")),
    CONSTRAINT "multicam_angle_candidates_protected_check"
        CHECK (("protectedSelectionId" IS NULL) = ("protectedReason" IS NULL)),
    -- ADR-118: a rejected candidate stays inspectable, and eligibility is
    -- exactly the emptiness of its rejection list (multicam-direction.ts:1000).
    CONSTRAINT "multicam_angle_candidates_eligible_check"
        CHECK ("rejectionCount" >= 0 AND "eligible" = ("rejectionCount" = 0))
);

CREATE INDEX "multicam_angle_candidates_workspaceId_directionId_eligible_idx" ON "multicam_angle_candidates"("workspaceId", "directionId", "eligible");
CREATE INDEX "multicam_angle_candidates_workspaceId_trackId_idx" ON "multicam_angle_candidates"("workspaceId", "trackId");
CREATE UNIQUE INDEX "multicam_angle_candidates_id_workspaceId_key" ON "multicam_angle_candidates"("id", "workspaceId");
CREATE UNIQUE INDEX "multicam_angle_candidates_workspaceId_shotId_candidateId_key" ON "multicam_angle_candidates"("workspaceId", "shotId", "candidateId");

CREATE TABLE "multicam_angle_score_components" (
    "id" VARCHAR(160) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "candidateId" VARCHAR(160) NOT NULL,
    "name" VARCHAR(32) NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "evidenceRefsJson" TEXT NOT NULL DEFAULT '[]',
    "evidenceRefCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "multicam_angle_score_components_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "multicam_angle_score_components_name_check"
        CHECK ("name" IN ('baseline', 'speaker', 'demonstration', 'reaction', 'quality',
                         'continuity', 'redundancyPenalty', 'protectedBonus', 'formatPenalty')
              AND "evidenceRefCount" >= 0)
);

CREATE UNIQUE INDEX "multicam_angle_score_components_id_workspaceId_key" ON "multicam_angle_score_components"("id", "workspaceId");
CREATE UNIQUE INDEX "multicam_angle_score_components_candidate_name_key" ON "multicam_angle_score_components"("workspaceId", "candidateId", "name");

-- ---------------------------------------------------------------------------
-- F4.013 / FR-151 — camera colour measurements and multicam match plans
-- ---------------------------------------------------------------------------

CREATE TABLE "camera_color_measurements" (
    "id" VARCHAR(128) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "sessionId" VARCHAR(128),
    "schemaVersion" VARCHAR(64) NOT NULL,
    "measurementId" VARCHAR(128) NOT NULL,
    "sourceAssetId" VARCHAR(128) NOT NULL,
    "sourceSha256" CHAR(64) NOT NULL,
    "cameraId" VARCHAR(128) NOT NULL,
    "rangeStartTicks" BIGINT NOT NULL,
    "rangeEndTicks" BIGINT NOT NULL,
    "sourceStartFrame" INTEGER NOT NULL,
    "sourceEndFrame" INTEGER NOT NULL,
    "sampledFrames" INTEGER NOT NULL,
    "pixelFormat" VARCHAR(32) NOT NULL,
    "hdrMode" VARCHAR(8) NOT NULL,
    "metadataJson" TEXT NOT NULL,
    "comparable" BOOLEAN NOT NULL,
    "comparabilityJson" TEXT NOT NULL DEFAULT '[]',
    "confidence" DOUBLE PRECISION NOT NULL,
    "issuesJson" TEXT NOT NULL DEFAULT '[]',
    "measuredDimensions" INTEGER NOT NULL DEFAULT 0,
    "measurementHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "camera_color_measurements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "camera_color_measurements_range_check"
        CHECK ("rangeStartTicks" < "rangeEndTicks" AND "sourceStartFrame" >= 0
              AND "sourceEndFrame" > "sourceStartFrame"),
    CONSTRAINT "camera_color_measurements_technical_check"
        CHECK ("hdrMode" IN ('sdr', 'hlg', 'pq') AND "confidence" >= 0 AND "confidence" <= 1),
    -- COLOR_MEASUREMENT_MINIMUM_FRAMES is 3 (color-measurement.ts:167): below
    -- it a range has not been measured whatever the numbers say. One frame is
    -- a still, not a statistic.
    CONSTRAINT "camera_color_measurements_sampling_check"
        CHECK ("sampledFrames" >= 0 AND "measuredDimensions" BETWEEN 0 AND 8
              AND ("measuredDimensions" = 0 OR "sampledFrames" >= 3)),
    -- deriveComparability (color-measurement.ts:315-327): comparable means SDR
    -- bytes, enough frames, and all four match dimensions actually measured.
    CONSTRAINT "camera_color_measurements_comparable_check"
        CHECK (NOT "comparable" OR ("hdrMode" = 'sdr' AND "sampledFrames" >= 3 AND "measuredDimensions" >= 4))
);

CREATE INDEX "camera_color_measurements_camera_source_idx" ON "camera_color_measurements"("workspaceId", "cameraId", "sourceAssetId");
CREATE INDEX "camera_color_measurements_workspaceId_sessionId_idx" ON "camera_color_measurements"("workspaceId", "sessionId");
CREATE UNIQUE INDEX "camera_color_measurements_id_workspaceId_key" ON "camera_color_measurements"("id", "workspaceId");
CREATE UNIQUE INDEX "camera_color_measurements_workspaceId_measurementHash_key" ON "camera_color_measurements"("workspaceId", "measurementHash");

CREATE TABLE "color_measurement_dimensions" (
    "id" VARCHAR(160) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "measurementId" VARCHAR(128) NOT NULL,
    "dimension" VARCHAR(24) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "value" DOUBLE PRECISION,
    "unit" VARCHAR(24),
    "evaluatorId" VARCHAR(128),
    "evaluatorKind" VARCHAR(16),
    "evaluatorVersion" VARCHAR(64),
    "evidenceRef" VARCHAR(512),
    "reason" VARCHAR(512),

    CONSTRAINT "color_measurement_dimensions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "color_measurement_dimensions_dimension_check"
        CHECK ("dimension" IN ('whiteBalance', 'exposure', 'contrast', 'blacks', 'highlights',
                              'saturation', 'tonalResponse', 'skin')
              AND "status" IN ('measured', 'not-applicable', 'unavailable')
              AND ("evaluatorKind" IS NULL OR "evaluatorKind" IN ('measured', 'controlled'))),
    -- COLOR_MEASUREMENT_UNITS is fixed per dimension: a reader comparing
    -- "exposure 0.42" with "exposure 0.55" must not have to ask which unit.
    CONSTRAINT "color_measurement_dimensions_unit_check"
        CHECK ("unit" IS NULL OR "unit" = CASE "dimension"
                WHEN 'whiteBalance' THEN 'ratio'
                WHEN 'exposure' THEN 'normalized-luma'
                WHEN 'contrast' THEN 'normalized-luma'
                WHEN 'blacks' THEN 'ratio'
                WHEN 'highlights' THEN 'ratio'
                WHEN 'saturation' THEN 'normalized-chroma'
                WHEN 'tonalResponse' THEN 'normalized-luma'
                WHEN 'skin' THEN 'degrees'
              END),
    -- Not measured is NULL, never 0. A measured dimension carries a number, its
    -- unit, the evaluator that produced it and something that can be re-opened;
    -- anything else carries no number at all and says why in words
    -- (color-measurement.ts:261-313).
    CONSTRAINT "color_measurement_dimensions_resolution_check"
        CHECK (("status" = 'measured' AND "value" IS NOT NULL AND "unit" IS NOT NULL
                AND "evaluatorId" IS NOT NULL AND "evaluatorKind" IS NOT NULL
                AND "evaluatorVersion" IS NOT NULL
                AND char_length(btrim("evidenceRef")) >= 1 AND "reason" IS NULL) OR
              ("status" <> 'measured' AND "value" IS NULL AND "unit" IS NULL
                AND "evaluatorId" IS NULL AND "evaluatorKind" IS NULL
                AND "evaluatorVersion" IS NULL AND "evidenceRef" IS NULL
                AND char_length(btrim("reason")) >= 10))
);

CREATE INDEX "color_measurement_dimensions_dimension_status_idx" ON "color_measurement_dimensions"("workspaceId", "dimension", "status");
CREATE UNIQUE INDEX "color_measurement_dimensions_id_workspaceId_key" ON "color_measurement_dimensions"("id", "workspaceId");
CREATE UNIQUE INDEX "color_measurement_dimensions_measurement_dimension_key" ON "color_measurement_dimensions"("workspaceId", "measurementId", "dimension");

CREATE TABLE "color_measurement_components" (
    "id" VARCHAR(160) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "dimensionId" VARCHAR(160) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "color_measurement_components_pkey" PRIMARY KEY ("id"),
    -- COMPONENT_KEY (color-measurement.ts:160): components are read by people
    -- and asked for by name (rOverG, bOverG), so they use the identifier
    -- grammar rather than the lowercase ColorPlan token one.
    CONSTRAINT "color_measurement_components_name_check"
        CHECK ("name" ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$')
);

CREATE UNIQUE INDEX "color_measurement_components_id_workspaceId_key" ON "color_measurement_components"("id", "workspaceId");
CREATE UNIQUE INDEX "color_measurement_components_dimension_name_key" ON "color_measurement_components"("workspaceId", "dimensionId", "name");

CREATE TABLE "multicam_match_plans" (
    "id" VARCHAR(160) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "projectId" VARCHAR(128) NOT NULL,
    "sessionId" VARCHAR(128) NOT NULL,
    "schemaVersion" VARCHAR(64) NOT NULL,
    "planId" VARCHAR(128) NOT NULL,
    "version" INTEGER NOT NULL,
    "previousVersionHash" CHAR(64),
    "supersedesPlanId" VARCHAR(128),
    "sessionVersion" INTEGER NOT NULL,
    "referenceEpoch" INTEGER NOT NULL,
    "referenceCameraId" VARCHAR(128) NOT NULL,
    "selectedByKind" VARCHAR(16) NOT NULL,
    "selectedById" VARCHAR(128) NOT NULL,
    "selectedAt" TIMESTAMPTZ(3) NOT NULL,
    "selectionBaseVersionId" VARCHAR(160) NOT NULL,
    "selectionBaseHash" CHAR(64) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "pipelineStage" VARCHAR(16) NOT NULL,
    "humanReviewRequired" BOOLEAN NOT NULL,
    "transformCount" INTEGER NOT NULL DEFAULT 0,
    "overrideCount" INTEGER NOT NULL DEFAULT 0,
    "issueCount" INTEGER NOT NULL DEFAULT 0,
    "nonComparableCount" INTEGER NOT NULL DEFAULT 0,
    "reviewIssueCount" INTEGER NOT NULL DEFAULT 0,
    "lineageJson" TEXT NOT NULL,
    "dependsOnMeasurementIdsJson" TEXT NOT NULL DEFAULT '[]',
    "planHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "multicam_match_plans_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "multicam_match_plans_chain_check"
        CHECK (("version" = 1 AND "previousVersionHash" IS NULL) OR
              ("version" > 1 AND "previousVersionHash" IS NOT NULL)),
    CONSTRAINT "multicam_match_plans_counters_check"
        CHECK ("version" >= 1 AND "sessionVersion" >= 1 AND "referenceEpoch" >= 1
              AND "transformCount" >= 0 AND "overrideCount" >= 0 AND "issueCount" >= 0
              AND "nonComparableCount" >= 0 AND "reviewIssueCount" >= 0
              AND "reviewIssueCount" <= "issueCount"
              AND "confidence" >= 0 AND "confidence" <= 1),
    CONSTRAINT "multicam_match_plans_actor_check"
        CHECK ("selectedByKind" IN ('human', 'director', 'system')),
    -- F4.013, in SQL: a match is a match-stage plan. COLOR_TRANSFORM_ORDER puts
    -- `match` before `creative-lut`, and a correction that ran after the look
    -- is not a match at all (multicam-match-plan.ts:45, assertMatchPlanInvariants).
    CONSTRAINT "multicam_match_plans_stage_check"
        CHECK ("pipelineStage" = 'match'),
    -- humanReviewRequired is what the issues say, not what a caller declares
    -- (multicam-match-plan.ts:1094).
    CONSTRAINT "multicam_match_plans_review_check"
        CHECK ("humanReviewRequired" = ("reviewIssueCount" > 0))
);

CREATE INDEX "multicam_match_plans_workspaceId_sessionId_createdAt_idx" ON "multicam_match_plans"("workspaceId", "sessionId", "createdAt" DESC);
CREATE INDEX "multicam_match_plans_workspaceId_referenceCameraId_idx" ON "multicam_match_plans"("workspaceId", "referenceCameraId");
CREATE UNIQUE INDEX "multicam_match_plans_id_workspaceId_key" ON "multicam_match_plans"("id", "workspaceId");
CREATE UNIQUE INDEX "multicam_match_plans_project_session_version_key" ON "multicam_match_plans"("workspaceId", "projectId", "sessionId", "version");
CREATE UNIQUE INDEX "multicam_match_plans_workspaceId_planHash_key" ON "multicam_match_plans"("workspaceId", "planHash");

CREATE TABLE "multicam_match_plan_heads" (
    "id" VARCHAR(160) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "projectId" VARCHAR(128) NOT NULL,
    "sessionId" VARCHAR(128) NOT NULL,
    "planId" VARCHAR(128) NOT NULL,
    "version" INTEGER NOT NULL,
    "planHash" CHAR(64) NOT NULL,
    "referenceCameraId" VARCHAR(128) NOT NULL,
    "humanReviewRequired" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "multicam_match_plan_heads_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "multicam_match_plan_heads_version_check"
        CHECK ("version" >= 1)
);

CREATE INDEX "multicam_match_plan_heads_workspaceId_humanReviewRequired_idx" ON "multicam_match_plan_heads"("workspaceId", "humanReviewRequired");
CREATE UNIQUE INDEX "multicam_match_plan_heads_id_workspaceId_key" ON "multicam_match_plan_heads"("id", "workspaceId");
CREATE UNIQUE INDEX "multicam_match_plan_heads_projectId_sessionId_workspaceId_key" ON "multicam_match_plan_heads"("projectId", "sessionId", "workspaceId");

CREATE TABLE "match_plan_measurements" (
    "id" VARCHAR(160) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "planId" VARCHAR(160) NOT NULL,
    "measurementId" VARCHAR(128) NOT NULL,
    "cameraId" VARCHAR(128) NOT NULL,
    "isReference" BOOLEAN NOT NULL,

    CONSTRAINT "match_plan_measurements_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "match_plan_measurements_workspaceId_measurementId_idx" ON "match_plan_measurements"("workspaceId", "measurementId");
CREATE UNIQUE INDEX "match_plan_measurements_id_workspaceId_key" ON "match_plan_measurements"("id", "workspaceId");
CREATE UNIQUE INDEX "match_plan_measurements_plan_measurement_key" ON "match_plan_measurements"("workspaceId", "planId", "measurementId");

-- A plan is built against one reference camera, so at most one of its
-- measurements may claim to be the reference. Prisma cannot express a partial
-- index, and a CHECK on a single row cannot see the other rows it would have
-- to compare itself with.
CREATE UNIQUE INDEX "match_plan_measurements_reference_key" ON "match_plan_measurements"("workspaceId", "planId") WHERE "isReference";

CREATE TABLE "camera_match_transforms" (
    "id" VARCHAR(160) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "planId" VARCHAR(160) NOT NULL,
    "cameraId" VARCHAR(128) NOT NULL,
    "transformId" VARCHAR(128) NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "providerVersion" VARCHAR(8) NOT NULL,
    "mode" VARCHAR(16) NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "parametersJson" TEXT NOT NULL,
    "deltasJson" TEXT NOT NULL,
    "brightness" DOUBLE PRECISION,
    "contrast" DOUBLE PRECISION,
    "saturation" DOUBLE PRECISION,
    "redGain" DOUBLE PRECISION,
    "greenGain" DOUBLE PRECISION,
    "blueGain" DOUBLE PRECISION,
    "exposureEv" DOUBLE PRECISION,
    "derivedFromJson" TEXT NOT NULL DEFAULT '[]',
    "derivedFromCount" INTEGER NOT NULL DEFAULT 0,
    "rangePairs" INTEGER NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "camera_match_transforms_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "camera_match_transforms_provider_check"
        CHECK ("provider" = 'apollo-match' AND "providerVersion" IN ('v1', 'v2')
              AND "mode" IN ('adjust', 'bypass')),
    -- A bypass is an explicit, hashed no-op: it carries no numbers to apply
    -- (multicam-match-plan.ts:312-326).
    CONSTRAINT "camera_match_transforms_mode_check"
        CHECK (("mode" = 'bypass' AND NOT "enabled" AND "brightness" IS NULL AND "contrast" IS NULL
                AND "saturation" IS NULL AND "redGain" IS NULL AND "greenGain" IS NULL
                AND "blueGain" IS NULL) OR
              ("mode" = 'adjust' AND "enabled" AND "brightness" IS NOT NULL
                AND "contrast" IS NOT NULL AND "saturation" IS NOT NULL)),
    -- MATCH_PARAMETER_BOUNDS, one clause per parameter
    -- (multicam-match-plan.ts:95-100). A gain outside [0.5, 2] is a grade.
    CONSTRAINT "camera_match_transforms_bounds_check"
        CHECK (("brightness" IS NULL OR ("brightness" >= -1 AND "brightness" <= 1))
              AND ("contrast" IS NULL OR ("contrast" >= 0.1 AND "contrast" <= 3))
              AND ("saturation" IS NULL OR ("saturation" >= 0 AND "saturation" <= 3))
              AND ("redGain" IS NULL OR ("redGain" >= 0.5 AND "redGain" <= 2))
              AND ("greenGain" IS NULL OR ("greenGain" >= 0.5 AND "greenGain" <= 2))
              AND ("blueGain" IS NULL OR ("blueGain" >= 0.5 AND "blueGain" <= 2))),
    -- Channel gains arrive with v2 and arrive together: a red gain without a
    -- blue one is half a white balance.
    CONSTRAINT "camera_match_transforms_gain_check"
        CHECK (("providerVersion" = 'v2' OR ("redGain" IS NULL AND "greenGain" IS NULL AND "blueGain" IS NULL))
              AND ("redGain" IS NULL) = ("greenGain" IS NULL)
              AND ("redGain" IS NULL) = ("blueGain" IS NULL)),
    -- A correction nobody can trace back to a measurement is a number with no
    -- provenance.
    CONSTRAINT "camera_match_transforms_derivation_check"
        CHECK ("derivedFromCount" >= 1 AND "rangePairs" >= 1
              AND "confidence" >= 0 AND "confidence" <= 1)
);

CREATE INDEX "camera_match_transforms_workspaceId_cameraId_idx" ON "camera_match_transforms"("workspaceId", "cameraId");
CREATE UNIQUE INDEX "camera_match_transforms_id_workspaceId_key" ON "camera_match_transforms"("id", "workspaceId");
CREATE UNIQUE INDEX "camera_match_transforms_workspaceId_planId_cameraId_key" ON "camera_match_transforms"("workspaceId", "planId", "cameraId");

CREATE TABLE "match_range_overrides" (
    "id" VARCHAR(160) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "planId" VARCHAR(160) NOT NULL,
    "overrideId" VARCHAR(128) NOT NULL,
    "cameraId" VARCHAR(128) NOT NULL,
    "segmentId" VARCHAR(128),
    "rangeStartTicks" BIGINT,
    "rangeEndTicks" BIGINT,
    "transformId" VARCHAR(128) NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "providerVersion" VARCHAR(8) NOT NULL,
    "parametersJson" TEXT NOT NULL,
    "reason" VARCHAR(1024) NOT NULL,
    "actorKind" VARCHAR(16) NOT NULL,
    "actorId" VARCHAR(128) NOT NULL,

    CONSTRAINT "match_range_overrides_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "match_range_overrides_provider_check"
        CHECK ("provider" = 'apollo-match' AND "providerVersion" IN ('v1', 'v2')
              AND "actorKind" IN ('human', 'director', 'system')),
    -- Exactly one target: a segment or a range, never both and never neither
    -- (multicam-match-plan.ts normalizedOverride).
    CONSTRAINT "match_range_overrides_target_check"
        CHECK (("segmentId" IS NULL) <> ("rangeStartTicks" IS NULL)
              AND ("rangeStartTicks" IS NULL) = ("rangeEndTicks" IS NULL)
              AND ("rangeStartTicks" IS NULL OR "rangeStartTicks" < "rangeEndTicks")),
    -- An override changes colour by hand and must say why.
    CONSTRAINT "match_range_overrides_reason_check"
        CHECK (char_length(btrim("reason")) >= 3)
);

CREATE INDEX "match_range_overrides_workspaceId_planId_cameraId_idx" ON "match_range_overrides"("workspaceId", "planId", "cameraId");
CREATE UNIQUE INDEX "match_range_overrides_id_workspaceId_key" ON "match_range_overrides"("id", "workspaceId");
CREATE UNIQUE INDEX "match_range_overrides_workspaceId_planId_overrideId_key" ON "match_range_overrides"("workspaceId", "planId", "overrideId");

CREATE TABLE "match_non_comparable_ranges" (
    "id" VARCHAR(160) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "planId" VARCHAR(160) NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "cameraId" VARCHAR(128) NOT NULL,
    "measurementId" VARCHAR(128) NOT NULL,
    "rangeStartTicks" BIGINT NOT NULL,
    "rangeEndTicks" BIGINT NOT NULL,
    "reason" VARCHAR(1024) NOT NULL,

    CONSTRAINT "match_non_comparable_ranges_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "match_non_comparable_ranges_range_check"
        CHECK ("rangeStartTicks" < "rangeEndTicks" AND "ordinal" >= 0
              AND char_length(btrim("reason")) >= 1)
);

CREATE INDEX "match_non_comparable_ranges_workspaceId_planId_cameraId_idx" ON "match_non_comparable_ranges"("workspaceId", "planId", "cameraId");
CREATE UNIQUE INDEX "match_non_comparable_ranges_id_workspaceId_key" ON "match_non_comparable_ranges"("id", "workspaceId");
CREATE UNIQUE INDEX "match_non_comparable_ranges_workspaceId_planId_ordinal_key" ON "match_non_comparable_ranges"("workspaceId", "planId", "ordinal");

CREATE TABLE "match_plan_issues" (
    "id" VARCHAR(160) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "planId" VARCHAR(160) NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "cameraId" VARCHAR(128),
    "message" VARCHAR(1024) NOT NULL,
    "humanReviewRequired" BOOLEAN NOT NULL,

    CONSTRAINT "match_plan_issues_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "match_plan_issues_content_check"
        CHECK ("ordinal" >= 0 AND char_length(btrim("code")) >= 1 AND char_length(btrim("message")) >= 1)
);

CREATE INDEX "match_plan_issues_workspaceId_code_idx" ON "match_plan_issues"("workspaceId", "code");
CREATE UNIQUE INDEX "match_plan_issues_id_workspaceId_key" ON "match_plan_issues"("id", "workspaceId");
CREATE UNIQUE INDEX "match_plan_issues_workspaceId_planId_ordinal_key" ON "match_plan_issues"("workspaceId", "planId", "ordinal");

-- ---------------------------------------------------------------------------
-- F4.014 / FR-152 — colour critic reports
-- ---------------------------------------------------------------------------

CREATE TABLE "color_critic_reports" (
    "id" VARCHAR(128) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "projectId" VARCHAR(128) NOT NULL,
    "projectVersionId" VARCHAR(128) NOT NULL,
    "schemaVersion" VARCHAR(64) NOT NULL,
    "reportId" VARCHAR(128) NOT NULL,
    "subjectKind" VARCHAR(16) NOT NULL,
    "subjectSourceAssetId" VARCHAR(128),
    "subjectCameraId" VARCHAR(128),
    "subjectArtifactId" VARCHAR(128),
    "subjectRangeStartTicks" BIGINT,
    "subjectRangeEndTicks" BIGINT,
    "referenceCameraId" VARCHAR(128),
    "matchPlanId" VARCHAR(128),
    "matchPlanHash" CHAR(64),
    "sectionCount" INTEGER NOT NULL,
    "sectionsJson" TEXT NOT NULL,
    "stagePairsJson" TEXT NOT NULL DEFAULT '[]',
    "bytesEvaluatedJson" TEXT NOT NULL DEFAULT '[]',
    "bytesEvaluatedCount" INTEGER NOT NULL DEFAULT 0,
    "evaluatorsJson" TEXT NOT NULL,
    "dimensionCount" INTEGER NOT NULL,
    "unavailableDimensionCount" INTEGER NOT NULL DEFAULT 0,
    "issueCount" INTEGER NOT NULL DEFAULT 0,
    "hardIssueCount" INTEGER NOT NULL DEFAULT 0,
    "insufficientEvidenceCount" INTEGER NOT NULL DEFAULT 0,
    "creativeIntentDeclared" BOOLEAN NOT NULL,
    "creativeIntentJson" TEXT NOT NULL,
    "castAllowedDelta" DOUBLE PRECISION,
    "maxDeclaredCastAllowance" DOUBLE PRECISION NOT NULL,
    "cause" VARCHAR(40) NOT NULL,
    "action" VARCHAR(24) NOT NULL,
    "correctionIteration" INTEGER,
    "correctionMaxIterations" INTEGER,
    "correctionReason" VARCHAR(1024),
    "proposedDeltaCount" INTEGER NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL,
    "confidenceBand" VARCHAR(16) NOT NULL,
    "thresholdVersion" VARCHAR(64) NOT NULL,
    "thresholdsJson" TEXT NOT NULL,
    "evaluatedAt" TIMESTAMPTZ(3) NOT NULL,
    "reportHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "color_critic_reports_pkey" PRIMARY KEY ("id"),
    -- normalizedSubject (color-critic-report.ts): each subject kind names the
    -- thing it is about, and a range subject names its camera too.
    CONSTRAINT "color_critic_reports_subject_check"
        CHECK ("subjectKind" IN ('source', 'camera', 'range', 'output') AND
              (("subjectKind" = 'source' AND "subjectSourceAssetId" IS NOT NULL) OR
              ("subjectKind" = 'camera' AND "subjectCameraId" IS NOT NULL) OR
              ("subjectKind" = 'range' AND "subjectCameraId" IS NOT NULL AND "subjectRangeStartTicks" IS NOT NULL) OR
              ("subjectKind" = 'output' AND "subjectArtifactId" IS NOT NULL))),
    CONSTRAINT "color_critic_reports_subject_range_check"
        CHECK (("subjectRangeStartTicks" IS NULL) = ("subjectRangeEndTicks" IS NULL)
              AND ("subjectRangeStartTicks" IS NULL OR "subjectRangeStartTicks" < "subjectRangeEndTicks")
              AND ("matchPlanId" IS NULL) = ("matchPlanHash" IS NULL)),
    -- COLOR_CRITIC_STAGES has two entries and COLOR_CRITIC_DIMENSIONS twelve.
    -- Every dimension answers exactly once: silence about one of them is not a
    -- clean report, it is an unread one.
    CONSTRAINT "color_critic_reports_coverage_check"
        CHECK ("sectionCount" = 2 AND "dimensionCount" = 12
              AND "unavailableDimensionCount" BETWEEN 0 AND 12
              AND "issueCount" >= 0 AND "hardIssueCount" >= 0 AND "hardIssueCount" <= "issueCount"
              AND "insufficientEvidenceCount" >= 0 AND "insufficientEvidenceCount" <= "issueCount"
              AND "bytesEvaluatedCount" >= 0 AND "proposedDeltaCount" >= 0),
    -- ADR-147's cause table, transcribed from COLOR_CRITIC_CAUSE_ACTIONS: the
    -- action is looked up from the cause, never averaged out of the numbers.
    --
    -- The two sets come first because the CASE alone was not a constraint. A
    -- CASE with no ELSE returns NULL for a cause it does not list, `action =
    -- NULL` is unknown, and an unknown CHECK is a SATISFIED CHECK — so
    -- ('not-a-real-cause', 'banana') was accepted by the table that claims to
    -- encode the cause table. Closing both vocabularies makes the equality
    -- reachable for every row that gets that far.
    CONSTRAINT "color_critic_reports_cause_action_check"
        CHECK ("cause" IN ('irreversible-technical-defect', 'evidence-unavailable',
                          'correction-budget-exhausted', 'correction-confidence-insufficient',
                          'correction-out-of-bounds', 'correction-not-derivable',
                          'correctable-technical-defect', 'advisory-warning',
                          'documented-intent', 'no-defect')
              AND "action" IN ('approve', 'bounded-correction', 'human-review', 'reject')
              AND "action" = CASE "cause"
                WHEN 'irreversible-technical-defect' THEN 'reject'
                WHEN 'evidence-unavailable' THEN 'human-review'
                WHEN 'correction-budget-exhausted' THEN 'human-review'
                WHEN 'correction-confidence-insufficient' THEN 'human-review'
                WHEN 'correction-out-of-bounds' THEN 'human-review'
                WHEN 'correction-not-derivable' THEN 'human-review'
                WHEN 'correctable-technical-defect' THEN 'bounded-correction'
                WHEN 'advisory-warning' THEN 'approve'
                WHEN 'documented-intent' THEN 'approve'
                WHEN 'no-defect' THEN 'approve'
              END),
    -- An approval carries no blocking issue and no dimension nobody could
    -- read; a rejection localizes at least one; evidence-unavailable points at
    -- the dimension it could not evaluate.
    CONSTRAINT "color_critic_reports_verdict_check"
        CHECK (("action" <> 'approve' OR ("hardIssueCount" = 0 AND "unavailableDimensionCount" = 0))
              AND ("action" <> 'reject' OR "hardIssueCount" > 0)
              AND ("cause" <> 'evidence-unavailable' OR "insufficientEvidenceCount" > 0)),
    -- COLOR_CRITIC_MAX_CORRECTION_ITERATIONS is 2 and the correction floor is
    -- 0.85: a bounded correction exists exactly when the verdict is one,
    -- proposes at least one delta, and stays inside both limits.
    CONSTRAINT "color_critic_reports_correction_check"
        CHECK (("action" = 'bounded-correction' AND "correctionIteration" BETWEEN 1 AND 2
                AND "correctionMaxIterations" = 2 AND "proposedDeltaCount" >= 1
                AND "confidence" >= 0.85 AND "correctionReason" IS NOT NULL) OR
              ("action" <> 'bounded-correction' AND "correctionIteration" IS NULL
                AND "correctionMaxIterations" IS NULL AND "proposedDeltaCount" = 0
                AND "correctionReason" IS NULL)),
    CONSTRAINT "color_critic_reports_confidence_check"
        CHECK ("confidence" >= 0 AND "confidence" <= 1
              AND "confidenceBand" = CASE
                WHEN "confidence" >= 0.85 THEN 'high'
                WHEN "confidence" >= 0.65 THEN 'medium'
                WHEN "confidence" >= 0.4 THEN 'low'
                ELSE 'insufficient'
              END),
    -- intentBounds, both halves auditable: without the ceiling, declaring a
    -- large enough allowance would let the caller write the verdict.
    CONSTRAINT "color_critic_reports_intent_check"
        CHECK ("maxDeclaredCastAllowance" > 0
              AND ("castAllowedDelta" IS NULL OR
                   ("castAllowedDelta" >= 0 AND "castAllowedDelta" <= "maxDeclaredCastAllowance")))
);

CREATE INDEX "color_critic_reports_workspaceId_projectId_evaluatedAt_idx" ON "color_critic_reports"("workspaceId", "projectId", "evaluatedAt" DESC);
CREATE INDEX "color_critic_reports_workspaceId_projectVersionId_action_idx" ON "color_critic_reports"("workspaceId", "projectVersionId", "action");
CREATE INDEX "color_critic_reports_workspaceId_matchPlanId_idx" ON "color_critic_reports"("workspaceId", "matchPlanId");
CREATE UNIQUE INDEX "color_critic_reports_id_workspaceId_key" ON "color_critic_reports"("id", "workspaceId");
CREATE UNIQUE INDEX "color_critic_reports_workspaceId_reportHash_key" ON "color_critic_reports"("workspaceId", "reportHash");

CREATE TABLE "color_critic_dimension_results" (
    "id" VARCHAR(160) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "reportId" VARCHAR(128) NOT NULL,
    "dimension" VARCHAR(24) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "stage" VARCHAR(32) NOT NULL,
    "value" DOUBLE PRECISION,
    "unit" VARCHAR(24),
    "threshold" DOUBLE PRECISION,
    "classification" VARCHAR(24),
    "reason" VARCHAR(512),
    "evaluatorIdsJson" TEXT NOT NULL DEFAULT '[]',
    "evidenceRefsJson" TEXT NOT NULL DEFAULT '[]',
    "cameraIdsJson" TEXT NOT NULL DEFAULT '[]',

    CONSTRAINT "color_critic_dimension_results_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "color_critic_dimension_results_dimension_check"
        CHECK ("dimension" IN ('clipping', 'crushedBlacks', 'cast', 'whiteBalanceMismatch',
                              'exposureMismatch', 'saturationExcess', 'saturationDeficit',
                              'skinToneOffTarget', 'localizedMismatch', 'brandColorDrift',
                              'hdrSdrInconsistency', 'matchRegression')
              AND "status" IN ('measured', 'not-applicable', 'unavailable')
              AND "stage" IN ('before-output-transform', 'after-output-transform',
                             'across-output-transform')
              AND ("classification" IS NULL OR "classification" IN ('technical-defect',
                   'documented-intent', 'insufficient-evidence', 'localized', 'global'))),
    -- Not measured is NULL, never 0; and a dimension that was not read says
    -- why in words.
    CONSTRAINT "color_critic_dimension_results_resolution_check"
        CHECK (("status" = 'measured' AND "value" IS NOT NULL AND "unit" IS NOT NULL) OR
              ("status" <> 'measured' AND "value" IS NULL AND char_length(btrim("reason")) >= 1))
);

CREATE INDEX "color_critic_dimension_results_dimension_status_idx" ON "color_critic_dimension_results"("workspaceId", "dimension", "status");
CREATE UNIQUE INDEX "color_critic_dimension_results_id_workspaceId_key" ON "color_critic_dimension_results"("id", "workspaceId");
CREATE UNIQUE INDEX "color_critic_dimension_results_report_dimension_key" ON "color_critic_dimension_results"("workspaceId", "reportId", "dimension");

CREATE TABLE "color_critic_issues" (
    "id" VARCHAR(160) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "reportId" VARCHAR(128) NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "dimension" VARCHAR(24) NOT NULL,
    "severity" VARCHAR(16) NOT NULL,
    "classification" VARCHAR(24) NOT NULL,
    "cause" VARCHAR(40) NOT NULL,
    "stage" VARCHAR(32) NOT NULL,
    "cameraId" VARCHAR(128),
    "rangeStartTicks" BIGINT,
    "rangeEndTicks" BIGINT,
    "measured" DOUBLE PRECISION,
    "threshold" DOUBLE PRECISION,
    "thresholdVersion" VARCHAR(64) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidenceRefsJson" TEXT NOT NULL DEFAULT '[]',
    "evidenceArtifactId" VARCHAR(128),

    CONSTRAINT "color_critic_issues_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "color_critic_issues_vocabulary_check"
        CHECK ("severity" IN ('hard', 'warning')
              AND "classification" IN ('technical-defect', 'documented-intent',
                                      'insufficient-evidence', 'localized', 'global')
              AND "cause" IN ('irreversible-technical-defect', 'evidence-unavailable',
                             'correction-budget-exhausted', 'correction-confidence-insufficient',
                             'correction-out-of-bounds', 'correction-not-derivable',
                             'correctable-technical-defect', 'advisory-warning',
                             'documented-intent', 'no-defect')
              AND "dimension" IN ('clipping', 'crushedBlacks', 'cast', 'whiteBalanceMismatch',
                                 'exposureMismatch', 'saturationExcess', 'saturationDeficit',
                                 'skinToneOffTarget', 'localizedMismatch', 'brandColorDrift',
                                 'hdrSdrInconsistency', 'matchRegression')
              AND "stage" IN ('before-output-transform', 'after-output-transform',
                             'across-output-transform')),
    -- An issue may omit its numbers only when it reports missing evidence.
    CONSTRAINT "color_critic_issues_evidence_check"
        CHECK (("classification" = 'insufficient-evidence') = ("measured" IS NULL)
              AND ("classification" = 'insufficient-evidence') = ("threshold" IS NULL)),
    CONSTRAINT "color_critic_issues_range_check"
        CHECK (("rangeStartTicks" IS NULL) = ("rangeEndTicks" IS NULL)
              AND ("rangeStartTicks" IS NULL OR "rangeStartTicks" < "rangeEndTicks")
              AND "ordinal" >= 0 AND "confidence" >= 0 AND "confidence" <= 1)
);

CREATE INDEX "color_critic_issues_workspaceId_reportId_severity_idx" ON "color_critic_issues"("workspaceId", "reportId", "severity");
CREATE UNIQUE INDEX "color_critic_issues_id_workspaceId_key" ON "color_critic_issues"("id", "workspaceId");
CREATE UNIQUE INDEX "color_critic_issues_workspaceId_reportId_ordinal_key" ON "color_critic_issues"("workspaceId", "reportId", "ordinal");

CREATE TABLE "color_critic_proposed_deltas" (
    "id" VARCHAR(160) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "reportId" VARCHAR(128) NOT NULL,
    "cameraId" VARCHAR(128) NOT NULL,
    "exposureEv" DOUBLE PRECISION,
    "redGain" DOUBLE PRECISION,
    "greenGain" DOUBLE PRECISION,
    "blueGain" DOUBLE PRECISION,
    "saturation" DOUBLE PRECISION,
    "maxExposureEv" DOUBLE PRECISION NOT NULL,
    "maxGain" DOUBLE PRECISION NOT NULL,
    "minSaturation" DOUBLE PRECISION NOT NULL,
    "maxSaturation" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "color_critic_proposed_deltas_pkey" PRIMARY KEY ("id"),
    -- The bounds travel with the delta rather than living in a policy the row
    -- cannot see: a stored correction is checkable against the limits that
    -- actually produced it, whatever the policy is today.
    CONSTRAINT "color_critic_proposed_deltas_bounds_check"
        CHECK ("maxExposureEv" > 0 AND "maxGain" > 1
              AND "minSaturation" > 0 AND "minSaturation" < "maxSaturation"
              AND ("exposureEv" IS NULL OR abs("exposureEv") <= "maxExposureEv")
              AND ("redGain" IS NULL OR ("redGain" >= 1 / "maxGain" AND "redGain" <= "maxGain"))
              AND ("greenGain" IS NULL OR ("greenGain" >= 1 / "maxGain" AND "greenGain" <= "maxGain"))
              AND ("blueGain" IS NULL OR ("blueGain" >= 1 / "maxGain" AND "blueGain" <= "maxGain"))
              AND ("saturation" IS NULL OR
                   ("saturation" >= "minSaturation" AND "saturation" <= "maxSaturation"))),
    -- A delta that proposes nothing is not a proposal, and a white balance is
    -- three channels or none.
    CONSTRAINT "color_critic_proposed_deltas_content_check"
        CHECK (("exposureEv" IS NOT NULL OR "redGain" IS NOT NULL OR "saturation" IS NOT NULL)
              AND ("redGain" IS NULL) = ("greenGain" IS NULL)
              AND ("redGain" IS NULL) = ("blueGain" IS NULL))
);

CREATE UNIQUE INDEX "color_critic_proposed_deltas_id_workspaceId_key" ON "color_critic_proposed_deltas"("id", "workspaceId");
CREATE UNIQUE INDEX "color_critic_proposed_deltas_workspaceId_reportId_cameraId_key" ON "color_critic_proposed_deltas"("workspaceId", "reportId", "cameraId");

-- ---------------------------------------------------------------------------
-- F4.015 / FR-153 — react playback maps
-- ---------------------------------------------------------------------------

CREATE TABLE "playback_maps" (
    "id" VARCHAR(160) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "sessionId" VARCHAR(128) NOT NULL,
    "schemaVersion" VARCHAR(64) NOT NULL,
    "mapId" VARCHAR(128) NOT NULL,
    "version" INTEGER NOT NULL,
    "previousVersionHash" CHAR(64),
    "supersedesMapId" VARCHAR(128),
    "sessionVersion" INTEGER NOT NULL,
    "referenceEpoch" INTEGER NOT NULL,
    "reactionTrackId" VARCHAR(128) NOT NULL,
    "referenceTrackId" VARCHAR(128) NOT NULL,
    "referenceAssetId" VARCHAR(128) NOT NULL,
    "referenceSha256" CHAR(64) NOT NULL,
    "referenceDurationTicks" BIGINT NOT NULL,
    "referenceTimebaseNum" BIGINT NOT NULL,
    "referenceTimebaseDen" BIGINT NOT NULL,
    "reactionAssetId" VARCHAR(128) NOT NULL,
    "reactionSha256" CHAR(64) NOT NULL,
    "reactionDurationTicks" BIGINT NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "warningsJson" TEXT NOT NULL DEFAULT '[]',
    "pieceCount" INTEGER NOT NULL,
    "referencedPieceCount" INTEGER NOT NULL DEFAULT 0,
    "uncoveredCount" INTEGER NOT NULL DEFAULT 0,
    "anchorCount" INTEGER NOT NULL DEFAULT 0,
    "manualAnchorCount" INTEGER NOT NULL DEFAULT 0,
    "mapHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "playback_maps_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "playback_maps_chain_check"
        CHECK (("version" = 1 AND "previousVersionHash" IS NULL) OR
              ("version" > 1 AND "previousVersionHash" IS NOT NULL)),
    CONSTRAINT "playback_maps_counters_check"
        CHECK ("version" >= 1 AND "sessionVersion" >= 1 AND "referenceEpoch" >= 1
              AND "pieceCount" >= 1 AND "referencedPieceCount" >= 0
              AND "referencedPieceCount" <= "pieceCount"
              AND "uncoveredCount" >= 0 AND "anchorCount" >= 0
              AND "manualAnchorCount" >= 0 AND "manualAnchorCount" <= "anchorCount"),
    -- Both durations are measured, never derived from each other.
    CONSTRAINT "playback_maps_media_check"
        CHECK ("referenceDurationTicks" > 0 AND "reactionDurationTicks" > 0
              AND "referenceTimebaseNum" > 0 AND "referenceTimebaseDen" > 0),
    -- The status is derived (playback-map.ts:829-833): no piece naming a
    -- reference at all is a failure, an uncovered stretch needs a person, and
    -- only a complete tiling is resolved.
    CONSTRAINT "playback_maps_status_check"
        CHECK ("status" = CASE
                WHEN "referencedPieceCount" = 0 THEN 'failed'
                WHEN "uncoveredCount" > 0 THEN 'needs-input'
                ELSE 'resolved'
              END)
);

CREATE INDEX "playback_maps_workspaceId_sessionId_status_idx" ON "playback_maps"("workspaceId", "sessionId", "status");
CREATE INDEX "playback_maps_workspaceId_referenceAssetId_referenceSha256_idx" ON "playback_maps"("workspaceId", "referenceAssetId", "referenceSha256");
CREATE UNIQUE INDEX "playback_maps_id_workspaceId_key" ON "playback_maps"("id", "workspaceId");
CREATE UNIQUE INDEX "playback_maps_session_reaction_version_key" ON "playback_maps"("workspaceId", "sessionId", "reactionTrackId", "version");
CREATE UNIQUE INDEX "playback_maps_workspaceId_mapHash_key" ON "playback_maps"("workspaceId", "mapHash");

CREATE TABLE "playback_map_heads" (
    "id" VARCHAR(160) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "sessionId" VARCHAR(128) NOT NULL,
    "reactionTrackId" VARCHAR(128) NOT NULL,
    "mapId" VARCHAR(128) NOT NULL,
    "version" INTEGER NOT NULL,
    "mapHash" CHAR(64) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "playback_map_heads_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "playback_map_heads_version_check"
        CHECK ("version" >= 1 AND "status" IN ('resolved', 'needs-input', 'failed'))
);

CREATE INDEX "playback_map_heads_workspaceId_status_idx" ON "playback_map_heads"("workspaceId", "status");
CREATE UNIQUE INDEX "playback_map_heads_id_workspaceId_key" ON "playback_map_heads"("id", "workspaceId");
CREATE UNIQUE INDEX "playback_map_heads_workspaceId_sessionId_reactionTrackId_key" ON "playback_map_heads"("workspaceId", "sessionId", "reactionTrackId");

CREATE TABLE "playback_pieces" (
    "id" VARCHAR(160) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "mapId" VARCHAR(160) NOT NULL,
    "pieceId" VARCHAR(128) NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "mode" VARCHAR(24) NOT NULL,
    "reactionStartTicks" BIGINT NOT NULL,
    "reactionEndTicks" BIGINT NOT NULL,
    "referenceStartTicks" BIGINT,
    "referenceEndTicks" BIGINT,
    "rateNum" BIGINT,
    "rateDen" BIGINT,
    "direction" VARCHAR(16) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidenceRefsJson" TEXT NOT NULL DEFAULT '[]',
    "evidenceRefCount" INTEGER NOT NULL,
    "detectionMethod" VARCHAR(24) NOT NULL,
    "residualTicks" BIGINT,
    "discontinuityReason" VARCHAR(32),
    "pieceHash" CHAR(64) NOT NULL,

    CONSTRAINT "playback_pieces_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "playback_pieces_vocabulary_check"
        CHECK ("mode" IN ('playing', 'paused', 'rewind', 'replay', 'seek', 'commentary-only')
              AND "direction" IN ('forward', 'backward', 'none')
              AND "detectionMethod" IN ('audio-fingerprint', 'player-visual', 'ocr-timestamp',
                                       'manual-anchor')
              AND ("discontinuityReason" IS NULL OR "discontinuityReason" IN
                   ('recorder-restart', 'pts-regression', 'seek', 'rewind', 'file-split',
                    'coverage-gap', 'residual-exceeded', 'manual-anchor-conflict',
                    'pause', 'commentary', 'manual-anchor'))),
    -- NO_REFERENCE_PLAYBACK_MODES, mandatory rather than conventional: a paused
    -- or commentary-only piece that claimed reference time would assert the
    -- reference advanced while it was stopped (ADR-135).
    CONSTRAINT "playback_pieces_reference_check"
        CHECK ("reactionStartTicks" < "reactionEndTicks" AND "ordinal" >= 0 AND
              (("mode" IN ('paused', 'commentary-only') AND "referenceStartTicks" IS NULL
                AND "referenceEndTicks" IS NULL AND "rateNum" IS NULL AND "rateDen" IS NULL
                AND "direction" = 'none') OR
               ("mode" NOT IN ('paused', 'commentary-only') AND "referenceStartTicks" IS NOT NULL
                AND "referenceEndTicks" IS NOT NULL
                AND "referenceStartTicks" < "referenceEndTicks" AND "direction" <> 'none'))),
    -- A rate is a measured slope: never 1/1 by assumption, both halves strictly
    -- positive, and only from a method that measures one
    -- (playback-map.ts:667-694).
    CONSTRAINT "playback_pieces_rate_check"
        CHECK (("rateNum" IS NULL) = ("rateDen" IS NULL)
              AND ("rateNum" IS NULL OR ("rateNum" > 0 AND "rateDen" > 0
                   AND "referenceStartTicks" IS NOT NULL
                   AND "detectionMethod" IN ('audio-fingerprint', 'ocr-timestamp')))),
    -- Going backwards is what makes a rewind a rewind, and a seek records that
    -- it was reached by seeking.
    CONSTRAINT "playback_pieces_movement_check"
        CHECK (("mode" NOT IN ('rewind', 'replay') OR "direction" = 'backward')
              AND ("mode" <> 'seek' OR "discontinuityReason" = 'seek')),
    -- The first piece cannot have been reached by a movement from a piece that
    -- does not exist; every later one must say why it begins where it does.
    CONSTRAINT "playback_pieces_boundary_check"
        CHECK (("ordinal" = 0 AND ("discontinuityReason" IS NULL OR
                "discontinuityReason" NOT IN ('seek', 'rewind', 'pts-regression'))) OR
              ("ordinal" > 0 AND "discontinuityReason" IS NOT NULL)),
    CONSTRAINT "playback_pieces_confidence_check"
        CHECK ("confidence" >= 0 AND "confidence" <= 1 AND "evidenceRefCount" >= 1
              AND ("residualTicks" IS NULL OR "residualTicks" >= 0))
);

CREATE INDEX "playback_pieces_workspaceId_mapId_mode_idx" ON "playback_pieces"("workspaceId", "mapId", "mode");
CREATE UNIQUE INDEX "playback_pieces_id_workspaceId_key" ON "playback_pieces"("id", "workspaceId");
CREATE UNIQUE INDEX "playback_pieces_workspaceId_mapId_ordinal_key" ON "playback_pieces"("workspaceId", "mapId", "ordinal");
CREATE UNIQUE INDEX "playback_pieces_workspaceId_mapId_pieceId_key" ON "playback_pieces"("workspaceId", "mapId", "pieceId");

-- The reactor lived each instant once. Two pieces covering the same reaction
-- tick would make "where was the reference" depend on which piece was read.
ALTER TABLE "playback_pieces"
    ADD CONSTRAINT "playback_pieces_no_overlap_excl"
    EXCLUDE USING gist (
        "workspaceId" WITH =,
        "mapId" WITH =,
        int8range("reactionStartTicks", "reactionEndTicks") WITH &&
    );

CREATE TABLE "playback_anchors" (
    "id" VARCHAR(160) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "mapId" VARCHAR(160) NOT NULL,
    "anchorId" VARCHAR(128) NOT NULL,
    "origin" VARCHAR(16) NOT NULL,
    "reactionTick" BIGINT NOT NULL,
    "referenceTick" BIGINT,
    "mode" VARCHAR(24),
    "method" VARCHAR(24) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    -- Wide enough to hold what the constraint below DERIVES from the other
    -- three columns: 'operator:' + actorId(128) + ' (' + note + ')'. At 512
    -- this refused any note past about 490 characters with a raw 22001 —
    -- "value too long for type character varying" — which is not a refusal an
    -- application can classify, and it took the whole map version with it. The
    -- domain bounds the note at PLAYBACK_ANCHOR_NOTE_MAX (playback-map.ts), and
    -- 1200 is that bound plus the longest actor and the decoration around it.
    "evidenceRef" VARCHAR(1200) NOT NULL,
    "actorKind" VARCHAR(16),
    "actorId" VARCHAR(128),
    "note" VARCHAR(1024),
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "playback_anchors_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "playback_anchors_vocabulary_check"
        CHECK ("origin" IN ('automatic', 'manual')
              AND "method" IN ('audio-fingerprint', 'player-visual', 'ocr-timestamp', 'manual-anchor')
              AND ("mode" IS NULL OR "mode" IN ('playing', 'paused', 'rewind', 'replay',
                                               'seek', 'commentary-only'))
              AND "confidence" >= 0 AND "confidence" <= 1 AND "reactionTick" >= 0
              AND ("referenceTick" IS NULL OR "referenceTick" >= 0)),
    -- An anchor that names a reference instant cannot describe a stretch where
    -- the reference produced no time (playback-map.ts:1446-1450).
    CONSTRAINT "playback_anchors_reference_check"
        CHECK ("mode" IS NULL OR
              (("referenceTick" IS NULL) = ("mode" IN ('paused', 'commentary-only')))),
    -- CONTRACT §2: the audit trail is never displaced by the caller. The
    -- evidence of a manual anchor is the actor PLUS the note, in the exact
    -- shape anchorEvidenceRef writes (playback-map.ts:1396-1397) — never the
    -- note instead of the actor.
    CONSTRAINT "playback_anchors_actor_check"
        CHECK (("origin" = 'manual' AND "method" = 'manual-anchor'
                AND "actorId" IS NOT NULL AND "actorKind" IS NOT NULL
                AND ("note" IS NULL OR char_length(btrim("note")) >= 1)
                AND "evidenceRef" = 'operator:' || "actorId" ||
                    CASE WHEN "note" IS NULL THEN '' ELSE ' (' || btrim("note") || ')' END) OR
              ("origin" = 'automatic' AND "actorId" IS NULL AND "actorKind" IS NULL
                AND "note" IS NULL AND char_length(btrim("evidenceRef")) >= 1))
);

CREATE INDEX "playback_anchors_workspaceId_mapId_origin_idx" ON "playback_anchors"("workspaceId", "mapId", "origin");
CREATE UNIQUE INDEX "playback_anchors_id_workspaceId_key" ON "playback_anchors"("id", "workspaceId");
CREATE UNIQUE INDEX "playback_anchors_workspaceId_mapId_anchorId_key" ON "playback_anchors"("workspaceId", "mapId", "anchorId");

CREATE TABLE "playback_uncovered_ranges" (
    "id" VARCHAR(160) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "mapId" VARCHAR(160) NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "reactionStartTicks" BIGINT NOT NULL,
    "reactionEndTicks" BIGINT NOT NULL,
    "reason" VARCHAR(32) NOT NULL,

    CONSTRAINT "playback_uncovered_ranges_pkey" PRIMARY KEY ("id"),
    -- PLAYBACK_UNCOVERED_REASONS: nobody knows is an answer, and it says which
    -- kind of not-knowing it is.
    CONSTRAINT "playback_uncovered_ranges_reason_check"
        CHECK ("reason" IN ('manual-anchor-required', 'conflicting-evidence')
              AND "reactionStartTicks" < "reactionEndTicks" AND "ordinal" >= 0)
);

CREATE INDEX "playback_uncovered_ranges_workspaceId_mapId_reason_idx" ON "playback_uncovered_ranges"("workspaceId", "mapId", "reason");
CREATE UNIQUE INDEX "playback_uncovered_ranges_id_workspaceId_key" ON "playback_uncovered_ranges"("id", "workspaceId");
CREATE UNIQUE INDEX "playback_uncovered_ranges_workspaceId_mapId_ordinal_key" ON "playback_uncovered_ranges"("workspaceId", "mapId", "ordinal");

-- Two uncovered stretches of one map cannot overlap either: the tiling is
-- pieces plus uncovered, and an overlap there is a hole by another name.
ALTER TABLE "playback_uncovered_ranges"
    ADD CONSTRAINT "playback_uncovered_ranges_no_overlap_excl"
    EXCLUDE USING gist (
        "workspaceId" WITH =,
        "mapId" WITH =,
        int8range("reactionStartTicks", "reactionEndTicks") WITH &&
    );

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

ALTER TABLE "multicam_evidence_sets" ADD CONSTRAINT "multicam_evidence_sets_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "multicam_evidence_sets" ADD CONSTRAINT "multicam_evidence_sets_sessionId_workspaceId_fkey" FOREIGN KEY ("sessionId", "workspaceId") REFERENCES "capture_session_heads"("sessionId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "multicam_observations" ADD CONSTRAINT "multicam_observations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "multicam_observations" ADD CONSTRAINT "multicam_observations_evidenceSetId_workspaceId_fkey" FOREIGN KEY ("evidenceSetId", "workspaceId") REFERENCES "multicam_evidence_sets"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "multicam_directions" ADD CONSTRAINT "multicam_directions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "multicam_directions" ADD CONSTRAINT "multicam_directions_sessionId_workspaceId_fkey" FOREIGN KEY ("sessionId", "workspaceId") REFERENCES "capture_session_heads"("sessionId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "multicam_direction_heads" ADD CONSTRAINT "multicam_direction_heads_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "multicam_direction_heads" ADD CONSTRAINT "multicam_direction_heads_sessionId_workspaceId_fkey" FOREIGN KEY ("sessionId", "workspaceId") REFERENCES "capture_session_heads"("sessionId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "multicam_shot_decisions" ADD CONSTRAINT "multicam_shot_decisions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "multicam_shot_decisions" ADD CONSTRAINT "multicam_shot_decisions_directionId_workspaceId_fkey" FOREIGN KEY ("directionId", "workspaceId") REFERENCES "multicam_directions"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "multicam_shot_alternatives" ADD CONSTRAINT "multicam_shot_alternatives_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "multicam_shot_alternatives" ADD CONSTRAINT "multicam_shot_alternatives_shotId_workspaceId_fkey" FOREIGN KEY ("shotId", "workspaceId") REFERENCES "multicam_shot_decisions"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "multicam_angle_candidates" ADD CONSTRAINT "multicam_angle_candidates_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "multicam_angle_candidates" ADD CONSTRAINT "multicam_angle_candidates_shotId_workspaceId_fkey" FOREIGN KEY ("shotId", "workspaceId") REFERENCES "multicam_shot_decisions"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "multicam_angle_score_components" ADD CONSTRAINT "multicam_angle_score_components_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "multicam_angle_score_components" ADD CONSTRAINT "multicam_angle_score_components_candidateId_workspaceId_fkey" FOREIGN KEY ("candidateId", "workspaceId") REFERENCES "multicam_angle_candidates"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "camera_color_measurements" ADD CONSTRAINT "camera_color_measurements_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "camera_color_measurements" ADD CONSTRAINT "camera_color_measurements_sessionId_workspaceId_fkey" FOREIGN KEY ("sessionId", "workspaceId") REFERENCES "capture_session_heads"("sessionId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "color_measurement_dimensions" ADD CONSTRAINT "color_measurement_dimensions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "color_measurement_dimensions" ADD CONSTRAINT "color_measurement_dimensions_measurementId_workspaceId_fkey" FOREIGN KEY ("measurementId", "workspaceId") REFERENCES "camera_color_measurements"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "color_measurement_components" ADD CONSTRAINT "color_measurement_components_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "color_measurement_components" ADD CONSTRAINT "color_measurement_components_dimensionId_workspaceId_fkey" FOREIGN KEY ("dimensionId", "workspaceId") REFERENCES "color_measurement_dimensions"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "multicam_match_plans" ADD CONSTRAINT "multicam_match_plans_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "multicam_match_plans" ADD CONSTRAINT "multicam_match_plans_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "multicam_match_plans" ADD CONSTRAINT "multicam_match_plans_sessionId_workspaceId_fkey" FOREIGN KEY ("sessionId", "workspaceId") REFERENCES "capture_session_heads"("sessionId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "multicam_match_plan_heads" ADD CONSTRAINT "multicam_match_plan_heads_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "multicam_match_plan_heads" ADD CONSTRAINT "multicam_match_plan_heads_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "multicam_match_plan_heads" ADD CONSTRAINT "multicam_match_plan_heads_sessionId_workspaceId_fkey" FOREIGN KEY ("sessionId", "workspaceId") REFERENCES "capture_session_heads"("sessionId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "match_plan_measurements" ADD CONSTRAINT "match_plan_measurements_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "match_plan_measurements" ADD CONSTRAINT "match_plan_measurements_planId_workspaceId_fkey" FOREIGN KEY ("planId", "workspaceId") REFERENCES "multicam_match_plans"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "match_plan_measurements" ADD CONSTRAINT "match_plan_measurements_measurementId_workspaceId_fkey" FOREIGN KEY ("measurementId", "workspaceId") REFERENCES "camera_color_measurements"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "camera_match_transforms" ADD CONSTRAINT "camera_match_transforms_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "camera_match_transforms" ADD CONSTRAINT "camera_match_transforms_planId_workspaceId_fkey" FOREIGN KEY ("planId", "workspaceId") REFERENCES "multicam_match_plans"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "match_range_overrides" ADD CONSTRAINT "match_range_overrides_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "match_range_overrides" ADD CONSTRAINT "match_range_overrides_planId_workspaceId_fkey" FOREIGN KEY ("planId", "workspaceId") REFERENCES "multicam_match_plans"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "match_non_comparable_ranges" ADD CONSTRAINT "match_non_comparable_ranges_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "match_non_comparable_ranges" ADD CONSTRAINT "match_non_comparable_ranges_planId_workspaceId_fkey" FOREIGN KEY ("planId", "workspaceId") REFERENCES "multicam_match_plans"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "match_plan_issues" ADD CONSTRAINT "match_plan_issues_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "match_plan_issues" ADD CONSTRAINT "match_plan_issues_planId_workspaceId_fkey" FOREIGN KEY ("planId", "workspaceId") REFERENCES "multicam_match_plans"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "color_critic_reports" ADD CONSTRAINT "color_critic_reports_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "color_critic_reports" ADD CONSTRAINT "color_critic_reports_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "color_critic_reports" ADD CONSTRAINT "color_critic_reports_projectVersionId_projectId_workspaceI_fkey" FOREIGN KEY ("projectVersionId", "projectId", "workspaceId") REFERENCES "project_versions"("id", "projectId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "color_critic_dimension_results" ADD CONSTRAINT "color_critic_dimension_results_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "color_critic_dimension_results" ADD CONSTRAINT "color_critic_dimension_results_reportId_workspaceId_fkey" FOREIGN KEY ("reportId", "workspaceId") REFERENCES "color_critic_reports"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "color_critic_issues" ADD CONSTRAINT "color_critic_issues_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "color_critic_issues" ADD CONSTRAINT "color_critic_issues_reportId_workspaceId_fkey" FOREIGN KEY ("reportId", "workspaceId") REFERENCES "color_critic_reports"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "color_critic_proposed_deltas" ADD CONSTRAINT "color_critic_proposed_deltas_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "color_critic_proposed_deltas" ADD CONSTRAINT "color_critic_proposed_deltas_reportId_workspaceId_fkey" FOREIGN KEY ("reportId", "workspaceId") REFERENCES "color_critic_reports"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "playback_maps" ADD CONSTRAINT "playback_maps_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "playback_maps" ADD CONSTRAINT "playback_maps_sessionId_workspaceId_fkey" FOREIGN KEY ("sessionId", "workspaceId") REFERENCES "capture_session_heads"("sessionId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "playback_map_heads" ADD CONSTRAINT "playback_map_heads_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "playback_map_heads" ADD CONSTRAINT "playback_map_heads_sessionId_workspaceId_fkey" FOREIGN KEY ("sessionId", "workspaceId") REFERENCES "capture_session_heads"("sessionId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "playback_pieces" ADD CONSTRAINT "playback_pieces_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "playback_pieces" ADD CONSTRAINT "playback_pieces_mapId_workspaceId_fkey" FOREIGN KEY ("mapId", "workspaceId") REFERENCES "playback_maps"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "playback_anchors" ADD CONSTRAINT "playback_anchors_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "playback_anchors" ADD CONSTRAINT "playback_anchors_mapId_workspaceId_fkey" FOREIGN KEY ("mapId", "workspaceId") REFERENCES "playback_maps"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "playback_uncovered_ranges" ADD CONSTRAINT "playback_uncovered_ranges_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "playback_uncovered_ranges" ADD CONSTRAINT "playback_uncovered_ranges_mapId_workspaceId_fkey" FOREIGN KEY ("mapId", "workspaceId") REFERENCES "playback_maps"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
