import type {
  CreateTakeLibraryRequest,
} from '../application/take-libraries.ts'
import { DomainError } from '../domain/errors.ts'
import {
  TAKE_DIMENSIONS,
  type TakeDimension,
  type TakeIntentionRole,
  type TakeLibraryRun,
  type TakeSourceEvaluationInput,
  type TakeSourceKind,
} from '../domain/take-library.ts'
import { SCRIPT_BLOCK_ROLES } from '../domain/script-alignment.ts'

function record(value: unknown, field: string): Record<string, unknown> {
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

function array(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must contain ${minimum} to ${maximum} entries`,
    )
  }
  return value
}

function unit(value: unknown, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must be between 0 and 1`,
    )
  }
  return value
}

function dimension(value: unknown, field: string): TakeDimension {
  const parsed = string(value, field, 3, 32) as TakeDimension
  if (!TAKE_DIMENSIONS.includes(parsed)) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} is not a supported take dimension`,
    )
  }
  return parsed
}

function sourceKind(value: unknown, field: string): TakeSourceKind {
  const parsed = string(value, field, 3, 32) as TakeSourceKind
  if (!['alignment-candidate', 'extra-take'].includes(parsed)) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} is not a supported take source`,
    )
  }
  return parsed
}

function intentionRole(
  value: unknown,
  field: string,
): TakeIntentionRole {
  const parsed = string(value, field, 3, 32) as TakeIntentionRole
  if (![...SCRIPT_BLOCK_ROLES, 'other'].includes(parsed)) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} is not a supported take intention`,
    )
  }
  return parsed
}

function optionalTokens(
  value: unknown,
  field: string,
  maximum = 50,
): readonly string[] {
  if (value === undefined) return Object.freeze([])
  return Object.freeze(
    array(value, field, 0, maximum).map((entry, index) =>
      string(entry, `${field}[${index}]`, 3, 128)),
  )
}

function parseEvaluation(
  entry: unknown,
  index: number,
): Readonly<TakeSourceEvaluationInput> {
  const field = `evaluations[${index}]`
  const evaluation = record(entry, field)
  exactFields(
    evaluation,
    [
      'sourceKind',
      'sourceId',
      'expectedSourceHash',
      'dimensions',
      'inferredIntention',
    ],
    field,
  )
  const dimensions = array(
    evaluation.dimensions,
    `${field}.dimensions`,
    0,
    5,
  ).map((entry, dimensionIndex) => {
    const dimensionField = `${field}.dimensions[${dimensionIndex}]`
    const measured = record(entry, dimensionField)
    exactFields(
      measured,
      [
        'dimension',
        'score',
        'evaluatorVersion',
        'evidenceRefs',
        'reasonCodes',
      ],
      dimensionField,
    )
    return Object.freeze({
      dimension: dimension(
        measured.dimension,
        `${dimensionField}.dimension`,
      ),
      score: unit(measured.score, `${dimensionField}.score`),
      evaluatorVersion: string(
        measured.evaluatorVersion,
        `${dimensionField}.evaluatorVersion`,
        3,
        128,
      ),
      evidenceRefs: Object.freeze(
        array(
          measured.evidenceRefs,
          `${dimensionField}.evidenceRefs`,
          1,
          50,
        ).map((reference, referenceIndex) =>
          string(
            reference,
            `${dimensionField}.evidenceRefs[${referenceIndex}]`,
            3,
            128,
          )),
      ),
      reasonCodes: optionalTokens(
        measured.reasonCodes,
        `${dimensionField}.reasonCodes`,
      ),
    })
  })
  const inferred = evaluation.inferredIntention === undefined
    ? undefined
    : record(evaluation.inferredIntention, `${field}.inferredIntention`)
  if (inferred) {
    exactFields(
      inferred,
      ['role', 'label', 'confidence', 'evidenceRefs'],
      `${field}.inferredIntention`,
    )
  }
  return Object.freeze({
    sourceKind: sourceKind(evaluation.sourceKind, `${field}.sourceKind`),
    sourceId: string(evaluation.sourceId, `${field}.sourceId`, 3, 128),
    expectedSourceHash: string(
      evaluation.expectedSourceHash,
      `${field}.expectedSourceHash`,
      64,
      64,
    ),
    dimensions: Object.freeze(dimensions),
    ...(inferred
      ? {
          inferredIntention: Object.freeze({
            role: intentionRole(
              inferred.role,
              `${field}.inferredIntention.role`,
            ),
            label: string(
              inferred.label,
              `${field}.inferredIntention.label`,
              1,
              240,
            ),
            confidence: unit(
              inferred.confidence,
              `${field}.inferredIntention.confidence`,
            ),
            evidenceRefs: Object.freeze(
              array(
                inferred.evidenceRefs,
                `${field}.inferredIntention.evidenceRefs`,
                1,
                50,
              ).map((reference, referenceIndex) =>
                string(
                  reference,
                  `${field}.inferredIntention.evidenceRefs[${referenceIndex}]`,
                  3,
                  128,
                )),
            ),
          }),
        }
      : {}),
  })
}

export function parseCreateTakeLibraryBody(
  raw: unknown,
): Omit<
  CreateTakeLibraryRequest,
  'workspaceId' | 'batchId' | 'actor' | 'idempotencyKey'
> {
  const body = record(raw, 'body')
  exactFields(
    body,
    ['alignmentId', 'expectedAlignmentRunHash', 'evaluations'],
    'body',
  )
  return Object.freeze({
    alignmentId: string(body.alignmentId, 'alignmentId', 3, 128),
    expectedAlignmentRunHash: string(
      body.expectedAlignmentRunHash,
      'expectedAlignmentRunHash',
      64,
      64,
    ),
    evaluations: Object.freeze(
      array(body.evaluations, 'evaluations', 0, 2_000)
        .map(parseEvaluation),
    ),
  })
}

export function parseTakeSelectionBody(raw: unknown): Readonly<{
  expectedRevision: number
  groupId: string
  takeId: string
  protect: boolean
  replacedProtectedTakeId?: string
  note?: string
}> {
  const body = record(raw, 'body')
  exactFields(
    body,
    [
      'expectedRevision',
      'groupId',
      'takeId',
      'protect',
      'replacedProtectedTakeId',
      'note',
    ],
    'body',
  )
  if (
    !Number.isSafeInteger(body.expectedRevision) ||
    Number(body.expectedRevision) < 1 ||
    Number(body.expectedRevision) > 1_000_000 ||
    typeof body.protect !== 'boolean'
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'Take selection revision or protection is invalid',
    )
  }
  return Object.freeze({
    expectedRevision: Number(body.expectedRevision),
    groupId: string(body.groupId, 'groupId', 3, 128),
    takeId: string(body.takeId, 'takeId', 3, 128),
    protect: body.protect,
    ...(body.replacedProtectedTakeId !== undefined
      ? {
          replacedProtectedTakeId: string(
            body.replacedProtectedTakeId,
            'replacedProtectedTakeId',
            3,
            128,
          ),
        }
      : {}),
    ...(body.note !== undefined
      ? { note: string(body.note, 'note', 1, 500) }
      : {}),
  })
}

export function presentTakeLibraryRun(
  run: Readonly<TakeLibraryRun>,
) {
  return run
}

export function presentTakeLibraryPage(input: {
  runs: readonly Readonly<TakeLibraryRun>[]
  nextCursor?: string
}) {
  return Object.freeze({
    libraries: Object.freeze(input.runs.map(presentTakeLibraryRun)),
    ...(input.nextCursor ? { nextCursor: input.nextCursor } : {}),
  })
}
