-- F4.012 / FR-150 — the `direct-multicam-session` EditCommand type.
--
-- The canonical registry (src/v2/domain/edit-command-registry.ts) and
-- PostgreSQL must expose the same closed set of Command types, and a
-- structural test reads the latest constraint and compares it with
-- EDIT_COMMAND_TYPES, so an application Command without a matching migration
-- fails the default suite (ADR-133, "the canonical EditCommand registry and
-- PostgreSQL must expose the same closed set").
--
-- The constraint is dropped and re-added with the full list rather than
-- widened in place: a CHECK is one expression, and the migration that names
-- every accepted value is the one a reader can compare against the registry
-- without reconstructing it from a chain of ALTERs.
--
-- `direct-multicam-session` is a `deferred` Command: it produces no render of
-- its own, and a DirectorRun is what turns its shots into clips.

ALTER TABLE "edit_commands" DROP CONSTRAINT "edit_commands_type_check";
ALTER TABLE "edit_commands" ADD CONSTRAINT "edit_commands_type_check" CHECK ("type" IN (
  'apply-review-patch',
  'apply-review-patch-batch',
  'apply-subtitle-segment-override',
  'compare-action',
  'direct-multicam-session',
  'manual-edit',
  'remove-spoken-content',
  'replace-source-transcript',
  'run-director',
  'set-project-color-plan',
  'set-project-lut-selection',
  'set-project-policy-overrides',
  'set-project-subtitle-mode'
));
