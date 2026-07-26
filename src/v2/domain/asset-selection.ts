import { calculateCanonicalHash } from './canonical-hash.ts'
import { DomainError } from './errors.ts'

export interface AssetBrief {
  intention: string
  content: readonly string[]
  style: readonly string[]
  durationMs: { min: number; max: number }
  entry: string
  exit: string
  prohibited: readonly string[]
}

export type AssetSource = 'library' | 'stock' | 'generated'
export interface AssetCandidate {
  id: string
  source: AssetSource
  content: readonly string[]
  style: readonly string[]
  durationMs: number
  rights: 'approved' | 'unknown' | 'denied'
  quality: number
  continuity: number
  novelty: number
  literalness: number
}

export interface AssetEvaluation {
  candidateId: string
  source: AssetSource
  score: number
  verdict: 'accepted' | 'rejected'
  reasons: readonly string[]
  dimensions: Readonly<
    Record<'relevance' | 'continuity' | 'quality' | 'rights' | 'novelty' | 'literalness', number>
  >
}

export interface AssetSelectionDecision {
  decision: 'use_asset' | 'no_insert'
  selectedId: string | null
  source: AssetSource | null
  evaluations: readonly AssetEvaluation[]
  searchStoppedBefore: readonly AssetSource[]
  auditId: string
}

export interface AssetCandidateRightsEvidence {
  artifactId: string
  artifactSha256: string
  outcome: 'allow' | 'deny'
  reasonCodes: readonly string[]
  rightsSnapshotId?: string
  rightsSnapshotHash?: string
  validUntil?: string
}

export interface AssetSelectionIntegrityContent {
  schemaVersion: 'asset-selection/v1'
  id: string
  workspaceId: string
  projectId: string
  projectVersionId: string
  projectVersionHash: string
  brief: Readonly<AssetBrief>
  briefHash: string
  candidates: readonly Readonly<AssetCandidate>[]
  candidatesHash: string
  rightsEvidence: readonly Readonly<AssetCandidateRightsEvidence>[]
  result: Readonly<AssetSelectionDecision>
  idempotencyKey: string
  requestFingerprint: string
  createdBy: Readonly<{ type: 'api-client'; id: string }>
  createdAt: string
}

export function calculateAssetSelectionRecordHash(
  input: Readonly<AssetSelectionIntegrityContent>,
): string {
  return calculateCanonicalHash(input)
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const ASSET_SOURCES = ['library', 'stock', 'generated'] as const

function boundedText(value: string, field: string, maximum: number): string {
  if (typeof value !== 'string') {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be a string`)
  }
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (normalized.length < 1 || normalized.length > maximum) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must contain 1 to ${maximum} characters`)
  }
  return normalized
}

