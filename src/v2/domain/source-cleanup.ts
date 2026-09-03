import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import {
  type ContaminationFinding,
  type ContaminationReport,
  type NormalizedRegion,
} from './contamination-report.ts'
import { assertDomain } from './errors.ts'

export const SOURCE_CLEANUP_SCHEMA_VERSION = 'source-cleanup-plan/v1' as const
export const SOURCE_CLEANUP_POLICY_VERSION = 'source-cleanup-mvp/v1' as const
export const SOURCE_CLEANUP_REVIEW_SCHEMA_VERSION = 'post-cleanup-review/v1' as const

export const SOURCE_CLEANUP_STRATEGIES = [
  'trim',
  'crop-reframe',
  'cover',
  'separation',
  'reject',
] as const
export type SourceCleanupStrategy = (typeof SOURCE_CLEANUP_STRATEGIES)[number]

export interface SourceCleanupPolicy {
  minResidualQuality: number
  minIntegrity: number
  maxCost: number
  edgeTolerance: number
  maxCropFraction: number
  maxCoverArea: number
  coverColor: string
  costs: Readonly<Record<'trim' | 'crop-reframe' | 'cover', number>>
}

export interface SourceSeparationOffer {
  adapterId: string
  adapterVersion: string
  provider: string
  modelRef: string
  configHash: string
  capabilityHash: string
  minDurationMs: number
  maxDurationMs: number
  normalizedCost: number
  predictedSpeechRetention: number
  predictedMusicRemoval: number
  predictedIntegrity: number
  billing: Readonly<{
    unit: 'provider-characters'
    quantity: number
  }>
}

export type SourceCleanupAction =
  | Readonly<{
      strategy: 'trim'
      keepRangeMs: readonly [number, number]
      removedRangeMs: readonly [number, number]
    }>
  | Readonly<{
      strategy: 'crop-reframe'
      crop: Readonly<NormalizedRegion>
      removedRegion: Readonly<NormalizedRegion>
    }>
  | Readonly<{
      strategy: 'cover'
      rangeMs: readonly [number, number]
      region: Readonly<NormalizedRegion>
      color: string
    }>
  | Readonly<{
      strategy: 'separation'
      rangeMs: readonly [number, number]
      offer: Readonly<SourceSeparationOffer>
    }>
  | Readonly<{
      strategy: 'reject'
      reasonCodes: readonly string[]
    }>

export interface SourceCleanupCandidate {
  strategy: SourceCleanupStrategy
  eligible: boolean
  predictedResidualQuality: number
  predictedIntegrity: number
  cost: number
  score: number
  reasonCodes: readonly string[]
  action?: Exclude<SourceCleanupAction, { strategy: 'reject' }>
}

export interface SourceCleanupPlan {
  schemaVersion: typeof SOURCE_CLEANUP_SCHEMA_VERSION
  policyVersion: typeof SOURCE_CLEANUP_POLICY_VERSION
  id: string
  workspaceId: string
  projectId: string
  contaminationReportId: string
  contaminationReportHash: string
  findingId: string
  findingHash: string
  sourceArtifactId: string
  sourceArtifactSha256: string
  sourceManifestId: string
  sourceDurationMs: number
  sourceImmutable: true
  policy: Readonly<SourceCleanupPolicy>
  candidates: readonly Readonly<SourceCleanupCandidate>[]
  selectedStrategy: SourceCleanupStrategy
  selectedAction: Readonly<SourceCleanupAction>
  decision: 'execute' | 'reject'
  predictedResidualQuality: number
  predictedIntegrity: number
  predictedCost: number
  rightsSnapshotId?: string
  rightsSnapshotHash?: string
  rightsDecision: 'allow' | 'deny'
  rightsReasonCodes: readonly string[]
  operationId?: string
  outputArtifactId?: string
  outputManifestId?: string
  postCleanupReviewRequired: boolean
  createdByClientId: string
  createdAt: string
  planHash: string
}

