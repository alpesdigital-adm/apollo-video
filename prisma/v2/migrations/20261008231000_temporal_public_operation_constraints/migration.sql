-- Add the separate temporal operation without weakening any existing PublicOperation checks.
ALTER TABLE "public_operations"
  DROP CONSTRAINT "public_operations_type_check",
  DROP CONSTRAINT "public_operations_phase_check",
  DROP CONSTRAINT "public_operations_type_target_check",
  DROP CONSTRAINT "public_operations_project_scope_check",
  DROP CONSTRAINT "public_operations_progress_check";

ALTER TABLE "public_operations"
  ADD CONSTRAINT "public_operations_type_check"
  CHECK ("type" IN ('artifact-render', 'synthetic-production-render', 'media-ingest', 'project-proxy-render', 'project-final-export', 'source-cleanup', 'long-form-index', 'project-director-run', 'perception-producer-run', 'perception-temporal-run')),
  ADD CONSTRAINT "public_operations_phase_check"
  CHECK ("phase" IN ('queued', 'materializing', 'rendering', 'assembling', 'probing',
    'normalizing', 'transcribing', 'analyzing', 'diarizing', 'chunking', 'indexing',
    'directing', 'verifying', 'persisting', 'waiting', 'retrying', 'completed', 'failed', 'canceled')),
  ADD CONSTRAINT "public_operations_type_target_check"
  CHECK (
    ("type" IN ('project-director-run', 'synthetic-production-render', 'perception-producer-run', 'perception-temporal-run') AND "targetType" = 'project-version')
    OR
    ("type" NOT IN ('project-director-run', 'synthetic-production-render', 'perception-producer-run', 'perception-temporal-run') AND "targetType" = 'media-artifact')
  ),
  ADD CONSTRAINT "public_operations_project_scope_check"
  CHECK (
    ("type" = 'artifact-render' AND "projectId" IS NULL)
    OR
    ("type" IN ('media-ingest', 'project-proxy-render', 'project-final-export', 'source-cleanup', 'long-form-index', 'project-director-run', 'synthetic-production-render', 'perception-producer-run', 'perception-temporal-run') AND "projectId" IS NOT NULL)
  ),
  ADD CONSTRAINT "public_operations_progress_check" CHECK (
    "progressCompleted" IS NOT NULL
    AND "progressTotal" IS NOT NULL
    AND "progressUnit" IS NOT NULL
    AND "progressTotal" = CASE
      WHEN "type" IN ('artifact-render', 'synthetic-production-render', 'project-proxy-render', 'project-final-export', 'source-cleanup', 'perception-producer-run', 'perception-temporal-run') THEN 4
      WHEN "type" IN ('media-ingest', 'long-form-index') THEN 6
      WHEN "type" = 'project-director-run' THEN 2
    END
    AND "progressUnit" = CASE
      WHEN "type" IN ('artifact-render', 'synthetic-production-render', 'project-proxy-render', 'project-final-export', 'source-cleanup') THEN 'render'
      ELSE 'stage'
    END
    AND ("type" <> 'perception-producer-run' OR "status" <> 'running'
      OR "phase" IN ('probing', 'transcribing', 'verifying', 'persisting'))
    AND ("type" <> 'perception-temporal-run' OR "status" <> 'running'
      OR "phase" IN ('probing', 'analyzing', 'verifying', 'persisting'))
    AND (
      ("status" = 'queued' AND "phase" = 'queued' AND "progressCompleted" = 0)
      OR ("status" = 'running' AND "progressCompleted" = CASE
        WHEN "type" IN ('artifact-render', 'synthetic-production-render', 'project-proxy-render', 'project-final-export', 'source-cleanup') AND "phase" = 'materializing' THEN 0
        WHEN "type" IN ('artifact-render', 'synthetic-production-render', 'project-proxy-render', 'project-final-export', 'source-cleanup') AND "phase" = 'rendering' THEN 1
        WHEN "type" IN ('artifact-render', 'synthetic-production-render', 'project-proxy-render', 'project-final-export', 'source-cleanup') AND "phase" = 'verifying' THEN 2
        WHEN "type" IN ('artifact-render', 'synthetic-production-render', 'project-proxy-render', 'project-final-export', 'source-cleanup') AND "phase" = 'persisting' THEN 3
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
        WHEN "type" = 'perception-producer-run' AND "phase" = 'probing' THEN 0
        WHEN "type" = 'perception-producer-run' AND "phase" = 'transcribing' THEN 1
        WHEN "type" = 'perception-producer-run' AND "phase" = 'verifying' THEN 2
        WHEN "type" = 'perception-producer-run' AND "phase" = 'persisting' THEN 3
        WHEN "type" = 'perception-temporal-run' AND "phase" = 'probing' THEN 0
        WHEN "type" = 'perception-temporal-run' AND "phase" = 'analyzing' THEN 1
        WHEN "type" = 'perception-temporal-run' AND "phase" = 'verifying' THEN 2
        WHEN "type" = 'perception-temporal-run' AND "phase" = 'persisting' THEN 3
      END)
      OR ("status" = 'succeeded' AND "phase" = 'completed' AND "progressCompleted" = "progressTotal")
      OR ("status" IN ('waiting', 'retrying', 'failed', 'canceled')
        AND "phase" = "status" AND "progressCompleted" >= 0 AND "progressCompleted" < "progressTotal")
    )
  );
