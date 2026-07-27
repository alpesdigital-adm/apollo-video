import type {
  ScriptAlignmentRun,
  ScriptAlignmentReview,
  ScriptBlockRole,
  ScriptTranscriptSource,
} from '../../domain/script-alignment.ts'

export interface ScriptAlignmentCreateRecord {
  run: Readonly<ScriptAlignmentRun>
  requestFingerprint: string
  idempotencyKey: string
}

export interface ScriptAlignmentReviewRecord {
  previousRun: Readonly<ScriptAlignmentRun>
  resultingRun: Readonly<ScriptAlignmentRun>
  review: Readonly<ScriptAlignmentReview>
  requestFingerprint: string
  idempotencyKey: string
}

export interface ScriptAlignmentReplay {
  run: Readonly<ScriptAlignmentRun>
  requestFingerprint: string
}

export interface ScriptAlignmentPage {
  runs: readonly Readonly<ScriptAlignmentRun>[]
  nextCursor?: string
}

export interface ScriptAlignmentRepository {
  loadCreationContext(input: {
    workspaceId: string
    batchId: string
    actorClientId: string
    sources: readonly Readonly<{
      transcriptId: string
      expectedTranscriptHash: string
      roleHint?: ScriptBlockRole
    }>[]
  }): Promise<Readonly<{
    projectId: string
    sources: readonly Readonly<ScriptTranscriptSource>[]
  }>>
  findCreateReplay(input: {
    workspaceId: string
    actorClientId: string
    idempotencyKey: string
  }): Promise<Readonly<ScriptAlignmentReplay> | null>
  create(
    record: Readonly<ScriptAlignmentCreateRecord>,
  ): Promise<Readonly<{
    run: Readonly<ScriptAlignmentRun>
    replayed: boolean
  }>>
  read(input: {
    workspaceId: string
    batchId: string
    runId: string
  }): Promise<Readonly<ScriptAlignmentRun> | null>
  list(input: {
    workspaceId: string
    batchId: string
    limit: number
    cursor?: string
  }): Promise<Readonly<ScriptAlignmentPage>>
  findReviewReplay(input: {
    workspaceId: string
    actorClientId: string
    idempotencyKey: string
  }): Promise<Readonly<ScriptAlignmentReplay> | null>
  persistReview(
    record: Readonly<ScriptAlignmentReviewRecord>,
  ): Promise<Readonly<{
    run: Readonly<ScriptAlignmentRun>
    replayed: boolean
  }>>
}
