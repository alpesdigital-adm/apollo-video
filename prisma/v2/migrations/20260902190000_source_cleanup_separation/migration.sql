ALTER TABLE "source_cleanup_plans"
  DROP CONSTRAINT "source_cleanup_plans_strategy_check";

ALTER TABLE "source_cleanup_plans"
  ADD CONSTRAINT "source_cleanup_plans_strategy_check"
  CHECK (
    "selectedStrategy" IN (
      'trim',
      'crop-reframe',
      'cover',
      'separation',
      'reject'
    )
  );

ALTER TABLE "source_cleanup_results"
  DROP CONSTRAINT "source_cleanup_results_strategy_check";

ALTER TABLE "source_cleanup_results"
  ADD COLUMN "audioPassed" BOOLEAN;

ALTER TABLE "source_cleanup_results"
  ADD CONSTRAINT "source_cleanup_results_strategy_check"
  CHECK (
    "strategy" IN (
      'trim',
      'crop-reframe',
      'cover',
      'separation'
    )
  );

ALTER TABLE "source_cleanup_results"
  DROP CONSTRAINT "source_cleanup_results_review_check";

ALTER TABLE "source_cleanup_results"
  ADD CONSTRAINT "source_cleanup_results_review_check" CHECK (
    "residualQuality" BETWEEN 0 AND 1
    AND "passed" = (
      "visualPassed"
      AND COALESCE("audioPassed", TRUE)
      AND "rightsPassed"
    )
    AND (
      ("strategy" = 'separation' AND "audioPassed" IS NOT NULL)
      OR ("strategy" <> 'separation' AND "audioPassed" IS NULL)
    )
    AND length("reviewJson") BETWEEN 2 AND 1000000
  );
