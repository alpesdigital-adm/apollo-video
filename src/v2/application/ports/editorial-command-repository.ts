import type { EditCommand } from '../../domain/edit-command.ts'
import type { MediaTranscript } from '../../domain/media-transcript.ts'
import type { ProjectSnapshot } from '../../domain/project-snapshot.ts'
import type { ProjectVersion } from '../../domain/project-version.ts'
import type { PublicEvent } from '../../domain/public-event.ts'
import type { EditorialCutEditPlan, RemoveSpokenContentPayload } from '../apply-editorial-cut-command.ts'
import type { EditorialExclusionRange, SourceTimeRange } from '../recovery-project-acceptance.ts'

export interface EditorialCommandContext {
  projectId: string
  workspaceId: string
  currentVersion: Readonly<ProjectVersion>
  transcriptId: string
  transcript: Readonly<MediaTranscript>
  sourceArtifactId: string
  sourceDurationSeconds: number
  sourceFps: number
}

export interface EditorialCommandResult {
  command: Readonly<EditCommand<RemoveSpokenContentPayload>>
  version: Readonly<ProjectVersion>
  editPlan: Readonly<EditorialCutEditPlan>
  exclusions: readonly Readonly<EditorialExclusionRange>[]
  retainedSourceRanges: readonly Readonly<SourceTimeRange>[]
  replayed: boolean
}

export interface EditorialCommandCommit {
  command: Readonly<EditCommand<RemoveSpokenContentPayload>>
  requestFingerprint: string
  snapshot: Readonly<ProjectSnapshot>
  version: Readonly<ProjectVersion>
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
  }): Promise<Readonly<{ requestFingerprint: string; result: EditorialCommandResult }> | null>
  readContext(input: {
    workspaceId: string
    projectId: string
    transcriptId: string
  }): Promise<Readonly<EditorialCommandContext> | null>
  commitOrReplay(bundle: EditorialCommandCommit): Promise<EditorialCommandResult>
}
