ALTER TABLE "public_operations"
ADD COLUMN "traceId" VARCHAR(100);

ALTER TABLE "public_operations"
ADD CONSTRAINT "public_operations_traceId_format"
CHECK (
  "traceId" IS NULL OR
  "traceId" ~ '^[A-Za-z0-9_-]{8,100}$'
);
