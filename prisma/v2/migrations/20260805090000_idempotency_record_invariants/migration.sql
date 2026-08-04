-- The V2 reset policy permits discarding malformed replay metadata.
-- No product aggregate or media identity is stored in this ledger.
DELETE FROM "idempotency_records"
WHERE "expiresAt" <= "createdAt"
   OR "updatedAt" < "createdAt"
   OR octet_length(COALESCE("responseJson", '')) > 1048576
   OR CASE "status"
        WHEN 'processing' THEN
          "responseStatus" IS NOT NULL OR "responseJson" IS NOT NULL
        WHEN 'completed' THEN
          "responseStatus" IS NULL OR
          "responseStatus" NOT BETWEEN 200 AND 299 OR
          "responseJson" IS NULL OR
          jsonb_typeof("responseJson"::jsonb) <> 'object'
        WHEN 'failed-retryable' THEN
          "responseStatus" IS NULL OR
          "responseStatus" NOT BETWEEN 400 AND 599 OR
          "responseJson" IS NULL OR
          jsonb_typeof("responseJson"::jsonb) <> 'object'
        WHEN 'failed-final' THEN
          "responseStatus" IS NULL OR
          "responseStatus" NOT BETWEEN 400 AND 499 OR
          "responseJson" IS NULL OR
          jsonb_typeof("responseJson"::jsonb) <> 'object'
        ELSE TRUE
      END;

ALTER TABLE "idempotency_records"
  DROP CONSTRAINT IF EXISTS "idempotency_records_response_matrix_check",
  DROP CONSTRAINT IF EXISTS "idempotency_records_time_order_check",
  DROP CONSTRAINT IF EXISTS "idempotency_records_response_size_check";

ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_response_matrix_check"
  CHECK (
    ("status" = 'processing' AND
      "responseStatus" IS NULL AND "responseJson" IS NULL) OR
    ("status" = 'completed' AND
      "responseStatus" BETWEEN 200 AND 299 AND
      "responseJson" IS NOT NULL AND
      jsonb_typeof("responseJson"::jsonb) = 'object') OR
    ("status" = 'failed-retryable' AND
      "responseStatus" BETWEEN 400 AND 599 AND
      "responseJson" IS NOT NULL AND
      jsonb_typeof("responseJson"::jsonb) = 'object') OR
    ("status" = 'failed-final' AND
      "responseStatus" BETWEEN 400 AND 499 AND
      "responseJson" IS NOT NULL AND
      jsonb_typeof("responseJson"::jsonb) = 'object')
  ),
  ADD CONSTRAINT "idempotency_records_time_order_check"
  CHECK ("expiresAt" > "createdAt" AND "updatedAt" >= "createdAt"),
  ADD CONSTRAINT "idempotency_records_response_size_check"
  CHECK (octet_length(COALESCE("responseJson", '')) <= 1048576);
