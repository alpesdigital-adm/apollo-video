import type { ProjectCreationOutputCommandV2 } from '../../domain/project-creation-command.ts'
import type { CreationOutputVersionBundleV2 } from '../../domain/output-version-bundle.ts'
import type { ProjectForkDerivationBodyV2, ProjectForkDerivationBodyV3, ProjectForkCallerRequestV3, ForkMediaReferenceFactsV2 } from '../../domain/project-fork-derivation.ts'
import type { OutputVersionBundle } from '../../domain/output-version-bundle.ts'
import type { ProjectSnapshot } from '../../domain/project-snapshot.ts'
import type { V2RenderablePlanSnapshotFacts } from '../../domain/project-creation-command.ts'

export interface CreationSourceFactsV2 {
  project: ProjectForkDerivationBodyV2['sourceProject']
  bundle: Readonly<OutputVersionBundle>
  editPlanSnapshot: Readonly<ProjectSnapshot>
  renderablePlanSnapshot: Readonly<V2RenderablePlanSnapshotFacts> | null
  references: readonly Readonly<ForkMediaReferenceFactsV2>[]
}
export interface CreationSourceFactsV3 {
  schemaVersion: 'project-creation-source-facts/v3'
  project: ProjectForkDerivationBodyV3['sourceProject']
  bundle: OperationalOutputParentV3
  snapshots: readonly Readonly<ProjectSnapshot>[]
  editPlanSnapshot: Readonly<ProjectSnapshot>
  renderablePlanSnapshot: Readonly<V2RenderablePlanSnapshotFacts> | null
  references: readonly Readonly<ForkMediaReferenceFactsV2>[]
}
export interface CreationOutputBundleWriteV2 {
  proposal: Readonly<ProjectCreationOutputCommandV2>
  idempotencyKey: string
  idempotencyRecordId: string
  eventIds: readonly [string, string]
  /** Fork HTTP intent is replayed independently of mutable source metadata.
   * The Creation Command retains its separate complete factual fingerprint. */
  forkCallerRequest?: Readonly<ProjectForkCallerRequestV3>
  expiresAt?: string
  /** Pure reference/seal reconstruction only. IDs, actor, intent, request
   * fingerprint and timestamp stay fixed. No compiler/provider/clock here. */
  recompose: (facts: Readonly<CreationSourceFactsV2 | CreationSourceFactsV3> | null) => Readonly<ProjectCreationOutputCommandV2>
}
export interface CreationOutputBundleRepositoryV2 {
  persist(input: CreationOutputBundleWriteV2): Promise<Readonly<{ bundle: CreationOutputVersionBundleV2; replayed: boolean }>>
  /**
   * Whether a creation with this idempotency key already completed for this client. A replay never calls a model: the answer is the first one,
   * so the caller asks before it spends a reading. Optional: a repository that cannot say simply lets the persist step decide.
   */
  hasCompletedCreation?(input: Readonly<{ workspaceId: string; clientId: string; idempotencyKey: string }>): Promise<boolean>
  read(input: Readonly<{ workspaceId: string; projectId: string; versionId: string }>): Promise<Readonly<CreationOutputVersionBundleV2> | null>
}


import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { BuildOperationalOutputVersionBundleV3, OperationalOutputVersionBundleV3, OperationalOutputParentV3 } from '../../domain/output-version-bundle.ts'
import type { SealedOutputNormalizationV3 } from '../../domain/output-materialization.ts'
export interface OperationalOutputBundleWriteV3 {
  proposal:Readonly<BuildOperationalOutputVersionBundleV3>
  audit:Readonly<ApiAccessAuditContext>
  /** Fixed allocation outside every retry; constructors validate UUID v4. */
  versionEventId:string
  operationEventId:string|null
  ingestFacts:Readonly<PreparedOperationalIngestV3>|null
  /** Pure recomposition only: no allocations, provider, compiler or clock. */
  recompose:(facts:Readonly<{parent:OperationalOutputParentV3;restoreTarget:OperationalOutputParentV3|null;
    normalizations:readonly SealedOutputNormalizationV3[]}>)=>Readonly<BuildOperationalOutputVersionBundleV3>
}
export interface OperationalOutputBundleRepositoryV3 {
  persistChild(input:OperationalOutputBundleWriteV3):Promise<Readonly<{bundle:OperationalOutputVersionBundleV3;replayed:boolean}>>
  read(input:Readonly<{workspaceId:string;projectId:string;versionId:string}>):Promise<Readonly<OperationalOutputParentV3>|null>
}

/** Facts prepared once by the ingest producer, allocations never renewed in TX retries. */
export interface PreparedOperationalIngestV3 {
  uploadId:string
  originalFileName:string
  sourceLinkId:string
  derivativeLinkId:string
  sourceColorProbe:Readonly<import('../../domain/color-and-export.ts').MediaColorProbe>
  derivativeColorProbe:Readonly<import('../../domain/color-and-export.ts').MediaColorProbe>
  normalization:Readonly<SealedOutputNormalizationV3>
  transcript:Readonly<Extract<import('../../domain/output-version-origin.ts').OperationalOutputOriginV3,{kind:'ingest-operation'}>['transcript']>
}
