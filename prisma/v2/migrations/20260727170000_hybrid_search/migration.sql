CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE "semantic_search_documents" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "sourceType" VARCHAR(32) NOT NULL,
  "sourceId" VARCHAR(128) NOT NULL,
  "sourceHash" CHAR(64) NOT NULL,
  "identityKey" VARCHAR(260) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL,
  "sourceArtifactSha256" CHAR(64) NOT NULL,
  "kind" VARCHAR(32) NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "locale" VARCHAR(35) NOT NULL,
  "personIdsJson" TEXT NOT NULL,
  "personIdsNormalized" TEXT NOT NULL,
  "transcriptText" TEXT NOT NULL,
  "ocrText" TEXT NOT NULL,
  "intentionsJson" TEXT NOT NULL,
  "intentionsNormalized" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "metadataJson" TEXT NOT NULL,
  "metadataSearchNormalized" TEXT NOT NULL,
  "searchTextNormalized" TEXT NOT NULL,
  "searchVector" TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce("transcriptText", '')), 'A')
    || setweight(to_tsvector('simple', coalesce("ocrText", '')), 'A')
    || setweight(to_tsvector('simple', coalesce("intentionsNormalized", '')), 'B')
    || setweight(to_tsvector('simple', coalesce("description", '')), 'B')
    || setweight(to_tsvector('simple', coalesce("metadataSearchNormalized", '')), 'C')
  ) STORED,
  "producerJson" TEXT NOT NULL,
  "embeddingState" VARCHAR(32) NOT NULL,
  "embeddingProvider" VARCHAR(64) NOT NULL,
  "embeddingModel" VARCHAR(128) NOT NULL,
  "embeddingVersion" VARCHAR(64) NOT NULL,
  "embeddingDimensions" INTEGER NOT NULL,
  "embeddingDegraded" BOOLEAN NOT NULL,
  "embeddingInputHash" CHAR(64) NOT NULL,
  "embeddingVectorHash" CHAR(64),
  "embeddingJson" TEXT NOT NULL,
  "embedding" vector(256),
  "rightsSnapshotId" VARCHAR(128) NOT NULL,
  "rightsStatus" VARCHAR(32) NOT NULL,
  "consentStatus" VARCHAR(32) NOT NULL,
  "indexVersion" VARCHAR(64) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  "physicalMaterialized" BOOLEAN NOT NULL DEFAULT FALSE,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByType" VARCHAR(32) NOT NULL,
  "createdById" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "documentHash" CHAR(64) NOT NULL,

  CONSTRAINT "semantic_search_documents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "semantic_search_documents_hashes_check" CHECK (
    "sourceHash" ~ '^[a-f0-9]{64}$'
    AND "sourceArtifactSha256" ~ '^[a-f0-9]{64}$'
    AND "embeddingInputHash" ~ '^[a-f0-9]{64}$'
    AND (
      "embeddingVectorHash" IS NULL
      OR "embeddingVectorHash" ~ '^[a-f0-9]{64}$'
    )
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
    AND "documentHash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "semantic_search_documents_source_check" CHECK (
    "sourceType" IN (
      'artifact',
      'speech-segment',
      'evidence-segment',
      'long-form-moment',
      'validated-segment'
    )
    AND "kind" IN (
      'image',
      'video',
      'audio',
      'speech-segment',
      'evidence-segment',
      'long-form-moment',
      'validated-segment'
    )
    AND "identityKey" = "sourceType" || ':' || "sourceId"
    AND (
      ("sourceType" = 'artifact' AND "kind" IN ('image', 'video', 'audio'))
      OR ("sourceType" = 'speech-segment' AND "kind" = 'speech-segment')
      OR ("sourceType" = 'evidence-segment' AND "kind" = 'evidence-segment')
      OR ("sourceType" = 'long-form-moment' AND "kind" = 'long-form-moment')
      OR ("sourceType" = 'validated-segment' AND "kind" = 'validated-segment')
    )
    AND "durationMs" >= 0
    AND "locale" ~ '^[a-z]{2,3}(-[A-Z]{2})?$'
  ),
  CONSTRAINT "semantic_search_documents_embedding_check" CHECK (
    "embeddingState" IN ('ready', 'unavailable')
    AND "embeddingDimensions" = 256
    AND (
      (
        "embeddingState" = 'ready'
        AND "embeddingVectorHash" IS NOT NULL
        AND jsonb_typeof("embeddingJson"::jsonb) = 'array'
        AND jsonb_array_length("embeddingJson"::jsonb) = 256
        AND "embedding" IS NOT NULL
      )
      OR (
        "embeddingState" = 'unavailable'
        AND "embeddingVectorHash" IS NULL
        AND "embeddingJson" = '[]'
        AND "embedding" IS NULL
      )
    )
  ),
  CONSTRAINT "semantic_search_documents_policy_check" CHECK (
    "indexVersion" = 'semantic-search-index/v1'
    AND "physicalMaterialized" = FALSE
    AND "createdByType" = 'api-client'
  ),
  CONSTRAINT "semantic_search_documents_rights_check" CHECK (
    "rightsStatus" IN (
      'approved',
      'restricted',
      'unknown',
      'expired',
      'revoked'
    )
    AND "consentStatus" IN (
      'approved',
      'not-required',
      'restricted',
      'unknown',
      'expired',
      'revoked'
    )
  ),
  CONSTRAINT "semantic_search_documents_text_check" CHECK (
    length("personIdsJson") BETWEEN 2 AND 100000
    AND length("personIdsNormalized") BETWEEN 2 AND 100000
    AND length("transcriptText") <= 100000
    AND length("ocrText") <= 100000
    AND length("intentionsJson") BETWEEN 2 AND 100000
    AND length("intentionsNormalized") BETWEEN 2 AND 100000
    AND length("description") <= 40001
    AND length("metadataJson") BETWEEN 2 AND 100000
    AND length("metadataSearchNormalized") <= 100000
    AND length("searchTextNormalized") BETWEEN 1 AND 300000
    AND length("producerJson") BETWEEN 2 AND 100000
  )
);

