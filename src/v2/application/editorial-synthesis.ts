import {
  createEditorialSynthesis,
  type EditorialSynthesis,
  type SynthesisJoin,
  type SynthesisRange,
} from '../domain/editorial-synthesis.ts'
import { DomainError } from '../domain/errors.ts'
import type { Rational } from '../domain/session-time.ts'
import type { StoryPlan } from '../domain/story-plan.ts'
import type { EditorialSynthesisRepository } from './ports/editorial-synthesis-repository.ts'
import type { StoryPlanRepository } from './ports/story-plan-repository.ts'

/**
 * Multi-range editorial synthesis (F4.001 / FR-135).
 *
 * The service does almost nothing, and that is the point: the domain decides
 * whether the assembly is honest, and the only thing worth doing here is
 * fetching the StoryPlan so the claims and qualifiers it declares are the ones
 * the check runs against.
 *
 * Reading the plan is not a formality. `assertClaimContextPreserved` compares
 * the claims a range carries against the qualifiers the *plan* says those
 * claims need; a caller that supplied both halves would be marking its own
 * homework, and the failure it would hide — a claim shipped without the words
 * that qualify it — is the one this feature exists to prevent.
 */
export function createEditorialSynthesisService(dependencies: {
  repository: EditorialSynthesisRepository
  storyPlans: StoryPlanRepository
  clock: () => Date
}) {
  return async (input: {
    workspaceId: string
    projectId: string
    synthesisId: string
    objective: string
    targetDurationMs: number
    toleranceMs: number
    sourceDurationMs: number
    frameRate: Rational
    storyPlanId: string
    editPlanId: string
    allowReorder?: Readonly<{ reason: string }>
    ranges: readonly Readonly<SynthesisRange>[]
    joins: readonly Readonly<Omit<SynthesisJoin, 'droppedMs' | 'timelineMs'>>[]
  }): Promise<Readonly<{ synthesis: Readonly<EditorialSynthesis>; replayed: boolean }>> => {
    const plan = await dependencies.storyPlans.read({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      storyPlanId: input.storyPlanId,
    })
    if (!plan) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        `StoryPlan ${input.storyPlanId} does not exist, so there is nothing to check the claims against`,
      )
    }
    const synthesis = createEditorialSynthesis({
      id: input.synthesisId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      objective: input.objective,
      targetDurationMs: input.targetDurationMs,
      toleranceMs: input.toleranceMs,
      sourceDurationMs: input.sourceDurationMs,
      frameRate: input.frameRate,
      ranges: input.ranges,
      joins: input.joins,
      // The stored record wraps the plan alongside its idempotency evidence;
      // the synthesis needs the plan itself, and `mode` labels the plan as one
      // a multi-range cut was built from.
      storyPlan: Object.freeze({ ...plan.plan, mode: 'multi-range' as const }) as
        Readonly<StoryPlan> & Readonly<{ id: string; mode: 'multi-range' }>,
      editPlanId: input.editPlanId,
      allowReorder: input.allowReorder,
    })
    return dependencies.repository.persist({
      synthesis,
      createdAt: dependencies.clock().toISOString(),
    })
  }
}

export function readEditorialSynthesisService(dependencies: {
  repository: EditorialSynthesisRepository
}) {
  return async (input: { workspaceId: string; synthesisId: string }) => {
    const stored = await dependencies.repository.read(input)
    if (!stored) {
      throw new DomainError(
        'EDITORIAL_SYNTHESIS_NOT_FOUND',
        `Editorial synthesis ${input.synthesisId} does not exist`,
      )
    }
    return stored
  }
}

export function listEditorialSynthesesService(dependencies: {
  repository: EditorialSynthesisRepository
}) {
  return async (input: { workspaceId: string; projectId: string; limit?: number }) =>
    dependencies.repository.list(input)
}
