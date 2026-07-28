import { DomainError } from '../domain/errors.ts'
import {
  SOURCE_DECONSTRUCTION_DESIRED_ROLES,
  SOURCE_DECONSTRUCTION_VALIDATION_SCOPES,
  type SourceDeconstructionBoundaryPolicy,
  type SourceDeconstructionDesiredRole,
  type SourceDeconstructionReport,
  type SourceDeconstructionValidationScope,
} from '../domain/source-deconstruction.ts'

const DEFAULT_BOUNDARY_POLICY =
  Object.freeze<SourceDeconstructionBoundaryPolicy>({
    preRollMs: 120,
    postRollMs: 160,
    maxJoinGapMs: 250,
    maxContextGapMs: 500,
    minCompleteThoughtScore: 0.7,
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

function integer(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
) {
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

function score(value: unknown, field: string) {
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

function desiredRole(
  value: unknown,
): SourceDeconstructionDesiredRole {
  if (
    typeof value !== 'string' ||
    !SOURCE_DECONSTRUCTION_DESIRED_ROLES.includes(
      value as SourceDeconstructionDesiredRole,
    )
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'desiredRole is invalid',
    )
  }
  return value as SourceDeconstructionDesiredRole
}

function validationScope(
  value: unknown,
): SourceDeconstructionValidationScope {
  if (
    typeof value !== 'string' ||
    !SOURCE_DECONSTRUCTION_VALIDATION_SCOPES.includes(
      value as SourceDeconstructionValidationScope,
    )
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'validationScope is invalid',
    )
  }
  return value as SourceDeconstructionValidationScope
}

function targetComposition(value: unknown) {
  const target = record(value, 'targetComposition')
  exactFields(
    target,
    ['objective', 'outputSpecId', 'targetDurationMs'],
    'targetComposition',
  )
  if (
    typeof target.objective !== 'string' ||
    !/^[a-z0-9][a-z0-9._:/-]{0,127}$/
      .test(target.objective.trim())
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'targetComposition.objective is invalid',
    )
  }
  if (
    typeof target.outputSpecId !== 'string' ||
    !/^(?:9:16|16:9|4:5|1:1|21:9|[a-z0-9][a-z0-9._:/-]{1,63})$/
      .test(target.outputSpecId.trim())
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'targetComposition.outputSpecId is invalid',
    )
  }
  return Object.freeze({
    objective: target.objective.trim(),
    outputSpecId: target.outputSpecId.trim(),
    targetDurationMs: integer(
      target.targetDurationMs,
      'targetComposition.targetDurationMs',
      500,
      30 * 60 * 1_000,
    ),
  })
}

function boundaryPolicy(
  value: unknown,
): Readonly<SourceDeconstructionBoundaryPolicy> {
  if (value === undefined) return DEFAULT_BOUNDARY_POLICY
  const policy = record(value, 'boundaryPolicy')
  exactFields(
    policy,
    [
      'preRollMs',
      'postRollMs',
      'maxJoinGapMs',
      'maxContextGapMs',
      'minCompleteThoughtScore',
    ],
    'boundaryPolicy',
  )
  return Object.freeze({
    preRollMs: integer(
      policy.preRollMs,
      'boundaryPolicy.preRollMs',
      0,
      2_000,
    ),
    postRollMs: integer(
      policy.postRollMs,
      'boundaryPolicy.postRollMs',
      0,
      2_000,
    ),
    maxJoinGapMs: integer(
      policy.maxJoinGapMs,
      'boundaryPolicy.maxJoinGapMs',
      0,
      5_000,
    ),
    maxContextGapMs: integer(
      policy.maxContextGapMs,
      'boundaryPolicy.maxContextGapMs',
      0,
      5_000,
    ),
    minCompleteThoughtScore: score(
      policy.minCompleteThoughtScore,
      'boundaryPolicy.minCompleteThoughtScore',
    ),
  })
}

export function parseCreateSourceDeconstructionBody(
  raw: unknown,
) {
  const body = record(raw, 'body')
  exactFields(
    body,
    [
      'sourceArtifactId',
      'expectedArtifactSha256',
      'sourceTranscriptId',
      'expectedTranscriptHash',
      'desiredRole',
      'validationScope',
      'targetComposition',
      'boundaryPolicy',
    ],
    'body',
  )
  return Object.freeze({
    sourceArtifactId: identity(
      body.sourceArtifactId,
      'sourceArtifactId',
    ),
    expectedArtifactSha256: sha256(
      body.expectedArtifactSha256,
      'expectedArtifactSha256',
    ),
    sourceTranscriptId: identity(
      body.sourceTranscriptId,
      'sourceTranscriptId',
    ),
    expectedTranscriptHash: sha256(
      body.expectedTranscriptHash,
      'expectedTranscriptHash',
    ),
    desiredRole: desiredRole(body.desiredRole),
    validationScope: validationScope(body.validationScope),
    targetComposition: targetComposition(
      body.targetComposition,
    ),
    boundaryPolicy: boundaryPolicy(body.boundaryPolicy),
  })
}

export function presentSourceDeconstruction(
  report: Readonly<SourceDeconstructionReport>,
) {
  return Object.freeze({
    ...report,
    segments: Object.freeze(report.segments.map((segment) =>
      Object.freeze({
        ...segment,
        rangeMs: Object.freeze([...segment.rangeMs]),
        roleReasonCodes: Object.freeze([
          ...segment.roleReasonCodes,
        ]),
      }))),
    cleanCandidateRanges: Object.freeze(
      report.cleanCandidateRanges.map((candidate) =>
        Object.freeze({
          ...candidate,
          rangeMs: Object.freeze([...candidate.rangeMs]),
          speechRangeMs: Object.freeze([
            ...candidate.speechRangeMs,
          ]),
          sourceSpeechSegmentIds: Object.freeze([
            ...candidate.sourceSpeechSegmentIds,
          ]),
          roles: Object.freeze([...candidate.roles]),
          boundaryReasonCodes: Object.freeze([
            ...candidate.boundaryReasonCodes,
          ]),
        })),
    ),
    semanticContaminants: Object.freeze(
      report.semanticContaminants.map((item) =>
        Object.freeze({
          ...item,
          rangeMs: Object.freeze([...item.rangeMs]),
        })),
    ),
    comparison: presentSourceDeconstructionComparison(report),
  })
}

export function presentSourceDeconstructionComparison(
  report: Readonly<SourceDeconstructionReport>,
) {
  return Object.freeze({
    reportId: report.id,
    sourceArtifactId: report.sourceArtifactId,
    desiredRole: report.desiredRole,
    validationScope: report.validationScope,
    decision: report.decision,
    confidence: report.confidence,
    editabilityScore: report.editabilityScore,
    contextPreserved: report.contextPreserved,
    ...report.comparison,
  })
}

export function presentSourceDeconstructionPage(input: {
  reports: readonly Readonly<SourceDeconstructionReport>[]
  nextCursor?: string
}) {
  return Object.freeze({
    reports: Object.freeze(
      input.reports.map(presentSourceDeconstruction),
    ),
    ...(input.nextCursor
      ? { nextCursor: input.nextCursor }
      : {}),
  })
}
