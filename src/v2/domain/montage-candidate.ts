import { calculateCanonicalHash } from './canonical-hash.ts'
import { DomainError } from './errors.ts'

export const MONTAGE_ALTERNATIVE_POLICY_VERSION = 'montage-alternatives-2026-08-v1'
export const MONTAGE_RUBRIC = Object.freeze({
  id: 'montage-rubric-v1',
  weights: Object.freeze({ narrative: 0.35, objective: 0.25, continuity: 0.2, evidence: 0.2 }),
  tieTolerance: 0.000_001,
  minimumConfidence: 0.7,
})

export type MontageMode = 'chronological' | 'cold-open' | 'reorganized'
export type MontageSelectionStatus = 'selected' | 'review' | 'blocked'
export type MontageHardGateCode =
  | 'HOOK_NOT_SELF_CONTAINED'
  | 'ORDER_NOT_PERMITTED'
  | 'RIGHTS_NOT_APPROVED'
  | 'PATTERN_BUDGET_EXCEEDED'
  | 'STORY_BLOCK_COVERAGE_INVALID'

export interface MontageCandidateSeed {
  schemaVersion: 'montage-candidate-seed/v1'
  id: string
  seed: string
  storyPlanRef: Readonly<{ id: string; hash: string }>
  mode: MontageMode
  hook: Readonly<{ id: string; selfContained: boolean }>
  blockOrder: readonly string[]
  permittedBlockOrders: readonly (readonly string[])[]
  assets: readonly Readonly<{ id: string; rightsApproved: boolean }>[]
  patternBreaks: readonly Readonly<{ id: string; atMs: number; group: string }>[]
  maximumPatternBreaks: number
  confidence: number
  rubricSignals: Readonly<Record<keyof typeof MONTAGE_RUBRIC.weights, number>>
  seedHash: string
}

export interface EvaluatedMontageCandidate extends MontageCandidateSeed {
  status: 'eligible' | 'rejected'
  hardGateResults: readonly Readonly<{ code: MontageHardGateCode; passed: boolean; evidenceRefs: readonly string[] }>[]
  score: number | null
  estimatedCost: number | null
  rejectionReasons: readonly MontageHardGateCode[]
  candidateHash: string
}

