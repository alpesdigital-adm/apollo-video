import { calculateCanonicalHash } from './canonical-hash.ts'
import { createDesiredActionReference, type DesiredActionReference } from './desired-action.ts'
import { DomainError } from './errors.ts'

export type StoryRole = 'hook' | 'context' | 'argument' | 'proof' | 'cta'
export type StoryPresentation = 'source-video' | 'voiceover' | 'cold-open-reference'
export interface StoryDurationTarget { min: number; ideal: number; max: number }
export interface StorySourceRange {
  id: string
  artifactId: string
  startMs: number
  endMs: number
  rightsRef: string
  consentRef?: string
}
export interface StorySourceCandidate {
  id: string
  sourceRangeId: string
  purpose: StoryRole
  rank: number
}
export interface StoryClaim { id: string; text: string; qualifierIds: readonly string[]; proofContextIds: readonly string[] }
export interface StoryQualifier { id: string; text: string }
export interface StoryProofContext { id: string; claimIds: readonly string[]; sourceCandidateIds: readonly string[]; attribution: string }
export interface StoryBlock {
  id: string
  actId: string
  role: StoryRole
  intent: string
  dependencies: readonly string[]
  sourceCandidateIds: readonly string[]
  durationTargetMs: StoryDurationTarget
  content: { claimIds: readonly string[]; qualifierIds: readonly string[]; proofIds: readonly string[]; ctaId?: string }
  presentation: StoryPresentation
  sourceRangeId?: string
}
export interface StoryAct { id: string; role: 'opening' | 'development' | 'resolution'; blockIds: readonly string[] }
export interface TreatmentPlanReference { id: string; schemaVersion: number; contentHash: string }
export interface StoryPlan {
  schemaVersion: 1 | 2 | 3
  objective: string
  desiredActionRef?: Readonly<DesiredActionReference>
  treatmentPlanRef?: Readonly<TreatmentPlanReference>
  targetDurationMs: { min: number; max: number }
  acts: readonly StoryAct[]
  blocks: readonly StoryBlock[]
  sourceRanges?: readonly StorySourceRange[]
  sourceCandidates?: readonly StorySourceCandidate[]
  qualifiers?: readonly StoryQualifier[]
  claims?: readonly StoryClaim[]
  proofContexts?: readonly StoryProofContext[]
}

export interface PersistableStoryPlan extends StoryPlan {
  id: string
  workspaceId: string
  projectId: string
  projectVersionId: string
  storyHash: string
  createdBy: Readonly<{ type: 'api-client'; id: string }>
  createdAt: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DomainError('INVALID_ARGUMENT', message)
}
function ids<T extends { id: string }>(items: readonly T[], label: string): Map<string, T> {
  const result = new Map<string, T>()
  for (const item of items) {
    assert(ID.test(item.id), `${label} id is invalid`)
    assert(!result.has(item.id), `${label} ids must be unique`)
    result.set(item.id, item)
  }
  return result
}

