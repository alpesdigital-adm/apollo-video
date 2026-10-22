import type { AdoptableObservationReader } from './adoptable-observation-reader.ts'
import type { EditorialCutEditPlan } from '../apply-editorial-cut-command.ts'
import type { EditorialPhraseRule } from '../editorial-phrase-rules.ts'
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
import type { ServerPerceptionAssemblyInput, ServerPerceptionSnapshot } from '../../domain/server-perception-snapshot.ts'
import type { SourceRightsRecord } from '../../domain/director-evidence-rubric.ts'

export interface DirectorRunContext {
  workspaceId: string
  project: Readonly<{
    id: string
    objective: StrategicObjectiveId
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
  /** Every output of the project: the stable variant ids of the sealed State the Command's child Version carries. */
  variantIds: readonly string[]
  /** The renders of the head Version, each attributed to its own output. */
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
  /**
   * W64. The current rights of EVERY source the head EditPlan plays (the master and each insert), by artifact, as the database holds them
   * at claim. Rights are integral: the Director blocks if any of them is not certain, and a source that is not listed here is unknown.
   * Absent only where there is no store to read (a controlled context), which then states the master's rights through `sourceRights`
   * alone - every other source is unknown.
   */
  timelineSourceRights?: readonly Readonly<{ artifactId: string; rights: SourceRightsRecord }>[]
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
  /**
   * The speech this project asked to have removed: the phrase rules of the `remove-spoken-content` Commands in the lineage of the
   * Version the Director directs (the same rules the cut applied). The Director holds no phrase of its own - what must not be said
   * is what THIS project asked to cut. REQUIRED: an empty list says nothing was asked and nothing is forbidden, and only that; an
   * implementation that does not state it does not implement the port (the Director refuses the context rather than read it as empty).
   */
  requestedSpeechRemovals: readonly Readonly<EditorialPhraseRule>[]
  /** Absent means no server-produced OCR envelope exists for this input version. */
  ocrEnvelope?: Readonly<PerceptionProducerEnvelope>
  /**
   * W63a. Every sealed piece of server evidence of the input Version (OCR, temporal, source-keyed face windows, the EditPlan's own
   * retimed transcript), read through the same reader the public snapshot uses. The Director assembles its perception from it, so the
   * Director and the API see the same bytes. Absent only where there is no store to read (a controlled context): the Director then
   * assembles from what the context itself carries.
   */
  perceptionEvidence?: Readonly<ServerPerceptionAssemblyInput>
}

export interface DirectorRunCommit {
  /** Version, State, EditPlan, replaced brief/treatment/story, Command and credential audit, sealed together. */
  bundle: Readonly<OperationalOutputVersionBundleV3>
  /** Every canonical snapshot the Director resolved, including the perception and quality report the Version does not reference. */
  snapshots: readonly Readonly<ProjectSnapshot>[]
  run: Readonly<DirectorRun>
  decisionLog: Readonly<DirectorDecisionLog>
  event: Readonly<PublicEvent>
  /**
   * W63a. The server perception snapshot the run's perception IS, present only when the evidence it was assembled from was fully bound
   * (EditPlan hash and every source's bytes hash verified). The commit re-reads the evidence, refuses a run whose evidence moved, and
   * writes the snapshot (once, by content) in the same transaction, so the Director and the public snapshot hold the same bytes.
   */
  serverPerception?: Readonly<ServerPerceptionSnapshot>
  sourceEvidence: Readonly<{
    transcriptId: string
    transcriptHash: string
    sourceArtifactId: string
    /**
     * W64. The rights snapshot of every source the plan plays, as the plan was judged on it (`null` ids: the source had none). The commit
     * re-reads them in its own transaction and refuses the run, with `ASSET_RIGHTS_BLOCKED`, if one moved or is no longer certain.
     */
    rights: readonly Readonly<{ artifactId: string; snapshotId: string | null; snapshotHash: string | null }>[]
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
