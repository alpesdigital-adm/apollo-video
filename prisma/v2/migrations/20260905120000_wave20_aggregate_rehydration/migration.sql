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
--
-- Every one of them is wrapped in COALESCE(..., FALSE), because a CHECK is
-- violated only by FALSE and satisfied by unknown. `-> 'implementation' ->>
-- 'provider'` on a document that has no implementation is NULL, so the bare
-- equality accepted a transform that named the wrong provider only when it
-- named one at all — a document missing the key entirely walked straight
-- through, which is the exact edit these constraints exist to refuse.
-- `enabled` is type-checked before it is cast for the same reason, and so a
-- non-boolean is a refusal rather than an invalid-input-syntax error.

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
          AND COALESCE("transformJson"::jsonb -> 'implementation' ->> 'provider' = "provider", FALSE)
          AND COALESCE("transformJson"::jsonb -> 'implementation' ->> 'version' = "providerVersion", FALSE)
          AND COALESCE("transformJson"::jsonb -> 'implementation' -> 'parameters' = "parametersJson"::jsonb, FALSE)
          AND COALESCE(jsonb_typeof("transformJson"::jsonb -> 'enabled') = 'boolean', FALSE)
          AND COALESCE(("transformJson"::jsonb ->> 'enabled')::boolean = "enabled", FALSE));

ALTER TABLE "match_range_overrides"
    ADD COLUMN "transformJson" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "match_range_overrides" ALTER COLUMN "transformJson" DROP DEFAULT;
ALTER TABLE "match_range_overrides"
    ADD CONSTRAINT "match_range_overrides_transform_check"
    CHECK (jsonb_typeof("transformJson"::jsonb) = 'object'
          AND COALESCE("transformJson"::jsonb -> 'implementation' ->> 'provider' = "provider", FALSE)
          AND COALESCE("transformJson"::jsonb -> 'implementation' ->> 'version' = "providerVersion", FALSE)
          AND COALESCE("transformJson"::jsonb -> 'implementation' -> 'parameters' = "parametersJson"::jsonb, FALSE));

-- The other half of the same problem: five child collections are ordered by
-- the aggregate that owns them, and their tables had no way to say so.
--
-- An evidence set sorts its observations with its own comparator before
-- hashing them; a match plan keeps the measurements and the overrides in the
-- order it was given; a bounded correction keeps its deltas in the order the
-- critic proposed them. Read back in index order — or in id order, which is
-- the same accident by another name — the array comes back permuted and the
-- aggregate hash no longer matches, so the read is refused and the row might as
-- well not have been written. Sorting on read by some column that happens to
-- work for today's fixtures would be that same accident a third time.

ALTER TABLE "multicam_observations" ADD COLUMN "ordinal" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "multicam_observations" ALTER COLUMN "ordinal" DROP DEFAULT;
ALTER TABLE "multicam_observations"
    ADD CONSTRAINT "multicam_observations_ordinal_check" CHECK ("ordinal" >= 0);
CREATE UNIQUE INDEX "multicam_observations_set_ordinal_key" ON "multicam_observations"("workspaceId", "evidenceSetId", "ordinal");

ALTER TABLE "match_plan_measurements" ADD COLUMN "ordinal" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "match_plan_measurements" ALTER COLUMN "ordinal" DROP DEFAULT;
ALTER TABLE "match_plan_measurements"
    ADD CONSTRAINT "match_plan_measurements_ordinal_check" CHECK ("ordinal" >= 0);
CREATE UNIQUE INDEX "match_plan_measurements_plan_ordinal_key" ON "match_plan_measurements"("workspaceId", "planId", "ordinal");

ALTER TABLE "match_range_overrides" ADD COLUMN "ordinal" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "match_range_overrides" ALTER COLUMN "ordinal" DROP DEFAULT;
ALTER TABLE "match_range_overrides"
    ADD CONSTRAINT "match_range_overrides_ordinal_check" CHECK ("ordinal" >= 0);
CREATE UNIQUE INDEX "match_range_overrides_plan_ordinal_key" ON "match_range_overrides"("workspaceId", "planId", "ordinal");

ALTER TABLE "color_critic_proposed_deltas" ADD COLUMN "ordinal" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "color_critic_proposed_deltas" ALTER COLUMN "ordinal" DROP DEFAULT;
ALTER TABLE "color_critic_proposed_deltas"
    ADD CONSTRAINT "color_critic_proposed_deltas_ordinal_check" CHECK ("ordinal" >= 0);
CREATE UNIQUE INDEX "color_critic_proposed_deltas_report_ordinal_key" ON "color_critic_proposed_deltas"("workspaceId", "reportId", "ordinal");

-- The fifth, missed the first time round because every fixture had at most one
-- anchor, where any order is sorted order.
--
-- A playback map hashes its anchors as an array (playback-map.ts:472-482) and
-- `applyPlaybackAnchor` appends the new one (playback-map.ts:1554) — it never
-- sorts. An operator who answers the later uncovered stretch first therefore
-- holds a map whose anchors are [late, early]. Read back unordered and
-- re-sorted by (reactionTick, anchorId), that map comes back as [early, late],
-- hashes differently, and `assertPlaybackMapIntegrity` refuses it: the write
-- succeeded and the row can never be read again. The anchors carry their
-- position for exactly the same reason the other four do.
ALTER TABLE "playback_anchors" ADD COLUMN "ordinal" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "playback_anchors" ALTER COLUMN "ordinal" DROP DEFAULT;
ALTER TABLE "playback_anchors"
    ADD CONSTRAINT "playback_anchors_ordinal_check" CHECK ("ordinal" >= 0);
CREATE UNIQUE INDEX "playback_anchors_map_ordinal_key" ON "playback_anchors"("workspaceId", "mapId", "ordinal");
