import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import { TRANSFORMATION_FALLBACKS, type TransformationBrief, type TransformationFallback } from './transformation-brief.ts'

/**
 * The transformation fallback ladder (FR-115).
 *
 * The ladder is canonical and versioned, but descending it is never mechanical.
 * Each rung has to keep satisfying the editorial intent the brief states; a
 * still-parallax that no longer says what the scene needed to say is not a
 * cheaper success, it is a failure that costs less. So a descent is always a
 * *decision*, always recorded, and always carries the reason it was taken.
 *
 * Three rules here exist because their absence would be silently expensive:
 *
 * - An artifact that violates protected content can never become the "best
 *   artifact", no matter how good it looks. Aesthetics do not buy back a
 *   changed face.
 * - `source-unchanged` is a valid, explicit decision — not an error and not a
 *   silent no-op. A workflow that reaches it has decided something.
 * - No derivative ever replaces the source. The source keeps its own id, key
 *   and bytes; every attempt is a sibling, never an overwrite.
 */

export const TRANSFORMATION_FALLBACK_LEDGER_VERSION = 'transformation-fallback-ledger/v1' as const

/**
 * The canonical order. A brief may skip rungs but may never reorder them: the
 * ladder descends from most faithful to the original intent to least, and
 * inverting it would mean preferring a cutaway over a video-to-video that
 * worked.
 */
export const CANONICAL_FALLBACK_LADDER = TRANSFORMATION_FALLBACKS

export const FALLBACK_DESCENT_REASONS = [
  'critic-rejected-protected-content',
  'critic-rejected-quality',
  'capability-unavailable',
  'provider-exhausted',
  'attempt-budget-exhausted',
  'novelty-budget-blocked',
  'rights-withdrawn',
  'intent-not-satisfied',
  'no-improvement',
] as const
export type FallbackDescentReason = (typeof FALLBACK_DESCENT_REASONS)[number]

export const FALLBACK_ATTEMPT_OUTCOMES = ['approved', 'rejected', 'failed', 'skipped'] as const
export type FallbackAttemptOutcome = (typeof FALLBACK_ATTEMPT_OUTCOMES)[number]

export const FALLBACK_REVIEW_DECISIONS = ['accepted', 'awaiting-review', 'kept-source'] as const
export type FallbackReviewDecision = (typeof FALLBACK_REVIEW_DECISIONS)[number]

export interface FallbackAttempt {
  /** Position in this ledger, append-only and gap-free. */
  sequence: number
  rung: TransformationFallback
  /** Absent when the rung was skipped without contacting any provider. */
  providerJobId?: string
  providerId?: string
  artifactId?: string
  artifactSha256?: string
  outcome: FallbackAttemptOutcome
  /**
   * How well this attempt satisfies the brief's editorial intent, in basis
   * points. Null when nothing was produced to score.
   */
  intentScoreBps: number | null
  criticReportHash?: string
  /** True only when the critic found a protected-content violation. */
  violatesProtectedContent: boolean
  estimatedCostMinorUnits: number
  observedCostMinorUnits: number
  costCurrency: string
  reason: string
  descendedBecause?: FallbackDescentReason
}

