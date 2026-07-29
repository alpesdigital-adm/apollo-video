ALTER TABLE "long_form_index_stage_checkpoints"
  ADD COLUMN "outputEntityType" VARCHAR(64),
  ADD COLUMN "outputEntityId" VARCHAR(128);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "long_form_index_stage_checkpoints"
    WHERE "status" = 'succeeded'
  ) THEN
    RAISE EXCEPTION
      'Long-form stage output references require a clean V2 workflow table';
  END IF;
END
$$;

ALTER TABLE "long_form_index_stage_checkpoints"
  DROP CONSTRAINT "long_form_index_stage_checkpoints_result_check";

ALTER TABLE "long_form_index_stage_checkpoints"
  ADD CONSTRAINT "long_form_index_stage_checkpoints_result_check" CHECK (
    "resultCount" >= 0
    AND "costMinorUnits" >= 0
    AND "elapsedMs" >= 0
    AND (
      ("status" = 'succeeded'
        AND "outputHash" ~ '^[a-f0-9]{64}$'
        AND "outputEntityId" IS NOT NULL
        AND "outputEntityType" = CASE "stage"
          WHEN 'probe' THEN 'media-artifact-manifest'
          WHEN 'transcript' THEN 'media-transcript'
          WHEN 'diarization' THEN 'speaker-diarization-run'
          WHEN 'chunks' THEN 'hierarchical-processing-run'
          WHEN 'moments' THEN 'long-form-index-run'
        END
        AND "resultCount" >= 1
        AND "completedAt" IS NOT NULL
        AND "errorCode" IS NULL
        AND "errorMessage" IS NULL
        AND "errorRetryable" IS NULL)
      OR
      ("status" = 'running'
        AND "attempt" >= 1
        AND "startedAt" IS NOT NULL
        AND "completedAt" IS NULL
        AND "outputHash" IS NULL
        AND "outputEntityType" IS NULL
        AND "outputEntityId" IS NULL
        AND "errorCode" IS NULL
        AND "errorMessage" IS NULL
        AND "errorRetryable" IS NULL)
      OR
      ("status" = 'failed'
        AND "completedAt" IS NOT NULL
        AND "outputHash" IS NULL
        AND "outputEntityType" IS NULL
        AND "outputEntityId" IS NULL
        AND "errorCode" IS NOT NULL
        AND "errorMessage" IS NOT NULL
        AND "errorRetryable" IS NOT NULL)
      OR
      ("status" IN ('pending', 'ready', 'budget-blocked')
        AND "completedAt" IS NULL
        AND "outputHash" IS NULL
        AND "outputEntityType" IS NULL
        AND "outputEntityId" IS NULL
        AND "errorCode" IS NULL
        AND "errorMessage" IS NULL
        AND "errorRetryable" IS NULL)
    )
  );
