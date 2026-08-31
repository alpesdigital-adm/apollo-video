-- Two eligibility checks that had no way to be written down until now.
--
-- A candidate could be rejected for its blob being gone, but not for the blob
-- still being there with different bytes than the generation registered, and
-- not for satisfying an output shape nobody asked for any more. Both are
-- misses — the work is generated and paid for — so they widen the reason code
-- vocabulary without touching the outcome vocabulary, and every historical row
-- keeps verifying because no stored value changes.

ALTER TABLE "synthetic_cache_decisions"
  DROP CONSTRAINT "synthetic_cache_decisions_reason_code_check";

ALTER TABLE "synthetic_cache_decisions"
  ADD CONSTRAINT "synthetic_cache_decisions_reason_code_check"
  CHECK ("reasonCode" IN (
    'CACHE_HIT_ELIGIBLE', 'CACHE_MISS_NO_CANDIDATE', 'CANDIDATE_BLOB_UNAVAILABLE',
    'CANDIDATE_CHECKSUM_DRIFT', 'CANDIDATE_OUTPUT_MISMATCH',
    'CANDIDATE_CRITIC_REJECTED', 'CANDIDATE_RIGHTS_BLOCKED', 'CONSENT_REVOKED',
    'MUST_REGENERATE', 'IN_FLIGHT_TWIN'
  ));
