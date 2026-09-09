import type {
  MusicAnalysisV1,
  MusicMontagePlanV1,
  ProtectedSpeechRange,
} from "../../domain/music-led-montage.ts";
import type { DirectedEditPlan } from "../../domain/director-run.ts";
import type { RenderablePlanSnapshot } from "./renderable-plan-snapshot-repository.ts";
import type { ApiAccessAuditContext } from "../../domain/api-access-control.ts";

export interface MaterializedMusicSource {
  readonly filePath: string;
  readonly observedByteSize: number;
  readonly observedSha256: string;
  release(): Promise<void>;
}

export interface MusicSourceMaterializer {
  materialize(input: {
    workspaceId: string;
    artifactId: string;
    artifactKey: string;
    expectedByteSize: number;
    expectedSha256: string;
    rightsSnapshotId: string;
    signal?: AbortSignal;
  }): Promise<MaterializedMusicSource>;
}

export interface MusicRightsAuthorizer {
  authorizeCurrent(input: {
    workspaceId: string;
    projectVersionId: string;
    artifactId: string;
    rightsSnapshotId: string;
    at: string;
  }): Promise<Readonly<{ authorized: true }>>;
}

export interface MusicSignalAnalyzer {
  analyzeVerifiedFile(input: {
    filePath: string;
    sourceArtifactId: string;
    sourceSha256: string;
    sourceByteSize: number;
    signal?: AbortSignal;
  }): Promise<MusicAnalysisV1>;
}

export interface MusicAnalysisRepository {
  findBySourceFingerprint(input: {
    workspaceId: string;
    sourceArtifactId: string;
    sourceSha256: string;
    analyzerId: string;
    analyzerVersion: string;
  }): Promise<MusicAnalysisV1 | null>;
  save(input: {
    workspaceId: string;
    projectVersionId: string;
    rightsSnapshotId: string;
    analysis: MusicAnalysisV1;
  }): Promise<MusicAnalysisV1>;
  authorizeReuse?(input: {
    workspaceId: string;
    projectVersionId: string;
    rightsSnapshotId: string;
    analysis: MusicAnalysisV1;
    authorizedAt: string;
  }): Promise<MusicAnalysisV1>;
  findById(workspaceId: string, id: string): Promise<MusicAnalysisV1 | null>;
}

export type MusicAnalysisRunStatus =
  "queued" | "running" | "completed" | "failed" | "canceled";
export interface MusicAnalysisRun {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly projectVersionId: string;
  readonly sourceArtifactId: string;
  readonly sourceArtifactKey: string;
  readonly sourceSha256: string;
  readonly sourceByteSize: number;
  readonly rightsSnapshotId: string;
  readonly locale: string;
  readonly status: MusicAnalysisRunStatus;
  readonly attempt: number;
  readonly analysisId: string | null;
  readonly analysisHash: string | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly requestedByClientId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface MusicAnalysisRunRepository {
  resolveRequestAuthority(input: {
    workspaceId: string;
    projectId: string;
    projectVersionId: string;
    artifactId: string;
    at: string;
  }): Promise<
    Readonly<{
      artifactKey: string;
      sha256: string;
      byteSize: number;
      rightsSnapshotId: string;
      locale: string;
    }>
  >;
  findRequestReplay(input: {
    workspaceId: string;
    actorClientId: string;
    actorContextHash: string;
    idempotencyKey: string;
    requestFingerprint: string;
  }): Promise<Readonly<MusicAnalysisRun> | null>;
  create(input: {
    run: Readonly<MusicAnalysisRun>;
    requestFingerprint: string;
    sourceFingerprint: string;
    idempotencyKey: string;
    authenticationAudit: Readonly<ApiAccessAuditContext>;
  }): Promise<Readonly<{ run: Readonly<MusicAnalysisRun>; replayed: boolean }>>;
  read(input: {
    workspaceId: string;
    projectId: string;
    runId: string;
  }): Promise<Readonly<MusicAnalysisRun> | null>;
  claim(input: {
    workerId: string;
    leaseTokenHash: string;
    now: string;
    leaseExpiresAt: string;
  }): Promise<Readonly<MusicAnalysisRun> | null>;
  heartbeat(input: {
    workspaceId: string;
    runId: string;
    leaseTokenHash: string;
    now: string;
    leaseExpiresAt: string;
  }): Promise<boolean>;
  settle(input: {
    run: Readonly<MusicAnalysisRun>;
    leaseTokenHash: string;
    now: string;
  }): Promise<Readonly<MusicAnalysisRun>>;
  cancel(input: {
    workspaceId: string;
    projectId: string;
    runId: string;
    now: string;
    authenticationAudit: Readonly<ApiAccessAuditContext>;
  }): Promise<Readonly<MusicAnalysisRun>>;
  retry(input: {
    workspaceId: string;
    projectId: string;
    runId: string;
    now: string;
    authenticationAudit: Readonly<ApiAccessAuditContext>;
  }): Promise<Readonly<MusicAnalysisRun>>;
}

export interface MusicMontagePlanningAuthority {
  resolveCurrent(input: {
    workspaceId: string;
    projectId: string;
    projectVersionId: string;
    analysisId: string;
    visualArtifactIds: readonly string[];
    locale: string;
    market?: string;
    at: string;
  }): Promise<
    Readonly<{
      analysis: MusicAnalysisV1;
      musicArtifactId: string;
      rightsSnapshotId: string;
      visualSources: readonly Readonly<{
        id: string;
        artifactId: string;
        durationSeconds: number;
      }>[];
      /** Server-derived source-time ranges. Callers cannot weaken speech/claim protection. */
      protectedSpeechRanges: readonly Readonly<
        ProtectedSpeechRange & { sourceArtifactId: string }
      >[];
    }>
  >;
}

export interface MusicMontageRun {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly projectVersionId: string;
  readonly locale: string;
  readonly market?: string;
  readonly rightsSnapshotId: string;
  readonly musicAnalysis: MusicAnalysisV1;
  readonly montagePlan: MusicMontagePlanV1;
  readonly editPlan: DirectedEditPlan;
  readonly critic: Readonly<{
    passed: boolean;
    eligibleForAutomaticRender: boolean;
    issues: readonly Readonly<{
      code: string;
      hard: boolean;
      atMs: number;
      evidence: string;
    }>[];
    densityPerMinute: number;
  }>;
  readonly createdAt: string;
  readonly runHash: string;
}

export interface MusicMontageRunRepository {
  findRequestReplay(input: {
    workspaceId: string;
    actorClientId: string;
    actorContextHash: string;
    idempotencyKey: string;
    requestFingerprint: string;
  }): Promise<MusicMontageRun | null>;
  /** Atomically publishes the run and renderer-consumable plan; neither may be visible alone. */
  saveWithRenderablePlan(input: {
    run: MusicMontageRun;
    renderablePlan: RenderablePlanSnapshot;
    requestFingerprint: string;
    idempotencyKey: string;
    actorClientId: string;
    authenticationAudit: Readonly<ApiAccessAuditContext>;
  }): Promise<Readonly<{ run: MusicMontageRun; replayed: boolean }>>;
  findById(
    workspaceId: string,
    projectId: string,
    id: string,
  ): Promise<MusicMontageRun | null>;
}
