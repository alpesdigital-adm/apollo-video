-- F4.012 / FR-150 and F4.013 / FR-151 — the columns without which a stored
-- aggregate cannot be handed back as the one that was stored.
--
-- 20260905090000 gave every child of these three tables the column a CHECK
-- needed to see, and stopped there. What it left out is the part of each child
-- that no constraint reasons about but the hash still covers:
--
--   * An angle candidate hashes its four evidence readings — active speaker,
--     screen activity, reaction, technical quality — each with its score and
--     the observation refs behind it (multicam-direction.ts:1032). Nothing was
--     stored for them, so a rehydrated candidate hashed differently from the
--     one that was written and assertMulticamDirectionIntegrity refused the
--     whole direction. A repository that can write but not read back is not
--     persistence.
--   * A match transform is a ColorTransform: an id, a kind, the input and
--     output ColorMetadata and an optional LUT ref, on top of the parameters.
--     Only the parameters had columns, and a colour transform whose declared
--     input metadata is lost is one nobody can re-apply to the same footage.
--
-- The remainder is stored as canonical JSON because no constraint reads it —
-- the migration's own rule. The two equalities below keep the JSON and the
-- projected columns one fact rather than two: a repair script that edits the
-- parameters column without editing the transform is refused here.

ALTER TABLE "multicam_angle_candidates"
    ADD COLUMN "evidenceJson" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "multicam_angle_candidates" ALTER COLUMN "evidenceJson" DROP DEFAULT;
ALTER TABLE "multicam_angle_candidates"
    ADD CONSTRAINT "multicam_angle_candidates_evidence_check"
    CHECK (jsonb_typeof("evidenceJson"::jsonb) = 'object');

ALTER TABLE "camera_match_transforms"
    ADD COLUMN "transformJson" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "camera_match_transforms" ALTER COLUMN "transformJson" DROP DEFAULT;
ALTER TABLE "camera_match_transforms"
    ADD CONSTRAINT "camera_match_transforms_transform_check"
    CHECK (jsonb_typeof("transformJson"::jsonb) = 'object'
          AND "transformJson"::jsonb -> 'implementation' ->> 'provider' = "provider"
          AND "transformJson"::jsonb -> 'implementation' ->> 'version' = "providerVersion"
          AND "transformJson"::jsonb -> 'implementation' -> 'parameters' = "parametersJson"::jsonb
          AND ("transformJson"::jsonb ->> 'enabled')::boolean = "enabled");

ALTER TABLE "match_range_overrides"
    ADD COLUMN "transformJson" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "match_range_overrides" ALTER COLUMN "transformJson" DROP DEFAULT;
ALTER TABLE "match_range_overrides"
    ADD CONSTRAINT "match_range_overrides_transform_check"
    CHECK (jsonb_typeof("transformJson"::jsonb) = 'object'
          AND "transformJson"::jsonb -> 'implementation' ->> 'provider' = "provider"
          AND "transformJson"::jsonb -> 'implementation' ->> 'version' = "providerVersion"
          AND "transformJson"::jsonb -> 'implementation' -> 'parameters' = "parametersJson"::jsonb);
