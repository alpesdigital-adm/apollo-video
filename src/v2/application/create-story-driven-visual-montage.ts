import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { DomainError } from '../domain/errors.ts'
import { hydrateMontageSelection, type MontageSelection } from '../domain/montage-candidate.ts'
import { validateStoryPlan, type PersistableStoryPlan } from '../domain/story-plan.ts'
import {
  createVisualMontagePlan,
  type VisualMontagePlan,
  type VisualMontageSourceAsset,
} from '../domain/visual-montage.ts'

function exactSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.every((value) => right.includes(value))
}

function boundaryUnits(weights: readonly number[], totalUnits: number): readonly number[] {
  const totalWeight = weights.reduce((total, value) => total + value, 0)
  let accumulatedWeight = 0
  return Object.freeze(weights.map((weight, index) => {
    accumulatedWeight += weight
    return index === weights.length - 1
      ? totalUnits
      : Math.round(totalUnits * accumulatedWeight / totalWeight)
  }))
}

/**
 * Joins the persisted StoryPlan and the winner selected by the Director's
 * canonical montage rubric to the renderable, person-free visual plan.
 */
export function createStoryDrivenVisualMontage(input: {
  id: string
  storyPlan: Readonly<PersistableStoryPlan>
  montageSelection: Readonly<MontageSelection>
  sourceAudio: VisualMontagePlan['sourceAudio']
  narrationByBlockId: Readonly<Record<string, string>>
  assets: readonly VisualMontageSourceAsset[]
}): Readonly<VisualMontagePlan> {
  validateStoryPlan(input.storyPlan)
  const { storyHash, ...storyBody } = input.storyPlan
  if (calculateCanonicalHash(storyBody) !== storyHash) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'StoryPlan hash does not match its persisted content')
  }
  const selection = hydrateMontageSelection(input.montageSelection)
  if (selection.status !== 'selected' || !selection.winnerId) {
    throw new DomainError('INVALID_ARGUMENT', 'Visual montage requires one canonically selected montage candidate')
  }
  const winner = selection.candidates.find(({ id }) => id === selection.winnerId)
  if (!winner || winner.status !== 'eligible' || winner.hardGateResults.some(({ passed }) => !passed)) {
    throw new DomainError('INVALID_ARGUMENT', 'Selected montage candidate did not pass every hard gate')
  }
  if (winner.storyPlanRef.id !== input.storyPlan.id || winner.storyPlanRef.hash !== storyHash) {
    throw new DomainError('VERSION_CONFLICT', 'Montage selection does not reference the exact StoryPlan')
  }
  const blockById = new Map(input.storyPlan.blocks.map((block) => [block.id, block]))
  const orderedBlocks = winner.blockOrder.map((blockId) => blockById.get(blockId))
  if (orderedBlocks.some((block) => !block)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Montage winner references a missing StoryPlan block')
  }
  const assetIds = input.assets.map(({ id }) => id)
  const selectedAssetIds = winner.assets.map(({ id }) => id)
  if (!exactSet(assetIds, selectedAssetIds) || winner.assets.some(({ rightsApproved }) => !rightsApproved)) {
    throw new DomainError('INVALID_ARGUMENT', 'Visual assets must exactly match the rights-approved montage winner')
  }
  if (!Number.isSafeInteger(input.sourceAudio.durationMs) || input.sourceAudio.durationMs % 100 !== 0) {
    throw new DomainError('INVALID_ARGUMENT', 'Voiceover duration must align to the canonical 100ms beat grid')
  }
  const totalUnits = input.sourceAudio.durationMs / 100
  const unitBoundaries = boundaryUnits(
    orderedBlocks.map((block) => block!.durationTargetMs.ideal),
    totalUnits,
  )
  const beatBoundaries = orderedBlocks.map((block, index) => {
    const safeBlock = block!
    const narration = input.narrationByBlockId[safeBlock.id]
    if (typeof narration !== 'string') {
      throw new DomainError('INVALID_ARGUMENT', `Narration is missing for StoryPlan block ${safeBlock.id}`)
    }
    const claims = (input.storyPlan.claims ?? [])
      .filter(({ id }) => safeBlock.content.claimIds.includes(id))
      .map(({ text }) => text)
    return Object.freeze({
      storyBlockId: safeBlock.id,
      endMs: unitBoundaries[index]! * 100,
      narration,
      intention: safeBlock.intent,
      content: Object.freeze(claims.length ? claims : [safeBlock.intent]),
      style: Object.freeze([safeBlock.role, safeBlock.presentation]),
    })
  })
  return createVisualMontagePlan({
    id: input.id,
    workspaceId: input.storyPlan.workspaceId,
    projectId: input.storyPlan.projectId,
    projectVersionId: input.storyPlan.projectVersionId,
    storyPlanRef: { id: input.storyPlan.id, hash: storyHash },
    montageSelectionRef: {
      selectionHash: selection.selectionHash,
      candidateId: winner.id,
      candidateHash: winner.candidateHash,
    },
    sourceAudio: input.sourceAudio,
    beatBoundaries,
    assets: input.assets,
  })
}
