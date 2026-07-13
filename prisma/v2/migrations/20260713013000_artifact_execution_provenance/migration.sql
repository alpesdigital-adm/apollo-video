ALTER TABLE "media_artifact_lineage"
  ADD COLUMN "toolId" VARCHAR(64),
  ADD COLUMN "toolVersion" VARCHAR(64),
  ADD COLUMN "toolDigest" CHAR(64),
  ADD COLUMN "modelProvider" VARCHAR(64),
  ADD COLUMN "modelId" VARCHAR(128),
  ADD COLUMN "modelVersion" VARCHAR(64),
  ADD COLUMN "modelConfigHash" CHAR(64),
  ADD CONSTRAINT "media_artifact_lineage_tool_check" CHECK (
    ("toolId" IS NULL AND "toolVersion" IS NULL AND "toolDigest" IS NULL)
    OR
    (
      "toolId" ~ '^[a-z0-9][a-z0-9._-]*$'
      AND "toolVersion" ~ '^[a-z0-9][a-z0-9._-]*$'
      AND "toolDigest" ~ '^[a-f0-9]{64}$'
    )
  ),
  ADD CONSTRAINT "media_artifact_lineage_model_check" CHECK (
    (
      "modelProvider" IS NULL
      AND "modelId" IS NULL
      AND "modelVersion" IS NULL
      AND "modelConfigHash" IS NULL
    )
    OR
    (
      "modelProvider" ~ '^[a-z0-9][a-z0-9._-]*$'
      AND "modelId" ~ '^[a-z0-9][a-z0-9._-]*$'
      AND "modelVersion" ~ '^[a-z0-9][a-z0-9._-]*$'
      AND "modelConfigHash" ~ '^[a-f0-9]{64}$'
      AND "toolId" IS NOT NULL
    )
  );
