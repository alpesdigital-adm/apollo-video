ALTER TABLE "edit_commands" DROP CONSTRAINT "edit_commands_type_check";
ALTER TABLE "edit_commands" ADD CONSTRAINT "edit_commands_type_check" CHECK ("type" IN ('remove-spoken-content', 'run-director', 'apply-review-patch', 'apply-review-patch-batch', 'manual-edit', 'compare-action'));
