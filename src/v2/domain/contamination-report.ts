import {
  calculateCanonicalHash,
  stableSerialize,
} from './canonical-hash.ts'
import { assertDomain, DomainError } from './errors.ts'
import {
  hydrateSourceDeconstructionReport,
  type SourceDeconstructionReport,
} from './source-deconstruction.ts'

export const CONTAMINATION_REPORT_SCHEMA_VERSION =
  'contamination-report/v1' as const
export const CONTAMINATION_POLICY_VERSION =
  'source-contamination/v1' as const

export const CONTAMINATION_KINDS = [
  'burned-caption',
  'logo-watermark',
  'music',
  'border',
  'overlay',
] as const
export type ContaminationKind =
  typeof CONTAMINATION_KINDS[number]

export const CONTAMINATION_DECISIONS = [
  'cleanup-eligible',
  'human-review',
  'manual-preservation-required',
] as const
export type ContaminationDecision =
  typeof CONTAMINATION_DECISIONS[number]

export const CONTAMINATION_REMOVAL_IMPACTS = [
  'safe',
  'review-required',
  'destructive',
] as const
export type ContaminationRemovalImpact =
  typeof CONTAMINATION_REMOVAL_IMPACTS[number]

export const PROTECTED_REGION_KINDS = [
  'face',
  'speaker',
  'essential-text',
  'product',
  'screen-content',
] as const
export type ProtectedRegionKind =
  typeof PROTECTED_REGION_KINDS[number]

export interface NormalizedRegion {
  x: number
  y: number
  width: number
  height: number
}

export interface ContaminationDetector {
  provider: string
  model: string
  version: string
}

export interface BurnedCaptionSignals {
  text: string
  textTrackMatch: number
  frameCoverage: number
  foregroundContrast: number
}

export interface LogoWatermarkSignals {
  label: string
  logoMatch: number
  frameCoverage: number
  opacity: number
}

export interface MusicSignals {
  musicLikelihood: number
  speechLikelihood: number
  separableStem: boolean
  spectralPersistence: number
}

export interface BorderSignals {
  edges: readonly ('top' | 'right' | 'bottom' | 'left')[]
  uniformity: number
  thicknessRatio: number
  frameCoverage: number
}

export interface OverlaySignals {
  overlayClass: string
  frameCoverage: number
  opacity: number
  occludesSubject: boolean
}

export type ContaminationSignals =
  | BurnedCaptionSignals
  | LogoWatermarkSignals
  | MusicSignals
  | BorderSignals
  | OverlaySignals

interface ContaminationObservationBase {
  id: string
  rangeMs: readonly [number, number]
  confidence: number
  detector: Readonly<ContaminationDetector>
}

export type ContaminationObservation =
  | (ContaminationObservationBase & {
      kind: 'burned-caption'
      region: Readonly<NormalizedRegion>
      signals: Readonly<BurnedCaptionSignals>
    })
  | (ContaminationObservationBase & {
      kind: 'logo-watermark'
      region: Readonly<NormalizedRegion>
      signals: Readonly<LogoWatermarkSignals>
    })
  | (ContaminationObservationBase & {
      kind: 'music'
      region: null
      signals: Readonly<MusicSignals>
    })
  | (ContaminationObservationBase & {
      kind: 'border'
      region: Readonly<NormalizedRegion>
      signals: Readonly<BorderSignals>
    })
  | (ContaminationObservationBase & {
      kind: 'overlay'
      region: Readonly<NormalizedRegion>
      signals: Readonly<OverlaySignals>
    })

export interface ContaminationProtectedRegion {
  id: string
  kind: ProtectedRegionKind
  rangeMs: readonly [number, number]
  region: Readonly<NormalizedRegion>
  confidence: number
  source: string
  regionHash: string
}

export interface ContaminationPolicy {
  minObservationConfidence: number
  minAutomaticConfidence: number
  protectedIntersectionReviewRatio: number
  protectedIntersectionDestructiveRatio: number
  lowConfidenceRequiresReview: boolean
}

export interface ContaminationFinding {
  id: string
  observationId: string
  kind: ContaminationKind
  rangeMs: readonly [number, number]
  region: Readonly<NormalizedRegion> | null
  confidence: number
  detector: Readonly<ContaminationDetector>
  signals: Readonly<ContaminationSignals>
  overlapsEssentialTime: boolean
  essentialOverlapRatio: number
  protectedRegionIds: readonly string[]
  protectedRegionIntersectionRatio: number
  removalImpact: ContaminationRemovalImpact
  removalWouldDestroyEssential: boolean
  requiresHumanReview: boolean
  reasonCodes: readonly string[]
  observationHash: string
  findingHash: string
}