export interface MontageSelection {
  schemaVersion: 'montage-selection/v1'
  policyVersion: typeof MONTAGE_ALTERNATIVE_POLICY_VERSION
  rubric: typeof MONTAGE_RUBRIC
  status: MontageSelectionStatus
  winnerId: string | null
  reason: 'HIGHEST_RUBRIC_SCORE' | 'SCORE_TIE' | 'LOW_CONFIDENCE' | 'NO_ELIGIBLE_CANDIDATE'
  diversity: Readonly<{
    candidateCount: number
    eligibleCount: number
    uniqueHooks: number
    uniqueOrders: number
    uniqueAssetSets: number
    uniquePatternSets: number
    normalized: Readonly<{ hooks: number; orders: number; assets: number; patterns: number; overall: number }>
  }>
  candidates: readonly Readonly<EvaluatedMontageCandidate>[]
  selectionHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/

function validId(value: string, field: string): string {
  const normalized = value?.trim()
  if (!ID.test(normalized)) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}

function validHash(value: string, field: string): string {
  if (!HASH.test(value)) throw new DomainError('INVALID_ARGUMENT', `${field} must be a lowercase SHA-256`)
  return value
}

function stableUnique(values: readonly string[], field: string, minimum = 1): readonly string[] {
  if (!Array.isArray(values) || values.length < minimum || values.length > 64) throw new DomainError('INVALID_ARGUMENT', `${field} is not bounded`)
  const result = Object.freeze(values.map((value, index) => validId(value, `${field}[${index}]`)))
  if (new Set(result).size !== result.length) throw new DomainError('INVALID_ARGUMENT', `${field} must not repeat values`)
  return result
}

export function createMontageCandidateSeed(input: Omit<MontageCandidateSeed, 'schemaVersion' | 'seedHash'>): Readonly<MontageCandidateSeed> {
  const id = validId(input.id, 'candidate.id')
  const seed = validId(input.seed, 'candidate.seed')
  const storyPlanRef = Object.freeze({ id: validId(input.storyPlanRef.id, 'storyPlanRef.id'), hash: validHash(input.storyPlanRef.hash, 'storyPlanRef.hash') })
  if (!['chronological', 'cold-open', 'reorganized'].includes(input.mode)) throw new DomainError('INVALID_ARGUMENT', 'candidate.mode is unsupported')
  const hook = Object.freeze({ id: validId(input.hook.id, 'candidate.hook.id'), selfContained: input.hook.selfContained })
  if (typeof hook.selfContained !== 'boolean') throw new DomainError('INVALID_ARGUMENT', 'candidate hook coverage is invalid')
  const blockOrder = stableUnique(input.blockOrder, 'candidate.blockOrder')
  if (!Array.isArray(input.permittedBlockOrders) || input.permittedBlockOrders.length < 1 || input.permittedBlockOrders.length > 32) throw new DomainError('INVALID_ARGUMENT', 'permittedBlockOrders is not bounded')
  const permittedBlockOrders = Object.freeze(input.permittedBlockOrders.map((order, index) => stableUnique(order, `permittedBlockOrders[${index}]`)))
  const assets = Object.freeze(input.assets.map((asset, index) => Object.freeze({ id: validId(asset.id, `candidate.assets[${index}].id`), rightsApproved: asset.rightsApproved })))
  if (assets.length > 32 || new Set(assets.map(({ id: assetId }) => assetId)).size !== assets.length || assets.some(({ rightsApproved }) => typeof rightsApproved !== 'boolean')) throw new DomainError('INVALID_ARGUMENT', 'candidate assets are invalid')
  const patternBreaks = Object.freeze(input.patternBreaks.map((item, index) => Object.freeze({ id: validId(item.id, `candidate.patternBreaks[${index}].id`), atMs: item.atMs, group: validId(item.group, `candidate.patternBreaks[${index}].group`) })).toSorted((left, right) => left.atMs - right.atMs || left.id.localeCompare(right.id)))
  if (patternBreaks.length > 64 || new Set(patternBreaks.map(({ id: itemId }) => itemId)).size !== patternBreaks.length || patternBreaks.some(({ atMs }) => !Number.isSafeInteger(atMs) || atMs < 0 || atMs > 3_600_000)) throw new DomainError('INVALID_ARGUMENT', 'candidate pattern breaks are invalid')
  if (!Number.isSafeInteger(input.maximumPatternBreaks) || input.maximumPatternBreaks < 0 || input.maximumPatternBreaks > 64) throw new DomainError('INVALID_ARGUMENT', 'candidate pattern-break limit is invalid')
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) throw new DomainError('INVALID_ARGUMENT', 'candidate confidence is invalid')
  const signalKeys = Object.keys(MONTAGE_RUBRIC.weights)
  if (Object.keys(input.rubricSignals).toSorted().join('|') !== signalKeys.toSorted().join('|') || Object.values(input.rubricSignals).some((value) => !Number.isFinite(value) || value < 0 || value > 1)) throw new DomainError('INVALID_ARGUMENT', 'candidate rubric signals do not match the canonical rubric')
  const body = Object.freeze({
    schemaVersion: 'montage-candidate-seed/v1' as const,
    id, seed, storyPlanRef, mode: input.mode, hook, blockOrder, permittedBlockOrders, assets, patternBreaks,
    maximumPatternBreaks: input.maximumPatternBreaks, confidence: input.confidence,
    rubricSignals: Object.freeze({ ...input.rubricSignals }),
  })
  return Object.freeze({ ...body, seedHash: calculateCanonicalHash(body) })
}

