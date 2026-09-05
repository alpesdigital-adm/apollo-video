-- F4.012 / FR-150, ADR-118 — every EVALUATED angle of a decided shot, not only
-- the one that won.
--
-- The Wave 20 phase-2 migration
-- (20260905090000_multicam_direction_color_playback) shipped
-- `multicam_angle_candidates` as "the angle a shot CHOSE, one row per shot, and
-- nothing else", and said so in its own words: it had carried `eligible` /
-- `rejectionReasonsJson` / `rejectionCount`, and dropped them because
-- `ShotDecision` did not retain the evaluated window, so every row the schema
-- could hold had `eligible = true` and `rejectionCount = 0`. That reasoning was
-- right about the columns and right about the cause: the fix belonged in the
-- aggregate. It is made here. `ShotDecision.evaluated`
-- (multicam-direction.ts) now keeps every candidate derived over the shot's own
-- range — the losers with their `rejectionReasons`, inside the candidate hash
-- and inside the shot hash — so the three columns come back with rows that can
-- actually violate their CHECK, and a reviewer can ask "why could I not cut to
-- camera B there?" of the database instead of of the log.
--
-- `ordinal` is the position in that retained list. The order is track-id
-- ascending, it is covered by the shot hash, and hydration that permuted it
-- would fail `assertMulticamDirectionIntegrity` — so it is stored rather than
-- re-derived from a sort the reader would have to guess.
--
-- Backfill: the table can only hold chosen candidates so far, one per shot, all
-- of them eligible with an empty rejection list. The column defaults say exactly
-- that, and `ordinal` is numbered per shot rather than left at zero so the new
-- unique index is satisfied even if a row somewhere was written twice.

ALTER TABLE "multicam_angle_candidates"
    ADD COLUMN "ordinal" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "eligible" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "rejectionReasonsJson" TEXT NOT NULL DEFAULT '[]',
    ADD COLUMN "rejectionCount" INTEGER NOT NULL DEFAULT 0;

UPDATE "multicam_angle_candidates" AS "candidate"
SET "ordinal" = "numbered"."position"
FROM (
    SELECT
        "id",
        (row_number() OVER (PARTITION BY "workspaceId", "shotId" ORDER BY "candidateId") - 1)::int AS "position"
    FROM "multicam_angle_candidates"
) AS "numbered"
WHERE "numbered"."id" = "candidate"."id";

-- The two columns that are one fact must be written together, and the writer
-- must state both rather than inherit them: a row that says nothing about its
-- eligibility is a row nobody measured.
ALTER TABLE "multicam_angle_candidates"
    ALTER COLUMN "ordinal" DROP DEFAULT,
    ALTER COLUMN "eligible" DROP DEFAULT;

-- Eligibility IS the emptiness of the rejection list (multicam-direction.ts
-- deriveCandidate: `eligible: rejections.size === 0`), and the count IS the
-- length of the stored list. Both equalities are written down so a repair
-- script cannot clear the reasons and leave the flag, or mark an angle rejected
-- without saying why. Unlike the version this migration replaces, rows on both
-- sides of the CHECK are now writable: a rejected candidate is stored on every
-- shot that had one.
ALTER TABLE "multicam_angle_candidates"
    ADD CONSTRAINT "multicam_angle_candidates_eligibility_check"
    CHECK (
        "ordinal" >= 0
        AND "rejectionCount" >= 0
        AND "eligible" = ("rejectionCount" = 0)
        AND "rejectionCount" = json_array_length("rejectionReasonsJson"::json)
    );

-- Two candidates of one shot cannot claim the same position in the list the
-- shot hash covers.
CREATE UNIQUE INDEX "multicam_angle_candidates_workspaceId_shotId_ordinal_key" ON "multicam_angle_candidates"("workspaceId", "shotId", "ordinal");

-- "Which angles of this direction were rejected?" is the review question this
-- table now exists to answer; it should not read every candidate to find out.
CREATE INDEX "multicam_angle_candidates_workspaceId_directionId_eligible_idx" ON "multicam_angle_candidates"("workspaceId", "directionId", "eligible");
