import type { EditCommand } from '../../domain/edit-command.ts'
import type { MediaTranscript } from '../../domain/media-transcript.ts'
import type { OperationalOutputParentV3, OperationalOutputVersionBundleV3 } from '../../domain/output-version-bundle.ts'
import type { ProjectVersionV3 } from '../../domain/project-version.ts'
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
  /** The sealed output bundle of the current head: the exact parent the Command's Version is born from. */
  parent: OperationalOutputParentV3
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
  version: Readonly<ProjectVersionV3>
  editPlan: Readonly<Record<string, unknown>>
  impact: Readonly<SourceTranscriptReplacementImpactV1>
  invalidations: readonly Readonly<CommandArtifactInvalidationV1>[]
  replayed: boolean
}

export interface SourceTranscriptReplacementCommit {
  /** Version, State, the retimed EditPlan, Command and credential audit, sealed together by the child-command transition. */
  bundle: Readonly<OperationalOutputVersionBundleV3>
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
    actorContextHash: string
  }): Promise<Readonly<{ requestFingerprint: string; result: SourceTranscriptReplacementResult }> | null>
  readContext(input: {
    workspaceId: string
    projectId: string
    replacementTranscriptId: string
  }): Promise<Readonly<SourceTranscriptReplacementContext> | null>
  commitOrReplay(input: SourceTranscriptReplacementCommit): Promise<Readonly<SourceTranscriptReplacementResult>>
}
