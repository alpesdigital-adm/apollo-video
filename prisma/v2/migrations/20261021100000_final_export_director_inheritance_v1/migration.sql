-- A ProjectVersion made by an exception Command (a per-segment subtitle exception, a manual reframe of one output) has no DirectorRun of
-- its own, so a final export of it was unreachable. The quality the Director certified for the ancestor it descends from, through
-- exception Commands only, now describes it, and the export records HOW it reached that run: the sealed `director-run-inheritance/v1`
-- document names the Version the run produced and every Version and Command the quality went through. It is nullable and
-- application-written: a final export of the Director's own Version has none, exactly as every row written before this column.
-- The DirectorRun row is the ancestor's own and is never copied; `directorRunId` keeps pointing at it.
ALTER TABLE "project_final_export_operations" ADD COLUMN "directorInheritanceJson" TEXT;
