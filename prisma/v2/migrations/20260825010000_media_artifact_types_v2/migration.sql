-- Keep PostgreSQL aligned with the canonical V2 MediaArtifactType contract.
-- Existing rows remain valid; this only enables immutable font and data artifacts.

ALTER TABLE "media_artifacts"
  DROP CONSTRAINT "media_artifacts_type_check",
  ADD CONSTRAINT "media_artifacts_type_check"
    CHECK ("mediaType" IN ('video', 'audio', 'image', 'font', 'data'));
