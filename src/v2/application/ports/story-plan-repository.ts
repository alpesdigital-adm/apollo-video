import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { PersistableStoryPlan } from '../../domain/story-plan.ts'

export interface StoredStoryPlan {
  plan: Readonly<PersistableStoryPlan>
  requestFingerprint: string
  idempotencyKey: string
}
export interface StoryPlanRepository {
  findIdempotent(input: { workspaceId: string; projectId: string; createdByClientId: string; actorContextHash: string; idempotencyKey: string }): Promise<Readonly<StoredStoryPlan> | null>
  persist(value: Readonly<StoredStoryPlan>, audit: Readonly<ApiAccessAuditContext>): Promise<Readonly<{ value: Readonly<StoredStoryPlan>; replayed: boolean }>>
  read(input: { workspaceId: string; projectId: string; storyPlanId: string }): Promise<Readonly<StoredStoryPlan> | null>
}