export function validateStoryPlan(plan: StoryPlan): Readonly<{ plan: StoryPlan; estimatedDurationMs: number; readyForEditPlan: true }> {
  const byId = ids(plan.blocks, 'Story block')
  if (plan.schemaVersion >= 2 && !plan.desiredActionRef) throw new DomainError('INVALID_ARGUMENT', 'Story requires a canonical desired action reference')
  assert(plan.blocks.length > 0 && plan.acts.length > 0, 'Story requires acts and blocks')
  assert(Number.isSafeInteger(plan.targetDurationMs.min) && Number.isSafeInteger(plan.targetDurationMs.max) && plan.targetDurationMs.min > 0 && plan.targetDurationMs.min <= plan.targetDurationMs.max, 'Story target duration is invalid')
  const actIds = ids(plan.acts, 'Story act')
  const ordered = plan.acts.flatMap((act) => act.blockIds.map((id) => byId.get(id) ?? (() => { throw new DomainError('INVALID_ARGUMENT', `Act references missing block ${id}`) })()))
  assert(ordered.length === plan.blocks.length && new Set(ordered.map((block) => block.id)).size === plan.blocks.length, 'Every story block must be covered exactly once')
  const orderedIndex = new Map(ordered.map((block, index) => [block.id, index]))
  for (const block of ordered) {
    assert(actIds.has(block.actId) && actIds.get(block.actId)?.blockIds.includes(block.id), `Block ${block.id} has inconsistent act ownership`)
    const d = block.durationTargetMs
    assert([d.min, d.ideal, d.max].every(Number.isSafeInteger) && d.min > 0 && d.min <= d.ideal && d.ideal <= d.max, `Invalid duration target for ${block.id}`)
    for (const dependency of block.dependencies) {
      assert(byId.has(dependency), `Missing dependency ${dependency}`)
      assert((orderedIndex.get(dependency) ?? Infinity) < (orderedIndex.get(block.id) ?? -1), `Dependency ${dependency} must precede ${block.id}`)
    }
    if (block.content.claimIds.length && block.role === 'proof' && !block.content.proofIds.length) throw new DomainError('INVALID_ARGUMENT', 'Proof claims require proof context')
    if (block.role === 'cta' && (!block.content.ctaId || (plan.desiredActionRef && block.content.ctaId !== plan.desiredActionRef.id))) throw new DomainError('INVALID_ARGUMENT', 'CTA block requires its canonical desired action reference')
    if (block.presentation === 'cold-open-reference' && !block.sourceRangeId) throw new DomainError('INVALID_ARGUMENT', 'Cold open must reference a source range')
  }

  if (plan.schemaVersion === 3) {
    const expectedActionRef = createDesiredActionReference(plan.desiredActionRef!.action)
    assert(plan.desiredActionRef!.schemaVersion === expectedActionRef.schemaVersion && plan.desiredActionRef!.id === expectedActionRef.id && plan.desiredActionRef!.actionHash === expectedActionRef.actionHash, 'Story desired action reference failed integrity validation')
    assert(plan.treatmentPlanRef && ID.test(plan.treatmentPlanRef.id) && Number.isSafeInteger(plan.treatmentPlanRef.schemaVersion) && plan.treatmentPlanRef.schemaVersion > 0 && HASH.test(plan.treatmentPlanRef.contentHash), 'Story requires a versioned TreatmentPlan reference')
    const ranges = ids(plan.sourceRanges ?? [], 'Source range')
    const candidates = ids(plan.sourceCandidates ?? [], 'Source candidate')
    const qualifiers = ids(plan.qualifiers ?? [], 'Qualifier')
    const claims = ids(plan.claims ?? [], 'Claim')
    const proofs = ids(plan.proofContexts ?? [], 'Proof context')
    assert(ranges.size > 0 && candidates.size > 0, 'Story requires source ranges and candidates')
    for (const range of ranges.values()) assert(Number.isSafeInteger(range.startMs) && Number.isSafeInteger(range.endMs) && range.startMs >= 0 && range.startMs < range.endMs && ID.test(range.artifactId) && ID.test(range.rightsRef), `Source range ${range.id} is invalid`)
    for (const candidate of candidates.values()) assert(ranges.has(candidate.sourceRangeId) && Number.isSafeInteger(candidate.rank) && candidate.rank > 0, `Source candidate ${candidate.id} is invalid`)
    for (const claim of claims.values()) {
      assert(claim.text.trim().length > 0, `Claim ${claim.id} is empty`)
      claim.qualifierIds.forEach((id) => assert(qualifiers.has(id), `Claim ${claim.id} references missing qualifier ${id}`))
      claim.proofContextIds.forEach((id) => assert(proofs.has(id), `Claim ${claim.id} references missing proof context ${id}`))
    }
    for (const proof of proofs.values()) {
      assert(proof.attribution.trim().length > 0, `Proof context ${proof.id} requires attribution`)
      proof.claimIds.forEach((id) => assert(claims.has(id), `Proof context ${proof.id} references missing claim ${id}`))
      proof.sourceCandidateIds.forEach((id) => assert(candidates.has(id), `Proof context ${proof.id} references missing source candidate ${id}`))
    }
    for (const block of ordered) {
      block.sourceCandidateIds.forEach((id) => assert(candidates.has(id), `Block ${block.id} references missing source candidate ${id}`))
      block.content.qualifierIds.forEach((id) => assert(qualifiers.has(id), `Block ${block.id} references missing qualifier ${id}`))
      block.content.claimIds.forEach((id) => assert(claims.has(id), `Block ${block.id} references missing claim ${id}`))
      block.content.proofIds.forEach((id) => assert(proofs.has(id), `Block ${block.id} references missing proof context ${id}`))
      if (block.presentation === 'cold-open-reference') {
        assert(ranges.has(block.sourceRangeId!), `Cold open ${block.id} references missing source range`)
        const laterUse = ordered.slice((orderedIndex.get(block.id) ?? -1) + 1).some((later) => later.sourceCandidateIds.some((candidateId) => candidates.get(candidateId)?.sourceRangeId === block.sourceRangeId))
        assert(laterUse, 'Cold open source range must be referenced by a later story block')
        assert((plan.sourceRanges ?? []).filter((range) => range.id === block.sourceRangeId).length === 1, 'Cold open must not duplicate its source range')
      }
    }
    const ctaBlocks = ordered.filter((block) => block.role === 'cta')
    for (const cta of ctaBlocks) assert(cta.dependencies.some((id) => ['argument', 'proof'].includes(byId.get(id)?.role ?? '')), 'CTA must depend on argument or proof context')
  }
  const estimatedDurationMs = ordered.reduce((sum, block) => sum + block.durationTargetMs.ideal, 0)
  assert(estimatedDurationMs >= plan.targetDurationMs.min && estimatedDurationMs <= plan.targetDurationMs.max, 'Story duration is outside target')
  return Object.freeze({ plan: Object.freeze(plan), estimatedDurationMs, readyForEditPlan: true as const })
}

