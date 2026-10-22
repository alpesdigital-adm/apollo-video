-- W70 readiness follow-up. A review whose approval a carry re-bound used to hold, in its own acknowledgement columns, the API client that
-- acknowledged the SOURCE review (the constraint required an acknowledged review to name an API client), and only the read path rewrote it into
-- the automatic carry. The stored row itself therefore named a person who never acknowledged that Version.
--   * the acknowledgement of a review is now either an API client (a person, on this Version) or the automatic carry; for the carry the id is the
--     `carry-over-approval` decision that re-bound the approval and the time is the time of that decision;
--   * the person who acknowledged the source review is not copied: it stays on the source review row, reachable through the carry
--     (`carriedFromReviewId`), and the carry decision keeps the hash of that review as its base;
--   * rows written by the earlier carry are rewritten here from their own decision, so no stored row names the earlier person as acknowledger.
ALTER TABLE "proxy_reviews" DROP CONSTRAINT "proxy_reviews_acknowledgement_check";

ALTER TABLE "proxy_reviews" ADD CONSTRAINT "proxy_reviews_acknowledgement_check" CHECK (
    ("warningsAcknowledged" = false AND "acknowledgedByType" IS NULL AND "acknowledgedById" IS NULL AND "acknowledgedAt" IS NULL) OR
    ("warningsAcknowledged" = true AND "acknowledgedByType" IN ('api-client', 'automatic-carry') AND "acknowledgedById" IS NOT NULL AND "acknowledgedAt" IS NOT NULL)
);

UPDATE "proxy_reviews" AS review
SET "acknowledgedByType" = 'automatic-carry',
    "acknowledgedById" = decision."id",
    "acknowledgedAt" = decision."createdAt"
FROM "proxy_review_decisions" AS decision
WHERE decision."workspaceId" = review."workspaceId"
  AND decision."proxyReviewId" = review."id"
  AND decision."action" = 'carry-over-approval';
