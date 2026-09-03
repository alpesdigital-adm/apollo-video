import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type {
  SyntheticPhaseGateCriterionEvidenceInput,
} from '../../domain/synthetic-phase-gate.ts'
import type { SyntheticPhaseGateReport } from '../run-synthetic-phase-gate.ts'

export interface SyntheticPhaseGateEvidenceQuery {
  workspaceId: string
  projectId: string
  projectVersionId: string
  projectVersionHash: string
  actorId: string
}

export interface SyntheticPhaseGateEvidenceContext {
  projectVersionId: string
  projectVersionHash: string
  evidence: readonly SyntheticPhaseGateCriterionEvidenceInput[]
}

export interface PersistedSyntheticPhaseGate {
  schemaVersion: 'synthetic-phase-gate/v1'
  id: string
  workspaceId: string
  projectId: string
  projectVersionId: string
  projectVersionHash: string
  report: Readonly<SyntheticPhaseGateReport>
  reportFingerprint: string
  idempotencyKey: string
  requestFingerprint: string
  createdBy: Readonly<{ type: 'api-client'; id: string }>
  createdAt: string
  recordHash: string
}

export interface SyntheticPhaseGateRepository {
  findIdempotent(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
    actorContextHash: string
  }): Promise<Readonly<PersistedSyntheticPhaseGate> | null>
  readEvidence(
    input: Readonly<SyntheticPhaseGateEvidenceQuery>,
  ): Promise<Readonly<SyntheticPhaseGateEvidenceContext> | null>
  persist(
    gate: Readonly<PersistedSyntheticPhaseGate>,
    authenticationAudit: Readonly<ApiAccessAuditContext>,
  ): Promise<Readonly<{
    gate: Readonly<PersistedSyntheticPhaseGate>
    replayed: boolean
  }>>
  list(input: {
    workspaceId: string
    projectId: string
    limit: number
  }): Promise<readonly Readonly<PersistedSyntheticPhaseGate>[]>
}