export interface ContaminationOverlap {
  id: string
  leftFindingId: string
  rightFindingId: string
  rangeMs: readonly [number, number]
  spatiallyOverlapping: boolean
  intersectionRegion: Readonly<NormalizedRegion> | null
  confidence: number
  overlapHash: string
}

export interface DirectorContaminationDiagnostic {
  findingId: string
  code: ContaminationKind
  severity: 'information' | 'warning' | 'blocking'
  rangeMs: readonly [number, number]
  region: Readonly<NormalizedRegion> | null
  confidence: number
  removalDecision: 'eligible' | 'review' | 'blocked'
  reasonCodes: readonly string[]
  message: string
}

export interface HumanContaminationDiagnostic {
  findingId: string
  reviewRequired: boolean
  rangeMs: readonly [number, number]
  region: Readonly<NormalizedRegion> | null
  compareSource: true
  question: string
  reasonCodes: readonly string[]
}

export interface ContaminationReport {
  schemaVersion: typeof CONTAMINATION_REPORT_SCHEMA_VERSION
  id: string
  workspaceId: string
  projectId: string
  sourceDeconstructionReportId: string
  sourceDeconstructionReportHash: string
  sourceArtifactId: string
  sourceArtifactSha256: string
  sourceDurationMs: number
  analyzer: Readonly<{
    provider: string
    model: string
    version: string
    observationBatchHash: string
  }>
  policy: Readonly<
    ContaminationPolicy & {
      version: typeof CONTAMINATION_POLICY_VERSION
    }
  >
  observations: readonly Readonly<ContaminationObservation>[]
  protectedRegions:
    readonly Readonly<ContaminationProtectedRegion>[]
  findings: readonly Readonly<ContaminationFinding>[]
  overlaps: readonly Readonly<ContaminationOverlap>[]
  summary: Readonly<{
    findingCount: number
    observationCount: number
    protectedRegionCount: number
    overlapCount: number
    countsByKind: Readonly<Record<ContaminationKind, number>>
    safeCount: number
    reviewCount: number
    destructiveCount: number
  }>
  diagnostics: Readonly<{
    director:
      readonly Readonly<DirectorContaminationDiagnostic>[]
    humanReview:
      readonly Readonly<HumanContaminationDiagnostic>[]
  }>
  decision: ContaminationDecision
  humanReviewRequired: boolean
  confidence: number
  createdByClientId: string
  createdAt: string
  reportHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const TOKEN = /^[a-z0-9][a-z0-9._:/-]{0,127}$/
const HASH = /^[a-f0-9]{64}$/

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function token(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && TOKEN.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function text(
  value: unknown,
  field: string,
  minimum = 1,
  maximum = 4_000,
): string {
  assertDomain(
    typeof value === 'string' &&
      value.trim().length >= minimum &&
      value.trim().length <= maximum,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function sha256(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && HASH.test(value),
    'INVALID_ARGUMENT',
    `${field} must be a lowercase SHA-256`,
  )
  return value
}

function integer(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  assertDomain(
    Number.isSafeInteger(value) &&
      Number(value) >= minimum &&
      Number(value) <= maximum,
    'INVALID_ARGUMENT',
    `${field} must be an integer between ${minimum} and ${maximum}`,
  )
  return Number(value)
}

function score(value: unknown, field: string): number {
  assertDomain(
    typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1,
    'INVALID_ARGUMENT',
    `${field} must be between zero and one`,
  )
  return Number(value.toFixed(4))
}

function range(
  value: unknown,
  durationMs: number,
  field: string,
): readonly [number, number] {
  assertDomain(
    Array.isArray(value) && value.length === 2,
    'INVALID_ARGUMENT',
    `${field} must contain start and end`,
  )
  const start = integer(value[0], `${field}[0]`, 0, durationMs)
  const end = integer(value[1], `${field}[1]`, 1, durationMs)
  assertDomain(
    end > start,
    'INVALID_ARGUMENT',
    `${field} must have positive duration`,
  )
  return Object.freeze([start, end])
}

function region(
  value: unknown,
  field: string,
): Readonly<NormalizedRegion> {
  assertDomain(
    typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value),
    'INVALID_ARGUMENT',
    `${field} must be a normalized region`,
  )
  const candidate = value as Partial<NormalizedRegion>
  const normalized = {
    x: score(candidate.x, `${field}.x`),
    y: score(candidate.y, `${field}.y`),
    width: score(candidate.width, `${field}.width`),
    height: score(candidate.height, `${field}.height`),
  }
  assertDomain(
    normalized.width > 0 &&
      normalized.height > 0 &&
      normalized.x + normalized.width <= 1.0001 &&
      normalized.y + normalized.height <= 1.0001,
    'INVALID_ARGUMENT',
    `${field} exceeds the normalized canvas`,
  )
  return Object.freeze(normalized)
}

function detector(
  value: unknown,
  field: string,
): Readonly<ContaminationDetector> {
  assertDomain(
    typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value),
    'INVALID_ARGUMENT',
    `${field} must identify the detector`,
  )
  const candidate = value as Partial<ContaminationDetector>
  return Object.freeze({
    provider: token(candidate.provider, `${field}.provider`),
    model: token(candidate.model, `${field}.model`),
    version: token(candidate.version, `${field}.version`),
  })
}

function stringArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): readonly T[] {
  assertDomain(
    Array.isArray(value) && value.length > 0,
    'INVALID_ARGUMENT',
    `${field} must be a non-empty array`,
  )
  const normalized = value.map((item, index) => {
    assertDomain(
      typeof item === 'string' &&
        allowed.includes(item as T),
      'INVALID_ARGUMENT',
      `${field}[${index}] is invalid`,
    )
    return item as T
  })
  assertDomain(
    new Set(normalized).size === normalized.length,
    'INVALID_ARGUMENT',
    `${field} contains duplicates`,
  )
  return Object.freeze(normalized)
}

