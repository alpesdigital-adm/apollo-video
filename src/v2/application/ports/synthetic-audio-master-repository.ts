import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { SyntheticAudioMaster } from '../../domain/synthetic-audio-master.ts'

export interface PersistedSyntheticAudioMaster {
  master: Readonly<SyntheticAudioMaster>
  requestFingerprint: string
  idempotencyKey: string
}

export interface SyntheticAudioMasterRepository {
  findReplay(input: {
    workspaceId: string
    projectId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<PersistedSyntheticAudioMaster> | null>
  create(input: {
    master: Readonly<SyntheticAudioMaster>
    requestFingerprint: string
    idempotencyKey: string
    authenticationAudit: Readonly<ApiAccessAuditContext>
  }): Promise<Readonly<{ value: Readonly<PersistedSyntheticAudioMaster>; replayed: boolean }>>
  read(input: {
    workspaceId: string
    projectId: string
    audioMasterId: string
  }): Promise<Readonly<PersistedSyntheticAudioMaster> | null>
}
