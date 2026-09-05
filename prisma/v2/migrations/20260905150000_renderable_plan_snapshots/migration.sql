-- F4.015 / F4.016 — the compiled plan a derivation produced.
--
-- Two aggregates in this wave decide a cut that nothing could render: the react
-- playback map and the multi-range editorial synthesis. Wave 20 gives each a
-- compiler; this table is where the compiler's output lives, so a gate can
-- point at the exact clips the renderer received instead of recompiling later
-- against an aggregate that has moved on.
--
-- The CHECKs encode what the application refuses, so a repair script cannot
-- write a row the domain would not build:
--
--   * `origin` names one of the two compilers (RENDERABLE_PLAN_ORIGINS,
--     renderable-edit-plan.ts). A third origin means a third compiler nobody
--     reviewed.
--   * A plan with no clips or no frames is a row that renders nothing while
--     claiming to be a render plan.
--   * `sourceVersion` is a chain position, so it is null (the source is not
--     versioned) or 1-based — never 0, which would name a version before the
--     first one.
--   * The stored JSON and the projected columns are one fact, not two. The
--     equalities are wrapped in COALESCE(..., FALSE) because `->> 'id'` on a
--     document missing the key is NULL, and a CHECK is violated only by FALSE:
--     without the wrapper a document with no `id` at all walks straight
--     through, which is the exact edit this refuses.
--   * `fps` is deliberately NOT compared against the JSON. It is a double on
--     both sides and an equality between two floats is a trap, not a
--     constraint; the JSON is the authority and the column is the projection
--     a query reads.

-- CreateTable
CREATE TABLE "renderable_plan_snapshots" (
    "id" VARCHAR(200) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "projectId" VARCHAR(128) NOT NULL,
    "projectVersionId" VARCHAR(128) NOT NULL,
    "planId" VARCHAR(200) NOT NULL,
    "origin" VARCHAR(32) NOT NULL,
    "sourceId" VARCHAR(160) NOT NULL,
    "sourceHash" CHAR(64) NOT NULL,
    "sourceVersion" INTEGER,
    "fps" DOUBLE PRECISION NOT NULL,
    "durationFrames" INTEGER NOT NULL,
    "clipCount" INTEGER NOT NULL,
    "planJson" TEXT NOT NULL,
    "planHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "renderable_plan_snapshots_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "renderable_plan_snapshots"
    ADD CONSTRAINT "renderable_plan_snapshots_origin_check"
    CHECK ("origin" IN ('react-playback', 'multi-range-synthesis'));

ALTER TABLE "renderable_plan_snapshots"
    ADD CONSTRAINT "renderable_plan_snapshots_shape_check"
    CHECK ("durationFrames" > 0
          AND "clipCount" > 0
          AND "fps" > 0
          AND ("sourceVersion" IS NULL OR "sourceVersion" >= 1));

ALTER TABLE "renderable_plan_snapshots"
    ADD CONSTRAINT "renderable_plan_snapshots_plan_check"
    CHECK (jsonb_typeof("planJson"::jsonb) = 'object'
          AND COALESCE("planJson"::jsonb ->> 'id' = "planId", FALSE)
          AND COALESCE("planJson"::jsonb ->> 'state' = 'compiled', FALSE)
          AND COALESCE(("planJson"::jsonb ->> 'schemaVersion')::int = 2, FALSE)
          AND COALESCE("planJson"::jsonb ->> 'projectVersionId' = "projectVersionId", FALSE)
          AND COALESCE(("planJson"::jsonb ->> 'durationFrames')::int = "durationFrames", FALSE)
          AND COALESCE(jsonb_array_length("planJson"::jsonb -> 'videoTracks' -> 0 -> 'clips') = "clipCount", FALSE));

-- CreateIndex
CREATE INDEX "renderable_plan_snapshots_workspaceId_projectId_createdAt_idx" ON "renderable_plan_snapshots"("workspaceId", "projectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "renderable_plan_snapshots_workspaceId_origin_sourceId_creat_idx" ON "renderable_plan_snapshots"("workspaceId", "origin", "sourceId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "renderable_plan_snapshots_id_workspaceId_key" ON "renderable_plan_snapshots"("id", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "renderable_plan_snapshots_workspaceId_planHash_key" ON "renderable_plan_snapshots"("workspaceId", "planHash");

-- The idempotency key of the bridge: one derivation, at one hash, for one
-- project version, compiles to one plan. A recompile is a replay, not a row.
-- CreateIndex
CREATE UNIQUE INDEX "renderable_plan_snapshots_source_key" ON "renderable_plan_snapshots"("workspaceId", "origin", "sourceId", "sourceHash", "projectVersionId");

-- AddForeignKey
ALTER TABLE "renderable_plan_snapshots" ADD CONSTRAINT "renderable_plan_snapshots_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renderable_plan_snapshots" ADD CONSTRAINT "renderable_plan_snapshots_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
