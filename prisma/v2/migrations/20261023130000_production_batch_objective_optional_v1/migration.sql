-- ADR-160. A production batch may be created with no objective: the requester chose none and the Apollo presumes none. The column was NOT NULL
-- because every batch used to carry one; a batch that stores none stores NULL (and its definition hash covers no objective key).
ALTER TABLE "production_batches" ALTER COLUMN "objective" DROP NOT NULL;
