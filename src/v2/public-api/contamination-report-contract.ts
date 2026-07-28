import {
  CONTAMINATION_KINDS,
  PROTECTED_REGION_KINDS,
  type ContaminationDetector,
  type ContaminationKind,
  type ContaminationObservation,
  type ContaminationPolicy,
  type ContaminationProtectedRegion,
  type ContaminationReport,
  type NormalizedRegion,
  type ProtectedRegionKind,
} from '../domain/contamination-report.ts'
import { DomainError } from '../domain/errors.ts'

const DEFAULT_POLICY = Object.freeze<ContaminationPolicy>({
  minObservationConfidence: 0.5,
  minAutomaticConfidence: 0.85,
  protectedIntersectionReviewRatio: 0.1,
  protectedIntersectionDestructiveRatio: 0.35,
  lowConfidenceRequiresReview: true,
})

function record(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must be an object`,
    )
  }
  return value as Record<string, unknown>
}

function exactFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
) {
  const unknown = Object.keys(value).filter((key) =>
    !allowed.includes(key))
  if (unknown.length > 0) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} contains unknown fields`,
      { fields: unknown },
    )
  }
}

function identity(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
      .test(value.trim())
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} is invalid`,
    )
  }
  return value.trim()
}

function token(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z0-9][a-z0-9._:/-]{0,127}$/
      .test(value.trim())
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} is invalid`,
    )
  }
  return value.trim()
}

function text(
  value: unknown,
  field: string,
  maximum = 4_000,
): string {
  if (
    typeof value !== 'string' ||
    value.trim().length < 1 ||
    value.trim().length > maximum
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must contain 1 to ${maximum} characters`,
    )
  }
  return value.trim()
}

function sha256(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value)
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must be a lowercase SHA-256`,
    )
  }
  return value
}

function score(value: unknown, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must be between zero and one`,
    )
  }
  return Number(value.toFixed(4))
}

function integer(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must be an integer between ${minimum} and ${maximum}`,
    )
  }
  return Number(value)
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must be a boolean`,
    )
  }
  return value
}

function range(value: unknown, field: string) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must contain start and end milliseconds`,
    )
  }
  const start = integer(value[0], `${field}[0]`, 0, 86_399_999)
  const end = integer(value[1], `${field}[1]`, 1, 86_400_000)
  if (end <= start) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} end must be greater than start`,
    )
  }
  return Object.freeze([start, end] as const)
}

function region(
  value: unknown,
  field: string,
): Readonly<NormalizedRegion> {
  const item = record(value, field)
  exactFields(item, ['x', 'y', 'width', 'height'], field)
  const normalized = Object.freeze({
    x: score(item.x, `${field}.x`),
    y: score(item.y, `${field}.y`),
    width: score(item.width, `${field}.width`),
    height: score(item.height, `${field}.height`),
  })
  if (
    normalized.width === 0 ||
    normalized.height === 0 ||
    normalized.x + normalized.width > 1.0001 ||
    normalized.y + normalized.height > 1.0001
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must fit inside normalized video coordinates`,
    )
  }
  return normalized
}

function detector(
  value: unknown,
  field: string,
): Readonly<ContaminationDetector> {
  const item = record(value, field)
  exactFields(item, ['provider', 'model', 'version'], field)
  return Object.freeze({
    provider: token(item.provider, `${field}.provider`),
    model: token(item.model, `${field}.model`),
    version: token(item.version, `${field}.version`),
  })
}