export interface PostCleanupReview {
  schemaVersion: typeof SOURCE_CLEANUP_REVIEW_SCHEMA_VERSION
  cleanupPlanId: string
  cleanupPlanHash: string
  sourceArtifactId: string
  sourceArtifactSha256: string
  outputArtifactId: string
  outputArtifactSha256: string
  outputManifestId: string
  strategy: Exclude<SourceCleanupStrategy, 'reject'>
  visual: Readonly<{
    passed: boolean
    contaminationRemoved: boolean
    outputPlayable: boolean
    durationAligned: boolean
    framingPreserved: boolean
    residualQuality: number
    reasonCodes: readonly string[]
  }>
  audio?: Readonly<{
    passed: boolean
    providerBindingVerified: boolean
    isolatedSpeechPresent: boolean
    durationAligned: boolean
    reasonCodes: readonly string[]
  }>
  rights: Readonly<{
    passed: boolean
    sourceRightsSnapshotId: string
    sourceRightsSnapshotHash: string
    outputRightsSnapshotId: string
    outputRightsSnapshotHash: string
    use: 'editing'
    reasonCodes: readonly string[]
  }>
  passed: boolean
  reviewedAt: string
  reviewHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const COLOR = /^#[A-Fa-f0-9]{6}$/

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function hash(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && HASH.test(value),
    'INVALID_ARGUMENT',
    `${field} must be a lowercase SHA-256`,
  )
  return value
}

function score(value: unknown, field: string): number {
  assertDomain(
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1,
    'INVALID_ARGUMENT',
    `${field} must be between zero and one`,
  )
  return Number(value.toFixed(4))
}

function cost(value: unknown, field: string): number {
  assertDomain(
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000,
    'INVALID_ARGUMENT',
    `${field} must be a non-negative finite cost`,
  )
  return Number(value.toFixed(4))
}

function date(value: Date | string, field: string): string {
  const parsed = value instanceof Date ? value : new Date(value)
  assertDomain(!Number.isNaN(parsed.getTime()), 'INVALID_ARGUMENT', `${field} is invalid`)
  return parsed.toISOString()
}

function normalizePolicy(value: Readonly<SourceCleanupPolicy>): Readonly<SourceCleanupPolicy> {
  const normalized = {
    minResidualQuality: score(value.minResidualQuality, 'policy.minResidualQuality'),
    minIntegrity: score(value.minIntegrity, 'policy.minIntegrity'),
    maxCost: cost(value.maxCost, 'policy.maxCost'),
    edgeTolerance: score(value.edgeTolerance, 'policy.edgeTolerance'),
    maxCropFraction: score(value.maxCropFraction, 'policy.maxCropFraction'),
    maxCoverArea: score(value.maxCoverArea, 'policy.maxCoverArea'),
    coverColor: value.coverColor?.trim().toUpperCase(),
    costs: {
      trim: cost(value.costs?.trim, 'policy.costs.trim'),
      'crop-reframe': cost(value.costs?.['crop-reframe'], 'policy.costs.crop-reframe'),
      cover: cost(value.costs?.cover, 'policy.costs.cover'),
    },
  }
  assertDomain(
    normalized.edgeTolerance > 0 &&
      normalized.edgeTolerance <= 0.2 &&
      normalized.maxCropFraction > 0 &&
      normalized.maxCropFraction <= 0.4 &&
      normalized.maxCoverArea > 0 &&
      normalized.maxCoverArea <= 0.4 &&
      COLOR.test(normalized.coverColor),
    'INVALID_ARGUMENT',
    'Source cleanup policy limits are invalid',
  )
  return Object.freeze({
    ...normalized,
    costs: Object.freeze(normalized.costs),
  })
}

export function defaultSourceCleanupPolicy(): Readonly<SourceCleanupPolicy> {
  return normalizePolicy({
    minResidualQuality: 0.7,
    minIntegrity: 0.9,
    maxCost: 1,
    edgeTolerance: 0.04,
    maxCropFraction: 0.25,
    maxCoverArea: 0.12,
    coverColor: '#111111',
    costs: { trim: 0.1, 'crop-reframe': 0.2, cover: 0.3 },
  })
}

function intersectsTime(
  left: readonly [number, number],
  right: readonly [number, number],
): boolean {
  return Math.max(left[0], right[0]) < Math.min(left[1], right[1])
}

function normalizedArea(region: Readonly<NormalizedRegion>): number {
  return region.width * region.height
}

function cropCandidates(
  region: Readonly<NormalizedRegion>,
  edgeTolerance: number,
): readonly Readonly<NormalizedRegion>[] {
  const candidates: NormalizedRegion[] = []
  const right = region.x + region.width
  const bottom = region.y + region.height
  if (region.x <= edgeTolerance && right <= 1) {
    candidates.push({ x: right, y: 0, width: 1 - right, height: 1 })
  }
  if (1 - right <= edgeTolerance && region.x >= 0) {
    candidates.push({ x: 0, y: 0, width: region.x, height: 1 })
  }
  if (region.y <= edgeTolerance && bottom <= 1) {
    candidates.push({ x: 0, y: bottom, width: 1, height: 1 - bottom })
  }
  if (1 - bottom <= edgeTolerance && region.y >= 0) {
    candidates.push({ x: 0, y: 0, width: 1, height: region.y })
  }
  return Object.freeze(candidates
    .filter((candidate) => candidate.width > 0 && candidate.height > 0)
    .map((candidate) => Object.freeze({
      x: score(candidate.x, 'crop.x'),
      y: score(candidate.y, 'crop.y'),
      width: score(candidate.width, 'crop.width'),
      height: score(candidate.height, 'crop.height'),
    })))
}

