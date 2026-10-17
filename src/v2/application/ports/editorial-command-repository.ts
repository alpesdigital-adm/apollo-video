import type { EditCommand } from '../../domain/edit-command.ts'
import type { MediaTranscript } from '../../domain/media-transcript.ts'
import type { ProjectSnapshot } from '../../domain/project-snapshot.ts'
import type { ProjectVersionV3 } from '../../domain/project-version.ts'
import type { OperationalOutputParentV3, OperationalOutputVersionBundleV3, BuildOperationalOutputVersionBundleV3 } from '../../domain/output-version-bundle.ts'
import type { EditorialSourceBindingBodyV1, SealedOutputNormalizationV3 } from '../../domain/output-materialization.ts'
import type { EditorialCutPayloadV3 } from '../../domain/editorial-cut-impact.ts'
import type { PublicEvent } from '../../domain/public-event.ts'
import type { EditorialMaterializedPlanV3 } from '../../domain/editorial-cut-impact.ts'
import type { SourceTimeRange } from '../recovery-project-acceptance.ts'
import type { CommandArtifactInvalidationV1, CommandImpactOutputReference } from '../../domain/command-impact.ts'
import type { EditorialCutImpactV2 } from '../../domain/editorial-cut-impact.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'

export interface EditorialCommandContext {
  projectId: string
  workspaceId: string
  currentVersion: OperationalOutputParentV3['version']
  parent: OperationalOutputParentV3
  sourceBindingFacts: Omit<EditorialSourceBindingBodyV1,'id'|'parentVersionId'|'parentStateId'|'parentStateHash'|'resultVersionId'|'createdAt'>
  normalizations: readonly SealedOutputNormalizationV3[]
  transcriptId: string
  transcript: Readonly<MediaTranscript>
  sourceArtifactId: string
  sourceDurationSeconds: number
  sourceFps: number
  currentDurationFrames: number
  variantId: string
  outputReferences: readonly Readonly<CommandImpactOutputReference>[]
}

export interface EditorialCommandResult {
  command: Readonly<EditCommand<EditorialCutPayloadV3>>
  version: Readonly<ProjectVersionV3>
  editPlan: Readonly<EditorialMaterializedPlanV3>
  // The persisted Command3 payload is the authority: no labels/matchedText survive the seal.
  exclusions: EditorialCutPayloadV3['exclusions']
  retainedSourceRanges: readonly Readonly<SourceTimeRange>[]
  impact: Readonly<EditorialCutImpactV2>
  invalidations: readonly Readonly<CommandArtifactInvalidationV1>[]
  outputBundle: Readonly<OperationalOutputVersionBundleV3>
  replayed: boolean
}

export interface EditorialCommandCommit {
  proposal: Readonly<BuildOperationalOutputVersionBundleV3>
  command: Readonly<EditCommand<EditorialCutPayloadV3>>
  authenticationAudit: Readonly<ApiAccessAuditContext>
  requestFingerprint: string
  snapshot: Readonly<ProjectSnapshot>
  version: Readonly<ProjectVersionV3>
  event: Readonly<PublicEvent>
  sourceEvidence: Readonly<{
    transcriptId: string
    transcriptHash: string
    sourceArtifactId: string
  }>
}

export interface EditorialCommandRepository {
  findIdempotentResult(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
    actorContextHash: string
  }): Promise<Readonly<{ requestFingerprint: string; result: EditorialCommandResult }> | null>
  readContext(input: {
    workspaceId: string
    projectId: string
    transcriptId: string
    variantId: string
  }): Promise<Readonly<EditorialCommandContext> | null>
  commitOrReplay(bundle: EditorialCommandCommit): Promise<EditorialCommandResult>
}