function signals(
  kind: ContaminationKind,
  value: unknown,
  field: string,
): Readonly<ContaminationSignals> {
  assertDomain(
    typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value),
    'INVALID_ARGUMENT',
    `${field} must contain detector signals`,
  )
  const candidate = value as Record<string, unknown>
  if (kind === 'burned-caption') {
    return Object.freeze({
      text: text(candidate.text, `${field}.text`),
      textTrackMatch: score(
        candidate.textTrackMatch,
        `${field}.textTrackMatch`,
      ),
      frameCoverage: score(
        candidate.frameCoverage,
        `${field}.frameCoverage`,
      ),
      foregroundContrast: score(
        candidate.foregroundContrast,
        `${field}.foregroundContrast`,
      ),
    })
  }
  if (kind === 'logo-watermark') {
    return Object.freeze({
      label: text(candidate.label, `${field}.label`, 1, 200),
      logoMatch: score(
        candidate.logoMatch,
        `${field}.logoMatch`,
      ),
      frameCoverage: score(
        candidate.frameCoverage,
        `${field}.frameCoverage`,
      ),
      opacity: score(candidate.opacity, `${field}.opacity`),
    })
  }
  if (kind === 'music') {
    assertDomain(
      typeof candidate.separableStem === 'boolean',
      'INVALID_ARGUMENT',
      `${field}.separableStem must be boolean`,
    )
    return Object.freeze({
      musicLikelihood: score(
        candidate.musicLikelihood,
        `${field}.musicLikelihood`,
      ),
      speechLikelihood: score(
        candidate.speechLikelihood,
        `${field}.speechLikelihood`,
      ),
      separableStem: candidate.separableStem,
      spectralPersistence: score(
        candidate.spectralPersistence,
        `${field}.spectralPersistence`,
      ),
    })
  }
  if (kind === 'border') {
    return Object.freeze({
      edges: stringArray(
        candidate.edges,
        ['top', 'right', 'bottom', 'left'] as const,
        `${field}.edges`,
      ),
      uniformity: score(
        candidate.uniformity,
        `${field}.uniformity`,
      ),
      thicknessRatio: score(
        candidate.thicknessRatio,
        `${field}.thicknessRatio`,
      ),
      frameCoverage: score(
        candidate.frameCoverage,
        `${field}.frameCoverage`,
      ),
    })
  }
  assertDomain(
    typeof candidate.occludesSubject === 'boolean',
    'INVALID_ARGUMENT',
    `${field}.occludesSubject must be boolean`,
  )
  return Object.freeze({
    overlayClass: token(
      candidate.overlayClass,
      `${field}.overlayClass`,
    ),
    frameCoverage: score(
      candidate.frameCoverage,
      `${field}.frameCoverage`,
    ),
    opacity: score(candidate.opacity, `${field}.opacity`),
    occludesSubject: candidate.occludesSubject,
  })
}

