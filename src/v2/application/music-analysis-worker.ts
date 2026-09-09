import { createHash, randomUUID } from "node:crypto";
import { calculateCanonicalHash } from "../domain/canonical-hash.ts";
import { DomainError } from "../domain/errors.ts";
import { analyzeMusicForMontageService } from "./analyze-music-for-montage.ts";
import type {
  MusicAnalysisRepository,
  MusicAnalysisRun,
  MusicAnalysisRunRepository,
  MusicRightsAuthorizer,
  MusicSignalAnalyzer,
  MusicSourceMaterializer,
} from "./ports/music-led-montage.ts";
import type { ApiAccessAuditContext } from "../domain/api-access-control.ts";

export function requestMusicAnalysisService(deps: {
  runs: MusicAnalysisRunRepository;
  clock?: () => Date;
  createId?: () => string;
}) {
  return async (input: {
    workspaceId: string;
    projectId: string;
    projectVersionId: string;
    artifactId: string;
    actorClientId: string;
    idempotencyKey: string;
    authenticationAudit: Readonly<ApiAccessAuditContext>;
  }) => {
    if (!input.idempotencyKey || input.idempotencyKey.length > 128)
      throw new DomainError(
        "INVALID_ARGUMENT",
        "A bounded Idempotency-Key header is required",
      );
    const requestFingerprint = calculateCanonicalHash({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      projectVersionId: input.projectVersionId,
      artifactId: input.artifactId,
    });
    const replay = await deps.runs.findRequestReplay({
      workspaceId: input.workspaceId,
      actorClientId: input.actorClientId,
      actorContextHash: input.authenticationAudit.contextHash,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
    });
    if (replay) return Object.freeze({ run: replay, replayed: true });
    const now = (deps.clock ?? (() => new Date()))().toISOString();
    const authority = await deps.runs.resolveRequestAuthority({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      projectVersionId: input.projectVersionId,
      artifactId: input.artifactId,
      at: now,
    });
    const run: MusicAnalysisRun = Object.freeze({
      id: `music-analysis-run-${(deps.createId ?? randomUUID)()}`,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      projectVersionId: input.projectVersionId,
      sourceArtifactId: input.artifactId,
      sourceArtifactKey: authority.artifactKey,
      sourceSha256: authority.sha256,
      sourceByteSize: authority.byteSize,
      rightsSnapshotId: authority.rightsSnapshotId,
      locale: authority.locale,
      status: "queued",
      attempt: 0,
      analysisId: null,
      analysisHash: null,
      failureCode: null,
      failureMessage: null,
      requestedByClientId: input.actorClientId,
      createdAt: now,
      updatedAt: now,
    });
    return deps.runs.create({
      run,
      requestFingerprint,
      sourceFingerprint: calculateCanonicalHash({
        workspaceId: run.workspaceId,
        projectVersionId: run.projectVersionId,
        artifactId: run.sourceArtifactId,
        sha256: run.sourceSha256,
        rightsSnapshotId: run.rightsSnapshotId,
        analyzer: "apollo-ffmpeg-pcm-onset@1.0.0",
      }),
      idempotencyKey: input.idempotencyKey,
      authenticationAudit: input.authenticationAudit,
    });
  };
}

export function runNextMusicAnalysisService(deps: {
  runs: MusicAnalysisRunRepository;
  rights: MusicRightsAuthorizer;
  sources: MusicSourceMaterializer;
  analyzer: MusicSignalAnalyzer;
  analyses: MusicAnalysisRepository;
  workerId: string;
  clock?: () => Date;
  leaseMs?: number;
  createLeaseToken?: () => string;
}) {
  return async (signal?: AbortSignal) => {
    if (signal?.aborted)
      throw (
        signal.reason ??
        new DomainError(
          "RENDER_EXECUTION_FAILED",
          "Music analysis worker was aborted before claim",
        )
      );
    const clock = deps.clock ?? (() => new Date()),
      leaseMs = deps.leaseMs ?? 120_000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 10_000 || leaseMs > 600_000)
      throw new DomainError(
        "INVALID_ARGUMENT",
        "Music analysis lease duration is invalid",
      );
    const tokenHash = createHash("sha256")
        .update((deps.createLeaseToken ?? randomUUID)())
        .digest("hex"),
      started = clock();
    const claim = await deps.runs.claim({
      workerId: deps.workerId,
      leaseTokenHash: tokenHash,
      now: started.toISOString(),
      leaseExpiresAt: new Date(started.getTime() + leaseMs).toISOString(),
    });
    if (!claim) return null;
    const controller = new AbortController(),
      forwardAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", forwardAbort, { once: true });
    const heartbeat = setInterval(
      () => {
        const now = clock();
        void deps.runs
          .heartbeat({
            workspaceId: claim.workspaceId,
            runId: claim.id,
            leaseTokenHash: tokenHash,
            now: now.toISOString(),
            leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
          })
          .then((ok) => {
            if (!ok) controller.abort(new Error("music analysis lease lost"));
          })
          .catch(() =>
            controller.abort(new Error("music analysis heartbeat failed")),
          );
      },
      Math.max(2_000, Math.floor(leaseMs / 3)),
    );
    try {
      const analysis = await analyzeMusicForMontageService({
        rights: deps.rights,
        sources: deps.sources,
        analyzer: deps.analyzer,
        analyses: deps.analyses,
        clock,
      })({
        workspaceId: claim.workspaceId,
        projectVersionId: claim.projectVersionId,
        artifactId: claim.sourceArtifactId,
        artifactKey: claim.sourceArtifactKey,
        expectedByteSize: claim.sourceByteSize,
        expectedSha256: claim.sourceSha256,
        rightsSnapshotId: claim.rightsSnapshotId,
        signal: controller.signal,
      });
      return await deps.runs.settle({
        run: Object.freeze({
          ...claim,
          status: "completed",
          analysisId: analysis.id,
          analysisHash: analysis.analysisHash,
          failureCode: null,
          failureMessage: null,
          updatedAt: clock().toISOString(),
        }),
        leaseTokenHash: tokenHash,
        now: clock().toISOString(),
      });
    } catch (error) {
      const code =
        error instanceof DomainError
          ? error.code
          : controller.signal.aborted
            ? "OPERATION_CANCELED"
            : "MUSIC_ANALYSIS_FAILED";
      const failed = Object.freeze({
        ...claim,
        status: "failed" as const,
        failureCode: code,
        failureMessage:
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Music analysis failed",
        updatedAt: clock().toISOString(),
      });
      try {
        return await deps.runs.settle({
          run: failed,
          leaseTokenHash: tokenHash,
          now: clock().toISOString(),
        });
      } catch {
        throw error;
      }
    } finally {
      clearInterval(heartbeat);
      signal?.removeEventListener("abort", forwardAbort);
    }
  };
}
