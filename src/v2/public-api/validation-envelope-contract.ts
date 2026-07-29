import type {
  ValidationEnvelopeReusePage,
  ValidationEnvelopeReuseRecord,
} from '../application/ports/validation-envelope-repository.ts'
import { DomainError } from '../domain/errors.ts'
import {
  VALIDATION_ENVELOPE_ASPECTS,
  type ValidationEnvelopeAspect,
  type ValidationEnvelopeChangeRequest,
} from '../domain/validation-envelope.ts'

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

function string(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string {
  if (
    typeof value !== 'string' ||
    value.trim().length < minimum ||
    value.trim().length > maximum
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must contain ${minimum} to ${maximum} characters`,
    )
  }
  return value.trim()
}

function sha256(value: unknown, field: string): string {
  const normalized = string(value, field, 64, 64)
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must be a lowercase SHA-256`,
    )
  }
  return normalized
}

function change(
  value: unknown,
  index: number,
): Readonly<ValidationEnvelopeChangeRequest> {
  const field = `requestedChanges[${index}]`
  const input = record(value, field)
  exactFields(input, ['aspect', 'required', 'rationale'], field)
  if (
    !VALIDATION_ENVELOPE_ASPECTS.includes(
      input.aspect as ValidationEnvelopeAspect,
    ) ||
    typeof input.required !== 'boolean'
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} is invalid`,
    )
  }
  return Object.freeze({
    aspect: input.aspect as ValidationEnvelopeAspect,
    required: input.required,
    rationale: string(
      input.rationale,
      `${field}.rationale`,
      3,
      500,
    ),
  })
}

export function parseCreateValidationEnvelopeBody(raw: unknown) {
  const body = record(raw, 'body')
  exactFields(
    body,
    [
      'batchId',
      'validatedSegmentId',
      'expectedValidatedSegmentHash',
      'targetRecipeId',
      'expectedTargetRecipeHash',
      'policyVersion',
      'requestedChanges',
    ],
    'body',
  )
  if (
    !Array.isArray(body.requestedChanges) ||
    body.requestedChanges.length > 5
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'requestedChanges must contain zero to five entries',
    )
  }
  const requestedChanges = Object.freeze(
    body.requestedChanges.map(change),
  )
  if (
    new Set(requestedChanges.map((item) => item.aspect)).size !==
      requestedChanges.length
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'requestedChanges must not contain duplicate aspects',
    )
  }
  return Object.freeze({
    batchId: string(body.batchId, 'batchId', 3, 128),
    validatedSegmentId: string(
      body.validatedSegmentId,
      'validatedSegmentId',
      3,
      128,
    ),
    expectedValidatedSegmentHash: sha256(
      body.expectedValidatedSegmentHash,
      'expectedValidatedSegmentHash',
    ),
    targetRecipeId: string(
      body.targetRecipeId,
      'targetRecipeId',
      3,
      128,
    ),
    expectedTargetRecipeHash: sha256(
      body.expectedTargetRecipeHash,
      'expectedTargetRecipeHash',
    ),
    policyVersion: string(
      body.policyVersion,
      'policyVersion',
      3,
      64,
    ),
    requestedChanges,
  })
}

export function parseValidationEnvelopeApprovalBody(raw: unknown) {
  const body = record(raw, 'body')
  exactFields(
    body,
    ['expectedPlanHash', 'action', 'note'],
    'body',
  )
  if (!['approve', 'reject'].includes(String(body.action))) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'action must be approve or reject',
    )
  }
  return Object.freeze({
    expectedPlanHash: sha256(
      body.expectedPlanHash,
      'expectedPlanHash',
    ),
    action: body.action as 'approve' | 'reject',
    note: string(body.note, 'note', 3, 1_000),
  })
}

export function presentValidationEnvelopeReuse(
  value: Readonly<ValidationEnvelopeReuseRecord>,
) {
  return value
}

export function presentValidationEnvelopeReusePage(
  page: Readonly<ValidationEnvelopeReusePage>,
) {
  return Object.freeze({
    reuses: Object.freeze(
      page.reuses.map(presentValidationEnvelopeReuse),
    ),
    ...(page.nextCursor
      ? { nextCursor: page.nextCursor }
      : {}),
  })
}