function normalizeObservation(
  value: Readonly<ContaminationObservation>,
  durationMs: number,
  index: number,
): Readonly<ContaminationObservation> {
  const kind = value.kind
  assertDomain(
    CONTAMINATION_KINDS.includes(kind),
    'INVALID_ARGUMENT',
    `observations[${index}].kind is invalid`,
  )
  const normalizedRegion = kind === 'music'
    ? null
    : region(value.region, `observations[${index}].region`)
  assertDomain(
    kind !== 'music' || value.region === null,
    'INVALID_ARGUMENT',
    `observations[${index}].region must be null for music`,
  )
  return Object.freeze({
    id: identity(value.id, `observations[${index}].id`),
    kind,
    rangeMs: range(
      value.rangeMs,
      durationMs,
      `observations[${index}].rangeMs`,
    ),
    region: normalizedRegion,
    confidence: score(
      value.confidence,
      `observations[${index}].confidence`,
    ),
    detector: detector(
      value.detector,
      `observations[${index}].detector`,
    ),
    signals: signals(
      kind,
      value.signals,
      `observations[${index}].signals`,
    ),
  } as ContaminationObservation)
}

function normalizeProtectedRegion(
  value: Omit<ContaminationProtectedRegion, 'regionHash'> & {
    regionHash?: string
  },
  durationMs: number,
  index: number,
): Readonly<ContaminationProtectedRegion> {
  assertDomain(
    PROTECTED_REGION_KINDS.includes(value.kind),
    'INVALID_ARGUMENT',
    `protectedRegions[${index}].kind is invalid`,
  )
  const normalized = {
    id: identity(value.id, `protectedRegions[${index}].id`),
    kind: value.kind,
    rangeMs: range(
      value.rangeMs,
      durationMs,
      `protectedRegions[${index}].rangeMs`,
    ),
    region: region(
      value.region,
      `protectedRegions[${index}].region`,
    ),
    confidence: score(
      value.confidence,
      `protectedRegions[${index}].confidence`,
    ),
    source: token(
      value.source,
      `protectedRegions[${index}].source`,
    ),
  }
  const regionHash = calculateCanonicalHash(normalized)
  if (value.regionHash !== undefined) {
    assertDomain(
      sha256(value.regionHash, `protectedRegions[${index}].regionHash`) ===
        regionHash,
      'PERSISTENCE_CONFLICT',
      `protectedRegions[${index}].regionHash is inconsistent`,
    )
  }
  return Object.freeze({ ...normalized, regionHash })
}

function normalizePolicy(
  value: Readonly<ContaminationPolicy>,
): Readonly<
  ContaminationPolicy & {
    version: typeof CONTAMINATION_POLICY_VERSION
  }
> {
  const minObservationConfidence = score(
    value.minObservationConfidence,
    'policy.minObservationConfidence',
  )
  const minAutomaticConfidence = score(
    value.minAutomaticConfidence,
    'policy.minAutomaticConfidence',
  )
  const protectedIntersectionReviewRatio = score(
    value.protectedIntersectionReviewRatio,
    'policy.protectedIntersectionReviewRatio',
  )
  const protectedIntersectionDestructiveRatio = score(
    value.protectedIntersectionDestructiveRatio,
    'policy.protectedIntersectionDestructiveRatio',
  )
  assertDomain(
    minAutomaticConfidence >= minObservationConfidence,
    'INVALID_ARGUMENT',
    'Automatic confidence must not be lower than observation confidence',
  )
  assertDomain(
    protectedIntersectionDestructiveRatio >
      protectedIntersectionReviewRatio,
    'INVALID_ARGUMENT',
    'Destructive intersection must be greater than review intersection',
  )
  assertDomain(
    typeof value.lowConfidenceRequiresReview === 'boolean',
    'INVALID_ARGUMENT',
    'policy.lowConfidenceRequiresReview must be boolean',
  )
  return Object.freeze({
    version: CONTAMINATION_POLICY_VERSION,
    minObservationConfidence,
    minAutomaticConfidence,
    protectedIntersectionReviewRatio,
    protectedIntersectionDestructiveRatio,
    lowConfidenceRequiresReview:
      value.lowConfidenceRequiresReview,
  })
}

function rangesOverlap(
  left: readonly [number, number],
  right: readonly [number, number],
): boolean {
  return left[0] < right[1] && right[0] < left[1]
}

