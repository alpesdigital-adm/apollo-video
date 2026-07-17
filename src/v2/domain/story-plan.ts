import { DomainError } from './errors.ts'

export type StoryRole = 'hook' | 'context' | 'argument' | 'proof' | 'cta'
export interface StoryBlock {
  id: string; actId: string; role: StoryRole; intent: string; dependencies: readonly string[]; sourceCandidateIds: readonly string[]
  durationTargetMs: { min: number; ideal: number; max: number }; content: { claimIds: readonly string[]; qualifierIds: readonly string[]; proofIds: readonly string[]; ctaId?: string }
  presentation: 'source-video' | 'voiceover' | 'cold-open-reference'; sourceRangeId?: string
}
export interface StoryAct { id: string; role: 'opening' | 'development' | 'resolution'; blockIds: readonly string[] }
export interface StoryPlan { schemaVersion: 1; objective: string; targetDurationMs: { min: number; max: number }; acts: readonly StoryAct[]; blocks: readonly StoryBlock[] }

export function validateStoryPlan(plan: StoryPlan): Readonly<{ plan: StoryPlan; estimatedDurationMs: number; readyForEditPlan: true }> {
  const byId = new Map(plan.blocks.map((block) => [block.id, block]))
  if (!plan.blocks.length || !plan.acts.length) throw new DomainError('INVALID_ARGUMENT', 'Story requires acts and blocks')
  const ordered = plan.acts.flatMap((act) => act.blockIds.map((id) => byId.get(id) ?? (() => { throw new DomainError('INVALID_ARGUMENT', `Act references missing block ${id}`) })()))
  if (new Set(ordered.map((block) => block.id)).size !== plan.blocks.length) throw new DomainError('INVALID_ARGUMENT', 'Every story block must be covered exactly once')
  for (const block of ordered) {
    if (block.durationTargetMs.min < 0 || block.durationTargetMs.min > block.durationTargetMs.ideal || block.durationTargetMs.ideal > block.durationTargetMs.max) throw new DomainError('INVALID_ARGUMENT', `Invalid duration target for ${block.id}`)
    for (const dependency of block.dependencies) if (!byId.has(dependency)) throw new DomainError('INVALID_ARGUMENT', `Missing dependency ${dependency}`)
    if (block.content.claimIds.length && block.role === 'proof' && !block.content.proofIds.length) throw new DomainError('INVALID_ARGUMENT', 'Proof claims require proof context')
    if (block.role === 'cta' && !block.content.ctaId) throw new DomainError('INVALID_ARGUMENT', 'CTA block requires structured CTA')
    if (block.presentation === 'cold-open-reference' && !block.sourceRangeId) throw new DomainError('INVALID_ARGUMENT', 'Cold open must reference a source range')
  }
  const estimatedDurationMs = ordered.reduce((sum, block) => sum + block.durationTargetMs.ideal, 0)
  if (estimatedDurationMs < plan.targetDurationMs.min || estimatedDurationMs > plan.targetDurationMs.max) throw new DomainError('INVALID_ARGUMENT', 'Story duration is outside target')
  return Object.freeze({ plan: Object.freeze(plan), estimatedDurationMs, readyForEditPlan: true as const })
}

const block = (id: string, role: StoryRole, presentation: StoryBlock['presentation'] = 'source-video', extra: Partial<StoryBlock> = {}): StoryBlock => ({ id, actId: role === 'hook' ? 'opening' : role === 'cta' ? 'resolution' : 'development', role, intent: role, dependencies: role === 'cta' ? ['proof'] : [], sourceCandidateIds: [`source-${id}`], durationTargetMs: { min: 1000, ideal: 2000, max: 3500 }, content: { claimIds: role === 'argument' ? ['claim-1'] : [], qualifierIds: role === 'argument' ? ['qualifier-1'] : [], proofIds: role === 'proof' ? ['proof-1'] : [], ...(role === 'cta' ? { ctaId: 'cta-1' } : {}) }, presentation, ...extra })
const fixture = (mode: 'linear' | 'cold-open' | 'voiceover'): StoryPlan => { const blocks = [block('hook', 'hook', mode === 'voiceover' ? 'voiceover' : mode === 'cold-open' ? 'cold-open-reference' : 'source-video', mode === 'cold-open' ? { sourceRangeId: 'range-proof' } : {}), block('argument', 'argument', mode === 'voiceover' ? 'voiceover' : 'source-video'), block('proof', 'proof'), block('cta', 'cta')]; return { schemaVersion: 1, objective: 'sale', targetDurationMs: { min: 6000, max: 12_000 }, acts: [{ id: 'opening', role: 'opening', blockIds: ['hook'] }, { id: 'development', role: 'development', blockIds: ['argument', 'proof'] }, { id: 'resolution', role: 'resolution', blockIds: ['cta'] }], blocks } }
export const STORY_GOLDEN_FIXTURES = Object.freeze({ linear: fixture('linear'), coldOpen: fixture('cold-open'), voiceover: fixture('voiceover') })
