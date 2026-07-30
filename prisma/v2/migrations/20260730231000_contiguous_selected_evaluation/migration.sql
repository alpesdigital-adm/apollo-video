ALTER TABLE "contiguous_extractions"
  ADD COLUMN "selectedEvaluationId" VARCHAR(128) NOT NULL;

CREATE INDEX "contiguous_extractions_workspaceId_selectedEvaluationId_idx"
  ON "contiguous_extractions"("workspaceId", "selectedEvaluationId");

ALTER TABLE "contiguous_extractions"
  ADD CONSTRAINT "contiguous_extractions_selectedEvaluationId_workspaceId_fkey"
    FOREIGN KEY ("selectedEvaluationId", "workspaceId")
    REFERENCES "contiguous_moment_evaluations"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE;
