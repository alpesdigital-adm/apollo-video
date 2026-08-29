ALTER TABLE "provider_jobs"
  DROP CONSTRAINT "provider_jobs_status_check",
  ADD CONSTRAINT "provider_jobs_status_check"
    CHECK ("status" IN ('planned','estimated','submitting','submitted','queued','processing','suspected-stalled','retrieving','evaluating','approved','rejected','failed','canceled','expired','superseded'));

ALTER TABLE "provider_job_transitions"
  DROP CONSTRAINT "provider_job_transitions_status_check",
  ADD CONSTRAINT "provider_job_transitions_status_check"
    CHECK ("toStatus" IN ('planned','estimated','submitting','submitted','queued','processing','suspected-stalled','retrieving','evaluating','approved','rejected','failed','canceled','expired','superseded'));
