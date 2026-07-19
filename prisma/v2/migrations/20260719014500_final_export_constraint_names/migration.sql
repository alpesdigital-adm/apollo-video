DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'project_final_export_operations_projectVersionId_worksp_fkey'
  ) THEN
    ALTER TABLE "project_final_export_operations"
      RENAME CONSTRAINT "project_final_export_operations_projectVersionId_worksp_fkey"
      TO "project_final_export_operations_projectVersionId_workspace_fkey";
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'project_final_export_operations_directorRunId_workspace_fkey'
  ) THEN
    ALTER TABLE "project_final_export_operations"
      RENAME CONSTRAINT "project_final_export_operations_directorRunId_workspace_fkey"
      TO "project_final_export_operations_directorRunId_workspaceId_fkey";
  END IF;
END $$;
