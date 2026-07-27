ALTER TABLE "project_media_assets"
  DROP CONSTRAINT "project_media_assets_role_check";

ALTER TABLE "project_media_assets"
  ADD CONSTRAINT "project_media_assets_role_check"
  CHECK (
    "role" IN (
      'source-master',
      'editing-proxy',
      'editorial-proxy',
      'final-output',
      'selected-insert'
    )
  );
