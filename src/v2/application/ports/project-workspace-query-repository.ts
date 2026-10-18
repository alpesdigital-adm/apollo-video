export interface ProjectWorkspaceMediaRecord {
  id: string
  role: 'source-master' | 'editing-proxy' | 'editorial-proxy' | 'final-output'
  originalFileName: string
  artifactId: string
  manifestId: string
  mediaType: 'video' | 'audio' | 'image'
  container: string
  byteSize: string
  sha256: string
  status: string
  rightsStatus?: string
  probe?: { width: number; height: number; duration: number; fps: number }
  createdAt: string
}

export interface ProjectReviewAvailability {
  schemaVersion: 'project-review-availability/v1'
  requestedVersionId: string | null
  annotations: Readonly<
    | { state: 'unavailable'; reason: 'no-version' | 'no-proxy' }
    | { state: 'available'; sourceVersionId: string | null; proxyArtifactId: string; proxyHash: string; stale: boolean }
  >
  proxyReview: Readonly<
    | { state: 'unavailable'; reason: 'no-version' | 'no-report' }
    | { state: 'available'; sourceVersionId: string; reviewId: string; proxyArtifactId: string; reviewHash: string }
  >
}

/** Whether one purpose may consume an output of the head Version, with the published reason when it may not. */
export type ProjectWorkspaceOutputPurposeVerdict = Readonly<{ status: 'allowed' } | { status: 'blocked'; reason: string }>

/**
 * One output of the head Version's State: the stable variant every variant-specific request names, its aspect ratio, and what each
 * consumer purpose (render, critic, final) would answer for it. This describes; it admits nothing (the consumer still decides).
 */
export interface ProjectWorkspaceOutput {
  variantId: string
  /** The aspect ratio the output's sealed spec carries; absent when the spec carries none. */
  aspectRatio?: string
  consumption: Readonly<{
    render: ProjectWorkspaceOutputPurposeVerdict
    critic: ProjectWorkspaceOutputPurposeVerdict
    final: ProjectWorkspaceOutputPurposeVerdict
  }>
}

export interface ProjectWorkspaceRecord {
  reviewAvailability: Readonly<ProjectReviewAvailability>
  operations: readonly Readonly<PublicOperation>[]
  project: {
    id: string; workspaceId: string; name: string; status: ProjectStatus; objective?: string;
    /** The aspect ratio of the head Version's only output; absent when the head has none or several (see `outputs`). */
    format?: string; locale?: string; currentVersionId?: string; createdAt: string
  }
  /** Every output of the head Version's State, in State order (empty while the project has none). */
  outputs: readonly Readonly<ProjectWorkspaceOutput>[]
  version?: { id: string; sequence: number; baseHash: string; createdAt: string }
  brief?: unknown
  editPlan?: {
    id: string; state: string; fps: number; durationFrames: number; clipCount: number;
    cutCount: number; automaticZoom: boolean; subtitleFaceProtection: boolean
  }
  commands: readonly {
    id: string; type: string; baseVersionId: string; resultVersionId?: string; reason?: string; createdAt: string
  }[]
  directorRuns: readonly {
    id: string; status: string; plannerVersion: string; criticVersion: string;
    baseVersionId: string; resultVersionId: string; treatmentSnapshotId: string;
    storySnapshotId: string; qualitySnapshotId: string; qualityStatus: string;
    qualityScore: number; decisionCount: number; assumptionCount: number;
    uncertainties: readonly {
      id: string; label: string; type: string; band: 'review' | 'block'; value: number;
      reasonCodes: readonly string[]; calibrationVersion: string; evidenceCount: number
    }[];
    subtitleCueCount: number; transitionCount: number; automaticZoom: boolean;
    createdAt: string
  }[]
  media: readonly ProjectWorkspaceMediaRecord[]
  transcripts: readonly {
    id: string; sourceArtifactId: string; language: string; provider: string; model: string;
    transcriptHash: string; text: string; wordCount: number; segmentCount: number; createdAt: string
  }[]
  operationIds: readonly string[]
}

export interface ProjectWorkspaceQueryRepository {
  read(input: { workspaceId: string; projectId: string }): Promise<Readonly<ProjectWorkspaceRecord> | null>
}
import type { ProjectStatus } from '../../domain/project.ts'
import type { PublicOperation } from '../../domain/public-operation.ts'