function containsRegion(
  container: Readonly<NormalizedRegion>,
  subject: Readonly<NormalizedRegion>,
): boolean {
  const epsilon = 0.0001
  return subject.x + epsilon >= container.x &&
    subject.y + epsilon >= container.y &&
    subject.x + subject.width <= container.x + container.width + epsilon &&
    subject.y + subject.height <= container.y + container.height + epsilon
}

function trimCandidate(
  report: Readonly<ContaminationReport>,
  finding: Readonly<ContaminationFinding>,
  policy: Readonly<SourceCleanupPolicy>,
): Readonly<SourceCleanupCandidate> {
  const startsAtEdge = finding.rangeMs[0] <= report.sourceDurationMs * policy.edgeTolerance
  const endsAtEdge = report.sourceDurationMs - finding.rangeMs[1] <=
    report.sourceDurationMs * policy.edgeTolerance
  const keepRangeMs = startsAtEdge
    ? [finding.rangeMs[1], report.sourceDurationMs] as const
    : [0, finding.rangeMs[0]] as const
  const keepRatio = Math.max(0, (keepRangeMs[1] - keepRangeMs[0]) / report.sourceDurationMs)
  const eligible = (startsAtEdge || endsAtEdge) &&
    finding.removalImpact === 'safe' &&
    !finding.overlapsEssentialTime &&
    keepRatio >= policy.minResidualQuality
  const reasonCodes = [
    ...(!startsAtEdge && !endsAtEdge ? ['TEMPORAL_RANGE_NOT_AT_EDGE'] : []),
    ...(finding.removalImpact !== 'safe' ? ['REMOVAL_NOT_SAFE'] : []),
    ...(finding.overlapsEssentialTime ? ['ESSENTIAL_TIME_OVERLAP'] : []),
    ...(keepRatio < policy.minResidualQuality ? ['RESIDUAL_DURATION_TOO_LOW'] : []),
    ...(policy.costs.trim > policy.maxCost ? ['COST_LIMIT_EXCEEDED'] : []),
  ]
  const predictedIntegrity = finding.overlapsEssentialTime ? 0 : 1
  const costFit = policy.maxCost === 0
    ? Number(policy.costs.trim === 0)
    : Math.max(0, 1 - policy.costs.trim / policy.maxCost)
  const candidateScore = 0.45 * keepRatio + 0.4 * predictedIntegrity + 0.15 * costFit
  const withinCost = policy.costs.trim <= policy.maxCost
  return Object.freeze({
    strategy: 'trim',
    eligible: eligible && withinCost,
    predictedResidualQuality: score(keepRatio, 'trim residual quality'),
    predictedIntegrity,
    cost: policy.costs.trim,
    score: score(Math.max(0, Math.min(1, candidateScore)), 'trim score'),
    reasonCodes: Object.freeze(reasonCodes),
    ...(eligible && withinCost
      ? {
          action: Object.freeze({
            strategy: 'trim' as const,
            keepRangeMs: Object.freeze(keepRangeMs),
            removedRangeMs: Object.freeze([...finding.rangeMs] as [number, number]),
          }),
        }
      : {}),
  })
}

