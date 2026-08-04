UPDATE "public_operations"
SET
  "progressTotal" = CASE
    WHEN "type" IN (
      'artifact-render',
      'project-proxy-render',
      'project-final-export',
      'source-cleanup'
    ) THEN 4
    WHEN "type" IN ('media-ingest', 'long-form-index') THEN 6
    WHEN "type" = 'project-director-run' THEN 2
  END,
  "progressUnit" = CASE
    WHEN "type" IN (
      'artifact-render',
      'project-proxy-render',
      'project-final-export',
      'source-cleanup'
    ) THEN 'render'
    ELSE 'stage'
  END
WHERE
  "status" = 'queued'
  AND "phase" = 'queued'
  AND "progressCompleted" = 0
  AND "progressTotal" = 1
  AND "progressUnit" = CASE
    WHEN "type" IN (
      'artifact-render',
      'project-proxy-render',
      'project-final-export',
      'source-cleanup'
    ) THEN 'render'
    ELSE 'stage'
  END;

ALTER TABLE "public_operations"
  DROP CONSTRAINT "public_operations_progress_check";

ALTER TABLE "public_operations"
  ADD CONSTRAINT "public_operations_progress_check" CHECK (
    "progressCompleted" IS NOT NULL
    AND "progressTotal" = CASE
      WHEN "type" IN (
        'artifact-render',
        'project-proxy-render',
        'project-final-export',
        'source-cleanup'
      ) THEN 4
      WHEN "type" IN ('media-ingest', 'long-form-index') THEN 6
      WHEN "type" = 'project-director-run' THEN 2
    END
    AND "progressUnit" = CASE
      WHEN "type" IN (
        'artifact-render',
        'project-proxy-render',
        'project-final-export',
        'source-cleanup'
      ) THEN 'render'
      ELSE 'stage'
    END
    AND (
      (
        "status" = 'queued'
        AND "phase" = 'queued'
        AND "progressCompleted" = 0
      )
      OR (
        "status" = 'running'
        AND "progressCompleted" = CASE
          WHEN "type" IN (
            'artifact-render',
            'project-proxy-render',
            'project-final-export',
            'source-cleanup'
          ) AND "phase" = 'materializing' THEN 0
          WHEN "type" IN (
            'artifact-render',
            'project-proxy-render',
            'project-final-export',
            'source-cleanup'
          ) AND "phase" = 'rendering' THEN 1
          WHEN "type" IN (
            'artifact-render',
            'project-proxy-render',
            'project-final-export',
            'source-cleanup'
          ) AND "phase" = 'verifying' THEN 2
          WHEN "type" IN (
            'artifact-render',
            'project-proxy-render',
            'project-final-export',
            'source-cleanup'
          ) AND "phase" = 'persisting' THEN 3
          WHEN "type" = 'media-ingest' AND "phase" = 'assembling' THEN 0
          WHEN "type" = 'media-ingest' AND "phase" = 'probing' THEN 1
          WHEN "type" = 'media-ingest' AND "phase" = 'normalizing' THEN 2
          WHEN "type" = 'media-ingest' AND "phase" = 'transcribing' THEN 3
          WHEN "type" = 'media-ingest' AND "phase" = 'verifying' THEN 4
          WHEN "type" = 'media-ingest' AND "phase" = 'persisting' THEN 5
          WHEN "type" = 'long-form-index' AND "phase" = 'probing' THEN 0
          WHEN "type" = 'long-form-index' AND "phase" = 'transcribing' THEN 1
          WHEN "type" = 'long-form-index' AND "phase" = 'diarizing' THEN 2
          WHEN "type" = 'long-form-index' AND "phase" = 'chunking' THEN 3
          WHEN "type" = 'long-form-index' AND "phase" = 'indexing' THEN 4
          WHEN "type" = 'long-form-index' AND "phase" = 'persisting' THEN 5
          WHEN "type" = 'project-director-run' AND "phase" = 'directing' THEN 0
          WHEN "type" = 'project-director-run' AND "phase" = 'persisting' THEN 1
        END
      )
      OR (
        "status" = 'succeeded'
        AND "phase" = 'completed'
        AND "progressCompleted" = "progressTotal"
      )
      OR (
        (
          ("status" = 'waiting' AND "phase" = 'waiting')
          OR ("status" = 'retrying' AND "phase" = 'retrying')
          OR ("status" = 'failed' AND "phase" = 'failed')
          OR ("status" = 'canceled' AND "phase" = 'canceled')
        )
        AND "progressCompleted" >= 0
        AND "progressCompleted" < "progressTotal"
      )
    )
  );
