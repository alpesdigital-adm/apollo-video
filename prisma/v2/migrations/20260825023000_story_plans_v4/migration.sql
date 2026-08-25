ALTER TABLE "story_plans"
  DROP CONSTRAINT "story_plans_schema_check";

ALTER TABLE "story_plans"
  ADD CONSTRAINT "story_plans_schema_check"
  CHECK ("schemaVersion" IN (3, 4));