function rangeIntersection(
  left: readonly [number, number],
  right: readonly [number, number],
): readonly [number, number] | null {
  const start = Math.max(left[0], right[0])
  const end = Math.min(left[1], right[1])
  return end > start ? Object.freeze([start, end]) : null
}

function regionIntersection(
  left: Readonly<NormalizedRegion>,
  right: Readonly<NormalizedRegion>,
): Readonly<NormalizedRegion> | null {
  const x = Math.max(left.x, right.x)
  const y = Math.max(left.y, right.y)
  const endX = Math.min(
    left.x + left.width,
    right.x + right.width,
  )
  const endY = Math.min(
    left.y + left.height,
    right.y + right.height,
  )
  if (endX <= x || endY <= y) return null
  return Object.freeze({
    x: Number(x.toFixed(4)),
    y: Number(y.toFixed(4)),
    width: Number((endX - x).toFixed(4)),
    height: Number((endY - y).toFixed(4)),
  })
}

function intersectionRatio(
  left: Readonly<NormalizedRegion>,
  right: Readonly<NormalizedRegion>,
): number {
  const intersection = regionIntersection(left, right)
  if (!intersection) return 0
  const intersectionArea =
    intersection.width * intersection.height
  const smallerArea = Math.min(
    left.width * left.height,
    right.width * right.height,
  )
  return smallerArea > 0
    ? Number((intersectionArea / smallerArea).toFixed(4))
    : 0
}

function temporalOverlapRatio(
  target: readonly [number, number],
  ranges: readonly (readonly [number, number])[],
): number {
  const duration = target[1] - target[0]
  const intervals = ranges
    .map((candidate) => rangeIntersection(target, candidate))
    .filter((candidate): candidate is readonly [number, number] =>
      candidate !== null)
    .sort((left, right) => left[0] - right[0])
  const merged: Array<[number, number]> = []
  for (const interval of intervals) {
    const last = merged.at(-1)
    if (!last || interval[0] > last[1]) {
      merged.push([interval[0], interval[1]])
    } else {
      last[1] = Math.max(last[1], interval[1])
    }
  }
  const covered = merged.reduce(
    (sum, interval) => sum + interval[1] - interval[0],
    0,
  )
  return duration > 0
    ? Number((covered / duration).toFixed(4))
    : 0
}

function removalAssessment(input: {
  observation: Readonly<ContaminationObservation>
  essentialOverlapRatio: number
  protectedIntersectionRatio: number
  policy: Readonly<ContaminationPolicy>
}): Readonly<{
  impact: ContaminationRemovalImpact
  reasons: readonly string[]
}> {
  const reasons: string[] = []
  if (input.essentialOverlapRatio === 0) {
    return Object.freeze({
      impact: 'safe',
      reasons: Object.freeze(['outside-clean-candidate']),
    })
  }
  reasons.push('overlaps-clean-candidate')
  if (input.observation.kind === 'music') {
    const audioSignals =
      input.observation.signals as Readonly<MusicSignals>
    if (
      audioSignals.speechLikelihood >= 0.5 &&
      !audioSignals.separableStem
    ) {
      reasons.push('mixed-with-essential-speech')
      reasons.push('no-separable-stem')
      return Object.freeze({
        impact: 'destructive',
        reasons: Object.freeze(reasons),
      })
    }
    if (!audioSignals.separableStem) {
      reasons.push('mixed-audio-review')
      return Object.freeze({
        impact: 'review-required',
        reasons: Object.freeze(reasons),
      })
    }
    reasons.push('separable-audio-evidence')
  }
  if (
    input.observation.kind === 'overlay' &&
    (input.observation.signals as Readonly<OverlaySignals>)
      .occludesSubject
  ) {
    reasons.push('overlay-occludes-subject')
    return Object.freeze({
      impact: 'destructive',
      reasons: Object.freeze(reasons),
    })
  }
  if (
    input.protectedIntersectionRatio >=
    input.policy.protectedIntersectionDestructiveRatio
  ) {
    reasons.push('protected-region-destructive-overlap')
    return Object.freeze({
      impact: 'destructive',
      reasons: Object.freeze(reasons),
    })
  }
  if (
    input.protectedIntersectionRatio >=
    input.policy.protectedIntersectionReviewRatio
  ) {
    reasons.push('protected-region-review-overlap')
    return Object.freeze({
      impact: 'review-required',
      reasons: Object.freeze(reasons),
    })
  }
  reasons.push(
    input.observation.region === null
      ? 'no-visual-region'
      : 'protected-region-clear',
  )
  return Object.freeze({
    impact: 'safe',
    reasons: Object.freeze(reasons),
  })
}

