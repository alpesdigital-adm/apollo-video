ALTER TABLE "project_final_export_attempts"
  ADD COLUMN "errorStage" VARCHAR(32);

ALTER TABLE "project_final_export_attempts"
  ADD CONSTRAINT "project_final_export_attempts_error_stage_check"
  CHECK (
    ("status" = 'promoted' AND "errorStage" IS NULL)
    OR
    ("status" = 'failed' AND (
      "errorStage" IS NULL OR "errorStage" IN (
        'source-read', 'color-plan', 'color-bindings', 'lut-materialization',
        'input-validation', 'rights', 'source-materialization', 'render',
        'output-verification', 'output-promotion', 'artifact-persistence'
      )
    ))
  );
