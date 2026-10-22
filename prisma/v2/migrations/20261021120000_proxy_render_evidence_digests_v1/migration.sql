-- W70 readiness (R2). The content address a render is carried by (`renderContentHash`) is computed from the sealed inputs of the output before
-- anything is read at render time, so it cannot see two things the review of a proxy depends on: the face windows the caption placement reads
-- for each source when the render runs (a window published after the render moves the decision of a cue), and the Director's quality issues
-- the review is built over. A completed render now stores a digest of each; a carry recomputes them for the head and refuses when either moved.
--   * written by the render worker at completion, and copied by a carry from the render it carries (they are equal by then);
--   * null on every row written before this migration: such a row is never a carry source (nothing is assumed about what it read);
--   * set together or not at all.
ALTER TABLE "project_proxy_render_operations"
  ADD COLUMN "faceEvidenceDigest" CHAR(64),
  ADD COLUMN "criticIssuesDigest" CHAR(64);

ALTER TABLE "project_proxy_render_operations"
  ADD CONSTRAINT "project_proxy_render_operations_evidence_digest_pair_check"
  CHECK (("faceEvidenceDigest" IS NULL) = ("criticIssuesDigest" IS NULL));
