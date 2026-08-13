import type { NarrativeSafetyContext } from '../../domain/narrative-safety.ts'
import type { StoryPlan } from '../../domain/story-plan.ts'

export interface LoadedNarrativeSafetyContext {
  projectVersionId: string
  projectVersionBaseHash: string
  storyPlanId: string
  storySnapshotHash: string
  storyPlan: Readonly<StoryPlan>
  context: Readonly<NarrativeSafetyContext>
}
export interface NarrativeSafetyRepository {
  load(input: { workspaceId: string; projectId: string; projectVersionId: string; storyPlanId: string }): Promise<Readonly<LoadedNarrativeSafetyContext> | null>
}
