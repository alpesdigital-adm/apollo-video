import { DomainError } from '../domain/errors.ts'
import {
  defaultSourceCleanupPolicy,
  type SourceCleanupPolicy,
} from '../domain/source-cleanup.ts'
import type {
  SourceCleanupPage,
  SourceCleanupRecord,
} from '../application/ports/source-cleanup-repository.ts'
import { presentPublicOperation } from './presenters.ts'

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
  const unknown = Object.keys(value)
    .filter((key) => !allowed.includes(key))
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

function cost(value: unknown, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1_000_000
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must be a non-negative finite cost`,
    )
  }
  return Number(value.toFixed(4))
}

function policy(value: unknown): Readonly<SourceCleanupPolicy> {
  if (value === undefined) return defaultSourceCleanupPolicy()
  const input = record(value, 'policy')
  exactFields(
    input,
    [
      'minResidualQuality',
      'minIntegrity',
      'maxCost',
      'edgeTolerance',
      'maxCropFraction',
      'maxCoverArea',
      'coverColor',
      'costs',
    ],
    'policy',
  )
  const costs = record(input.costs, 'policy.costs')
  exactFields(
    costs,
    ['trim', 'crop-reframe', 'cover'],
    'policy.costs',
  )
  if (
    typeof input.coverColor !== 'string' ||
    !/^#[A-Fa-f0-9]{6}$/.test(input.coverColor.trim())
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'policy.coverColor must be a six-digit hexadecimal color',
    )
  }
  return Object.freeze({
    minResidualQuality: score(
      input.minResidualQuality,
      'policy.minResidualQuality',
    ),
    minIntegrity: score(
      input.minIntegrity,
      'policy.minIntegrity',
    ),
    maxCost: cost(input.maxCost, 'policy.maxCost'),
    edgeTolerance: score(
      input.edgeTolerance,
      'policy.edgeTolerance',
    ),
    maxCropFraction: score(
      input.maxCropFraction,
      'policy.maxCropFraction',
    ),
    maxCoverArea: score(
      input.maxCoverArea,
      'policy.maxCoverArea',
    ),
    coverColor: input.coverColor.trim().toUpperCase(),
    costs: Object.freeze({
      trim: cost(costs.trim, 'policy.costs.trim'),
      'crop-reframe': cost(
        costs['crop-reframe'],
        'policy.costs.crop-reframe',
      ),
      cover: cost(costs.cover, 'policy.costs.cover'),
    }),
  })
}

export function parseCreateSourceCleanupBody(raw: unknown) {
  const body = record(raw, 'body')
  exactFields(
    body,
    [
      'contaminationReportId',
      'expectedReportHash',
      'findingId',
      'policy',
    ],
    'body',
  )
  return Object.freeze({
    contaminationReportId: identity(
      body.contaminationReportId,
      'contaminationReportId',
    ),
    expectedReportHash: sha256(
      body.expectedReportHash,
      'expectedReportHash',
    ),
    findingId: identity(body.findingId, 'findingId'),
    policy: policy(body.policy),
  })
}

export function presentSourceCleanup(
  record: Readonly<SourceCleanupRecord>,
) {
  return Object.freeze({
    plan: record.plan,
    ...(record.operation
      ? { operation: presentPublicOperation(record.operation) }
      : {}),
    ...(record.review ? { postCleanupReview: record.review } : {}),
  })
}

export function presentSourceCleanupPage(
  page: Readonly<SourceCleanupPage>,
) {
  return Object.freeze({
    cleanups: Object.freeze(
      page.cleanups.map(presentSourceCleanup),
    ),
    ...(page.nextCursor
      ? { nextCursor: page.nextCursor }
      : {}),
  })
}
