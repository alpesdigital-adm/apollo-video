import type { AuthenticatedExternalActor } from './authenticate-api-client.ts'
import { materializeActorAuditContext, requireScope } from './authenticate-api-client.ts'
import type { CreateTreatmentPlanInput, TreatmentPlanRepository } from './ports/treatment-plan-repository.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { DomainError } from '../domain/errors.ts'
import { resolveStrategicRubric } from '../domain/strategic-rubric.ts'
import { createTreatmentPlan } from '../domain/treatment-plan.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const IDEMPOTENCY = /^[\x21-\x7E]{8,128}$/
const SHA256 = /^[a-f0-9]{64}$/

function identity(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!ID.test(normalized)) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}

export function createTreatmentPlanService(dependencies: {
  repository: TreatmentPlanRepository
  createId: () => string
  clock?: () => Date
}) {
  const clock = dependencies.clock ?? (() => new Date())
  return async function create(request: Omit<CreateTreatmentPlanInput, 'actor'> & { actor: Readonly<AuthenticatedExternalActor> }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const projectVersionId = identity(request.projectVersionId, 'projectVersionId')
    const policySnapshotId = identity(request.policySnapshotId, 'policySnapshotId')
    requireScope(request.actor, 'projects:write')
    const authenticationAudit = materializeActorAuditContext(request.actor)
    if (authenticationAudit.workspaceId !== workspaceId) throw new DomainError('AUTH_INVALID', 'TreatmentPlan actor does not belong to the workspace')
    const createdByClientId = identity(authenticationAudit.clientId, 'actor.id')
    const idempotencyKey = request.idempotencyKey.trim()
    if (!IDEMPOTENCY.test(idempotencyKey)) throw new DomainError('INVALID_ARGUMENT', 'Idempotency-Key is invalid')
    if (!SHA256.test(request.perceptionSummary.summaryHash)) throw new DomainError('INVALID_ARGUMENT', 'Perception summary hash is invalid')
    const context = await dependencies.repository.loadContext({ workspaceId, projectId, projectVersionId, policySnapshotId })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Exact TreatmentPlan project context was not found')
    if (context.objective !== request.objective) throw new DomainError('VERSION_CONFLICT', 'TreatmentPlan objective does not match the immutable project context')
    const rubric = resolveStrategicRubric(request.objective)
    const plan = createTreatmentPlan({
      objective: request.objective,
      mode: request.mode,
      rubric: {
        id: rubric.id,
        version: rubric.version,
        proofRequired: rubric.criteria.some((criterion) => criterion.id === 'proof-strength' && criterion.weight >= .15),
        rubricHash: calculateCanonicalHash(rubric),
      },
      policy: {
        snapshotId: context.policySnapshot.id,
        schemaVersion: context.policySnapshot.schemaVersion,
        snapshotHash: context.policySnapshot.contentHash,
        maxPatternBreaksPer30s: 5,
        forbiddenEffects: ['zoom'],
        maxProofItems: 3,
        maxCtaOccurrences: 1,
        maxDecisions: 12,
      },
      perception: {
        summaryId: request.perceptionSummary.id,
        schemaVersion: request.perceptionSummary.schemaVersion,
        summaryHash: request.perceptionSummary.summaryHash,
        confidence: request.perceptionSummary.confidence,
        speakerCoverage: request.perceptionSummary.speakerCoverage,
        visualVariety: request.perceptionSummary.visualVariety,
        evidenceItemCount: request.perceptionSummary.evidenceItemCount,
        durationMs: request.perceptionSummary.durationMs,
      },
    })
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'create-treatment-plan-request/v1',
      workspaceId,
      projectId,
      projectVersionId,
      objective: request.objective,
      mode: request.mode,
      policySnapshot: context.policySnapshot,
      perceptionSummary: request.perceptionSummary,
      createdByClientId,
      actorContextHash: authenticationAudit.contextHash,
    })
    const replay = await dependencies.repository.findIdempotent({ workspaceId, projectId, createdByClientId, idempotencyKey, actorContextHash: authenticationAudit.contextHash })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with another TreatmentPlan request')
      return Object.freeze({ value: replay, replayed: true })
    }
    const value = Object.freeze({
      id: identity(dependencies.createId(), 'treatmentPlanId'),
      workspaceId,
      projectId,
      projectVersionId,
      plan,
      treatmentHash: calculateCanonicalHash(plan),
      requestFingerprint,
      idempotencyKey,
      createdByClientId,
      createdAt: clock().toISOString(),
    })
    return dependencies.repository.persist(value, authenticationAudit)
  }
}

export function readTreatmentPlanService(dependencies: { repository: TreatmentPlanRepository }) {
  return async function read(input: { workspaceId: string; projectId: string; treatmentPlanId: string }) {
    const normalized = { workspaceId: identity(input.workspaceId, 'workspaceId'), projectId: identity(input.projectId, 'projectId'), treatmentPlanId: identity(input.treatmentPlanId, 'treatmentPlanId') }
    const value = await dependencies.repository.read(normalized)
    if (!value) throw new DomainError('PROJECT_NOT_FOUND', 'TreatmentPlan was not found')
    return value
  }
}
