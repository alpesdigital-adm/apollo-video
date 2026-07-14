CREATE TABLE "render_input_payloads" (
  "ref" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "inputHash" CHAR(64) NOT NULL,
  "canonicalByteSize" INTEGER NOT NULL,
  "algorithm" VARCHAR(32) NOT NULL,
  "keyId" VARCHAR(64) NOT NULL,
  "nonce" VARCHAR(32) NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "authTag" VARCHAR(32) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "render_input_payloads_pkey" PRIMARY KEY ("workspaceId", "ref"),
  CONSTRAINT "render_input_payloads_hash_check" CHECK (
    "inputHash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "render_input_payloads_ref_check" CHECK (
    "ref" = 'render-input/sha256/' || "inputHash"
  ),
  CONSTRAINT "render_input_payloads_size_check" CHECK (
    "canonicalByteSize" > 0 AND "canonicalByteSize" <= 4194304
  ),
  CONSTRAINT "render_input_payloads_cipher_check" CHECK (
    "algorithm" = 'aes-256-gcm'
    AND "keyId" ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
    AND "nonce" ~ '^[A-Za-z0-9_-]{16}$'
    AND length("ciphertext") > 0
    AND "authTag" ~ '^[A-Za-z0-9_-]{22}$'
  )
);

ALTER TABLE "media_artifact_manifests"
  ADD COLUMN "renderInputRef" VARCHAR(128),
  ADD COLUMN "renderInputHash" CHAR(64),
  DROP CONSTRAINT "media_artifact_manifests_schema_check",
  ADD CONSTRAINT "media_artifact_manifests_schema_check" CHECK (
    "schemaVersion" IN (
      'media-artifact-manifest/v1',
      'media-artifact-manifest/v2',
      'media-artifact-manifest/v3',
      'media-artifact-manifest/v4'
    )
  ),
  ADD CONSTRAINT "media_artifact_manifests_recipe_parameters_check" CHECK (
    (
      "schemaVersion" IN ('media-artifact-manifest/v3', 'media-artifact-manifest/v4')
      AND "recipeParametersRef" IS NOT NULL
      AND "recipeParametersRef" = 'recipe-parameters/sha256/' || "parametersHash"
    )
    OR (
      "schemaVersion" IN ('media-artifact-manifest/v1', 'media-artifact-manifest/v2')
      AND "recipeParametersRef" IS NULL
    )
  ),
  ADD CONSTRAINT "media_artifact_manifests_render_input_check" CHECK (
    (
      "schemaVersion" = 'media-artifact-manifest/v4'
      AND "renderInputRef" IS NOT NULL
      AND "renderInputHash" ~ '^[a-f0-9]{64}$'
      AND "renderInputRef" = 'render-input/sha256/' || "renderInputHash"
    )
    OR (
      "schemaVersion" <> 'media-artifact-manifest/v4'
      AND "renderInputRef" IS NULL
      AND "renderInputHash" IS NULL
    )
  );

CREATE UNIQUE INDEX "render_input_payloads_workspaceId_inputHash_key"
  ON "render_input_payloads"("workspaceId", "inputHash");
CREATE INDEX "render_input_payloads_workspaceId_createdAt_idx"
  ON "render_input_payloads"("workspaceId", "createdAt" DESC);
CREATE INDEX "media_artifact_manifests_workspaceId_renderInputRef_idx"
  ON "media_artifact_manifests"("workspaceId", "renderInputRef");

ALTER TABLE "render_input_payloads"
  ADD CONSTRAINT "render_input_payloads_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "media_artifact_manifests"
  ADD CONSTRAINT "media_artifact_manifests_renderInputRef_workspaceId_fkey" FOREIGN KEY ("workspaceId", "renderInputRef")
  REFERENCES "render_input_payloads"("workspaceId", "ref")
  ON DELETE RESTRICT ON UPDATE CASCADE;
