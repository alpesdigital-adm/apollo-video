import { materializeActorAuditContext, requireScope, type AuthenticatedExternalActor } from './authenticate-api-client.ts'
import type { StoryPlanRepository } from './ports/story-plan-repository.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { DomainError } from '../domain/errors.ts'
import { createStoryPlan, type StoryPlan } from '../domain/story-plan.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const IDEMPOTENCY = /^[\x21-\x7e]{8,128}$/
function id(value: unknown, field: string) { const normalized = typeof value === 'string' ? value.trim() : ''; if (!ID.test(normalized)) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`); return normalized }

export function createStoryPlanService(dependencies: { repository: StoryPlanRepository; createId: () => string; clock?: () => Date }) {
  const clock = dependencies.clock ?? (() => new Date())
  return async (request: Readonly<{ workspaceId: string; projectId: string; projectVersionId: string; plan: Omit<StoryPlan, 'schemaVersion'>; actor: Readonly<AuthenticatedExternalActor>; idempotencyKey: string }>) => {
    requireScope(request.actor, 'projects:write')
    const workspaceId = id(request.workspaceId, 'workspaceId'); const projectId = id(request.projectId, 'projectId'); const projectVersionId = id(request.projectVersionId, 'projectVersionId')
    const audit = materializeActorAuditContext(request.actor)
    if (audit.workspaceId !== workspaceId) throw new DomainError('AUTH_INVALID', 'StoryPlan actor does not belong to workspace')
    const createdByClientId = id(audit.clientId, 'actor.id')
    if (!IDEMPOTENCY.test(request.idempotencyKey)) throw new DomainError('INVALID_ARGUMENT', 'Idempotency-Key is invalid')
    const requestFingerprint = calculateCanonicalHash({ schemaVersion: 'create-story-plan-request/v1', workspaceId, projectId, projectVersionId, plan: request.plan, createdByClientId, actorContextHash: audit.contextHash })
    const replay = await dependencies.repository.findIdempotent({ workspaceId, projectId, createdByClientId, actorContextHash: audit.contextHash, idempotencyKey: request.idempotencyKey })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with another StoryPlan request')
      return Object.freeze({ value: replay, replayed: true })
    }
    const plan = createStoryPlan({ ...request.plan, id: id(dependencies.createId(), 'storyPlanId'), workspaceId, projectId, projectVersionId, createdBy: { type: 'api-client', id: createdByClientId }, createdAt: clock().toISOString() })
    return dependencies.repository.persist({ plan, requestFingerprint, idempotencyKey: request.idempotencyKey }, audit)
  }
}

export function readStoryPlanService(dependencies: { repository: StoryPlanRepository }) {
  return async (input: { workspaceId: string; projectId: string; storyPlanId: string }) => {
    const value = await dependencies.repository.read({ workspaceId: id(input.workspaceId, 'workspaceId'), projectId: id(input.projectId, 'projectId'), storyPlanId: id(input.storyPlanId, 'storyPlanId') })
    if (!value) throw new DomainError('PROJECT_NOT_FOUND', 'StoryPlan was not found')
    return value
  }
}
