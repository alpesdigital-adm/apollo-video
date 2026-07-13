CREATE TABLE "recipe_parameter_payloads" (
  "ref" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "parametersHash" CHAR(64) NOT NULL,
  "canonicalByteSize" INTEGER NOT NULL,
  "algorithm" VARCHAR(32) NOT NULL,
  "keyId" VARCHAR(64) NOT NULL,
  "nonce" VARCHAR(32) NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "authTag" VARCHAR(32) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "recipe_parameter_payloads_pkey" PRIMARY KEY ("workspaceId", "ref"),
  CONSTRAINT "recipe_parameter_payloads_hash_check" CHECK (
    "parametersHash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "recipe_parameter_payloads_ref_check" CHECK (
    "ref" = 'recipe-parameters/sha256/' || "parametersHash"
  ),
  CONSTRAINT "recipe_parameter_payloads_size_check" CHECK (
    "canonicalByteSize" > 0 AND "canonicalByteSize" <= 1048576
  ),
  CONSTRAINT "recipe_parameter_payloads_cipher_check" CHECK (
    "algorithm" = 'aes-256-gcm'
    AND "keyId" ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
    AND "nonce" ~ '^[A-Za-z0-9_-]{16}$'
    AND length("ciphertext") > 0
    AND "authTag" ~ '^[A-Za-z0-9_-]{22}$'
  )
);

ALTER TABLE "media_artifact_manifests"
  ADD COLUMN "recipeParametersRef" VARCHAR(128),
  DROP CONSTRAINT "media_artifact_manifests_schema_check",
  ADD CONSTRAINT "media_artifact_manifests_schema_check" CHECK (
    "schemaVersion" IN (
      'media-artifact-manifest/v1',
      'media-artifact-manifest/v2',
      'media-artifact-manifest/v3'
    )
  );

CREATE UNIQUE INDEX "recipe_parameter_payloads_workspaceId_parametersHash_key"
  ON "recipe_parameter_payloads"("workspaceId", "parametersHash");
CREATE INDEX "recipe_parameter_payloads_workspaceId_createdAt_idx"
  ON "recipe_parameter_payloads"("workspaceId", "createdAt" DESC);
CREATE INDEX "media_artifact_manifests_workspaceId_recipeParametersRef_idx"
  ON "media_artifact_manifests"("workspaceId", "recipeParametersRef");

ALTER TABLE "recipe_parameter_payloads"
  ADD CONSTRAINT "recipe_parameter_payloads_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "media_artifact_manifests"
  ADD CONSTRAINT "media_artifact_manifests_recipeParametersRef_workspaceId_fkey" FOREIGN KEY ("workspaceId", "recipeParametersRef")
  REFERENCES "recipe_parameter_payloads"("workspaceId", "ref")
  ON DELETE RESTRICT ON UPDATE CASCADE;
