ALTER TABLE "contiguous_moment_evaluations"
  ADD COLUMN "producerProvider" VARCHAR(128) NOT NULL,
  ADD COLUMN "producerModel" VARCHAR(128) NOT NULL,
  ADD COLUMN "producerVersion" VARCHAR(128) NOT NULL,
  ADD COLUMN "producerInputHash" CHAR(64) NOT NULL,
  ADD COLUMN "producerOutputHash" CHAR(64) NOT NULL;

ALTER TABLE "contiguous_moment_evaluations"
  ADD CONSTRAINT "contiguous_moment_evaluations_producer_hashes_check"
    CHECK (
      "producerInputHash" ~ '^[a-f0-9]{64}$' AND
      "producerOutputHash" ~ '^[a-f0-9]{64}$'
    );

CREATE INDEX "contiguous_moment_evaluations_workspaceId_producerProvider__idx"
  ON "contiguous_moment_evaluations"(
    "workspaceId",
    "producerProvider",
    "producerModel",
    "producerVersion",
    "createdAt" DESC
  );
