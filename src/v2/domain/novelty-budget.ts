import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import { TRANSFORMATION_MODE_CONTRACTS } from './transformation-mode-registry.ts'
import type { TransformationMode } from './transformation-brief.ts'

/**
 * Narrative novelty budget (FR-114).
 *
 * Every number here is an integer. That is not a style preference: the policy
 * has to produce the same decision no matter what order the candidates come
 * back from the database in, and floating-point addition is not associative —
 * `(a + b) + c` and `a + (b + c)` can differ in the last bits, which is enough
 * to flip a candidate from accepted to blocked at a threshold. Costs are in
 * *novelty units*, one ten-thousandth of the total budget, and every
 * intermediate result is exact.
 *
 * The budget is evaluated **before** anything is submitted. A candidate that
 * the policy blocks must never reach a provider, because the cheapest
 * transformation is the one that was not paid for.
 */

export const NOVELTY_BUDGET_POLICY_VERSION = 'novelty-budget-policy/v1' as const
export const NOVELTY_BUDGET_DECISION_VERSION = 'novelty-budget-decision/v1' as const

export const NOVELTY_OUTCOMES = ['accepted', 'penalized', 'blocked'] as const
export type NoveltyOutcome = (typeof NOVELTY_OUTCOMES)[number]

export const NOVELTY_BLOCK_REASONS = [
  'total-budget-exhausted',
  'window-budget-exhausted',
  'cooldown-active',
  'group-repetition-exceeded',
  'proximity-too-close',
  'diversity-floor-unmet',
  'budget-is-zero',
] as const
export type NoveltyBlockReason = (typeof NOVELTY_BLOCK_REASONS)[number]

/**
 * Transformation modes collapse into effect *groups*. Two consecutive
 * background replacements read as the same trick to a viewer even when the
 * prompts differ, so cooldown and repetition are counted per group, not per
 * mode.
 */
export const NOVELTY_GROUPS = ['world', 'style', 'insert', 'camera', 'light'] as const
export type NoveltyGroup = (typeof NOVELTY_GROUPS)[number]

const GROUP_BY_MODE: Readonly<Record<TransformationMode, NoveltyGroup>> = Object.freeze({
  'background-replacement': 'world',
  'object-environment-change': 'world',
  stylization: 'style',
  cutaway: 'insert',
  'camera-motion': 'camera',
  relight: 'light',
})

export function noveltyGroupForMode(mode: TransformationMode): NoveltyGroup {
  return GROUP_BY_MODE[mode]
}

export interface NoveltyBudgetPolicy {
  schemaVersion: typeof NOVELTY_BUDGET_POLICY_VERSION
  id: string
  /** Total novelty units available across the whole narrative. */
  totalUnits: number
  /** Novelty units available inside any single window. */
  windowUnits: number
  /** Length of a narrative window, in frames. */
  windowFrames: number
  /** Minimum frames between two transformations of the same group. */
  cooldownFrames: number
  /** Minimum frames between any two transformations. */
  minimumSeparationFrames: number
  /** How many times one group may appear before repetition is refused. */
  maximumPerGroup: number
  /** Below this many distinct groups, a repeat of an already-used group is refused. */
  diversityFloor: number
  /** Base cost per group, in novelty units, before intensity and duration. */
  baseUnitsByGroup: Readonly<Record<NoveltyGroup, number>>
  /** Novelty units added per second of transformed material. */
  unitsPerSecond: number
  /** Extra cost, in basis points of the base cost, for landing near a neighbour. */
  proximityPenaltyBps: number
  /** Extra cost, in basis points, for each earlier use of the same group. */
  repetitionPenaltyBps: number
  policyHash: string
}

export interface NoveltyCandidate {
  id: string
  briefId: string
  mode: TransformationMode
  intensityBps: number
  startFrame: number
  endFrame: number
  fps: number
  /** A cache hit costs nothing to produce but still occupies the screen. */
  servedFromCache: boolean
}