export function createStoryPlan(input: Omit<PersistableStoryPlan, 'schemaVersion' | 'storyHash'>): Readonly<PersistableStoryPlan> {
  for (const [field, value] of Object.entries({ id: input.id, workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: input.projectVersionId, createdById: input.createdBy.id })) assert(ID.test(value), `${field} is invalid`)
  assert(!Number.isNaN(Date.parse(input.createdAt)), 'createdAt is invalid')
  const core: StoryPlan = { ...input, schemaVersion: 3 }
  validateStoryPlan(core)
  const storyHash = calculateCanonicalHash(core)
  return Object.freeze({ ...input, schemaVersion: 3 as const, storyHash })
}

const sourceRanges: StorySourceRange[] = [
  { id: 'range-hook', artifactId: 'artifact-master', startMs: 0, endMs: 2000, rightsRef: 'rights-master' },
  { id: 'range-argument', artifactId: 'artifact-master', startMs: 2000, endMs: 4000, rightsRef: 'rights-master' },
  { id: 'range-proof', artifactId: 'artifact-master', startMs: 4000, endMs: 6000, rightsRef: 'rights-master' },
  { id: 'range-cta', artifactId: 'artifact-master', startMs: 6000, endMs: 8000, rightsRef: 'rights-master' },
]
const candidate = (id: string, sourceRangeId: string, purpose: StoryRole, rank = 1): StorySourceCandidate => ({ id, sourceRangeId, purpose, rank })
const GOLDEN_DESIRED_ACTION_REF = createDesiredActionReference({ schemaVersion: 1, kind: 'buy', destination: { type: 'url', value: 'https://example.com' }, visualCta: 'Buy now', verbalCta: 'Buy now', disclosures: [] })
const block = (id: string, role: StoryRole, presentation: StoryPresentation = 'source-video', extra: Partial<StoryBlock> = {}): StoryBlock => ({ id, actId: role === 'hook' ? 'opening' : role === 'cta' ? 'resolution' : 'development', role, intent: role, dependencies: role === 'cta' ? ['proof'] : role === 'proof' ? ['argument'] : role === 'argument' ? ['hook'] : [], sourceCandidateIds: [`source-${id}`], durationTargetMs: { min: 1000, ideal: 2000, max: 3500 }, content: { claimIds: role === 'argument' ? ['claim-1'] : [], qualifierIds: role === 'argument' ? ['qualifier-1'] : [], proofIds: role === 'proof' ? ['proof-1'] : [], ...(role === 'cta' ? { ctaId: GOLDEN_DESIRED_ACTION_REF.id } : {}) }, presentation, ...extra })
const fixture = (mode: 'linear' | 'cold-open' | 'voiceover'): StoryPlan => {
  const blocks = [block('hook', 'hook', mode === 'voiceover' ? 'voiceover' : mode === 'cold-open' ? 'cold-open-reference' : 'source-video', mode === 'cold-open' ? { sourceRangeId: 'range-proof', sourceCandidateIds: ['source-proof'] } : {}), block('argument', 'argument', mode === 'voiceover' ? 'voiceover' : 'source-video'), block('proof', 'proof'), block('cta', 'cta')]
  return { schemaVersion: 3, objective: 'sale', desiredActionRef: GOLDEN_DESIRED_ACTION_REF, treatmentPlanRef: { id: 'treatment-1', schemaVersion: 1, contentHash: 'b'.repeat(64) }, targetDurationMs: { min: 6000, max: 12_000 }, acts: [{ id: 'opening', role: 'opening', blockIds: ['hook'] }, { id: 'development', role: 'development', blockIds: ['argument', 'proof'] }, { id: 'resolution', role: 'resolution', blockIds: ['cta'] }], blocks, sourceRanges, sourceCandidates: [candidate('source-hook', 'range-hook', 'hook'), candidate('source-argument', 'range-argument', 'argument'), candidate('source-proof', 'range-proof', 'proof'), candidate('source-cta', 'range-cta', 'cta')], qualifiers: [{ id: 'qualifier-1', text: 'for qualified participants' }], claims: [{ id: 'claim-1', text: 'The method improves clarity', qualifierIds: ['qualifier-1'], proofContextIds: ['proof-1'] }], proofContexts: [{ id: 'proof-1', claimIds: ['claim-1'], sourceCandidateIds: ['source-proof'], attribution: 'Participant result' }] }
}
export const STORY_GOLDEN_FIXTURES = Object.freeze({ linear: fixture('linear'), coldOpen: fixture('cold-open'), voiceover: fixture('voiceover') })