CREATE UNIQUE INDEX "semantic_search_documents_id_workspaceId_key"
  ON "semantic_search_documents"("id", "workspaceId");
CREATE UNIQUE INDEX "semantic_search_documents_workspaceId_projectId_idempotency_key"
  ON "semantic_search_documents"(
    "workspaceId",
    "projectId",
    "idempotencyKey"
  );
CREATE UNIQUE INDEX "semantic_search_documents_workspaceId_documentHash_key"
  ON "semantic_search_documents"("workspaceId", "documentHash");
CREATE UNIQUE INDEX "semantic_search_documents_active_identity_key"
  ON "semantic_search_documents"(
    "workspaceId",
    "projectId",
    "identityKey"
  )
  WHERE "active" = TRUE;
CREATE INDEX "semantic_search_documents_workspaceId_projectId_active_crea_idx"
  ON "semantic_search_documents"(
    "workspaceId",
    "projectId",
    "active",
    "createdAt" DESC
  );
CREATE INDEX "semantic_search_documents_workspaceId_projectId_kind_locale_idx"
  ON "semantic_search_documents"(
    "workspaceId",
    "projectId",
    "kind",
    "locale",
    "durationMs"
  );
CREATE INDEX "semantic_search_documents_workspaceId_sourceArtifactId_acti_idx"
  ON "semantic_search_documents"(
    "workspaceId",
    "sourceArtifactId",
    "active"
  );
CREATE INDEX "semantic_search_documents_workspaceId_sourceType_sourceId_a_idx"
  ON "semantic_search_documents"(
    "workspaceId",
    "sourceType",
    "sourceId",
    "active"
  );
CREATE INDEX "semantic_search_documents_workspaceId_rightsSnapshotId_idx"
  ON "semantic_search_documents"("workspaceId", "rightsSnapshotId");
CREATE INDEX "semantic_search_documents_workspaceId_embeddingProvider_emb_idx"
  ON "semantic_search_documents"(
    "workspaceId",
    "embeddingProvider",
    "embeddingModel",
    "embeddingVersion",
    "embeddingState"
  );