function cropCandidate(
  report: Readonly<ContaminationReport>,
  finding: Readonly<ContaminationFinding>,
  policy: Readonly<SourceCleanupPolicy>,
): Readonly<SourceCleanupCandidate> {
  const relevantProtected = report.protectedRegions.filter((protectedRegion) =>
    intersectsTime(protectedRegion.rangeMs, finding.rangeMs))
  const possible = finding.region
    ? cropCandidates(finding.region, policy.edgeTolerance)
      .filter((candidate) =>
        1 - normalizedArea(candidate) <= policy.maxCropFraction &&
        relevantProtected.every((protectedRegion) =>
          containsRegion(candidate, protectedRegion.region)))
      .toSorted((left, right) => normalizedArea(right) - normalizedArea(left))
    : []
  const crop = possible[0]
  const retainedArea = crop ? normalizedArea(crop) : 0
  const predictedIntegrity = finding.removalImpact === 'destructive' ||
    finding.protectedRegionIntersectionRatio > 0
    ? 0
    : 1
  const costFit = policy.maxCost === 0
    ? Number(policy.costs['crop-reframe'] === 0)
    : Math.max(0, 1 - policy.costs['crop-reframe'] / policy.maxCost)
  const candidateScore = 0.45 * retainedArea + 0.4 * predictedIntegrity + 0.15 * costFit
  const eligible = Boolean(crop) &&
    finding.kind !== 'music' &&
    finding.removalImpact !== 'destructive' &&
    retainedArea >= policy.minResidualQuality &&
    predictedIntegrity >= policy.minIntegrity &&
    policy.costs['crop-reframe'] <= policy.maxCost
  const reasonCodes = [
    ...(!finding.region ? ['VISUAL_REGION_REQUIRED'] : []),
    ...(finding.kind === 'music' ? ['AUDIO_SEPARATION_OUTSIDE_MVP'] : []),
    ...(finding.region && possible.length === 0 ? ['NO_SAFE_EDGE_CROP'] : []),
    ...(finding.removalImpact === 'destructive' ? ['REMOVAL_DESTRUCTIVE'] : []),
    ...(retainedArea < policy.minResidualQuality ? ['RESIDUAL_AREA_TOO_LOW'] : []),
    ...(predictedIntegrity < policy.minIntegrity ? ['INTEGRITY_BELOW_THRESHOLD'] : []),
    ...(policy.costs['crop-reframe'] > policy.maxCost ? ['COST_LIMIT_EXCEEDED'] : []),
  ]
  return Object.freeze({
    strategy: 'crop-reframe',
    eligible,
    predictedResidualQuality: score(retainedArea, 'crop residual quality'),
    predictedIntegrity,
    cost: policy.costs['crop-reframe'],
    score: score(Math.max(0, Math.min(1, candidateScore)), 'crop score'),
    reasonCodes: Object.freeze(reasonCodes),
    ...(eligible && crop && finding.region
      ? {
          action: Object.freeze({
            strategy: 'crop-reframe' as const,
            crop,
            removedRegion: Object.freeze({ ...finding.region }),
          }),
        }
      : {}),
  })
}

function coverCandidate(
  finding: Readonly<ContaminationFinding>,
  policy: Readonly<SourceCleanupPolicy>,
): Readonly<SourceCleanupCandidate> {
  const area = finding.region ? normalizedArea(finding.region) : 1
  const predictedResidualQuality = Math.max(0, 1 - area * 1.5)
  const predictedIntegrity = finding.removalImpact === 'safe' &&
    !finding.overlapsEssentialTime &&
    finding.protectedRegionIntersectionRatio === 0
    ? 1
    : 0
  const costFit = policy.maxCost === 0
    ? Number(policy.costs.cover === 0)
    : Math.max(0, 1 - policy.costs.cover / policy.maxCost)
  const candidateScore = 0.45 * predictedResidualQuality +
    0.4 * predictedIntegrity +
    0.15 * costFit
  const eligible = Boolean(finding.region) &&
    finding.kind !== 'music' &&
    area <= policy.maxCoverArea &&
    predictedResidualQuality >= policy.minResidualQuality &&
    predictedIntegrity >= policy.minIntegrity &&
    policy.costs.cover <= policy.maxCost
  const reasonCodes = [
    ...(!finding.region ? ['VISUAL_REGION_REQUIRED'] : []),
    ...(finding.kind === 'music' ? ['AUDIO_SEPARATION_OUTSIDE_MVP'] : []),
    ...(area > policy.maxCoverArea ? ['COVER_AREA_TOO_LARGE'] : []),
    ...(finding.removalImpact !== 'safe' ? ['REMOVAL_NOT_SAFE'] : []),
    ...(finding.overlapsEssentialTime ? ['ESSENTIAL_TIME_OVERLAP'] : []),
    ...(finding.protectedRegionIntersectionRatio > 0 ? ['PROTECTED_REGION_OVERLAP'] : []),
    ...(predictedResidualQuality < policy.minResidualQuality ? ['RESIDUAL_QUALITY_TOO_LOW'] : []),
    ...(policy.costs.cover > policy.maxCost ? ['COST_LIMIT_EXCEEDED'] : []),
  ]
  return Object.freeze({
    strategy: 'cover',
    eligible,
    predictedResidualQuality: score(predictedResidualQuality, 'cover residual quality'),
    predictedIntegrity,
    cost: policy.costs.cover,
    score: score(Math.max(0, Math.min(1, candidateScore)), 'cover score'),
    reasonCodes: Object.freeze(reasonCodes),
    ...(eligible && finding.region
      ? {
          action: Object.freeze({
            strategy: 'cover' as const,
            rangeMs: Object.freeze([...finding.rangeMs] as [number, number]),
            region: Object.freeze({ ...finding.region }),
            color: policy.coverColor,
          }),
        }
      : {}),
  })
}

