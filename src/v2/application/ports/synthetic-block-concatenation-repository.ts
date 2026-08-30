import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { AudioConcatenationManifestEntry } from '../../domain/synthetic-block-concatenation.ts'

export interface PersistedSyntheticBlockConcatenation {
  id: string
  workspaceId: string
  projectId: string
  planId: string
  planVersionId: string
  container: 'mp3' | 'wav'
  codec: string
  sampleRate: number
  channels: number
  gapMs: number
  durationMs: number
  settings: Readonly<{ gapMs: number; outputFormat: 'mp3' | 'wav' }>
  entries: readonly Readonly<AudioConcatenationManifestEntry>[]
  concatHash: string
  audioArtifactId: string
  alignmentArtifactId: string
  finalAudioSha256: string
  audioMasterId: string | null
  requestFingerprint: string
  idempotencyKey: string
  createdAt: string
}

export interface SyntheticBlockConcatenationRepository {
  findReplay(input: {
    workspaceId: string
    planId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<PersistedSyntheticBlockConcatenation> | null>
  create(input: {
    concatenation: Readonly<Omit<PersistedSyntheticBlockConcatenation, 'requestFingerprint' | 'idempotencyKey'>>
    requestFingerprint: string
    idempotencyKey: string
    authenticationAudit: Readonly<ApiAccessAuditContext>
  }): Promise<Readonly<{ concatenation: Readonly<PersistedSyntheticBlockConcatenation>; replayed: boolean }>>
  read(input: {
    workspaceId: string
    planId: string
    concatenationId: string
  }): Promise<Readonly<PersistedSyntheticBlockConcatenation> | null>
}