export interface NoveltyBudgetDecisionLine {
  candidateId: string
  briefId: string
  group: NoveltyGroup
  outcome: NoveltyOutcome
  /** What this candidate costs the budget. Zero for a cache hit. */
  chargedUnits: number
  /** What it would have cost if it were generated. Always populated. */
  grossUnits: number
  /** Penalty applied on top of the base cost, in novelty units. */
  penaltyUnits: number
  /** Budget already consumed when this candidate was evaluated. */
  consumedBeforeUnits: number
  /** Budget remaining after it. */
  remainingUnits: number
  /** How much of the density this candidate occupies, cache hit or not. */
  densityUnits: number
  reason: string
  blockedBecause?: NoveltyBlockReason
}

export interface NoveltyBudgetDecision {
  schemaVersion: typeof NOVELTY_BUDGET_DECISION_VERSION
  id: string
  workspaceId: string
  projectId: string
  projectVersionId: string
  treatmentPlanId: string
  storyPlanId: string
  policyId: string
  policyHash: string
  lines: readonly Readonly<NoveltyBudgetDecisionLine>[]
  acceptedUnits: number
  penalizedUnits: number
  blockedCount: number
  /** Total density, including cache hits. Never the same as spend. */
  densityUnits: number
  treatment: 'sober' | 'balanced' | 'intense'
  evaluatedAt: string
  decisionHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/

function id(value: string, field: string): string {
  assertDomain(typeof value === 'string' && ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

function instant(value: string, field: string): string {
  assertDomain(
    typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} must be a canonical ISO instant`,
  )
  return value
}

function bounded(value: number, field: string, min: number, max: number): number {
  assertDomain(Number.isSafeInteger(value) && value >= min && value <= max, 'INVALID_ARGUMENT', `${field} is out of range`)
  return value
}

export function createNoveltyBudgetPolicy(input: Omit<NoveltyBudgetPolicy, 'schemaVersion' | 'policyHash'>): Readonly<NoveltyBudgetPolicy> {
  bounded(input.totalUnits, 'totalUnits', 0, 10_000_000)
  bounded(input.windowUnits, 'windowUnits', 0, 10_000_000)
  bounded(input.windowFrames, 'windowFrames', 1, 10_000_000)
  bounded(input.cooldownFrames, 'cooldownFrames', 0, 10_000_000)
  bounded(input.minimumSeparationFrames, 'minimumSeparationFrames', 0, 10_000_000)
  bounded(input.maximumPerGroup, 'maximumPerGroup', 1, 1_000)
  bounded(input.diversityFloor, 'diversityFloor', 0, NOVELTY_GROUPS.length)
  bounded(input.unitsPerSecond, 'unitsPerSecond', 0, 100_000)
  bounded(input.proximityPenaltyBps, 'proximityPenaltyBps', 0, 100_000)
  bounded(input.repetitionPenaltyBps, 'repetitionPenaltyBps', 0, 100_000)
  assertDomain(input.windowUnits <= input.totalUnits, 'INVALID_ARGUMENT', 'A window cannot allow more than the whole narrative')
  for (const group of NOVELTY_GROUPS) {
    bounded(input.baseUnitsByGroup[group], `baseUnitsByGroup.${group}`, 0, 1_000_000)
  }
  const body = Object.freeze({
    schemaVersion: NOVELTY_BUDGET_POLICY_VERSION,
    id: id(input.id, 'policy.id'),
    totalUnits: input.totalUnits,
    windowUnits: input.windowUnits,
    windowFrames: input.windowFrames,
    cooldownFrames: input.cooldownFrames,
    minimumSeparationFrames: input.minimumSeparationFrames,
    maximumPerGroup: input.maximumPerGroup,
    diversityFloor: input.diversityFloor,
    baseUnitsByGroup: Object.freeze(Object.fromEntries(
      NOVELTY_GROUPS.map((group) => [group, input.baseUnitsByGroup[group]]),
    ) as Record<NoveltyGroup, number>),
    unitsPerSecond: input.unitsPerSecond,
    proximityPenaltyBps: input.proximityPenaltyBps,
    repetitionPenaltyBps: input.repetitionPenaltyBps,
  })
  return Object.freeze({ ...body, policyHash: calculateCanonicalHash(body) })
}

export const DEFAULT_NOVELTY_BUDGET_POLICY = createNoveltyBudgetPolicy({
  id: 'novelty-budget-default-v1',
  totalUnits: 10_000,
  windowUnits: 3_500,
  windowFrames: 900,
  cooldownFrames: 240,
  minimumSeparationFrames: 90,
  maximumPerGroup: 3,
  diversityFloor: 2,
  baseUnitsByGroup: { world: 1_400, style: 1_100, insert: 700, camera: 400, light: 500 },
  unitsPerSecond: 120,
  proximityPenaltyBps: 4_000,
  repetitionPenaltyBps: 2_500,
})

/**
 * Duration in whole seconds, rounded up.
 *
 * Ceiling rather than rounding: 31 frames at 30fps is two seconds of screen
 * time being charged as two, not as one. Rounding down would make a candidate
 * one frame over a boundary cheaper than one frame under it, which is exactly
 * the drift the boundary tests exist to catch.
 */
function durationSeconds(candidate: Readonly<NoveltyCandidate>): number {
  const frames = candidate.endFrame - candidate.startFrame
  return Math.ceil(frames / candidate.fps)
}

/**
 * The gross cost of one candidate, ignoring history.
 *
 * Integer basis-point arithmetic throughout: the intensity multiplier is
 * applied as `value * bps / 10000` with a single floor at the end, so the
 * result never depends on evaluation order.
 */
export function noveltyGrossUnits(policy: Readonly<NoveltyBudgetPolicy>, candidate: Readonly<NoveltyCandidate>): number {
  const group = noveltyGroupForMode(candidate.mode)
  const base = policy.baseUnitsByGroup[group] + policy.unitsPerSecond * durationSeconds(candidate)
  return Math.floor((base * candidate.intensityBps) / 10_000)
}

function candidateOrder(left: Readonly<NoveltyCandidate>, right: Readonly<NoveltyCandidate>): number {
  return left.startFrame - right.startFrame || left.endFrame - right.endFrame || left.id.localeCompare(right.id)
}

/**
 * Evaluate a whole set of candidates against one policy.
 *
 * Candidates are sorted into narrative order first. That is what makes the
 * decision independent of the order rows come back in: cooldown and proximity
 * are facts about where things sit on the timeline, not about when they were
 * written.
 */
export function evaluateNoveltyBudget(input: {
  policy: Readonly<NoveltyBudgetPolicy>
  candidates: readonly Readonly<NoveltyCandidate>[]
}): Readonly<{
  lines: readonly Readonly<NoveltyBudgetDecisionLine>[]
  acceptedUnits: number
  penalizedUnits: number
  blockedCount: number
  densityUnits: number
  treatment: 'sober' | 'balanced' | 'intense'
}> {
  const policy = input.policy
  assertDomain(input.candidates.length <= 1_000, 'INVALID_ARGUMENT', 'Too many novelty candidates')
  for (const candidate of input.candidates) {
    id(candidate.id, 'candidate.id')
    id(candidate.briefId, 'candidate.briefId')
    bounded(candidate.intensityBps, 'candidate.intensityBps', 0, 10_000)
    bounded(candidate.startFrame, 'candidate.startFrame', 0, 100_000_000)
    bounded(candidate.endFrame, 'candidate.endFrame', 1, 100_000_000)
    bounded(candidate.fps, 'candidate.fps', 1, 240)
    assertDomain(candidate.endFrame > candidate.startFrame, 'INVALID_ARGUMENT', 'candidate range must be non-empty')
  }
  assertDomain(
    new Set(input.candidates.map((candidate) => candidate.id)).size === input.candidates.length,
    'INVALID_ARGUMENT',
    'candidate ids must be unique',
  )

  const ordered = [...input.candidates].sort(candidateOrder)
  const lines: NoveltyBudgetDecisionLine[] = []
  const accepted: { group: NoveltyGroup; startFrame: number; endFrame: number; units: number }[] = []
  let consumed = 0
  let density = 0

  for (const candidate of ordered) {
    const group = noveltyGroupForMode(candidate.mode)
    const gross = noveltyGrossUnits(policy, candidate)
    const consumedBefore = consumed

    const sameGroup = accepted.filter((entry) => entry.group === group)
    const previous = accepted.at(-1)
    const distance = previous ? candidate.startFrame - previous.endFrame : Number.MAX_SAFE_INTEGER
    const sameGroupDistance = sameGroup.length > 0 ? candidate.startFrame - sameGroup.at(-1)!.endFrame : Number.MAX_SAFE_INTEGER
    const distinctGroups = new Set(accepted.map((entry) => entry.group))

    // Window consumption counts every accepted transformation whose range
    // overlaps the window ending at this candidate.
    const windowStart = Math.max(0, candidate.endFrame - policy.windowFrames)
    const windowConsumed = accepted
      .filter((entry) => entry.endFrame > windowStart)
      .reduce((sum, entry) => sum + entry.units, 0)

    let blocked: NoveltyBlockReason | undefined
    if (policy.totalUnits === 0) blocked = 'budget-is-zero'
    // Half-open: exactly `cooldownFrames` apart is allowed, one frame less is
    // not. Stating it explicitly is what makes the boundary reproducible.
    else if (sameGroupDistance < policy.cooldownFrames) blocked = 'cooldown-active'
    else if (distance < policy.minimumSeparationFrames) blocked = 'proximity-too-close'
    else if (sameGroup.length >= policy.maximumPerGroup) blocked = 'group-repetition-exceeded'
    else if (sameGroup.length > 0 && distinctGroups.size < policy.diversityFloor) blocked = 'diversity-floor-unmet'

    let penalty = 0
    if (!blocked) {
      // Penalties are integer basis points of the gross cost. Landing close to
      // a neighbour and repeating a group both make an effect read as cheaper
      // to the viewer, so they are made more expensive to the budget.
      if (distance < policy.windowFrames) penalty += Math.floor((gross * policy.proximityPenaltyBps) / 10_000)
      penalty += Math.floor((gross * policy.repetitionPenaltyBps * sameGroup.length) / 10_000)
    }
    const charged = candidate.servedFromCache ? 0 : gross + penalty

    if (!blocked) {
      if (consumed + charged > policy.totalUnits) blocked = 'total-budget-exhausted'
      else if (windowConsumed + charged > policy.windowUnits) blocked = 'window-budget-exhausted'
    }

    if (blocked) {
      lines.push(Object.freeze({
        candidateId: candidate.id,
        briefId: candidate.briefId,
        group,
        outcome: 'blocked' as const,
        chargedUnits: 0,
        grossUnits: gross,
        penaltyUnits: penalty,
        consumedBeforeUnits: consumedBefore,
        remainingUnits: policy.totalUnits - consumed,
        densityUnits: 0,
        reason: blockReason(blocked, policy),
        blockedBecause: blocked,
      }))
      continue
    }

    consumed += charged
    // A cache hit is free to produce but still occupies the screen. It joins
    // the accepted list at its full gross weight so the next candidate sees the
    // density a viewer will actually experience, not the invoice.
    const densityUnits = gross + penalty
    density += densityUnits
    accepted.push({ group, startFrame: candidate.startFrame, endFrame: candidate.endFrame, units: densityUnits })
    lines.push(Object.freeze({
      candidateId: candidate.id,
      briefId: candidate.briefId,
      group,
      outcome: penalty > 0 ? ('penalized' as const) : ('accepted' as const),
      chargedUnits: charged,
      grossUnits: gross,
      penaltyUnits: penalty,
      consumedBeforeUnits: consumedBefore,
      remainingUnits: policy.totalUnits - consumed,
      densityUnits,
      reason: candidate.servedFromCache
        ? 'reused from cache: no new provider call, but the effect still counts against narrative density'
        : penalty > 0
          ? `accepted with a ${penalty}-unit penalty for proximity and group repetition`
          : 'accepted at base cost',
    }))
  }

  const acceptedUnits = lines.filter((line) => line.outcome !== 'blocked').reduce((sum, line) => sum + line.chargedUnits, 0)
  const penalizedUnits = lines.reduce((sum, line) => sum + (line.outcome === 'blocked' ? 0 : line.penaltyUnits), 0)
  return Object.freeze({
    lines: Object.freeze(lines),
    acceptedUnits,
    penalizedUnits,
    blockedCount: lines.filter((line) => line.outcome === 'blocked').length,
    densityUnits: density,
    // Treatment reads the *density*, not the spend: a video full of reused
    // effects is not sober just because it was cheap.
    treatment: classifyTreatment(density, policy.totalUnits),
  })
}

function classifyTreatment(density: number, totalUnits: number): 'sober' | 'balanced' | 'intense' {
  if (totalUnits === 0) return 'sober'
  const ratioBps = Math.floor((density * 10_000) / totalUnits)
  if (ratioBps < 3_500) return 'sober'
  if (ratioBps < 8_000) return 'balanced'
  return 'intense'
}

function blockReason(reason: NoveltyBlockReason, policy: Readonly<NoveltyBudgetPolicy>): string {
  switch (reason) {
    case 'budget-is-zero':
      return 'the narrative has no novelty budget at all, so no transformation may be requested'
    case 'cooldown-active':
      return `the same effect group appeared less than ${policy.cooldownFrames} frames earlier`
    case 'proximity-too-close':
      return `another transformation ends less than ${policy.minimumSeparationFrames} frames before this one starts`
    case 'group-repetition-exceeded':
      return `this effect group already appears ${policy.maximumPerGroup} times`
    case 'diversity-floor-unmet':
      return `repeating a group before ${policy.diversityFloor} distinct groups have been used`
    case 'window-budget-exhausted':
      return `the ${policy.windowFrames}-frame window has no novelty left`
    case 'total-budget-exhausted':
      return 'the narrative novelty budget is exhausted'
  }
}

export function createNoveltyBudgetDecision(input: {
  workspaceId: string
  projectId: string
  projectVersionId: string
  treatmentPlanId: string
  storyPlanId: string
  policy: Readonly<NoveltyBudgetPolicy>
  candidates: readonly Readonly<NoveltyCandidate>[]
  evaluatedAt: string
}): Readonly<NoveltyBudgetDecision> {
  const evaluation = evaluateNoveltyBudget({ policy: input.policy, candidates: input.candidates })
  const body = Object.freeze({
    schemaVersion: NOVELTY_BUDGET_DECISION_VERSION,
    workspaceId: id(input.workspaceId, 'workspaceId'),
    projectId: id(input.projectId, 'projectId'),
    projectVersionId: id(input.projectVersionId, 'projectVersionId'),
    treatmentPlanId: id(input.treatmentPlanId, 'treatmentPlanId'),
    storyPlanId: id(input.storyPlanId, 'storyPlanId'),
    policyId: input.policy.id,
    policyHash: input.policy.policyHash,
    lines: evaluation.lines,
    acceptedUnits: evaluation.acceptedUnits,
    penalizedUnits: evaluation.penalizedUnits,
    blockedCount: evaluation.blockedCount,
    densityUnits: evaluation.densityUnits,
    treatment: evaluation.treatment,
    evaluatedAt: instant(input.evaluatedAt, 'evaluatedAt'),
  })
  const decisionHash = calculateCanonicalHash(body)
  return Object.freeze({ ...body, id: `novelty-budget-decision-${decisionHash.slice(0, 32)}`, decisionHash })
}

export function assertNoveltyBudgetDecision(decision: Readonly<NoveltyBudgetDecision>): Readonly<NoveltyBudgetDecision> {
  assertDomain(decision.schemaVersion === NOVELTY_BUDGET_DECISION_VERSION, 'PERSISTENCE_CONFLICT', 'Stored novelty decision schema is invalid')
  const { decisionHash, id: decisionId, ...body } = decision
  assertDomain(calculateCanonicalHash(body) === decisionHash, 'PERSISTENCE_CONFLICT', 'Stored novelty decision hash does not match its body')
  assertDomain(decisionId === `novelty-budget-decision-${decisionHash.slice(0, 32)}`, 'PERSISTENCE_CONFLICT', 'Stored novelty decision id does not match its hash')
  return decision
}

/**
 * The candidates a workflow may actually submit. Everything else was refused
 * before a provider was ever contacted.
 */
export function acceptedNoveltyCandidates(decision: Readonly<NoveltyBudgetDecision>): readonly string[] {
  return Object.freeze(decision.lines.filter((line) => line.outcome !== 'blocked').map((line) => line.briefId))
}

/** Group contract lookup, so callers never re-derive risk from the mode. */
export function noveltyRiskLevel(mode: TransformationMode): number {
  return TRANSFORMATION_MODE_CONTRACTS[mode].riskLevel
}