function directorMessage(
  kind: ContaminationKind,
  impact: ContaminationRemovalImpact,
): string {
  const subject: Record<ContaminationKind, string> = {
    'burned-caption': 'Legenda queimada',
    'logo-watermark': 'Logo ou watermark',
    music: 'Música mixada',
    border: 'Borda incorporada',
    overlay: 'Overlay incorporado',
  }
  const action: Record<
    Exclude<ContaminationRemovalImpact, 'destructive'>,
    string
  > = {
    safe: 'pode seguir para planejamento de limpeza',
    'review-required': 'precisa de revisão antes da limpeza',
  }
  const removalAgreement: Record<ContaminationKind, string> = {
    'burned-caption': 'removida',
    'logo-watermark': 'removido',
    music: 'removida',
    border: 'removida',
    overlay: 'removido',
  }
  return impact === 'destructive'
    ? `${subject[kind]} não pode ser ${removalAgreement[kind]} sem afetar conteúdo essencial.`
    : `${subject[kind]} ${action[impact]}.`
}

function humanQuestion(
  kind: ContaminationKind,
  impact: ContaminationRemovalImpact,
): string {
  const subject: Record<ContaminationKind, string> = {
    'burned-caption': 'da legenda incorporada',
    'logo-watermark': 'do logo ou da marca d’água',
    music: 'da música mixada',
    border: 'da borda incorporada',
    overlay: 'do overlay incorporado',
  }
  if (impact === 'destructive') {
    return `A remoção ${subject[kind]} destruiria conteúdo essencial; manter a fonte ou rejeitar o trecho?`
  }
  if (impact === 'review-required') {
    return `A remoção ${subject[kind]} preserva pessoa, fala e informação importante?`
  }
  return `Confirmar o diagnóstico automático ${subject[kind]} na comparação entre fonte e trecho limpo.`
}