export function deriveMontageHardGates(seed: Readonly<MontageCandidateSeed>) {
  const coverage = seed.permittedBlockOrders[0] ?? []
  const sameCoverage = seed.blockOrder.length === coverage.length && new Set(seed.blockOrder).size === new Set(coverage).size && seed.blockOrder.every((blockId) => coverage.includes(blockId))
  const exactOrderPermitted = seed.permittedBlockOrders.some((order) => order.join('|') === seed.blockOrder.join('|'))
  return Object.freeze([
    Object.freeze({ code: 'HOOK_NOT_SELF_CONTAINED' as const, passed: seed.mode === 'chronological' || seed.hook.selfContained, evidenceRefs: Object.freeze([seed.hook.id]) }),
    Object.freeze({ code: 'ORDER_NOT_PERMITTED' as const, passed: exactOrderPermitted, evidenceRefs: Object.freeze([seed.storyPlanRef.id]) }),
    Object.freeze({ code: 'RIGHTS_NOT_APPROVED' as const, passed: seed.assets.every(({ rightsApproved }) => rightsApproved), evidenceRefs: Object.freeze(seed.assets.map(({ id }) => id)) }),
    Object.freeze({ code: 'PATTERN_BUDGET_EXCEEDED' as const, passed: seed.patternBreaks.length <= seed.maximumPatternBreaks, evidenceRefs: Object.freeze(seed.patternBreaks.map(({ id }) => id)) }),
    Object.freeze({ code: 'STORY_BLOCK_COVERAGE_INVALID' as const, passed: sameCoverage, evidenceRefs: Object.freeze([seed.storyPlanRef.id]) }),
  ])
}

export function evaluateMontageCandidate(input: {
  seed: Readonly<MontageCandidateSeed>
  score: (seed: Readonly<MontageCandidateSeed>) => number
  estimateCost: (seed: Readonly<MontageCandidateSeed>) => number
}): Readonly<EvaluatedMontageCandidate> {
  const canonical = createMontageCandidateSeed(input.seed)
  if (canonical.seedHash !== input.seed.seedHash) throw new DomainError('INVALID_ARGUMENT', 'candidate seed hash is invalid')
  const hardGateResults = deriveMontageHardGates(canonical)
  const rejectionReasons = Object.freeze(hardGateResults.filter(({ passed }) => !passed).map(({ code }) => code))
  let score: number | null = null
  let estimatedCost: number | null = null
  if (!rejectionReasons.length) {
    score = input.score(canonical)
    estimatedCost = input.estimateCost(canonical)
    if (!Number.isFinite(score) || score < 0 || score > 1 || !Number.isFinite(estimatedCost) || estimatedCost < 0 || estimatedCost > 1_000_000) throw new DomainError('INVALID_ARGUMENT', 'candidate score or cost is invalid')
    score = Number(score.toFixed(6))
    estimatedCost = Number(estimatedCost.toFixed(4))
  }
  const body = Object.freeze({ ...canonical, status: rejectionReasons.length ? 'rejected' as const : 'eligible' as const, hardGateResults, score, estimatedCost, rejectionReasons })
  return Object.freeze({ ...body, candidateHash: calculateCanonicalHash(body) })
}

