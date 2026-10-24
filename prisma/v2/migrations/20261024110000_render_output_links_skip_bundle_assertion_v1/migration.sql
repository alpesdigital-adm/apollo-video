-- A render output (the proxy or the final export of a Version) is linked to its project when the render is promoted. That insert fired the
-- deferred bundle assertion of the project's head State (13 tables share one trigger function), which re-verifies the WHOLE sealed State:
-- on a copy of a project that was already cut that is several seconds, and the owner transaction that links the output has 5 s
-- (found by the W70 rehearsal: the final export of the cut copy failed at its last write, "Transaction already closed", then again on retry).
--
-- The assertion cannot be affected by those two links. A sealed State names the links it depends on (the editorial inventory) and the
-- assertion only checks that each named link EXISTS; adding a link that no sealed State names can never make a sealed State fail. So the
-- trigger now skips exactly the two roles that name a render output, and every other link (the source media, the master, an overlay
-- asset) still triggers the full assertion. Nothing about the assertion, its body or the other twelve tables changes.
DROP TRIGGER project_media_assets_creation_v2_commit_check ON project_media_assets;
CREATE CONSTRAINT TRIGGER project_media_assets_creation_v2_commit_check AFTER INSERT ON project_media_assets DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.role NOT IN ('editorial-proxy','final-output')) EXECUTE FUNCTION w66_creation_bundle_deferred_v2();