CREATE INDEX "semantic_search_documents_searchVector_idx"
  ON "semantic_search_documents" USING GIN ("searchVector");
CREATE INDEX "semantic_search_documents_searchText_trgm_idx"
  ON "semantic_search_documents"
  USING GIN ("searchTextNormalized" gin_trgm_ops);
CREATE INDEX "semantic_search_documents_embedding_hnsw_idx"
  ON "semantic_search_documents"
  USING hnsw ("embedding" vector_cosine_ops)
  WHERE "embeddingState" = 'ready' AND "active" = TRUE;

ALTER TABLE "semantic_search_documents"
  ADD CONSTRAINT "semantic_search_documents_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "semantic_search_documents"
  ADD CONSTRAINT "semantic_search_documents_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "semantic_search_documents"
  ADD CONSTRAINT "semantic_search_documents_sourceArtifactId_workspaceId_fkey"
  FOREIGN KEY ("sourceArtifactId", "workspaceId")
  REFERENCES "media_artifacts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "semantic_search_documents"
  ADD CONSTRAINT "semantic_search_documents_rightsSnapshotId_workspaceId_fkey"
  FOREIGN KEY ("rightsSnapshotId", "workspaceId")
  REFERENCES "asset_rights_snapshots"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "semantic_search_documents"
  ADD CONSTRAINT "semantic_search_documents_createdById_workspaceId_fkey"
  FOREIGN KEY ("createdById", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "retrieval_evaluations" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "policyVersion" VARCHAR(64) NOT NULL,
  "rerankPolicyVersion" VARCHAR(64) NOT NULL,
  "k" INTEGER NOT NULL,
  "caseCount" INTEGER NOT NULL,
  "casesJson" TEXT NOT NULL,
  "aggregateJson" TEXT NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByType" VARCHAR(32) NOT NULL,
  "createdById" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reportHash" CHAR(64) NOT NULL,

  CONSTRAINT "retrieval_evaluations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "retrieval_evaluations_policy_check" CHECK (
    "policyVersion" = 'retrieval-eval/v1'
    AND "rerankPolicyVersion" = 'hybrid-rerank/v1'
    AND "createdByType" = 'api-client'
    AND "k" BETWEEN 1 AND 100
    AND "caseCount" BETWEEN 1 AND 50
  ),
  CONSTRAINT "retrieval_evaluations_hashes_check" CHECK (
    "requestFingerprint" ~ '^[a-f0-9]{64}$'
    AND "reportHash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "retrieval_evaluations_json_check" CHECK (
    length("casesJson") BETWEEN 2 AND 1000000
    AND length("aggregateJson") BETWEEN 2 AND 100000
  )
);

CREATE UNIQUE INDEX "retrieval_evaluations_id_workspaceId_key"
  ON "retrieval_evaluations"("id", "workspaceId");
CREATE UNIQUE INDEX "retrieval_evaluations_workspaceId_projectId_idempotencyKey_key"
  ON "retrieval_evaluations"(
    "workspaceId",
    "projectId",
    "idempotencyKey"
  );
CREATE UNIQUE INDEX "retrieval_evaluations_workspaceId_reportHash_key"
  ON "retrieval_evaluations"("workspaceId", "reportHash");
CREATE INDEX "retrieval_evaluations_workspaceId_projectId_createdAt_idx"
  ON "retrieval_evaluations"(
    "workspaceId",
    "projectId",
    "createdAt" DESC
  );
CREATE INDEX "retrieval_evaluations_workspaceId_policyVersion_rerankPolic_idx"
  ON "retrieval_evaluations"(
    "workspaceId",
    "policyVersion",
    "rerankPolicyVersion"
  );

ALTER TABLE "retrieval_evaluations"
  ADD CONSTRAINT "retrieval_evaluations_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "retrieval_evaluations"
  ADD CONSTRAINT "retrieval_evaluations_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "retrieval_evaluations"
  ADD CONSTRAINT "retrieval_evaluations_createdById_workspaceId_fkey"
  FOREIGN KEY ("createdById", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