function kind(value: unknown, field: string): ContaminationKind {
  if (
    typeof value !== 'string' ||
    !CONTAMINATION_KINDS.includes(value as ContaminationKind)
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} is invalid`,
    )
  }
  return value as ContaminationKind
}

function signals(
  contaminationKind: ContaminationKind,
  value: unknown,
  field: string,
) {
  const item = record(value, field)
  if (contaminationKind === 'burned-caption') {
    exactFields(
      item,
      [
        'text',
        'textTrackMatch',
        'frameCoverage',
        'foregroundContrast',
      ],
      field,
    )
    return Object.freeze({
      text: text(item.text, `${field}.text`),
      textTrackMatch: score(
        item.textTrackMatch,
        `${field}.textTrackMatch`,
      ),
      frameCoverage: score(
        item.frameCoverage,
        `${field}.frameCoverage`,
      ),
      foregroundContrast: score(
        item.foregroundContrast,
        `${field}.foregroundContrast`,
      ),
    })
  }
  if (contaminationKind === 'logo-watermark') {
    exactFields(
      item,
      ['label', 'logoMatch', 'frameCoverage', 'opacity'],
      field,
    )
    return Object.freeze({
      label: text(item.label, `${field}.label`, 256),
      logoMatch: score(item.logoMatch, `${field}.logoMatch`),
      frameCoverage: score(
        item.frameCoverage,
        `${field}.frameCoverage`,
      ),
      opacity: score(item.opacity, `${field}.opacity`),
    })
  }
  if (contaminationKind === 'music') {
    exactFields(
      item,
      [
        'musicLikelihood',
        'speechLikelihood',
        'separableStem',
        'spectralPersistence',
      ],
      field,
    )
    return Object.freeze({
      musicLikelihood: score(
        item.musicLikelihood,
        `${field}.musicLikelihood`,
      ),
      speechLikelihood: score(
        item.speechLikelihood,
        `${field}.speechLikelihood`,
      ),
      separableStem: boolean(
        item.separableStem,
        `${field}.separableStem`,
      ),
      spectralPersistence: score(
        item.spectralPersistence,
        `${field}.spectralPersistence`,
      ),
    })
  }
  if (contaminationKind === 'border') {
    exactFields(
      item,
      ['edges', 'uniformity', 'thicknessRatio', 'frameCoverage'],
      field,
    )
    if (
      !Array.isArray(item.edges) ||
      item.edges.length === 0 ||
      item.edges.length > 4 ||
      item.edges.some((edge) =>
        !['top', 'right', 'bottom', 'left'].includes(String(edge)))
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        `${field}.edges is invalid`,
      )
    }
    return Object.freeze({
      edges: Object.freeze(item.edges.map((edge) =>
        String(edge) as 'top' | 'right' | 'bottom' | 'left')),
      uniformity: score(item.uniformity, `${field}.uniformity`),
      thicknessRatio: score(
        item.thicknessRatio,
        `${field}.thicknessRatio`,
      ),
      frameCoverage: score(
        item.frameCoverage,
        `${field}.frameCoverage`,
      ),
    })
  }
  exactFields(
    item,
    ['overlayClass', 'frameCoverage', 'opacity', 'occludesSubject'],
    field,
  )
  return Object.freeze({
    overlayClass: token(
      item.overlayClass,
      `${field}.overlayClass`,
    ),
    frameCoverage: score(
      item.frameCoverage,
      `${field}.frameCoverage`,
    ),
    opacity: score(item.opacity, `${field}.opacity`),
    occludesSubject: boolean(
      item.occludesSubject,
      `${field}.occludesSubject`,
    ),
  })
}

function observation(
  value: unknown,
  index: number,
): Readonly<ContaminationObservation> {
  const field = `observations[${index}]`
  const item = record(value, field)
  exactFields(
    item,
    ['id', 'kind', 'rangeMs', 'region', 'confidence', 'detector', 'signals'],
    field,
  )
  const observationKind = kind(item.kind, `${field}.kind`)
  const base = {
    id: identity(item.id, `${field}.id`),
    kind: observationKind,
    rangeMs: range(item.rangeMs, `${field}.rangeMs`),
    confidence: score(item.confidence, `${field}.confidence`),
    detector: detector(item.detector, `${field}.detector`),
    signals: signals(
      observationKind,
      item.signals,
      `${field}.signals`,
    ),
  }
  if (observationKind === 'music') {
    if (item.region !== null) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        `${field}.region must be null for music`,
      )
    }
    return Object.freeze({
      ...base,
      kind: 'music',
      region: null,
      signals: base.signals as ContaminationObservation['signals'],
    }) as Readonly<ContaminationObservation>
  }
  if (item.region === null) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field}.region is required for visual contamination`,
    )
  }
  return Object.freeze({
    ...base,
    region: region(item.region, `${field}.region`),
  }) as Readonly<ContaminationObservation>
}