function boundedTerms(
  values: readonly string[],
  field: string,
  options: { minimum: number; maximum: number },
): readonly string[] {
  if (!Array.isArray(values) || values.length < options.minimum || values.length > options.maximum) {
    throw new DomainError('INVALID_ARGUMENT', `${field} has an invalid number of terms`)
  }
  if (!values.every((value) => typeof value === 'string')) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must contain only strings`)
  }
  const normalized = values.map((value) => boundedText(value, field, 120).toLocaleLowerCase('pt-BR'))
  if (new Set(normalized).size !== normalized.length) {
    throw new DomainError('INVALID_ARGUMENT', `${field} cannot contain duplicate terms`)
  }
  return Object.freeze(normalized)
}

export function createAssetBrief(input: AssetBrief): Readonly<AssetBrief> {
  if (
    !Number.isSafeInteger(input.durationMs?.min) ||
    !Number.isSafeInteger(input.durationMs?.max) ||
    input.durationMs.min < 100 ||
    input.durationMs.max > 120_000 ||
    input.durationMs.max < input.durationMs.min
  ) {
    throw new DomainError('INVALID_ARGUMENT', 'AssetBrief duration range is invalid')
  }
  return Object.freeze({
    intention: boundedText(input.intention, 'AssetBrief intention', 500),
    content: boundedTerms(input.content, 'AssetBrief content', { minimum: 1, maximum: 32 }),
    style: boundedTerms(input.style, 'AssetBrief style', { minimum: 1, maximum: 24 }),
    durationMs: Object.freeze({ min: input.durationMs.min, max: input.durationMs.max }),
    entry: boundedText(input.entry, 'AssetBrief entry', 120),
    exit: boundedText(input.exit, 'AssetBrief exit', 120),
    prohibited: boundedTerms(input.prohibited, 'AssetBrief prohibited', { minimum: 0, maximum: 32 }),
  })
}

export function createAssetCandidate(input: AssetCandidate): Readonly<AssetCandidate> {
  if (
    !ID_PATTERN.test(input.id) ||
    !ASSET_SOURCES.includes(input.source) ||
    !Number.isSafeInteger(input.durationMs) ||
    input.durationMs < 100 ||
    input.durationMs > 120_000 ||
    !['approved', 'unknown', 'denied'].includes(input.rights) ||
    ![input.quality, input.continuity, input.novelty, input.literalness].every((value) =>
      Number.isFinite(value) && value >= 0 && value <= 1)
  ) {
    throw new DomainError('INVALID_ARGUMENT', 'Asset candidate is invalid')
  }
  return Object.freeze({
    id: input.id,
    source: input.source,
    content: boundedTerms(input.content, 'Asset candidate content', { minimum: 1, maximum: 64 }),
    style: boundedTerms(input.style, 'Asset candidate style', { minimum: 1, maximum: 32 }),
    durationMs: input.durationMs,
    rights: input.rights,
    quality: input.quality,
    continuity: input.continuity,
    novelty: input.novelty,
    literalness: input.literalness,
  })
}

function overlap(wanted: readonly string[], actual: readonly string[]): number {
  if (wanted.length === 0) return 1
  const normalized = new Set(actual.map((item) => item.toLowerCase()))
  return wanted.filter((item) => normalized.has(item.toLowerCase())).length / wanted.length
}

export function evaluateAssetCandidate(brief: AssetBrief, candidate: AssetCandidate): AssetEvaluation {
  const safeBrief = createAssetBrief(brief)
  const safeCandidate = createAssetCandidate(candidate)
  const relevance = overlap(safeBrief.content, safeCandidate.content)
  const styleFit = overlap(safeBrief.style, safeCandidate.style)
  const prohibited = safeBrief.prohibited.some((term) =>
    [...safeCandidate.content, ...safeCandidate.style].some((item) => item.includes(term)))
  const durationFit = safeCandidate.durationMs >= safeBrief.durationMs.min &&
    safeCandidate.durationMs <= safeBrief.durationMs.max
  const rights = safeCandidate.rights === 'approved' ? 1 : 0
  const novelty = safeCandidate.novelty <= 0.75
    ? 1 - Math.max(0, safeCandidate.novelty - 0.45)
    : 0
  const dimensions = Object.freeze({
    relevance,
    continuity: safeCandidate.continuity,
    quality: safeCandidate.quality,
    rights,
    novelty,
    literalness: 1 - safeCandidate.literalness,
  })
  const score = relevance * 0.32 + styleFit * 0.13 +
    safeCandidate.continuity * 0.2 + safeCandidate.quality * 0.15 +
    rights * 0.15 + novelty * 0.05
  const reasons = [
    ...(relevance < 0.5 ? ['irrelevant'] : []),
    ...(styleFit < 0.3 ? ['visual-conflict'] : []),
    ...(safeCandidate.continuity < 0.55 ? ['continuity-break'] : []),
    ...(safeCandidate.quality < 0.6 ? ['quality-below-threshold'] : []),
    ...(safeCandidate.novelty > 0.75 ? ['excessive-novelty'] : []),
    ...(safeCandidate.literalness > 0.8 ? ['too-literal'] : []),
    ...(!durationFit ? ['duration-mismatch'] : []),
    ...(safeCandidate.rights !== 'approved' ? ['rights-unavailable'] : []),
    ...(prohibited ? ['prohibited-element'] : []),
  ]
  if (reasons.length === 0 && score < 0.68) reasons.push('score-below-threshold')
  return Object.freeze({
    candidateId: safeCandidate.id,
    source: safeCandidate.source,
    score: Number(score.toFixed(4)),
    verdict: reasons.length === 0 ? 'accepted' : 'rejected',
    reasons: Object.freeze(reasons),
    dimensions,
  })
}

export function selectAsset(
  brief: AssetBrief,
  candidates: readonly AssetCandidate[],
): Readonly<AssetSelectionDecision> {
  const safeBrief = createAssetBrief(brief)
  if (!Array.isArray(candidates) || candidates.length > 100) {
    throw new DomainError('INVALID_ARGUMENT', 'Asset selection candidate count is invalid')
  }
  const safeCandidates = candidates.map(createAssetCandidate)
  if (new Set(safeCandidates.map((candidate) => candidate.id)).size !== safeCandidates.length) {
    throw new DomainError('INVALID_ARGUMENT', 'Asset selection candidate identities must be unique')
  }
  const sourceOrder: readonly AssetSource[] = ASSET_SOURCES
  const evaluations: AssetEvaluation[] = []
  for (const source of sourceOrder) {
    const sourceEvaluations = safeCandidates
      .filter((candidate) => candidate.source === source)
      .map((candidate) => evaluateAssetCandidate(safeBrief, candidate))
      .sort((left, right) => right.score - left.score || left.candidateId.localeCompare(right.candidateId))
    evaluations.push(...sourceEvaluations)
    const accepted = sourceEvaluations.find((item) => item.verdict === 'accepted')
    if (accepted) return Object.freeze({
      decision: 'use_asset' as const,
      selectedId: accepted.candidateId,
      source,
      evaluations: Object.freeze(evaluations),
      searchStoppedBefore: Object.freeze(sourceOrder.slice(sourceOrder.indexOf(source) + 1)),
      auditId: auditSelection(safeBrief, evaluations),
    })
  }
  return Object.freeze({
    decision: 'no_insert' as const,
    selectedId: null,
    source: null,
    evaluations: Object.freeze(evaluations),
    searchStoppedBefore: Object.freeze([] as AssetSource[]),
    auditId: auditSelection(safeBrief, evaluations),
  })
}

function auditSelection(brief: AssetBrief, evaluations: readonly AssetEvaluation[]) {
  return `asset_selection_${calculateCanonicalHash({ brief, evaluations })}`
}
