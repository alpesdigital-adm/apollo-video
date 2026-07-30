ALTER TABLE "contiguous_evaluation_evidence"
  ADD COLUMN "indexRunHash" CHAR(64) NOT NULL,
  ADD COLUMN "momentHash" CHAR(64) NOT NULL;

ALTER TABLE "contiguous_evaluation_evidence"
  ADD CONSTRAINT "contiguous_evaluation_evidence_lineage_hashes_check"
    CHECK (
      "indexRunHash" ~ '^[a-f0-9]{64}$' AND
      "momentHash" ~ '^[a-f0-9]{64}$'
    );
