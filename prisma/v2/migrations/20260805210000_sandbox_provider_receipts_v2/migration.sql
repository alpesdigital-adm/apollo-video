ALTER TABLE "sandbox_provider_executions"
  DROP CONSTRAINT "sandbox_provider_executions_schema_check",
  DROP CONSTRAINT "sandbox_provider_executions_operation_check";

ALTER TABLE "sandbox_provider_executions"
  ADD CONSTRAINT "sandbox_provider_executions_schema_check" CHECK (
    "schemaVersion" IN (
      'sandbox-provider-receipt/v1',
      'sandbox-provider-receipt/v2'
    )
  ),
  ADD CONSTRAINT "sandbox_provider_executions_operation_check" CHECK (
    ("schemaVersion" = 'sandbox-provider-receipt/v1' AND
      "operation" = 'semantic-embedding') OR
    ("schemaVersion" = 'sandbox-provider-receipt/v2' AND
      "operation" IN (
        'semantic-embedding', 'transcription', 'speaker-diarization'
      ))
  );
