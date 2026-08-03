ALTER TABLE "ui_sessions"
  ADD COLUMN "rotatedAt" TIMESTAMPTZ(3),
  ADD COLUMN "successorNonceHash" CHAR(64);

ALTER TABLE "ui_sessions"
  ADD CONSTRAINT "ui_sessions_rotation_check" CHECK (
    ("rotatedAt" IS NULL AND "successorNonceHash" IS NULL)
    OR
    (
      "rotatedAt" IS NOT NULL
      AND "successorNonceHash" IS NOT NULL
      AND "revokedAt" = "rotatedAt"
      AND "successorNonceHash" <> "nonceHash"
    )
  );

CREATE INDEX "ui_sessions_successorNonceHash_idx"
  ON "ui_sessions"("successorNonceHash");
