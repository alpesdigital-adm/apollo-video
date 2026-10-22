-- A render carried from an earlier Version (W70 prep) re-binds the approval its source review had to the new review. That has to be VISIBLE as
-- what it is - an automatic carry of an identical render, not a human acknowledgement made on the new Version - so the carried operation now
-- names the review it was carried from and the hash that review had at that moment. The public review exposes them as `carriedFrom`.
--   * both columns are written only by a carry (null on a render, on an inline reuse and on every row written before this migration: nothing
--     is assumed about those), and they are set together or not at all;
--   * the content address that proved the inputs equal stays in `renderContentHash`; `reuseImpactHash` keeps its own meaning (the impact hash of
--     the Command that made the head), which the carry used to overwrite with the content address.
ALTER TABLE "project_proxy_render_operations"
  ADD COLUMN "carriedFromReviewId" VARCHAR(128),
  ADD COLUMN "carriedFromReviewHash" CHAR(64);

ALTER TABLE "project_proxy_render_operations"
  ADD CONSTRAINT "project_proxy_render_operations_carried_from_pair_check"
  CHECK (("carriedFromReviewId" IS NULL) = ("carriedFromReviewHash" IS NULL));

ALTER TABLE "project_proxy_render_operations"
  ADD CONSTRAINT "project_proxy_render_operations_carriedFromReviewId_worksp_fkey"
  FOREIGN KEY ("carriedFromReviewId", "workspaceId") REFERENCES "proxy_reviews"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "pp_render_ops_carried_from_idx" ON "project_proxy_render_operations"("workspaceId", "carriedFromReviewId");