function diversity(candidates: readonly Readonly<EvaluatedMontageCandidate>[]) {
  const count = candidates.length
  const dimensions = {
    hooks: new Set(candidates.map(({ hook }) => hook.id)).size,
    orders: new Set(candidates.map(({ blockOrder }) => blockOrder.join('|'))).size,
    assets: new Set(candidates.map(({ assets }) => assets.map(({ id }) => id).toSorted().join('|'))).size,
    patterns: new Set(candidates.map(({ patternBreaks }) => patternBreaks.map(({ id }) => id).toSorted().join('|'))).size,
  }
  const normalized = Object.freeze({
    hooks: Number((dimensions.hooks / count).toFixed(6)), orders: Number((dimensions.orders / count).toFixed(6)),
    assets: Number((dimensions.assets / count).toFixed(6)), patterns: Number((dimensions.patterns / count).toFixed(6)),
    overall: Number(((dimensions.hooks + dimensions.orders + dimensions.assets + dimensions.patterns) / (4 * count)).toFixed(6)),
  })
  return Object.freeze({ candidateCount: count, eligibleCount: candidates.filter(({ status }) => status === 'eligible').length, uniqueHooks: dimensions.hooks, uniqueOrders: dimensions.orders, uniqueAssetSets: dimensions.assets, uniquePatternSets: dimensions.patterns, normalized })
}

export function createMontageSelection(input: { candidates: readonly Readonly<EvaluatedMontageCandidate>[] }): Readonly<MontageSelection> {
  if (!Array.isArray(input.candidates) || input.candidates.length < 1 || input.candidates.length > 32) throw new DomainError('INVALID_ARGUMENT', 'montage selection requires bounded candidates')
  const candidates = Object.freeze(input.candidates.map((candidate) => {
    const evaluated = evaluateMontageCandidate({ seed: candidate, score: () => candidate.score ?? Number.NaN, estimateCost: () => candidate.estimatedCost ?? Number.NaN })
    if (evaluated.candidateHash !== candidate.candidateHash || evaluated.status !== candidate.status || evaluated.rejectionReasons.join('|') !== candidate.rejectionReasons.join('|')) throw new DomainError('INVALID_ARGUMENT', 'evaluated candidate is inconsistent')
    return candidate
  }))
  if (new Set(candidates.map(({ id }) => id)).size !== candidates.length) throw new DomainError('INVALID_ARGUMENT', 'montage candidate IDs must be unique')
  const storyPlanContracts = new Set(candidates.map(({ storyPlanRef }) => `${storyPlanRef.id}:${storyPlanRef.hash}`))
  if (storyPlanContracts.size !== 1) throw new DomainError('INVALID_ARGUMENT', 'all candidates must target the same StoryPlan contract')
  const eligible = candidates.filter(({ status }) => status === 'eligible').toSorted((left, right) => (right.score! - left.score!) || left.estimatedCost! - right.estimatedCost! || left.id.localeCompare(right.id))
  let status: MontageSelectionStatus = 'blocked'
  let winnerId: string | null = null
  let reason: MontageSelection['reason'] = 'NO_ELIGIBLE_CANDIDATE'
  if (eligible.length) {
    const winner = eligible[0]
    winnerId = winner.id
    const tied = eligible.length > 1 && Math.abs(winner.score! - eligible[1].score!) <= MONTAGE_RUBRIC.tieTolerance
    status = tied || winner.confidence < MONTAGE_RUBRIC.minimumConfidence ? 'review' : 'selected'
    reason = tied ? 'SCORE_TIE' : winner.confidence < MONTAGE_RUBRIC.minimumConfidence ? 'LOW_CONFIDENCE' : 'HIGHEST_RUBRIC_SCORE'
  }
  const body = Object.freeze({ schemaVersion: 'montage-selection/v1' as const, policyVersion: MONTAGE_ALTERNATIVE_POLICY_VERSION, rubric: MONTAGE_RUBRIC, status, winnerId, reason, diversity: diversity(candidates), candidates })
  return Object.freeze({ ...body, selectionHash: calculateCanonicalHash(body) })
}

export function hydrateMontageSelection(input: Readonly<MontageSelection>) {
  const canonical = createMontageSelection({ candidates: input.candidates })
  if (canonical.selectionHash !== input.selectionHash || canonical.status !== input.status || canonical.winnerId !== input.winnerId || canonical.reason !== input.reason) throw new DomainError('PERSISTENCE_CONFLICT', 'stored montage selection failed integrity validation')
  return canonical
}