export function createContaminationReport(input: {
  id: string
  sourceDeconstruction:
    Readonly<SourceDeconstructionReport>
  expectedSourceDeconstructionReportHash: string
  analyzer: Readonly<ContaminationDetector>
  policy: Readonly<ContaminationPolicy>
  observations: readonly Readonly<ContaminationObservation>[]
  protectedRegions: readonly (
    Omit<ContaminationProtectedRegion, 'regionHash'> & {
      regionHash?: string
    }
  )[]
  createdByClientId: string
  createdAt: string | Date
}): Readonly<ContaminationReport> {
  const source = hydrateSourceDeconstructionReport(
    input.sourceDeconstruction,
  )
  const expectedSourceHash = sha256(
    input.expectedSourceDeconstructionReportHash,
    'expectedSourceDeconstructionReportHash',
  )
  if (source.reportHash !== expectedSourceHash) {
    throw new DomainError(
      'VERSION_CONFLICT',
      'Source deconstruction report hash is stale',
    )
  }
  const id = identity(input.id, 'id')
  assertDomain(
    Array.isArray(input.observations) &&
      input.observations.length <= 10_000,
    'INVALID_ARGUMENT',
    'observations must contain at most 10000 entries',
  )
  assertDomain(
    Array.isArray(input.protectedRegions) &&
      input.protectedRegions.length <= 5_000,
    'INVALID_ARGUMENT',
    'protectedRegions must contain at most 5000 entries',
  )
  const policy = normalizePolicy(input.policy)
  const observations = Object.freeze(
    input.observations.map((observation, index) =>
      normalizeObservation(
        observation,
        source.sourceDurationMs,
        index,
      ))
      .sort((left, right) =>
        left.rangeMs[0] - right.rangeMs[0] ||
        left.rangeMs[1] - right.rangeMs[1] ||
        CONTAMINATION_KINDS.indexOf(left.kind) -
          CONTAMINATION_KINDS.indexOf(right.kind) ||
        left.id.localeCompare(right.id)),
  )
  assertDomain(
    new Set(observations.map((observation) =>
      observation.id)).size === observations.length,
    'INVALID_ARGUMENT',
    'observations contain duplicate IDs',
  )
  for (const observation of observations) {
    assertDomain(
      observation.confidence >= policy.minObservationConfidence,
      'INVALID_ARGUMENT',
      `Observation ${observation.id} is below the policy confidence floor`,
    )
  }
  const protectedRegions = Object.freeze(
    input.protectedRegions.map((protectedRegion, index) =>
      normalizeProtectedRegion(
        protectedRegion,
        source.sourceDurationMs,
        index,
      ))
      .sort((left, right) =>
        left.rangeMs[0] - right.rangeMs[0] ||
        left.id.localeCompare(right.id)),
  )
  assertDomain(
    new Set(protectedRegions.map((protectedRegion) =>
      protectedRegion.id)).size === protectedRegions.length,
    'INVALID_ARGUMENT',
    'protectedRegions contain duplicate IDs',
  )
  const essentialRanges = source.cleanCandidateRanges.map(
    (candidate) => candidate.speechRangeMs,
  )
  const findings = Object.freeze(observations.map((observation) => {
    const essentialOverlapRatio = temporalOverlapRatio(
      observation.rangeMs,
      essentialRanges,
    )
    const relevantProtectedRegions = observation.region === null
      ? []
      : protectedRegions.filter((protectedRegion) =>
          rangesOverlap(
            observation.rangeMs,
            protectedRegion.rangeMs,
          ) &&
          intersectionRatio(
            observation.region!,
            protectedRegion.region,
          ) > 0)
    const protectedRegionIntersectionRatio =
      observation.region === null
        ? 0
        : relevantProtectedRegions.reduce(
            (maximum, protectedRegion) => Math.max(
              maximum,
              intersectionRatio(
                observation.region!,
                protectedRegion.region,
              ),
            ),
            0,
          )
    const assessment = removalAssessment({
      observation,
      essentialOverlapRatio,
      protectedIntersectionRatio:
        protectedRegionIntersectionRatio,
      policy,
    })
    const lowConfidence =
      observation.confidence < policy.minAutomaticConfidence
    const requiresHumanReview =
      assessment.impact !== 'safe' ||
      (policy.lowConfidenceRequiresReview && lowConfidence)
    const reasonCodes = Object.freeze([
      ...assessment.reasons,
      ...(lowConfidence ? ['below-automatic-confidence'] : []),
    ])
    const observationHash = calculateCanonicalHash(observation)
    const findingWithoutHash = {
      id: `contamination-finding-${calculateCanonicalHash({
        reportId: id,
        observationId: observation.id,
      }).slice(0, 32)}`,
      observationId: observation.id,
      kind: observation.kind,
      rangeMs: observation.rangeMs,
      region: observation.region,
      confidence: observation.confidence,
      detector: observation.detector,
      signals: observation.signals,
      overlapsEssentialTime: essentialOverlapRatio > 0,
      essentialOverlapRatio,
      protectedRegionIds: Object.freeze(
        relevantProtectedRegions.map((item) => item.id),
      ),
      protectedRegionIntersectionRatio,
      removalImpact: assessment.impact,
      removalWouldDestroyEssential:
        assessment.impact === 'destructive',
      requiresHumanReview,
      reasonCodes,
      observationHash,
    }
    return Object.freeze({
      ...findingWithoutHash,
      findingHash: calculateCanonicalHash(findingWithoutHash),
    })
  }))

  const overlaps: readonly Readonly<ContaminationOverlap>[] =
    Object.freeze(
    findings.flatMap((left, leftIndex) =>
      findings.slice(leftIndex + 1).flatMap((right) => {
        const temporal = rangeIntersection(
          left.rangeMs,
          right.rangeMs,
        )
        if (!temporal) return []
        const spatial = left.region && right.region
          ? regionIntersection(left.region, right.region)
          : left.region ?? right.region ?? null
        const spatiallyOverlapping =
          left.region === null ||
          right.region === null ||
          spatial !== null
        if (!spatiallyOverlapping) return []
        const [leftFindingId, rightFindingId] = [
          left.id,
          right.id,
        ].sort((first, second) => first.localeCompare(second))
        const withoutHash = {
          id: `contamination-overlap-${calculateCanonicalHash({
            reportId: id,
            leftFindingId,
            rightFindingId,
          }).slice(0, 32)}`,
          leftFindingId,
          rightFindingId,
          rangeMs: temporal,
          spatiallyOverlapping,
          intersectionRegion: spatial,
          confidence: Number(Math.min(
            left.confidence,
            right.confidence,
          ).toFixed(4)),
        }
        return [Object.freeze({
          ...withoutHash,
          overlapHash: calculateCanonicalHash(withoutHash),
        })]
      })),
  )

  const countsByKind = Object.freeze(
    Object.fromEntries(CONTAMINATION_KINDS.map((kind) => [
      kind,
      findings.filter((finding) => finding.kind === kind).length,
    ])) as Record<ContaminationKind, number>,
  )
  const safeCount = findings.filter((finding) =>
    finding.removalImpact === 'safe').length
  const reviewCount = findings.filter((finding) =>
    finding.removalImpact === 'review-required').length
  const destructiveCount = findings.filter((finding) =>
    finding.removalImpact === 'destructive').length
  const diagnostics = Object.freeze({
    director: Object.freeze(findings.map((finding) =>
      Object.freeze({
        findingId: finding.id,
        code: finding.kind,
        severity: finding.removalImpact === 'destructive'
          ? 'blocking' as const
          : finding.requiresHumanReview
            ? 'warning' as const
            : 'information' as const,
        rangeMs: finding.rangeMs,
        region: finding.region,
        confidence: finding.confidence,
        removalDecision:
          finding.removalImpact === 'destructive'
            ? 'blocked' as const
            : finding.requiresHumanReview
              ? 'review' as const
              : 'eligible' as const,
        reasonCodes: finding.reasonCodes,
        message: directorMessage(
          finding.kind,
          finding.removalImpact,
        ),
      }))),
    humanReview: Object.freeze(findings.map((finding) =>
      Object.freeze({
        findingId: finding.id,
        reviewRequired: finding.requiresHumanReview,
        rangeMs: finding.rangeMs,
        region: finding.region,
        compareSource: true as const,
        question: humanQuestion(
          finding.kind,
          finding.removalImpact,
        ),
        reasonCodes: finding.reasonCodes,
      }))),
  })
  const humanReviewRequired = findings.some((finding) =>
    finding.requiresHumanReview)
  const decision: ContaminationDecision =
    destructiveCount > 0
      ? 'manual-preservation-required'
      : humanReviewRequired
        ? 'human-review'
        : 'cleanup-eligible'
  const confidence = observations.length === 0
    ? 1
    : Number((
        observations.reduce(
          (sum, observation) => sum + observation.confidence,
          0,
        ) / observations.length
      ).toFixed(4))
  const createdAt = new Date(input.createdAt)
  assertDomain(
    !Number.isNaN(createdAt.getTime()),
    'INVALID_ARGUMENT',
    'createdAt is invalid',
  )
  const normalizedAnalyzer = detector(input.analyzer, 'analyzer')
  const analyzer = Object.freeze({
    ...normalizedAnalyzer,
    observationBatchHash: calculateCanonicalHash(observations),
  })
  const withoutHash = {
    schemaVersion: CONTAMINATION_REPORT_SCHEMA_VERSION,
    id,
    workspaceId: source.workspaceId,
    projectId: source.projectId,
    sourceDeconstructionReportId: source.id,
    sourceDeconstructionReportHash: source.reportHash,
    sourceArtifactId: source.sourceArtifactId,
    sourceArtifactSha256: source.sourceArtifactSha256,
    sourceDurationMs: source.sourceDurationMs,
    analyzer,
    policy,
    observations,
    protectedRegions,
    findings,
    overlaps,
    summary: Object.freeze({
      findingCount: findings.length,
      observationCount: observations.length,
      protectedRegionCount: protectedRegions.length,
      overlapCount: overlaps.length,
      countsByKind,
      safeCount,
      reviewCount,
      destructiveCount,
    }),
    diagnostics,
    decision,
    humanReviewRequired,
    confidence,
    createdByClientId: identity(
      input.createdByClientId,
      'createdByClientId',
    ),
    createdAt: createdAt.toISOString(),
  }
  return Object.freeze({
    ...withoutHash,
    reportHash: calculateCanonicalHash(withoutHash),
  })
}

export function hydrateContaminationReport(
  value: Readonly<ContaminationReport>,
  sourceDeconstruction: Readonly<SourceDeconstructionReport>,
): Readonly<ContaminationReport> {
  assertDomain(
    value.schemaVersion === CONTAMINATION_REPORT_SCHEMA_VERSION,
    'PERSISTENCE_CONFLICT',
    'Contamination report schema version is unsupported',
  )
  const rebuilt = createContaminationReport({
    id: value.id,
    sourceDeconstruction,
    expectedSourceDeconstructionReportHash:
      value.sourceDeconstructionReportHash,
    analyzer: value.analyzer,
    policy: value.policy,
    observations: value.observations,
    protectedRegions: value.protectedRegions,
    createdByClientId: value.createdByClientId,
    createdAt: value.createdAt,
  })
  if (stableSerialize(rebuilt) !== stableSerialize(value)) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored contamination report is inconsistent',
    )
  }
  return rebuilt
}
