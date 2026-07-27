import type {
  MvpCoreCriterionEvidenceInput,
} from '../../domain/mvp-core-gate.ts'
import type { MvpCoreGateReport } from '../run-mvp-core-gate.ts'

export interface MvpCoreGateEvidenceQuery {
  workspaceId: string
  primaryProjectId: string
  primaryVersionId: string
  primaryVersionHash: string
  companionProjectId: string
  companionVersionId: string
  companionVersionHash: string
  duplicateProjectId: string
  actorId: string
}

export interface MvpCoreGateEvidenceContext {
  primaryVersionId: string
  primaryVersionHash: string
  companionVersionId: string
  companionVersionHash: string
  evidence: readonly MvpCoreCriterionEvidenceInput[]
}

export interface PersistedMvpCoreGate {
  schemaVersion: 'mvp-core-gate/v1'
  id: string
  workspaceId: string
  primaryProjectId: string
  companionProjectId: string
  primaryVersionId: string
  companionVersionId: string
  primaryVersionHash: string
  companionVersionHash: string
  report: Readonly<MvpCoreGateReport>
  reportFingerprint: string
  idempotencyKey: string
  requestFingerprint: string
  createdBy: Readonly<{ type: 'api-client'; id: string }>
  createdAt: string
  recordHash: string
}

export interface MvpCoreGateRepository {
  findIdempotent(input: {
    workspaceId: string
    primaryProjectId: string
    idempotencyKey: string
  }): Promise<Readonly<PersistedMvpCoreGate> | null>
  readEvidence(
    input: Readonly<MvpCoreGateEvidenceQuery>,
  ): Promise<Readonly<MvpCoreGateEvidenceContext> | null>
  persist(
    gate: Readonly<PersistedMvpCoreGate>,
  ): Promise<Readonly<{ gate: Readonly<PersistedMvpCoreGate>; replayed: boolean }>>
  list(input: {
    workspaceId: string
    primaryProjectId: string
    limit: number
  }): Promise<readonly Readonly<PersistedMvpCoreGate>[]>
}
