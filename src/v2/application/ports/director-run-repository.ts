import type { AdoptableObservationReader } from './adoptable-observation-reader.ts'
import type { EditorialCutEditPlan } from '../apply-editorial-cut-command.ts'
import type { DirectorRun, RunDirectorCommandPayload } from '../../domain/director-run.ts'
import type { EditCommand } from '../../domain/edit-command.ts'
import type { OperationalOutputParentV3, OperationalOutputVersionBundleV3 } from '../../domain/output-version-bundle.ts'
import type { ProjectSnapshot } from '../../domain/project-snapshot.ts'
import type { ProjectVersionV2, ProjectVersionV3 } from '../../domain/project-version.ts'
import type { PublicEvent } from '../../domain/public-event.ts'
import type { CommandArtifactInvalidationV1, CommandImpactOutputReference } from '../../domain/command-impact.ts'
import type { DirectorRunImpactV1 } from '../../domain/director-run-impact.ts'
import type {
  PreviousDirectorObjectiveBinding,
  StrategicObjectiveId,
} from '../../domain/strategic-objective.ts'
import type { DirectorDecisionLog } from '../../domain/director-decision.ts'
import type { PerceptionProducerEnvelope } from '../../domain/perception-producer-envelope.ts'

export interface DirectorRunContext {
  workspaceId: string
  project: Readonly<{
    id: string
    objective: StrategicObjectiveId
    format: string
    locale: string
  }>
  latestDirectorObjective?: Readonly<PreviousDirectorObjectiveBinding>
  /** The sealed output bundle of the current head: the exact parent the Director's Version is born from. */
  parent: OperationalOutputParentV3
  currentVersion: Readonly<ProjectVersionV2 | ProjectVersionV3>
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
    /**
     * The observed transcript's words, in transcript order. With them the Director names, for every caption cue it generates,
     * the transcript words the cue is made of (`sourceWordIndices`); without them its cues carry no such authority.
     */
    words?: readonly Readonly<{ word: string; start: number; end: number }>[]
  }>
  /** Absent means no server-produced OCR envelope exists for this input version. */
  ocrEnvelope?: Readonly<PerceptionProducerEnvelope>
}

export interface DirectorRunCommit {
  /** Version, State, EditPlan, replaced brief/treatment/story, Command and credential audit, sealed together. */
  bundle: Readonly<OperationalOutputVersionBundleV3>
  /** Every canonical snapshot the Director resolved, including the perception and quality report the Version does not reference. */
  snapshots: readonly Readonly<ProjectSnapshot>[]
  run: Readonly<DirectorRun>
  decisionLog: Readonly<DirectorDecisionLog>
  event: Readonly<PublicEvent>
  sourceEvidence: Readonly<{
    transcriptId: string
    transcriptHash: string
    sourceArtifactId: string
    ocrEnvelope?: Readonly<{
      id: string
      envelopeHash: string
      inputVersionId: string
      sourceArtifactId: string
      timeMapHash: string
    }>
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
  version: Readonly<ProjectVersionV3>
  impact: Readonly<DirectorRunImpactV1>
  invalidations: readonly Readonly<CommandArtifactInvalidationV1>[]
  replayed: boolean
}

export interface DirectorSnapshotCommitScope {
  workspaceId: string
  projectId: string
  baseVersionId: string
  baseHash: string
  resultVersionId: string
  idempotencyKey: string
  requestFingerprint: string
  actorContextHash: string
  operationFence?: DirectorRunCommit['operationFence']
}
export type ResolveDirectorSnapshots = (candidates: readonly Readonly<ProjectSnapshot>[]) =>
  Promise<readonly Readonly<ProjectSnapshot>[]>

export interface DirectorRunRepository extends Partial<AdoptableObservationReader> {
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
  /** Owner transaction may retry this pure reference/seal callback only. */
  commitWithCanonicalSnapshots(
    scope: Readonly<DirectorSnapshotCommitScope>,
    prepare: (resolve: ResolveDirectorSnapshots) => Promise<Readonly<DirectorRunCommit>>,
  ): Promise<Readonly<DirectorRunResult>>
}