export interface TransformationFallbackLedger {
  schemaVersion: typeof TRANSFORMATION_FALLBACK_LEDGER_VERSION
  id: string
  workspaceId: string
  projectId: string
  projectVersionId: string
  briefId: string
  briefHash: string
  ladder: readonly TransformationFallback[]
  attempts: readonly Readonly<FallbackAttempt>[]
  /** The rung the workflow currently stands on. */
  currentRung: TransformationFallback
  /** The best valid artifact so far, or none if nothing valid was produced. */
  bestArtifactId: string | null
  bestArtifactSha256: string | null
  bestIntentScoreBps: number | null
  /** Every attempt's observed cost, including the ones that were rejected. */
  incurredCostMinorUnits: number
  costCurrency: string
  reviewDecision: FallbackReviewDecision
  /** The source artifact. Never replaced, only referenced. */
  sourceArtifactId: string
  sourceArtifactSha256: string
  createdAt: string
  updatedAt: string
  ledgerHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const CURRENCY = /^[A-Z]{3}$/

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

/**
 * The minimum intent score a rung must reach to be considered valid.
 *
 * Lower rungs are held to a lower bar on purpose — a cutaway is not expected to
 * carry the scene the way a video-to-video would — but never to *no* bar. A
 * still-parallax that says nothing is still a failure.
 */
const MINIMUM_INTENT_BPS: Readonly<Record<TransformationFallback, number>> = Object.freeze({
  'video-to-video': 7_500,
  'actor-composite': 7_000,
  'generated-cutaway': 6_500,
  'still-parallax': 6_000,
  // The source unchanged always satisfies the intent it started from: it is
  // the material the editor already accepted.
  'source-unchanged': 0,
})

export function minimumIntentScoreBps(rung: TransformationFallback): number {
  return MINIMUM_INTENT_BPS[rung]
}

export function isValidFallbackAttempt(attempt: Readonly<FallbackAttempt>): boolean {
  // A protected-content violation is disqualifying regardless of every other
  // number. This is the rule that stops a beautiful, wrong result from being
  // preserved as "the best we got".
  if (attempt.violatesProtectedContent) return false
  if (attempt.outcome !== 'approved') return false
  if (attempt.intentScoreBps === null) return false
  return attempt.intentScoreBps >= minimumIntentScoreBps(attempt.rung)
}

/**
 * The ladder a brief may actually descend.
 *
 * A brief may omit rungs but may not reorder them, and it must end at
 * `source-unchanged`: a ladder with no floor is a workflow that can run out of
 * options with nothing to fall back to.
 */
export function resolveFallbackLadder(brief: Readonly<TransformationBrief>): readonly TransformationFallback[] {
  const declared = brief.fallbackLadder
  const canonicalOrder = CANONICAL_FALLBACK_LADDER.filter((rung) => declared.includes(rung))
  assertDomain(
    canonicalOrder.length === declared.length && canonicalOrder.every((rung, index) => rung === declared[index]),
    'INVALID_ARGUMENT',
    'A brief may skip fallback rungs but never reorder them',
  )
  assertDomain(declared.at(-1) === 'source-unchanged', 'INVALID_ARGUMENT', 'A fallback ladder must end at source-unchanged')
  return canonicalOrder
}

export function nextFallbackRung(
  ladder: readonly TransformationFallback[],
  current: TransformationFallback,
): TransformationFallback | null {
  const index = ladder.indexOf(current)
  assertDomain(index >= 0, 'INVALID_ARGUMENT', 'The current rung is not on this ladder')
  return ladder[index + 1] ?? null
}

function sealLedger(body: Omit<TransformationFallbackLedger, 'id' | 'ledgerHash'>): Readonly<TransformationFallbackLedger> {
  const ledgerHash = calculateCanonicalHash(body)
  return Object.freeze({ ...body, id: `transformation-fallback-${ledgerHash.slice(0, 32)}`, ledgerHash })
}

export function createTransformationFallbackLedger(input: {
  workspaceId: string
  projectId: string
  projectVersionId: string
  brief: Readonly<TransformationBrief>
  sourceArtifactId: string
  sourceArtifactSha256: string
  costCurrency: string
  createdAt: string
}): Readonly<TransformationFallbackLedger> {
  const ladder = resolveFallbackLadder(input.brief)
  assertDomain(CURRENCY.test(input.costCurrency), 'INVALID_ARGUMENT', 'costCurrency is invalid')
  assertDomain(HASH.test(input.sourceArtifactSha256), 'INVALID_ARGUMENT', 'sourceArtifactSha256 is invalid')
  const createdAt = instant(input.createdAt, 'createdAt')
  return sealLedger({
    schemaVersion: TRANSFORMATION_FALLBACK_LEDGER_VERSION,
    workspaceId: id(input.workspaceId, 'workspaceId'),
    projectId: id(input.projectId, 'projectId'),
    projectVersionId: id(input.projectVersionId, 'projectVersionId'),
    briefId: input.brief.id,
    briefHash: input.brief.briefHash,
    ladder,
    attempts: Object.freeze([]),
    currentRung: ladder[0]!,
    bestArtifactId: null,
    bestArtifactSha256: null,
    bestIntentScoreBps: null,
    incurredCostMinorUnits: 0,
    costCurrency: input.costCurrency,
    reviewDecision: 'awaiting-review',
    sourceArtifactId: id(input.sourceArtifactId, 'sourceArtifactId'),
    sourceArtifactSha256: input.sourceArtifactSha256,
    createdAt,
    updatedAt: createdAt,
  })
}

/**
 * Record one attempt.
 *
 * The ledger is append-only. Cost accumulates across every attempt — including
 * the rejected ones, because a rejected provider result was still paid for —
 * and the best artifact only improves, never regresses.
 */
export function recordFallbackAttempt(input: {
  ledger: Readonly<TransformationFallbackLedger>
  attempt: Omit<FallbackAttempt, 'sequence'>
  occurredAt: string
}): Readonly<TransformationFallbackLedger> {
  const ledger = assertTransformationFallbackLedger(input.ledger)
  const occurredAt = instant(input.occurredAt, 'occurredAt')
  assertDomain(Date.parse(occurredAt) >= Date.parse(ledger.updatedAt), 'VERSION_CONFLICT', 'Fallback ledger time regressed')
  assertDomain(ledger.ladder.includes(input.attempt.rung), 'INVALID_ARGUMENT', 'Attempted rung is not on this ladder')
  assertDomain(
    ledger.ladder.indexOf(input.attempt.rung) >= ledger.ladder.indexOf(ledger.currentRung),
    'VERSION_CONFLICT',
    'A ladder descends; it never climbs back to a rung it already left',
  )
  assertDomain(CURRENCY.test(input.attempt.costCurrency), 'INVALID_ARGUMENT', 'attempt currency is invalid')
  assertDomain(
    input.attempt.costCurrency === ledger.costCurrency,
    'INVALID_ARGUMENT',
    'Attempts in a second currency would make the incurred total a number with no unit',
  )
  assertDomain(
    Number.isSafeInteger(input.attempt.observedCostMinorUnits) && input.attempt.observedCostMinorUnits >= 0 &&
      Number.isSafeInteger(input.attempt.estimatedCostMinorUnits) && input.attempt.estimatedCostMinorUnits >= 0,
    'INVALID_ARGUMENT',
    'Attempt costs must be non-negative integers',
  )
  if (input.attempt.intentScoreBps !== null) {
    assertDomain(
      Number.isSafeInteger(input.attempt.intentScoreBps) && input.attempt.intentScoreBps >= 0 && input.attempt.intentScoreBps <= 10_000,
      'INVALID_ARGUMENT',
      'intentScoreBps must be basis points',
    )
  }
  if (input.attempt.artifactId) {
    id(input.attempt.artifactId, 'attempt.artifactId')
    assertDomain(HASH.test(input.attempt.artifactSha256 ?? ''), 'INVALID_ARGUMENT', 'An attempt artifact needs its checksum')
    // The whole point of the ladder is that derivatives sit beside the source.
    assertDomain(
      input.attempt.artifactId !== ledger.sourceArtifactId,
      'PERSISTENCE_CONFLICT',
      'A transformation attempt may never claim the source artifact as its own output',
    )
  }
  if (input.attempt.outcome === 'approved') {
    assertDomain(
      Boolean(input.attempt.criticReportHash && HASH.test(input.attempt.criticReportHash)),
      'INVALID_ARGUMENT',
      'An approved attempt must name the critic report that approved it',
    )
  }
  if (input.attempt.rung === 'source-unchanged') {
    assertDomain(
      !input.attempt.artifactId && input.attempt.observedCostMinorUnits === 0,
      'INVALID_ARGUMENT',
      'Keeping the source produces no artifact and costs nothing',
    )
  }

  const attempt = Object.freeze({ ...input.attempt, sequence: ledger.attempts.length })
  const attempts = Object.freeze([...ledger.attempts, attempt])
  const valid = isValidFallbackAttempt(attempt)
  const improves = valid && (ledger.bestIntentScoreBps === null || attempt.intentScoreBps! > ledger.bestIntentScoreBps)

  const { id: _id, ledgerHash: _hash, ...body } = ledger
  return sealLedger({
    ...body,
    attempts,
    currentRung: attempt.rung,
    ...(improves
      ? {
          bestArtifactId: attempt.artifactId ?? null,
          bestArtifactSha256: attempt.artifactSha256 ?? null,
          bestIntentScoreBps: attempt.intentScoreBps,
        }
      : {}),
    incurredCostMinorUnits: ledger.incurredCostMinorUnits + attempt.observedCostMinorUnits,
    updatedAt: occurredAt,
  })
}

/**
 * Descend one rung.
 *
 * Descending is recorded as its own fact with its own reason, separate from the
 * attempt that triggered it, because "why did we end up on a cutaway" is a
 * question an editor will ask months later.
 */
export function descendFallbackLadder(input: {
  ledger: Readonly<TransformationFallbackLedger>
  because: FallbackDescentReason
  occurredAt: string
}): Readonly<TransformationFallbackLedger> {
  const ledger = assertTransformationFallbackLedger(input.ledger)
  const next = nextFallbackRung(ledger.ladder, ledger.currentRung)
  assertDomain(next !== null, 'PRECONDITION_REQUIRED', 'The ladder has no rung below this one')
  const occurredAt = instant(input.occurredAt, 'occurredAt')
  const attempt: FallbackAttempt = Object.freeze({
    sequence: ledger.attempts.length,
    rung: next,
    outcome: 'skipped',
    intentScoreBps: null,
    violatesProtectedContent: false,
    estimatedCostMinorUnits: 0,
    observedCostMinorUnits: 0,
    costCurrency: ledger.costCurrency,
    reason: descentReason(input.because),
    descendedBecause: input.because,
  })
  const { id: _id, ledgerHash: _hash, ...body } = ledger
  return sealLedger({
    ...body,
    attempts: Object.freeze([...ledger.attempts, attempt]),
    currentRung: next,
    updatedAt: occurredAt,
  })
}

function descentReason(reason: FallbackDescentReason): string {
  switch (reason) {
    case 'critic-rejected-protected-content':
      return 'the critic found a change to protected content; no amount of visual quality buys that back'
    case 'critic-rejected-quality':
      return 'the critic rejected the result on quality grounds at this rung'
    case 'capability-unavailable':
      return 'no registered provider offers this rung, so it is skipped without contacting an incompatible one'
    case 'provider-exhausted':
      return 'every eligible provider for this rung has been tried'
    case 'attempt-budget-exhausted':
      return 'the attempt budget for this rung is spent'
    case 'novelty-budget-blocked':
      return 'the novelty budget refuses another transformation at this position'
    case 'rights-withdrawn':
      return 'the rights that authorized this transformation are no longer in force'
    case 'intent-not-satisfied':
      return 'the result was technically valid but no longer said what the brief needed it to say'
    case 'no-improvement':
      return 'repeated attempts at this rung stopped improving the result'
  }
}

export function settleFallbackReview(input: {
  ledger: Readonly<TransformationFallbackLedger>
  decision: FallbackReviewDecision
  occurredAt: string
}): Readonly<TransformationFallbackLedger> {
  const ledger = assertTransformationFallbackLedger(input.ledger)
  if (input.decision === 'accepted') {
    assertDomain(
      ledger.bestArtifactId !== null,
      'PRECONDITION_REQUIRED',
      'There is no valid artifact to accept; the only honest outcomes here are keeping the source or continuing review',
    )
  }
  const { id: _id, ledgerHash: _hash, ...body } = ledger
  return sealLedger({ ...body, reviewDecision: input.decision, updatedAt: instant(input.occurredAt, 'occurredAt') })
}

export function assertTransformationFallbackLedger(
  ledger: Readonly<TransformationFallbackLedger>,
): Readonly<TransformationFallbackLedger> {
  assertDomain(ledger.schemaVersion === TRANSFORMATION_FALLBACK_LEDGER_VERSION, 'PERSISTENCE_CONFLICT', 'Stored fallback ledger schema is invalid')
  assertDomain(
    ledger.attempts.every((attempt, index) => attempt.sequence === index),
    'PERSISTENCE_CONFLICT',
    'Stored fallback attempts are not an append-only gap-free sequence',
  )
  // The invariant that matters most: a violating artifact can never be the best
  // one, so a stored ledger claiming otherwise is corrupt, not merely unusual.
  const best = ledger.attempts.find((attempt) => attempt.artifactId === ledger.bestArtifactId && ledger.bestArtifactId !== null)
  if (best) {
    assertDomain(
      !best.violatesProtectedContent,
      'PERSISTENCE_CONFLICT',
      'Stored fallback ledger names an artifact that violates protected content as its best',
    )
  }
  assertDomain(
    ledger.attempts.every((attempt) => attempt.artifactId !== ledger.sourceArtifactId),
    'PERSISTENCE_CONFLICT',
    'Stored fallback ledger has a derivative claiming the source artifact identity',
  )
  const { id, ledgerHash, ...body } = ledger
  assertDomain(calculateCanonicalHash(body) === ledgerHash, 'PERSISTENCE_CONFLICT', 'Stored fallback ledger hash does not match its body')
  assertDomain(id === `transformation-fallback-${ledgerHash.slice(0, 32)}`, 'PERSISTENCE_CONFLICT', 'Stored fallback ledger id does not match its hash')
  return ledger
}

/** What the editor may do next, given where the ladder stands. */
export function availableFallbackActions(ledger: Readonly<TransformationFallbackLedger>): readonly string[] {
  const actions: string[] = []
  if (ledger.bestArtifactId) actions.push('accept')
  if (ledger.attempts.some((attempt) => attempt.rung === ledger.currentRung && attempt.outcome !== 'skipped')) {
    actions.push('retry')
  }
  if (nextFallbackRung(ledger.ladder, ledger.currentRung) !== null) actions.push('descend')
  // Keeping the source is always available. It is a decision, not a failure.
  actions.push('keep-source')
  return Object.freeze(actions)
}