function normalizeSeparationOffer(
  value: Readonly<SourceSeparationOffer>,
): Readonly<SourceSeparationOffer> {
  const minDurationMs = Number(value.minDurationMs)
  const maxDurationMs = Number(value.maxDurationMs)
  const quantity = Number(value.billing?.quantity)
  assertDomain(
    Number.isSafeInteger(minDurationMs) && minDurationMs >= 1 &&
      Number.isSafeInteger(maxDurationMs) && maxDurationMs >= minDurationMs && maxDurationMs <= 3_600_000 &&
      Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= 60_000 &&
      value.billing?.unit === 'provider-characters',
    'INVALID_ARGUMENT',
    'Source separation offer limits are invalid',
  )
  return Object.freeze({
    adapterId: identity(value.adapterId, 'separation adapterId'),
    adapterVersion: identity(value.adapterVersion, 'separation adapterVersion'),
    provider: identity(value.provider, 'separation provider'),
    modelRef: identity(value.modelRef, 'separation modelRef'),
    configHash: hash(value.configHash, 'separation configHash'),
    capabilityHash: hash(value.capabilityHash, 'separation capabilityHash'),
    minDurationMs,
    maxDurationMs,
    normalizedCost: cost(value.normalizedCost, 'separation normalizedCost'),
    predictedSpeechRetention: score(
      value.predictedSpeechRetention,
      'separation predictedSpeechRetention',
    ),
    predictedMusicRemoval: score(
      value.predictedMusicRemoval,
      'separation predictedMusicRemoval',
    ),
    predictedIntegrity: score(
      value.predictedIntegrity,
      'separation predictedIntegrity',
    ),
    billing: Object.freeze({
      unit: 'provider-characters' as const,
      quantity,
    }),
  })
}

function separationCandidate(
  report: Readonly<ContaminationReport>,
  finding: Readonly<ContaminationFinding>,
  policy: Readonly<SourceCleanupPolicy>,
  offerValue?: Readonly<SourceSeparationOffer>,
): Readonly<SourceCleanupCandidate> {
  const offer = offerValue
    ? normalizeSeparationOffer(offerValue)
    : undefined
  const signals = finding.kind === 'music'
    ? finding.signals as Readonly<{
        musicLikelihood: number
        speechLikelihood: number
        separableStem: boolean
      }>
    : undefined
  const predictedResidualQuality = offer
    ? Math.min(offer.predictedSpeechRetention, offer.predictedMusicRemoval)
    : 0
  const predictedIntegrity = offer?.predictedIntegrity ?? 0
  const candidateCost = offer?.normalizedCost ?? 0
  const costFit = policy.maxCost === 0
    ? Number(candidateCost === 0)
    : Math.max(0, 1 - candidateCost / policy.maxCost)
  const candidateScore = 0.45 * predictedResidualQuality +
    0.4 * predictedIntegrity + 0.15 * costFit
  const eligible = Boolean(
    offer &&
      signals?.separableStem &&
      signals.speechLikelihood > 0 &&
      report.sourceDurationMs >= offer.minDurationMs &&
      report.sourceDurationMs <= offer.maxDurationMs &&
      candidateCost <= policy.maxCost &&
      predictedResidualQuality >= policy.minResidualQuality &&
      predictedIntegrity >= policy.minIntegrity,
  )
  const reasonCodes = [
    ...(finding.kind !== 'music' ? ['MUSIC_FINDING_REQUIRED'] : []),
    ...(!offer ? ['SOURCE_SEPARATION_PROVIDER_UNAVAILABLE'] : []),
    ...(signals && !signals.separableStem ? ['SOURCE_STEM_NOT_SEPARABLE'] : []),
    ...(signals && signals.speechLikelihood <= 0 ? ['SOURCE_SPEECH_NOT_DETECTED'] : []),
    ...(offer && report.sourceDurationMs > offer.maxDurationMs
      ? ['SOURCE_DURATION_EXCEEDS_PROVIDER_LIMIT']
      : []),
    ...(offer && report.sourceDurationMs < offer.minDurationMs
      ? ['SOURCE_DURATION_BELOW_PROVIDER_LIMIT']
      : []),
    ...(candidateCost > policy.maxCost ? ['COST_LIMIT_EXCEEDED'] : []),
    ...(predictedResidualQuality < policy.minResidualQuality
      ? ['RESIDUAL_QUALITY_TOO_LOW']
      : []),
    ...(predictedIntegrity < policy.minIntegrity
      ? ['INTEGRITY_BELOW_THRESHOLD']
      : []),
  ]
  return Object.freeze({
    strategy: 'separation',
    eligible,
    predictedResidualQuality: score(
      predictedResidualQuality,
      'separation residual quality',
    ),
    predictedIntegrity: score(
      predictedIntegrity,
      'separation integrity',
    ),
    cost: candidateCost,
    score: score(
      Math.max(0, Math.min(1, candidateScore)),
      'separation score',
    ),
    reasonCodes: Object.freeze(reasonCodes),
    ...(eligible && offer
      ? {
          action: Object.freeze({
            strategy: 'separation' as const,
            rangeMs: Object.freeze([...finding.rangeMs] as [number, number]),
            offer,
          }),
        }
      : {}),
  })
}

