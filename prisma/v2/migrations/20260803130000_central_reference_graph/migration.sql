-- Bind central aggregate references to the same project/workspace and bind
-- manifests to the artifact whose bytes they describe. Existing inconsistent
-- rows intentionally make this migration fail closed.

CREATE UNIQUE INDEX "project_snapshots_id_projectId_workspaceId_key"
  ON "project_snapshots"("id", "projectId", "workspaceId");

CREATE UNIQUE INDEX "project_versions_id_projectId_workspaceId_key"
  ON "project_versions"("id", "projectId", "workspaceId");

CREATE UNIQUE INDEX "director_runs_id_projectId_workspaceId_key"
  ON "director_runs"("id", "projectId", "workspaceId");

CREATE UNIQUE INDEX "project_proxy_render_operations_operationId_projectId_works_key"
  ON "project_proxy_render_operations"("operationId", "projectId", "workspaceId");

CREATE UNIQUE INDEX "proxy_reviews_id_projectId_workspaceId_key"
  ON "proxy_reviews"("id", "projectId", "workspaceId");

CREATE UNIQUE INDEX "proxy_reviews_operationId_projectId_workspaceId_key"
  ON "proxy_reviews"("operationId", "projectId", "workspaceId");

DROP INDEX "director_runs_resultVersionId_workspaceId_key";

CREATE UNIQUE INDEX "director_runs_resultVersionId_projectId_workspaceId_key"
  ON "director_runs"("resultVersionId", "projectId", "workspaceId");