function protectedKind(
  value: unknown,
  field: string,
): ProtectedRegionKind {
  if (
    typeof value !== 'string' ||
    !PROTECTED_REGION_KINDS.includes(value as ProtectedRegionKind)
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} is invalid`,
    )
  }
  return value as ProtectedRegionKind
}

function protectedRegion(
  value: unknown,
  index: number,
): Omit<ContaminationProtectedRegion, 'regionHash'> {
  const field = `protectedRegions[${index}]`
  const item = record(value, field)
  exactFields(
    item,
    ['id', 'kind', 'rangeMs', 'region', 'confidence', 'source'],
    field,
  )
  return Object.freeze({
    id: identity(item.id, `${field}.id`),
    kind: protectedKind(item.kind, `${field}.kind`),
    rangeMs: range(item.rangeMs, `${field}.rangeMs`),
    region: region(item.region, `${field}.region`),
    confidence: score(item.confidence, `${field}.confidence`),
    source: token(item.source, `${field}.source`),
  })
}

function policy(value: unknown): Readonly<ContaminationPolicy> {
  if (value === undefined) return DEFAULT_POLICY
  const item = record(value, 'policy')
  exactFields(
    item,
    [
      'minObservationConfidence',
      'minAutomaticConfidence',
      'protectedIntersectionReviewRatio',
      'protectedIntersectionDestructiveRatio',
      'lowConfidenceRequiresReview',
    ],
    'policy',
  )
  const parsed = Object.freeze({
    minObservationConfidence: score(
      item.minObservationConfidence,
      'policy.minObservationConfidence',
    ),
    minAutomaticConfidence: score(
      item.minAutomaticConfidence,
      'policy.minAutomaticConfidence',
    ),
    protectedIntersectionReviewRatio: score(
      item.protectedIntersectionReviewRatio,
      'policy.protectedIntersectionReviewRatio',
    ),
    protectedIntersectionDestructiveRatio: score(
      item.protectedIntersectionDestructiveRatio,
      'policy.protectedIntersectionDestructiveRatio',
    ),
    lowConfidenceRequiresReview: boolean(
      item.lowConfidenceRequiresReview,
      'policy.lowConfidenceRequiresReview',
    ),
  })
  if (
    parsed.minAutomaticConfidence <
      parsed.minObservationConfidence ||
    parsed.protectedIntersectionDestructiveRatio <=
      parsed.protectedIntersectionReviewRatio
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'policy thresholds are inconsistent',
    )
  }
  return parsed
}

export function parseCreateContaminationReportBody(raw: unknown) {
  const body = record(raw, 'body')
  exactFields(
    body,
    [
      'sourceDeconstructionReportId',
      'expectedSourceDeconstructionReportHash',
      'analyzer',
      'policy',
      'observations',
      'protectedRegions',
    ],
    'body',
  )
  if (
    !Array.isArray(body.observations) ||
    body.observations.length > 10_000
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'observations must be an array with at most 10000 entries',
    )
  }
  if (
    !Array.isArray(body.protectedRegions) ||
    body.protectedRegions.length > 5_000
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'protectedRegions must be an array with at most 5000 entries',
    )
  }
  return Object.freeze({
    sourceDeconstructionReportId: identity(
      body.sourceDeconstructionReportId,
      'sourceDeconstructionReportId',
    ),
    expectedSourceDeconstructionReportHash: sha256(
      body.expectedSourceDeconstructionReportHash,
      'expectedSourceDeconstructionReportHash',
    ),
    analyzer: detector(body.analyzer, 'analyzer'),
    policy: policy(body.policy),
    observations: Object.freeze(
      body.observations.map(observation),
    ),
    protectedRegions: Object.freeze(
      body.protectedRegions.map(protectedRegion),
    ),
  })
}

export function presentContaminationReport(
  report: Readonly<ContaminationReport>,
) {
  return Object.freeze({
    ...report,
    observations: Object.freeze(report.observations.map((item) =>
      Object.freeze({
        ...item,
        rangeMs: Object.freeze([...item.rangeMs]),
        region: item.region
          ? Object.freeze({ ...item.region })
          : null,
        detector: Object.freeze({ ...item.detector }),
        signals: Object.freeze({ ...item.signals }),
      }))),
    protectedRegions: Object.freeze(
      report.protectedRegions.map((item) =>
        Object.freeze({
          ...item,
          rangeMs: Object.freeze([...item.rangeMs]),
          region: Object.freeze({ ...item.region }),
        })),
    ),
    findings: Object.freeze(report.findings.map((item) =>
      Object.freeze({
        ...item,
        rangeMs: Object.freeze([...item.rangeMs]),
        region: item.region
          ? Object.freeze({ ...item.region })
          : null,
        detector: Object.freeze({ ...item.detector }),
        signals: Object.freeze({ ...item.signals }),
        protectedRegionIds: Object.freeze([
          ...item.protectedRegionIds,
        ]),
        reasonCodes: Object.freeze([...item.reasonCodes]),
      }))),
    overlaps: Object.freeze(report.overlaps.map((item) =>
      Object.freeze({
        ...item,
        rangeMs: Object.freeze([...item.rangeMs]),
        intersectionRegion: item.intersectionRegion
          ? Object.freeze({ ...item.intersectionRegion })
          : null,
      }))),
    diagnostics: presentContaminationDiagnostics(report, 'all'),
  })
}

export function presentContaminationDiagnostics(
  report: Readonly<ContaminationReport>,
  audience: 'director' | 'human-review' | 'all',
) {
  return Object.freeze({
    reportId: report.id,
    sourceArtifactId: report.sourceArtifactId,
    decision: report.decision,
    humanReviewRequired: report.humanReviewRequired,
    confidence: report.confidence,
    ...(audience === 'human-review'
      ? {}
      : {
          director: Object.freeze(
            report.diagnostics.director.map((item) =>
              Object.freeze({
                ...item,
                rangeMs: Object.freeze([...item.rangeMs]),
                region: item.region
                  ? Object.freeze({ ...item.region })
                  : null,
                reasonCodes: Object.freeze([
                  ...item.reasonCodes,
                ]),
              }))),
        }),
    ...(audience === 'director'
      ? {}
      : {
          humanReview: Object.freeze(
            report.diagnostics.humanReview.map((item) =>
              Object.freeze({
                ...item,
                rangeMs: Object.freeze([...item.rangeMs]),
                region: item.region
                  ? Object.freeze({ ...item.region })
                  : null,
                reasonCodes: Object.freeze([
                  ...item.reasonCodes,
                ]),
              }))),
        }),
  })
}

export function parseContaminationAudience(
  value: string | null,
): 'director' | 'human-review' | 'all' {
  if (value === null || value === 'all') return 'all'
  if (value === 'director' || value === 'human-review') {
    return value
  }
  throw new DomainError(
    'INVALID_ARGUMENT',
    'audience must be director, human-review or all',
  )
}

export function presentContaminationReportPage(input: {
  reports: readonly Readonly<ContaminationReport>[]
  nextCursor?: string
}) {
  return Object.freeze({
    reports: Object.freeze(
      input.reports.map(presentContaminationReport),
    ),
    ...(input.nextCursor
      ? { nextCursor: input.nextCursor }
      : {}),
  })
}
