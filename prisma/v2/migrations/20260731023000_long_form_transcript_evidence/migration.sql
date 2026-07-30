CREATE TABLE "long_form_moment_transcript_evidence" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "indexRunId" VARCHAR(128) NOT NULL,
  "indexRunHash" CHAR(64) NOT NULL,
  "momentId" VARCHAR(128) NOT NULL,
  "momentHash" CHAR(64) NOT NULL,
  "hierarchicalRunId" VARCHAR(128) NOT NULL,
  "hierarchicalRunHash" CHAR(64) NOT NULL,
  "sourceTranscriptId" VARCHAR(128) NOT NULL,
  "sourceTranscriptHash" CHAR(64) NOT NULL,
  "spansJson" TEXT NOT NULL,
  "spanCount" INTEGER NOT NULL,
  "startMs" INTEGER NOT NULL,
  "endMs" INTEGER NOT NULL,
  "wordCount" INTEGER NOT NULL,
  "evidenceHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "long_form_moment_transcript_evidence_pkey"
    PRIMARY KEY ("id"),
  CONSTRAINT "long_form_moment_transcript_evidence_counts_check"
    CHECK (
      "spanCount" > 0 AND "spanCount" <= 1024 AND
      "wordCount" > 0
    ),
  CONSTRAINT "long_form_moment_transcript_evidence_range_check"
    CHECK ("startMs" >= 0 AND "endMs" > "startMs"),
  CONSTRAINT "long_form_moment_transcript_evidence_hashes_check"
    CHECK (
      "indexRunHash" ~ '^[a-f0-9]{64}$' AND
      "momentHash" ~ '^[a-f0-9]{64}$' AND
      "hierarchicalRunHash" ~ '^[a-f0-9]{64}$' AND
      "sourceTranscriptHash" ~ '^[a-f0-9]{64}$' AND
      "evidenceHash" ~ '^[a-f0-9]{64}$'
    )
);

CREATE UNIQUE INDEX "long_form_moment_transcript_evidence_id_workspaceId_key"
  ON "long_form_moment_transcript_evidence"("id", "workspaceId");
CREATE UNIQUE INDEX "long_form_moment_transcript_evidence_momentId_workspaceId_key"
  ON "long_form_moment_transcript_evidence"("momentId", "workspaceId");
CREATE UNIQUE INDEX "long_form_moment_transcript_evidence_workspaceId_evidenceHa_key"
  ON "long_form_moment_transcript_evidence"("workspaceId", "evidenceHash");
CREATE INDEX "long_form_moment_transcript_evidence_workspaceId_projectId__idx"
  ON "long_form_moment_transcript_evidence"(
    "workspaceId", "projectId", "indexRunId"
  );
CREATE INDEX "long_form_moment_transcript_evidence_workspaceId_hierarchic_idx"
  ON "long_form_moment_transcript_evidence"(
    "workspaceId", "hierarchicalRunId"
  );
CREATE INDEX "long_form_moment_transcript_evidence_workspaceId_sourceTran_idx"
  ON "long_form_moment_transcript_evidence"(
    "workspaceId", "sourceTranscriptId"
  );

ALTER TABLE "long_form_moment_transcript_evidence"
  ADD CONSTRAINT "long_form_moment_transcript_evidence_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "long_form_moment_transcript_evidence_projectId_workspaceId_fkey"
    FOREIGN KEY ("projectId", "workspaceId")
    REFERENCES "projects"("id", "workspaceId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "long_form_moment_transcript_evidence_indexRunId_workspaceI_fkey"
    FOREIGN KEY ("indexRunId", "workspaceId")
    REFERENCES "long_form_index_runs"("id", "workspaceId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "long_form_moment_transcript_evidence_momentId_workspaceId_fkey"
    FOREIGN KEY ("momentId", "workspaceId")
    REFERENCES "long_form_moments"("id", "workspaceId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "long_form_moment_transcript_evidence_hierarchicalRunId_wor_fkey"
    FOREIGN KEY ("hierarchicalRunId", "workspaceId")
    REFERENCES "hierarchical_processing_runs"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "long_form_moment_transcript_evidence_sourceTranscriptId_wo_fkey"
    FOREIGN KEY ("sourceTranscriptId", "workspaceId")
    REFERENCES "media_transcripts"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE;
