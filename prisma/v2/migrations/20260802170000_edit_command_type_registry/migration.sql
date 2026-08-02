ALTER TABLE "edit_commands"
  DROP CONSTRAINT "edit_commands_type_check";

ALTER TABLE "edit_commands"
  ADD CONSTRAINT "edit_commands_type_check"
  CHECK ("type" IN (
    'apply-review-patch',
    'apply-review-patch-batch',
    'compare-action',
    'manual-edit',
    'remove-spoken-content',
    'replace-source-transcript',
    'run-director',
    'set-project-lut-selection'
  ));
