ALTER TABLE "public_operations"
  DROP CONSTRAINT "public_operations_type_check",
  DROP CONSTRAINT "public_operations_phase_check";

ALTER TABLE "public_operations"
  ADD CONSTRAINT "public_operations_type_check"
  CHECK (
    "type" IN (
      'artifact-render',
      'media-ingest',
      'project-proxy-render',
      'project-final-export',
      'source-cleanup',
      'long-form-index'
    )
  ),
  ADD CONSTRAINT "public_operations_phase_check"
  CHECK (
    "phase" IN (
      'queued',
      'materializing',
      'rendering',
      'assembling',
      'probing',
      'normalizing',
      'transcribing',
      'diarizing',
      'chunking',
      'indexing',
      'verifying',
      'persisting',
      'waiting',
      'retrying',
      'completed',
      'failed',
      'canceled'
    )
  );
