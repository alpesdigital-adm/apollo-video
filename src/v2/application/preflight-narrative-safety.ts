import { requireScope, type AuthenticatedExternalActor } from './authenticate-api-client.ts'
import type { NarrativeSafetyRepository } from './ports/narrative-safety-repository.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { DomainError } from '../domain/errors.ts'
import { validateNarrativeEdit, type NarrativeEditItem } from '../domain/narrative-safety.ts'
import { validateStoryPlan } from '../domain/story-plan.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
function id(value: string, field: string) { const normalized = value.trim(); if (!ID.test(normalized)) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`); return normalized }

export function preflightNarrativeSafetyService(dependencies: { repository: NarrativeSafetyRepository }) {
  return async (request: Readonly<{ workspaceId: string; projectId: string; projectVersionId: string; expectedBaseHash: string; storyPlanId: string; edit: readonly NarrativeEditItem[]; actor: Readonly<AuthenticatedExternalActor> }>) => {
    requireScope(request.actor, 'projects:read')
    const workspaceId = id(request.workspaceId, 'workspaceId'); const projectId = id(request.projectId, 'projectId'); const projectVersionId = id(request.projectVersionId, 'projectVersionId'); const storyPlanId = id(request.storyPlanId, 'storyPlanId')
    if (request.actor.workspaceId !== workspaceId) throw new DomainError('AUTH_INVALID', 'Narrative safety actor does not belong to workspace')
    if (!HASH.test(request.expectedBaseHash)) throw new DomainError('INVALID_ARGUMENT', 'expectedBaseHash is invalid')
    if (request.edit.length === 0 || request.edit.length > 500) throw new DomainError('INVALID_ARGUMENT', 'Narrative edit must contain between 1 and 500 items')
    const loaded = await dependencies.repository.load({ workspaceId, projectId, projectVersionId, storyPlanId })
    if (!loaded) throw new DomainError('PROJECT_NOT_FOUND', 'Exact StoryPlan narrative safety context was not found')
    if (loaded.projectVersionBaseHash !== request.expectedBaseHash) throw new DomainError('VERSION_CONFLICT', 'Narrative safety preflight is stale')
    validateStoryPlan(loaded.storyPlan)
    if (loaded.storyPlanId !== storyPlanId || loaded.context.storyPlanId !== storyPlanId) throw new DomainError('PERSISTENCE_CONFLICT', 'Narrative safety context is bound to another StoryPlan')
    const decision = validateNarrativeEdit(loaded.context, request.edit)
    const preflightHash = calculateCanonicalHash({ schemaVersion: 'narrative-safety-preflight/v1', workspaceId, projectId, projectVersionId, projectVersionBaseHash: loaded.projectVersionBaseHash, storyPlanId, storySnapshotHash: loaded.storySnapshotHash, contextHash: decision.contextHash, edit: request.edit, safe: decision.safe, issues: decision.issues })
    return Object.freeze({ ...decision, projectVersionId, projectVersionBaseHash: loaded.projectVersionBaseHash, storyPlanId, storySnapshotHash: loaded.storySnapshotHash, preflightHash })
  }
}
