import type { CommandArtifactInvalidationV1, CommandImpactOutputReference } from '../../domain/command-impact.ts'
import type { EditCommand } from '../../domain/edit-command.ts'
import type { EditorialRequestRevisionImpactV1 } from '../../domain/editorial-request-revision-impact.ts'
import type { OperationalOutputParentV3, OperationalOutputVersionBundleV3 } from '../../domain/output-version-bundle.ts'
import type { ProjectSnapshot } from '../../domain/project-snapshot.ts'
import type { ProjectVersionV2, ProjectVersionV3 } from '../../domain/project-version.ts'
import type { PublicEvent } from '../../domain/public-event.ts'

/** What the Command records of itself; the request itself lives in the Brief Snapshot the Version is born with. */
export interface EditorialRequestRevisionPayloadV1 {
  schemaVersion: 1
  /** What each part of the request did: kept as it was, replaced by the body, or (the briefing) cleared. */
  change: Readonly<{
    briefing: 'kept' | 'replaced' | 'cleared'
    directives: 'kept' | 'replaced'
    variantOverrides: 'kept' | 'replaced'
    desiredAction: 'kept' | 'replaced'
    /** `set`: the revision named the objective of the project (it had none, or no Director run had judged against it yet). Absent in a revision made before the objective could be set. */
    objective?: 'kept' | 'set'
    answeredQuestionIds: readonly string[]
  }>
  /** True when the model read the briefing for this Command; false when the interpretation was kept (or there is no briefing). */
  interpreted: boolean
  /** The objective the request of this revision is stated under (null: none). Absent in a revision made before the objective could be set. */
  objective?: string | null
  previousRequestHash: string
  requestHash: string
  interpretationHash: string | null
  briefSnapshotId: string
  briefSnapshotHash: string
  impact: Readonly<EditorialRequestRevisionImpactV1>
  nextRequiredCapability: 'apollo.projects.commands.apply:run-director'
}

export interface EditorialRequestContext {
  /** The sealed output bundle of the current head: the exact parent the Command's Version is born from. */
  parent: OperationalOutputParentV3
  /** The objective is absent when the project was created with none (ADR-160). */
  project: Readonly<{ objective?: string; /** True once a Director run exists for the project: the objective then changes through the Director's own flow. */ directorStarted: boolean }>
  currentBriefSnapshot: Readonly<{ id: string; contentSchemaVersion: number; contentHash: string; content: Readonly<Record<string, unknown>> }>
  currentDurationFrames: number
  /** The renders of the head Version, each attributed to its own output. */
  outputReferences: readonly Readonly<CommandImpactOutputReference>[]
}

export interface EditorialRequestRevisionResult {
  command: Readonly<EditCommand<EditorialRequestRevisionPayloadV1>>
  version: Readonly<ProjectVersionV3>
  briefSnapshot: Readonly<ProjectSnapshot>
  impact: Readonly<EditorialRequestRevisionImpactV1>
  invalidations: readonly Readonly<CommandArtifactInvalidationV1>[]
  replayed: boolean
}

export interface CurrentEditorialRequest {
  version: Readonly<ProjectVersionV2 | ProjectVersionV3>
  briefSnapshot: Readonly<{ id: string; contentSchemaVersion: number; contentHash: string; content: Readonly<Record<string, unknown>> }>
  objective?: string
}

export interface EditorialRequestRevisionCommit {
  /** Version, State, the unchanged EditPlan, the new Brief Snapshot, Command and credential audit, sealed together. */
  bundle: Readonly<OperationalOutputVersionBundleV3>
  event: Readonly<PublicEvent>
}

export interface EditorialRequestRepository {
  findIdempotent(input: { workspaceId: string; projectId: string; idempotencyKey: string; actorContextHash: string }): Promise<Readonly<{ requestFingerprint: string; result: Readonly<EditorialRequestRevisionResult> }> | null>
  readContext(input: { workspaceId: string; projectId: string }): Promise<Readonly<EditorialRequestContext> | null>
  readCurrent(input: { workspaceId: string; projectId: string }): Promise<Readonly<CurrentEditorialRequest> | null>
  commitOrReplay(input: Readonly<EditorialRequestRevisionCommit>): Promise<Readonly<EditorialRequestRevisionResult>>
}