function freezeCandidate(candidate: Readonly<SourceCleanupCandidate>): Readonly<SourceCleanupCandidate> {
  return Object.freeze({
    ...candidate,
    reasonCodes: Object.freeze([...candidate.reasonCodes]),
    ...(candidate.action
      ? {
          action: Object.freeze({
            ...candidate.action,
            ...(candidate.action.strategy === 'trim'
              ? {
                  keepRangeMs: Object.freeze([...candidate.action.keepRangeMs] as [number, number]),
                  removedRangeMs: Object.freeze([...candidate.action.removedRangeMs] as [number, number]),
                }
              : candidate.action.strategy === 'crop-reframe'
                ? {
                    crop: Object.freeze({ ...candidate.action.crop }),
                    removedRegion: Object.freeze({ ...candidate.action.removedRegion }),
                  }
                : candidate.action.strategy === 'cover'
                  ? {
                    rangeMs: Object.freeze([...candidate.action.rangeMs] as [number, number]),
                    region: Object.freeze({ ...candidate.action.region }),
                  }
                  : {
                      rangeMs: Object.freeze([...candidate.action.rangeMs] as [number, number]),
                      offer: Object.freeze({
                        ...candidate.action.offer,
                        billing: Object.freeze({ ...candidate.action.offer.billing }),
                      }),
                    }),
          }) as Exclude<SourceCleanupAction, { strategy: 'reject' }>,
        }
      : {}),
  })
}

