import type {
  SourceDeconstructionReport,
  SourceDeconstructionSpeechEvidence,
} from '../../domain/source-deconstruction.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'

export interface SourceDeconstructionSourceContext {
  sourceArtifactId: string
  sourceArtifactSha256: string
  sourceTranscriptId: string
  sourceTranscriptHash: string
  sourceDurationMs: number
  speechEvidence:
    readonly Readonly<SourceDeconstructionSpeechEvidence>[]
}

export interface SourceDeconstructionCreateRecord {
  report: Readonly<SourceDeconstructionReport>
  requestFingerprint: string
  idempotencyKey: string
  authenticationAudit: Readonly<ApiAccessAuditContext>
}

export interface SourceDeconstructionReplay {
  report: Readonly<SourceDeconstructionReport>
  requestFingerprint: string
}

export interface SourceDeconstructionPage {
  reports: readonly Readonly<SourceDeconstructionReport>[]
  nextCursor?: string
}

export interface SourceDeconstructionRepository {
  loadSourceContext(input: {
    workspaceId: string
    projectId: string
    sourceArtifactId: string
    sourceTranscriptId: string
    actorClientId: string
  }): Promise<Readonly<SourceDeconstructionSourceContext> | null>
  findCreateReplay(input: {
    workspaceId: string
    projectId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<SourceDeconstructionReplay> | null>
  create(
    record: Readonly<SourceDeconstructionCreateRecord>,
  ): Promise<Readonly<{
    report: Readonly<SourceDeconstructionReport>
    replayed: boolean
  }>>
  read(input: {
    workspaceId: string
    projectId: string
    reportId: string
  }): Promise<Readonly<SourceDeconstructionReport> | null>
  list(input: {
    workspaceId: string
    projectId: string
    sourceArtifactId?: string
    limit: number
    cursor?: string
  }): Promise<Readonly<SourceDeconstructionPage>>
}
