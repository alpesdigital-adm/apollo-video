import type { EditCommand } from '../../domain/edit-command.ts'
import type { MediaTranscript } from '../../domain/media-transcript.ts'
import type { ProjectSnapshot } from '../../domain/project-snapshot.ts'
import type { ProjectVersion } from '../../domain/project-version.ts'
import type { PublicEvent } from '../../domain/public-event.ts'
import type { CommandArtifactInvalidationV1, CommandImpactOutputReference } from '../../domain/command-impact.ts'
import type { SourceTranscriptReplacementImpactV1 } from '../../domain/source-transcript-replacement.ts'

export interface SourceTranscriptReplacementPayload {
  schemaVersion: 1
  action: 'replace-source-transcript'
  previousTranscriptId: string
  previousTranscriptHash: string
  replacementTranscriptId: string
  replacementTranscriptHash: string
  impact: Readonly<SourceTranscriptReplacementImpactV1>
  nextRequiredCapability: 'apollo.projects.commands.apply:run-director'
}

export interface SourceTranscriptReplacementContext {
  currentVersion: Readonly<ProjectVersion>
  editPlan: Readonly<Record<string, unknown>>
  editPlanHash: string
  currentTranscript: Readonly<{ id: string; transcriptHash: string; sourceArtifactId: string }>
  replacementTranscript: Readonly<{
    id: string
    transcriptHash: string
    sourceArtifactId: string
    transcript: Readonly<MediaTranscript>
  }>
  outputReferences: readonly Readonly<CommandImpactOutputReference>[]
}

export interface SourceTranscriptReplacementResult {
  command: Readonly<EditCommand<SourceTranscriptReplacementPayload>>
  version: Readonly<ProjectVersion>
  editPlan: Readonly<Record<string, unknown>>
  impact: Readonly<SourceTranscriptReplacementImpactV1>
  invalidations: readonly Readonly<CommandArtifactInvalidationV1>[]
  replayed: boolean
}

export interface SourceTranscriptReplacementCommit {
  command: Readonly<EditCommand<SourceTranscriptReplacementPayload>>
  requestFingerprint: string
  snapshot: Readonly<ProjectSnapshot>
  version: Readonly<ProjectVersion>
  event: Readonly<PublicEvent>
  sourceEvidence: Readonly<{
    currentTranscriptId: string
    currentTranscriptHash: string
    replacementTranscriptId: string
    replacementTranscriptHash: string
    sourceArtifactId: string
  }>
}

export interface SourceTranscriptReplacementRepository {
  findIdempotentResult(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
  }): Promise<Readonly<{ requestFingerprint: string; result: SourceTranscriptReplacementResult }> | null>
  readContext(input: {
    workspaceId: string
    projectId: string
    replacementTranscriptId: string
  }): Promise<Readonly<SourceTranscriptReplacementContext> | null>
  commitOrReplay(input: SourceTranscriptReplacementCommit): Promise<Readonly<SourceTranscriptReplacementResult>>
}
