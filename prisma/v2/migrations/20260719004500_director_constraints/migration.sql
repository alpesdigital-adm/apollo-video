ALTER TABLE "edit_commands"
  DROP CONSTRAINT "edit_commands_type_check";

ALTER TABLE "edit_commands"
  ADD CONSTRAINT "edit_commands_type_check"
  CHECK ("type" IN ('remove-spoken-content', 'run-director'));

ALTER TABLE "project_snapshots"
  DROP CONSTRAINT "project_snapshots_kind_check";

ALTER TABLE "project_snapshots"
  ADD CONSTRAINT "project_snapshots_kind_check"
  CHECK ("kind" IN ('brief', 'perception', 'treatment', 'story', 'edit-plan', 'quality-report', 'policies'));
