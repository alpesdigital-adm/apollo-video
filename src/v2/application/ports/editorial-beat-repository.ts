import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { MediaTranscript } from '../../domain/media-transcript.ts'
import type { AlignedBeatWord, BeatSignal, EditorialBeat } from '../../domain/editorial-beat.ts'

export interface EditorialBeatSourceContext {
  workspaceId: string
  projectId: string
  projectVersionId: string
  transcriptId: string
  transcript: Readonly<MediaTranscript>
}
export interface EditorialBeatSet {
  schemaVersion: 'editorial-beat-set/v1'
  id: string
  workspaceId: string
  projectId: string
  projectVersionId: string
  transcriptId: string
  transcriptHash: string
  derivationVersion: 'editorial-beat-derivation/v1'
  pauseBoundaryMs: number
  maxDurationMs: number
  words: readonly Readonly<AlignedBeatWord>[]
  wordsHash: string
  signals: readonly Readonly<BeatSignal>[]
  signalsHash: string
  beats: readonly Readonly<EditorialBeat>[]
  beatsHash: string
  idempotencyKey: string
  requestFingerprint: string
  actor: Readonly<ApiAccessAuditContext>
  createdAt: string
  recordHash: string
}
export interface EditorialBeatAdjustment {
  schemaVersion: 'editorial-beat-adjustment-record/v1'
  id: string
  workspaceId: string
  projectId: string
  beatSetId: string
  sourceBeatId: string
  directorRunId: string
  reason: string
  startWordId: string
  endWordId: string
  sourceBeatHash: string
  adjustedBeat: Readonly<EditorialBeat>
  wordAlignmentHash: string
  wordAlignmentUnchanged: true
  adjustmentHash: string
  idempotencyKey: string
  requestFingerprint: string
  actor: Readonly<ApiAccessAuditContext>
  createdAt: string
  recordHash: string
}
export interface EditorialBeatRepository {
  readSource(input: { workspaceId: string; projectId: string; projectVersionId: string; transcriptId: string }): Promise<EditorialBeatSourceContext | null>
  findSetByIdempotency(input: { workspaceId: string; projectId: string; idempotencyKey: string; actorClientId: string; actorContextHash: string }): Promise<EditorialBeatSet | null>
  persistSet(set: EditorialBeatSet): Promise<Readonly<{ set: EditorialBeatSet; replayed: boolean }>>
  findSet(input: { workspaceId: string; projectId: string; beatSetId: string }): Promise<EditorialBeatSet | null>
  assertDirectorRun(input: { workspaceId: string; projectId: string; projectVersionId: string; directorRunId: string }): Promise<boolean>
  findAdjustmentByIdempotency(input: { workspaceId: string; beatSetId: string; idempotencyKey: string; actorClientId: string; actorContextHash: string }): Promise<EditorialBeatAdjustment | null>
  persistAdjustment(adjustment: EditorialBeatAdjustment): Promise<Readonly<{ adjustment: EditorialBeatAdjustment; replayed: boolean }>>
}
