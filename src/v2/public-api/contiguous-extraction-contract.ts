import type {
  PersistedContiguousExtraction,
} from '../application/ports/contiguous-extraction-repository.ts'
import { DomainError } from '../domain/errors.ts'

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
  const unknown = Object.keys(value).filter(
    (key) => !allowed.includes(key),
  )
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
  maximum: number,
): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.trim().length > maximum
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} is invalid`,
    )
  }
  return value.trim().replace(/\s+/g, ' ')
}

function integer(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} is invalid`,
    )
  }
  return value
}

export function parseCreateContiguousExtractionBody(raw: unknown) {
  const body = record(raw, 'body')
  exactFields(
    body,
    [
      'objective',
      'topic',
      'targetDurationMs',
      'toleranceMs',
      'fps',
    ],
    'body',
  )
  const targetDurationMs = integer(
    body.targetDurationMs,
    'targetDurationMs',
    1_000,
    60 * 60 * 1_000,
  )
  return Object.freeze({
    objective: string(body.objective, 'objective', 240),
    topic: string(body.topic, 'topic', 500),
    targetDurationMs,
    toleranceMs: integer(
      body.toleranceMs,
      'toleranceMs',
      0,
      targetDurationMs,
    ),
    fps: integer(body.fps, 'fps', 1, 120),
  })
}

export function presentContiguousExtraction(
  value: Readonly<PersistedContiguousExtraction>,
) {
  return Object.freeze({
    ...value.result,
    createdBy: value.createdBy,
    createdAt: value.createdAt,
  })
}
