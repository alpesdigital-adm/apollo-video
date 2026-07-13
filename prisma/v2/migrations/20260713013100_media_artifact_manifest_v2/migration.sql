ALTER TABLE "media_artifact_manifests"
  DROP CONSTRAINT "media_artifact_manifests_schema_check",
  ADD CONSTRAINT "media_artifact_manifests_schema_check" CHECK (
    "schemaVersion" IN ('media-artifact-manifest/v1', 'media-artifact-manifest/v2')
  );