ALTER TABLE "director_runs"
  DROP CONSTRAINT "director_runs_baseVersionId_workspaceId_fkey",
  DROP CONSTRAINT "director_runs_resultVersionId_workspaceId_fkey",
  DROP CONSTRAINT "director_runs_perceptionSnapshotId_fkey",
  DROP CONSTRAINT "director_runs_treatmentSnapshotId_fkey",
  DROP CONSTRAINT "director_runs_storySnapshotId_fkey",
  DROP CONSTRAINT "director_runs_editPlanSnapshotId_fkey",
  DROP CONSTRAINT "director_runs_qualitySnapshotId_fkey",
  ADD CONSTRAINT "director_runs_baseVersionId_projectId_workspaceId_fkey"
    FOREIGN KEY ("baseVersionId", "projectId", "workspaceId")
    REFERENCES "project_versions"("id", "projectId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "director_runs_resultVersionId_projectId_workspaceId_fkey"
    FOREIGN KEY ("resultVersionId", "projectId", "workspaceId")
    REFERENCES "project_versions"("id", "projectId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "director_runs_perceptionSnapshotId_projectId_workspaceId_fkey"
    FOREIGN KEY ("perceptionSnapshotId", "projectId", "workspaceId")
    REFERENCES "project_snapshots"("id", "projectId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "director_runs_treatmentSnapshotId_projectId_workspaceId_fkey"
    FOREIGN KEY ("treatmentSnapshotId", "projectId", "workspaceId")
    REFERENCES "project_snapshots"("id", "projectId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "director_runs_storySnapshotId_projectId_workspaceId_fkey"
    FOREIGN KEY ("storySnapshotId", "projectId", "workspaceId")
    REFERENCES "project_snapshots"("id", "projectId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "director_runs_editPlanSnapshotId_projectId_workspaceId_fkey"
    FOREIGN KEY ("editPlanSnapshotId", "projectId", "workspaceId")
    REFERENCES "project_snapshots"("id", "projectId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "director_runs_qualitySnapshotId_projectId_workspaceId_fkey"
    FOREIGN KEY ("qualitySnapshotId", "projectId", "workspaceId")
    REFERENCES "project_snapshots"("id", "projectId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "projects"
  DROP CONSTRAINT "projects_currentVersionId_workspaceId_fkey",
  ADD CONSTRAINT "projects_currentVersionId_id_workspaceId_fkey"
    FOREIGN KEY ("currentVersionId", "id", "workspaceId")
    REFERENCES "project_versions"("id", "projectId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_versions"
  DROP CONSTRAINT "project_versions_parentVersionId_fkey",
  DROP CONSTRAINT "project_versions_briefSnapshotId_fkey",
  DROP CONSTRAINT "project_versions_treatmentSnapshotId_fkey",
  DROP CONSTRAINT "project_versions_storySnapshotId_fkey",
  DROP CONSTRAINT "project_versions_editPlanSnapshotId_fkey",
  DROP CONSTRAINT "project_versions_policiesSnapshotId_fkey",
  ADD CONSTRAINT "project_versions_parentVersionId_projectId_workspaceId_fkey"
    FOREIGN KEY ("parentVersionId", "projectId", "workspaceId")
    REFERENCES "project_versions"("id", "projectId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_versions_briefSnapshotId_projectId_workspaceId_fkey"
    FOREIGN KEY ("briefSnapshotId", "projectId", "workspaceId")
    REFERENCES "project_snapshots"("id", "projectId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_versions_treatmentSnapshotId_projectId_workspaceId_fkey"
    FOREIGN KEY ("treatmentSnapshotId", "projectId", "workspaceId")
    REFERENCES "project_snapshots"("id", "projectId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_versions_storySnapshotId_projectId_workspaceId_fkey"
    FOREIGN KEY ("storySnapshotId", "projectId", "workspaceId")
    REFERENCES "project_snapshots"("id", "projectId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_versions_editPlanSnapshotId_projectId_workspaceId_fkey"
    FOREIGN KEY ("editPlanSnapshotId", "projectId", "workspaceId")
    REFERENCES "project_snapshots"("id", "projectId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_versions_policiesSnapshotId_projectId_workspaceId_fkey"
    FOREIGN KEY ("policiesSnapshotId", "projectId", "workspaceId")
    REFERENCES "project_snapshots"("id", "projectId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "media_ingest_operations"
  ADD CONSTRAINT "media_ingest_operations_sourceArtifactId_workspaceId_fkey"
    FOREIGN KEY ("sourceArtifactId", "workspaceId")
    REFERENCES "media_artifacts"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "media_ingest_operations_sourceManifestId_sourceArtifactId__fkey"
    FOREIGN KEY ("sourceManifestId", "sourceArtifactId", "workspaceId")
    REFERENCES "media_artifact_manifests"("id", "artifactId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_proxy_render_operations"
  DROP CONSTRAINT "project_proxy_render_operations_projectVersionId_workspace_fkey",
  ADD CONSTRAINT "project_proxy_render_operations_projectVersionId_projectId_fkey"
    FOREIGN KEY ("projectVersionId", "projectId", "workspaceId")
    REFERENCES "project_versions"("id", "projectId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_proxy_render_operations_editPlanSnapshotId_project_fkey"
    FOREIGN KEY ("editPlanSnapshotId", "projectId", "workspaceId")
    REFERENCES "project_snapshots"("id", "projectId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_proxy_render_operations_sourceArtifactId_workspace_fkey"
    FOREIGN KEY ("sourceArtifactId", "workspaceId")
    REFERENCES "media_artifacts"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_proxy_render_operations_sourceManifestId_sourceArt_fkey"
    FOREIGN KEY ("sourceManifestId", "sourceArtifactId", "workspaceId")
    REFERENCES "media_artifact_manifests"("id", "artifactId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_proxy_render_operations_outputArtifactId_workspace_fkey"
    FOREIGN KEY ("outputArtifactId", "workspaceId")
    REFERENCES "media_artifacts"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_proxy_render_operations_outputManifestId_outputArt_fkey"
    FOREIGN KEY ("outputManifestId", "outputArtifactId", "workspaceId")
    REFERENCES "media_artifact_manifests"("id", "artifactId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_final_export_operations"
  DROP CONSTRAINT "project_final_export_operations_projectVersionId_workspace_fkey",
  DROP CONSTRAINT "project_final_export_operations_directorRunId_workspaceId_fkey",
  DROP CONSTRAINT "project_final_export_operations_qualitySnapshotId_fkey",
  DROP CONSTRAINT "project_final_export_operations_proxyReviewId_workspaceId_fkey",
  ADD CONSTRAINT "project_final_export_operations_projectVersionId_projectId_fkey"
    FOREIGN KEY ("projectVersionId", "projectId", "workspaceId")
    REFERENCES "project_versions"("id", "projectId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_final_export_operations_directorRunId_projectId_wo_fkey"
    FOREIGN KEY ("directorRunId", "projectId", "workspaceId")
    REFERENCES "director_runs"("id", "projectId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_final_export_operations_editPlanSnapshotId_project_fkey"
    FOREIGN KEY ("editPlanSnapshotId", "projectId", "workspaceId")
    REFERENCES "project_snapshots"("id", "projectId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_final_export_operations_qualitySnapshotId_projectI_fkey"
    FOREIGN KEY ("qualitySnapshotId", "projectId", "workspaceId")
    REFERENCES "project_snapshots"("id", "projectId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_final_export_operations_proxyReviewId_projectId_wo_fkey"
    FOREIGN KEY ("proxyReviewId", "projectId", "workspaceId")
    REFERENCES "proxy_reviews"("id", "projectId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_final_export_operations_proxyArtifactId_workspaceI_fkey"
    FOREIGN KEY ("proxyArtifactId", "workspaceId")
    REFERENCES "media_artifacts"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_final_export_operations_sourceArtifactId_workspace_fkey"
    FOREIGN KEY ("sourceArtifactId", "workspaceId")
    REFERENCES "media_artifacts"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_final_export_operations_sourceManifestId_sourceArt_fkey"
    FOREIGN KEY ("sourceManifestId", "sourceArtifactId", "workspaceId")
    REFERENCES "media_artifact_manifests"("id", "artifactId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_final_export_operations_outputArtifactId_workspace_fkey"
    FOREIGN KEY ("outputArtifactId", "workspaceId")
    REFERENCES "media_artifacts"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_final_export_operations_outputManifestId_outputArt_fkey"
    FOREIGN KEY ("outputManifestId", "outputArtifactId", "workspaceId")
    REFERENCES "media_artifact_manifests"("id", "artifactId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "proxy_reviews"
  DROP CONSTRAINT "proxy_reviews_projectVersionId_workspaceId_fkey",
  DROP CONSTRAINT "proxy_reviews_operationId_workspaceId_fkey",
  DROP CONSTRAINT "proxy_reviews_proxyManifestId_workspaceId_fkey",
  ADD CONSTRAINT "proxy_reviews_projectVersionId_projectId_workspaceId_fkey"
    FOREIGN KEY ("projectVersionId", "projectId", "workspaceId")
    REFERENCES "project_versions"("id", "projectId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "proxy_reviews_operationId_projectId_workspaceId_fkey"
    FOREIGN KEY ("operationId", "projectId", "workspaceId")
    REFERENCES "project_proxy_render_operations"("operationId", "projectId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "proxy_reviews_proxyManifestId_proxyArtifactId_workspaceId_fkey"
    FOREIGN KEY ("proxyManifestId", "proxyArtifactId", "workspaceId")
    REFERENCES "media_artifact_manifests"("id", "artifactId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "artifact_render_operations"
  DROP CONSTRAINT "artifact_render_operations_manifestId_workspaceId_fkey",
  ADD CONSTRAINT "artifact_render_operations_manifestId_artifactId_workspace_fkey"
    FOREIGN KEY ("manifestId", "artifactId", "workspaceId")
    REFERENCES "media_artifact_manifests"("id", "artifactId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_final_export_attempts"
  ADD CONSTRAINT "project_final_export_attempts_outputArtifactId_workspaceId_fkey"
    FOREIGN KEY ("outputArtifactId", "workspaceId")
    REFERENCES "media_artifacts"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_final_export_attempts_outputManifestId_outputArtif_fkey"
    FOREIGN KEY ("outputManifestId", "outputArtifactId", "workspaceId")
    REFERENCES "media_artifact_manifests"("id", "artifactId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE;
