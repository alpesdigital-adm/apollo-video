-- ADR-160 F6. The editorial request of a production batch: its briefing and how the interpreter read it, with the hash of the request.
-- Additive and nullable: a batch created before the request existed has neither, and a batch has both or neither.
ALTER TABLE "production_batches" ADD COLUMN "briefingJson" TEXT, ADD COLUMN "requestHash" CHAR(64);
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_request_check" CHECK (
  ("briefingJson" IS NULL AND "requestHash" IS NULL)
  OR ("briefingJson" IS NOT NULL AND length("briefingJson") BETWEEN 2 AND 1000000 AND "requestHash" ~ '^[a-f0-9]{64}$')
);
