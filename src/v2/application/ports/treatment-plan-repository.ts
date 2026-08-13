import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { ProductionMode, TreatmentPlan } from '../../domain/treatment-plan.ts'
import type { StrategicObjectiveId } from '../../domain/strategic-objective.ts'

export interface TreatmentPlanContext {
  workspaceId: string
  projectId: string
  projectVersionId: string
  objective: StrategicObjectiveId
  policySnapshot: { id: string; schemaVersion: number; contentHash: string }
}

export interface PersistedTreatmentPlan {
  id: string
  workspaceId: string
  projectId: string
  projectVersionId: string
  plan: Readonly<TreatmentPlan>
  treatmentHash: string
  requestFingerprint: string
  idempotencyKey: string
  createdByClientId: string
  createdAt: string
}

export interface TreatmentPlanRepository {
  loadContext(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    policySnapshotId: string
  }): Promise<Readonly<TreatmentPlanContext> | null>
  findIdempotent(input: {
    workspaceId: string
    projectId: string
    createdByClientId: string
    idempotencyKey: string
    actorContextHash: string
  }): Promise<Readonly<PersistedTreatmentPlan> | null>
  persist(value: Readonly<PersistedTreatmentPlan>, authenticationAudit: Readonly<ApiAccessAuditContext>): Promise<Readonly<{ value: Readonly<PersistedTreatmentPlan>; replayed: boolean }>>
  read(input: { workspaceId: string; projectId: string; treatmentPlanId: string }): Promise<Readonly<PersistedTreatmentPlan> | null>
}

export interface CreateTreatmentPlanInput {
  workspaceId: string
  projectId: string
  projectVersionId: string
  policySnapshotId: string
  objective: StrategicObjectiveId
  mode: Exclude<ProductionMode, 'media-only'>
  perceptionSummary: {
    id: string
    schemaVersion: number
    summaryHash: string
    confidence: number
    speakerCoverage: number
    visualVariety: number
    evidenceItemCount: number
    durationMs: number
  }
  actor: unknown
  idempotencyKey: string
}
