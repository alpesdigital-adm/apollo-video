-- The right to submit paid work for one cache address.
--
-- Until now "is a twin already in flight?" was a read followed, some
-- microseconds later, by a write. Two requests that asked at the same instant
-- both read "no" and both paid: measured, not theorised. The claim closes that
-- window at the only place that can arbitrate it — the database — by making
-- the cache address itself the primary key.
--
-- It is deliberately tiny and short-lived. It is taken just before the cost is
-- committed and released as soon as the pending generation row is visible, so
-- the union of "claim held" and "pending row exists" is never empty while work
-- is in flight. `claimedAt` exists so a process that dies mid-submission
-- cannot wedge an address forever: a stale claim is takeable.

CREATE TABLE "synthetic_cache_submission_claims" (
  "workspaceId" VARCHAR(128) NOT NULL,
  "cacheKey" CHAR(64) NOT NULL,
  "blockId" VARCHAR(128) NOT NULL,
  "claimedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "synthetic_cache_submission_claims_pkey" PRIMARY KEY ("workspaceId","cacheKey"),
  CONSTRAINT "synthetic_cache_submission_claims_hash_check"
    CHECK ("cacheKey" ~ '^[a-f0-9]{64}$')
);

CREATE INDEX "synthetic_cache_submission_claims_claimed_idx"
  ON "synthetic_cache_submission_claims"("claimedAt");

ALTER TABLE "synthetic_cache_submission_claims"
  ADD CONSTRAINT "synthetic_cache_submission_claims_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
