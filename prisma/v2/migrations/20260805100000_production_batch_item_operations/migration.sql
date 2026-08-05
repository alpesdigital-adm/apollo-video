ALTER TABLE "production_batch_items"
  ADD COLUMN "operationId" VARCHAR(128);

UPDATE "production_batch_items"
SET "operationId" = 'production-batch-item-operation-' || encode(
  digest(
    convert_to(
      '{"batchId":"' || "batchId" ||
      '","itemId":"' || "id" ||
      '","schemaVersion":"production-batch-item-operation-id/v1"' ||
      ',"workspaceId":"' || "workspaceId" || '"}',
      'UTF8'
    ),
    'sha256'
  ),
  'hex'
);

ALTER TABLE "production_batch_items"
  ALTER COLUMN "operationId" SET NOT NULL;

CREATE UNIQUE INDEX "production_batch_items_operationId_key"
  ON "production_batch_items"("operationId");
