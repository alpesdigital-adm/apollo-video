import { DomainError } from "../domain/errors.ts";
import type {
  MusicAnalysisRepository,
  MusicRightsAuthorizer,
  MusicSignalAnalyzer,
  MusicSourceMaterializer,
} from "./ports/music-led-montage.ts";

export const MUSIC_ANALYZER_ID = "apollo-ffmpeg-pcm-onset";
export const MUSIC_ANALYZER_VERSION = "1.0.0";

export function analyzeMusicForMontageService(dependencies: {
  rights: MusicRightsAuthorizer;
  sources: MusicSourceMaterializer;
  analyzer: MusicSignalAnalyzer;
  analyses: MusicAnalysisRepository;
  clock?: () => Date;
}) {
  return async (input: {
    workspaceId: string;
    projectVersionId: string;
    artifactId: string;
    artifactKey: string;
    expectedByteSize: number;
    expectedSha256: string;
    rightsSnapshotId: string;
    signal?: AbortSignal;
  }) => {
    await dependencies.rights.authorizeCurrent({
      workspaceId: input.workspaceId,
      projectVersionId: input.projectVersionId,
      artifactId: input.artifactId,
      rightsSnapshotId: input.rightsSnapshotId,
      at: (dependencies.clock ?? (() => new Date()))().toISOString(),
    });
    const cached = await dependencies.analyses.findBySourceFingerprint({
      workspaceId: input.workspaceId,
      sourceArtifactId: input.artifactId,
      sourceSha256: input.expectedSha256,
      analyzerId: MUSIC_ANALYZER_ID,
      analyzerVersion: MUSIC_ANALYZER_VERSION,
    });
    if (cached) {
      if (!dependencies.analyses.authorizeReuse)
        throw new DomainError(
          "PERSISTENCE_CONFLICT",
          "Music analysis cache cannot record current rights authorization",
        );
      return dependencies.analyses.authorizeReuse({
        workspaceId: input.workspaceId,
        projectVersionId: input.projectVersionId,
        rightsSnapshotId: input.rightsSnapshotId,
        analysis: cached,
        authorizedAt: (
          dependencies.clock ?? (() => new Date())
        )().toISOString(),
      });
    }
    const source = await dependencies.sources.materialize({
      workspaceId: input.workspaceId,
      artifactId: input.artifactId,
      artifactKey: input.artifactKey,
      expectedByteSize: input.expectedByteSize,
      expectedSha256: input.expectedSha256,
      rightsSnapshotId: input.rightsSnapshotId,
      signal: input.signal,
    });
    try {
      if (
        source.observedByteSize !== input.expectedByteSize ||
        source.observedSha256 !== input.expectedSha256
      )
        throw new DomainError(
          "MEDIA_ARTIFACT_IDENTITY_MISMATCH",
          "Materialized music bytes do not match the authorized artifact",
        );
      const analysis = await dependencies.analyzer.analyzeVerifiedFile({
        filePath: source.filePath,
        sourceArtifactId: input.artifactId,
        sourceSha256: input.expectedSha256,
        sourceByteSize: input.expectedByteSize,
        signal: input.signal,
      });
      if (
        analysis.analyzer.id !== MUSIC_ANALYZER_ID ||
        analysis.analyzer.version !== MUSIC_ANALYZER_VERSION
      )
        throw new DomainError(
          "INVALID_ARGUMENT",
          "Music analyzer identity is not supported",
        );
      await dependencies.rights.authorizeCurrent({
        workspaceId: input.workspaceId,
        projectVersionId: input.projectVersionId,
        artifactId: input.artifactId,
        rightsSnapshotId: input.rightsSnapshotId,
        at: (dependencies.clock ?? (() => new Date()))().toISOString(),
      });
      return await dependencies.analyses.save({
        workspaceId: input.workspaceId,
        projectVersionId: input.projectVersionId,
        rightsSnapshotId: input.rightsSnapshotId,
        analysis,
      });
    } finally {
      await source.release();
    }
  };
}
