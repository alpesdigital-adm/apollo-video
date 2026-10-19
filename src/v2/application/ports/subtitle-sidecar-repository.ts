import type { OutputConsumptionSealV3 } from '../../domain/output-consumption.ts'
import type { RenderElementMap } from '../../domain/review-system.ts'
import type { SubtitleSidecarFormat } from '../../domain/subtitle-sidecar.ts'

/** One admission of the Version's output by the persisted consumption reader: the seal and its hash. */
export type SidecarOutputConsumptionSeal = Readonly<{ seal: Readonly<OutputConsumptionSealV3>; sealHash: string }>

/**
 * Everything the sidecar pipeline is allowed to read, assembled from the
 * persisted render: the rendered artifact identity, the RenderInput hash that
 * produced it, the immutable EditPlan snapshot of the same ProjectVersion, and
 * the RenderElementMap that the renderer emitted for that exact artifact.
 *
 * `cueTexts` comes from the EditPlan snapshot referenced by the render operation
 * — never from the project head and never from a transcript. The application
 * service still cross-checks it cue by cue against the map.
 */
export interface RenderedSubtitleAlignmentSource {
  projectId: string
  projectVersionId: string
  projectVersionSequence: number
  isCurrentVersion: boolean
  variantId: string
  outputKind: 'proxy' | 'final'
  outputArtifactId: string
  outputManifestId: string
  outputArtifactKey: string
  outputSha256: string
  renderInputHash: string
  editPlanSnapshotId: string
  editPlanHash: string
  renderElementMapId: string
  renderElementMapHash: string
  map: Readonly<RenderElementMap>
  cueTexts: Readonly<Record<string, string>>
  /**
   * The exact Version, State, variant revision and materialization the alignment was admitted from: always the `render`
   * admission, and the `final` one too when the evidence is a final export. `variantId` above is that entry's stable State variant.
   */
  outputConsumption?: Readonly<{ render: SidecarOutputConsumptionSeal; final?: SidecarOutputConsumptionSeal }>
  /**
   * Verdict of the review that judged this exact render (the proxy review of the operation, or the one a
   * final export was approved from). `null` means no verdict exists. A blocked or unjudged render is not a
   * deliverable, so no sidecar is published for it.
   */
  review: Readonly<{ status: 'blocked' | 'warning-ack-required' | 'ready-for-final'; finalAllowed: boolean; reviewHash: string }> | null
}

export interface PersistedSubtitleSidecar {
  id: string
  workspaceId: string
  projectId: string
  projectVersionId: string
  variantId: string
  outputKind: 'proxy' | 'final'
  outputArtifactId: string
  outputManifestId: string
  outputSha256: string
  format: SubtitleSidecarFormat
  locale: string
  artifactId: string
  manifestId: string
  artifactKey: string
  sha256: string
  byteSize: number
  encoding: string
  cueCount: number
  lineageHash: string
  renderElementMapHash: string
  renderInputHash: string
  editPlanSnapshotId: string
  createdAt: string
}

export interface SubtitleSidecarRepository {
  /**
   * Resolves the exact rendered alignment for one output. `variantId` is the stable variant of the State of the selected Version
   * (an unknown one is refused `output-variant-unknown`, two outputs of one aspect ratio `output-variant-ambiguous`); the render
   * evidence is the proxy or final export made for THAT output, never the Version's other outputs'. `projectVersionId` omitted
   * means the current version; an explicit historical version is honored and reported through `isCurrentVersion`.
   */
  readRenderedAlignment(input: {
    workspaceId: string
    projectId: string
    variantId: string
    projectVersionId?: string
  }): Promise<Readonly<RenderedSubtitleAlignmentSource> | null>
  findIdempotent(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
  }): Promise<Readonly<{ requestFingerprint: string; record: PersistedSubtitleSidecar }> | null>
  persistOrReplay(input: {
    record: PersistedSubtitleSidecar
    idempotencyKey: string
    requestFingerprint: string
  }): Promise<Readonly<{ record: PersistedSubtitleSidecar; replayed: boolean }>>
  list(input: {
    workspaceId: string
    projectId: string
    projectVersionId?: string
    variantId?: string
    format?: SubtitleSidecarFormat
    limit: number
  }): Promise<readonly Readonly<PersistedSubtitleSidecar>[]>
}