export function createSourceCleanupPlan(input: {
  id: string
  report: Readonly<ContaminationReport>
  expectedReportHash: string
  findingId: string
  sourceManifestId: string
  policy?: Readonly<SourceCleanupPolicy>
  separationOffer?: Readonly<SourceSeparationOffer>
  rights: Readonly<{
    outcome: 'allow' | 'deny'
    reasonCodes: readonly string[]
    rightsSnapshotId?: string
    rightsSnapshotHash?: string
  }>
  createdByClientId: string
  createdAt: Date | string
}): Readonly<SourceCleanupPlan> {
  const id = identity(input.id, 'cleanup plan id')
  const expectedReportHash = hash(input.expectedReportHash, 'expectedReportHash')
  assertDomain(
    input.report.reportHash === expectedReportHash,
    'CONTAMINATION_REPORT_REVISION_MISMATCH',
    'Contamination report hash does not match the requested cleanup base',
  )
  const findingId = identity(input.findingId, 'findingId')
  const sourceManifestId = identity(input.sourceManifestId, 'sourceManifestId')
  const finding = input.report.findings.find((candidate) => candidate.id === findingId)
  assertDomain(Boolean(finding), 'INVALID_ARGUMENT', 'Cleanup finding was not found in the report')
  const policy = normalizePolicy(input.policy ?? defaultSourceCleanupPolicy())
  const candidates = Object.freeze([
    trimCandidate(input.report, finding!, policy),
    cropCandidate(input.report, finding!, policy),
    coverCandidate(finding!, policy),
    ...(finding!.kind === 'music' && input.separationOffer
      ? [separationCandidate(input.report, finding!, policy, input.separationOffer)]
      : []),
  ].map(freezeCandidate))
  const viable = candidates
    .filter((candidate) => candidate.eligible && candidate.action)
    .toSorted((left, right) =>
      right.score - left.score ||
      SOURCE_CLEANUP_STRATEGIES.indexOf(left.strategy) -
        SOURCE_CLEANUP_STRATEGIES.indexOf(right.strategy))
  const rightsReasonCodes = Object.freeze([...new Set(input.rights.reasonCodes)].sort())
  const selected = input.rights.outcome === 'allow' ? viable[0] : undefined
  const selectedAction: Readonly<SourceCleanupAction> = selected?.action
    ? selected.action
    : Object.freeze({
        strategy: 'reject',
        reasonCodes: Object.freeze([
          ...(input.rights.outcome === 'deny' ? ['RIGHTS_REEVALUATION_DENIED'] : []),
          ...rightsReasonCodes,
          ...candidates.flatMap((candidate) => candidate.reasonCodes),
          ...(viable.length === 0 ? ['NO_MVP_STRATEGY_MEETS_THRESHOLDS'] : []),
        ].filter((value, index, values) => values.indexOf(value) === index).sort()),
      })
  const selectedStrategy = selectedAction.strategy
  const decision = selectedStrategy === 'reject' ? 'reject' as const : 'execute' as const
  const createdAt = date(input.createdAt, 'createdAt')
  const createdByClientId = identity(input.createdByClientId, 'createdByClientId')
  const decisionContent = {
    schemaVersion: SOURCE_CLEANUP_SCHEMA_VERSION,
    policyVersion: SOURCE_CLEANUP_POLICY_VERSION,
    workspaceId: input.report.workspaceId,
    projectId: input.report.projectId,
    contaminationReportId: input.report.id,
    contaminationReportHash: input.report.reportHash,
    findingId,
    findingHash: finding!.findingHash,
    sourceArtifactId: input.report.sourceArtifactId,
    sourceArtifactSha256: input.report.sourceArtifactSha256,
    sourceManifestId,
    sourceDurationMs: input.report.sourceDurationMs,
    sourceImmutable: true as const,
    policy,
    candidates,
    selectedStrategy,
    selectedAction,
    decision,
    predictedResidualQuality: selected?.predictedResidualQuality ?? 0,
    predictedIntegrity: selected?.predictedIntegrity ?? 0,
    predictedCost: selected?.cost ?? 0,
    rightsSnapshotId: input.rights.rightsSnapshotId,
    rightsSnapshotHash: input.rights.rightsSnapshotHash,
    rightsDecision: input.rights.outcome,
    rightsReasonCodes,
    postCleanupReviewRequired: decision === 'execute',
    createdByClientId,
    createdAt,
  }
  const planHash = calculateCanonicalHash(decisionContent)
  const operationId = decision === 'execute'
    ? `operation-cleanup-${planHash.slice(0, 24)}`
    : undefined
  const outputArtifactId = decision === 'execute'
    ? `artifact-cleanup-${planHash.slice(0, 32)}`
    : undefined
  const outputManifestId = decision === 'execute'
    ? `manifest-cleanup-${planHash.slice(0, 32)}`
    : undefined
  return Object.freeze({
    ...decisionContent,
    id,
    ...(operationId ? { operationId } : {}),
    ...(outputArtifactId ? { outputArtifactId } : {}),
    ...(outputManifestId ? { outputManifestId } : {}),
    planHash,
  })
}

