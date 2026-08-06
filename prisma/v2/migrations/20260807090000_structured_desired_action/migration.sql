ALTER TABLE "project_director_operations"
  DROP CONSTRAINT "project_director_operations_objective_binding_check";

ALTER TABLE "project_director_operations"
  ADD COLUMN "desiredActionJson" TEXT;

ALTER TABLE "project_director_operations"
  DROP COLUMN "destination";

ALTER TABLE "project_director_operations"
  ADD CONSTRAINT "project_director_operations_objective_binding_check" CHECK (
    "objectiveVersion" >= 1
    AND "baseObjective" IN ('discovery', 'awareness', 'warming', 'lead-generation', 'sale', 'whatsapp', 'booking', 'download')
    AND "objective" IN ('discovery', 'awareness', 'warming', 'lead-generation', 'sale', 'whatsapp', 'booking', 'download')
    AND (
      ("objective" = 'discovery' AND "rubricRef" = 'awareness-discovery/v1')
      OR ("objective" = 'awareness' AND "rubricRef" = 'awareness-level/v1')
      OR ("objective" = 'warming' AND "rubricRef" = 'awareness-warming/v1')
      OR ("objective" = 'lead-generation' AND "rubricRef" = 'conversion-lead/v1')
      OR ("objective" = 'sale' AND "rubricRef" = 'conversion-sale/v1')
      OR ("objective" = 'whatsapp' AND "rubricRef" = 'conversion-whatsapp/v1')
      OR ("objective" = 'booking' AND "rubricRef" = 'conversion-booking/v1')
      OR ("objective" = 'download' AND "rubricRef" = 'conversion-download/v1')
    )
    AND ("desiredActionJson" IS NULL OR length("desiredActionJson") BETWEEN 2 AND 8192)
  );
