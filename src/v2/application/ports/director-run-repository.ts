import type { EditorialCutEditPlan } from '../apply-editorial-cut-command.ts'
import type { DirectorRun, RunDirectorCommandPayload } from '../../domain/director-run.ts'
import type { EditCommand } from '../../domain/edit-command.ts'
import type { ProjectSnapshot } from '../../domain/project-snapshot.ts'
import type { ProjectVersion } from '../../domain/project-version.ts'
import type { PublicEvent } from '../../domain/public-event.ts'
import type { CommandArtifactInvalidationV1, CommandImpactOutputReference } from '../../domain/command-impact.ts'
import type { DirectorRunImpactV1 } from '../../domain/director-run-impact.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type {
  PreviousDirectorObjectiveBinding,
  StrategicObjectiveId,
} from '../../domain/strategic-objective.ts'

export interface DirectorRunContext {
  workspaceId: string
  project: Readonly<{
    id: string
    objective: StrategicObjectiveId
    format: string
    locale: string
  }>
  latestDirectorObjective?: Readonly<PreviousDirectorObjectiveBinding>
  currentVersion: Readonly<ProjectVersion>
  brief: Readonly<Record<string, unknown>>
  policies: Readonly<Record<string, unknown>>
  editPlan: Readonly<EditorialCutEditPlan>
  currentDurationFrames: number
  proxyVariantId: string
  outputReferences: readonly Readonly<CommandImpactOutputReference>[]
  sourceRights: Readonly<
    | { state: 'missing' }
    | {
        state: 'present'
        snapshotId: string
        snapshotHash: string
        status: string
        consentStatus: string
        expiresAt?: string
        consentExpiresAt?: string
      }
  >
  transcript: Readonly<{
    id: string
    sourceArtifactId: string
    language: string
    provider: string
    model: string
    transcriptHash: string
  }>
}

export interface DirectorRunCommit {
  command: Readonly<EditCommand<RunDirectorCommandPayload>>
  authenticationAudit: Readonly<ApiAccessAuditContext>
  requestFingerprint: string
  snapshots: readonly Readonly<ProjectSnapshot>[]
  version: Readonly<ProjectVersion>
  run: Readonly<DirectorRun>
  event: Readonly<PublicEvent>
  sourceEvidence: Readonly<{
    transcriptId: string
    transcriptHash: string
    sourceArtifactId: string
  }>
  operationFence?: Readonly<{
    operationId: string
    leaseOwner: string
    attempt: number
    now: string
  }>
}

export interface DirectorRunResult {
  run: Readonly<DirectorRun>
  command: Readonly<EditCommand<RunDirectorCommandPayload>>
  version: Readonly<ProjectVersion>
  impact: Readonly<DirectorRunImpactV1>
  invalidations: readonly Readonly<CommandArtifactInvalidationV1>[]
  replayed: boolean
}

export interface DirectorRunRepository {
  readQualityReport(input: {
    workspaceId: string
    projectId: string
    directorRunId: string
  }): Promise<Readonly<{
    directorRunId: string
    projectId: string
    objective: StrategicObjectiveId
    objectiveVersion: number
    rubricRef: string
    qualitySnapshot: Readonly<{
      id: string
      contentSchemaVersion: number
      contentHash: string
    }>
    report: Readonly<DirectorRun['qualityReport']>
  }> | null>
  findIdempotentResult(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
    actorContextHash: string
  }): Promise<Readonly<{ requestFingerprint: string; result: DirectorRunResult }> | null>
  readContext(input: {
    workspaceId: string
    projectId: string
  }): Promise<Readonly<DirectorRunContext> | null>
  commitOrReplay(input: DirectorRunCommit): Promise<Readonly<DirectorRunResult>>
}