export function createPostCleanupReview(input: {
  plan: Readonly<SourceCleanupPlan>
  outputArtifactId: string
  outputArtifactSha256: string
  outputManifestId: string
  outputRightsSnapshotId: string
  outputRightsSnapshotHash: string
  visual: Omit<PostCleanupReview['visual'], 'reasonCodes'> & {
    reasonCodes: readonly string[]
  }
  audio?: Omit<NonNullable<PostCleanupReview['audio']>, 'reasonCodes'> & {
    reasonCodes: readonly string[]
  }
  rightsReasonCodes?: readonly string[]
  reviewedAt: Date | string
}): Readonly<PostCleanupReview> {
  assertDomain(
    input.plan.decision === 'execute' &&
      input.plan.selectedStrategy !== 'reject' &&
      input.plan.postCleanupReviewRequired &&
      input.plan.outputArtifactId === input.outputArtifactId &&
      input.plan.outputManifestId === input.outputManifestId &&
      Boolean(input.plan.rightsSnapshotId && input.plan.rightsSnapshotHash),
    'INVALID_ARGUMENT',
    'Executed cleanup plan is required for post-cleanup review',
  )
  const visual = Object.freeze({
    passed: Boolean(input.visual.passed),
    contaminationRemoved: Boolean(input.visual.contaminationRemoved),
    outputPlayable: Boolean(input.visual.outputPlayable),
    durationAligned: Boolean(input.visual.durationAligned),
    framingPreserved: Boolean(input.visual.framingPreserved),
    residualQuality: score(input.visual.residualQuality, 'visual.residualQuality'),
    reasonCodes: Object.freeze([...new Set(input.visual.reasonCodes)].sort()),
  })
  const rightsReasonCodes = Object.freeze([
    ...new Set(input.rightsReasonCodes ?? []),
  ].sort())
  const audio = input.audio
    ? Object.freeze({
        passed: Boolean(input.audio.passed),
        providerBindingVerified: Boolean(input.audio.providerBindingVerified),
        isolatedSpeechPresent: Boolean(input.audio.isolatedSpeechPresent),
        durationAligned: Boolean(input.audio.durationAligned),
        reasonCodes: Object.freeze([...new Set(input.audio.reasonCodes)].sort()),
      })
    : undefined
  assertDomain(
    (input.plan.selectedStrategy === 'separation') === Boolean(audio),
    'INVALID_ARGUMENT',
    'Source separation review requires exact audio evidence',
  )
  const rights = Object.freeze({
    passed: rightsReasonCodes.length === 0,
    sourceRightsSnapshotId: identity(input.plan.rightsSnapshotId!, 'sourceRightsSnapshotId'),
    sourceRightsSnapshotHash: hash(input.plan.rightsSnapshotHash!, 'sourceRightsSnapshotHash'),
    outputRightsSnapshotId: identity(input.outputRightsSnapshotId, 'outputRightsSnapshotId'),
    outputRightsSnapshotHash: hash(input.outputRightsSnapshotHash, 'outputRightsSnapshotHash'),
    use: 'editing' as const,
    reasonCodes: rightsReasonCodes,
  })
  const content = {
    schemaVersion: SOURCE_CLEANUP_REVIEW_SCHEMA_VERSION,
    cleanupPlanId: input.plan.id,
    cleanupPlanHash: input.plan.planHash,
    sourceArtifactId: input.plan.sourceArtifactId,
    sourceArtifactSha256: input.plan.sourceArtifactSha256,
    outputArtifactId: identity(input.outputArtifactId, 'outputArtifactId'),
    outputArtifactSha256: hash(input.outputArtifactSha256, 'outputArtifactSha256'),
    outputManifestId: identity(input.outputManifestId, 'outputManifestId'),
    strategy: input.plan.selectedStrategy,
    visual,
    ...(audio ? { audio } : {}),
    rights,
    passed: visual.passed && rights.passed && (audio?.passed ?? true),
    reviewedAt: date(input.reviewedAt, 'reviewedAt'),
  }
  const reviewHash = calculateCanonicalHash(content)
  return Object.freeze({ ...content, reviewHash }) as Readonly<PostCleanupReview>
}

export function hydrateSourceCleanupPlan(
  value: Readonly<SourceCleanupPlan>,
  report: Readonly<ContaminationReport>,
): Readonly<SourceCleanupPlan> {
  const rebuilt = createSourceCleanupPlan({
    id: value.id,
    report,
    expectedReportHash: value.contaminationReportHash,
    findingId: value.findingId,
    sourceManifestId: value.sourceManifestId,
    policy: value.policy,
    ...(value.selectedAction.strategy === 'separation'
      ? { separationOffer: value.selectedAction.offer }
      : {}),
    rights: {
      outcome: value.rightsDecision,
      reasonCodes: value.rightsReasonCodes,
      ...(value.rightsSnapshotId ? { rightsSnapshotId: value.rightsSnapshotId } : {}),
      ...(value.rightsSnapshotHash ? { rightsSnapshotHash: value.rightsSnapshotHash } : {}),
    },
    createdByClientId: value.createdByClientId,
    createdAt: value.createdAt,
  })
  assertDomain(
    stableSerialize(rebuilt) === stableSerialize(value) &&
      rebuilt.planHash === value.planHash,
    'PERSISTENCE_CONFLICT',
    'Stored source cleanup plan is inconsistent',
  )
  return rebuilt
}

export function hydratePostCleanupReview(
  value: Readonly<PostCleanupReview>,
  plan: Readonly<SourceCleanupPlan>,
): Readonly<PostCleanupReview> {
  const rebuilt = createPostCleanupReview({
    plan,
    outputArtifactId: value.outputArtifactId,
    outputArtifactSha256: value.outputArtifactSha256,
    outputManifestId: value.outputManifestId,
    outputRightsSnapshotId: value.rights.outputRightsSnapshotId,
    outputRightsSnapshotHash: value.rights.outputRightsSnapshotHash,
    visual: value.visual,
    ...(value.audio ? { audio: value.audio } : {}),
    rightsReasonCodes: value.rights.reasonCodes,
    reviewedAt: value.reviewedAt,
  })
  assertDomain(
    stableSerialize(rebuilt) === stableSerialize(value) &&
      rebuilt.reviewHash === value.reviewHash,
    'PERSISTENCE_CONFLICT',
    'Stored post-cleanup review is inconsistent',
  )
  return rebuilt
}
