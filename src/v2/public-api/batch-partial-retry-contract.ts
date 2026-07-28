import type {
  BatchPartialRetryRun,
  BatchPartialRetryTarget,
} from '../domain/batch-partial-retry.ts'
import { DomainError } from '../domain/errors.ts'
import {
  PRODUCTION_BATCH_STEPS,
  type ProductionBatchStep,
} from '../domain/production-batch.ts'

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
): void {
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
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/.test(value.trim())
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} is invalid`,
    )
  }
  return value.trim()
}

function revision(value: unknown, field: string): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 1 ||
    Number(value) > 1_000_000
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must be an integer between 1 and 1000000`,
    )
  }
  return Number(value)
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

export function parseCreateBatchPartialRetryBody(
  raw: unknown,
): Readonly<{
  expectedBatchRevision: number
  targets: readonly Readonly<BatchPartialRetryTarget>[]
}> {
  const body = record(raw, 'body')
  exactFields(
    body,
    ['expectedBatchRevision', 'targets'],
    'body',
  )
  if (
    !Array.isArray(body.targets) ||
    body.targets.length < 1 ||
    body.targets.length > 100
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'targets must contain one to 100 failed item steps',
    )
  }
  const targets = body.targets.map((entry, index) => {
    const target = record(entry, `targets[${index}]`)
    exactFields(
      target,
      [
        'itemId',
        'step',
        'expectedItemRevision',
        'expectedStepHash',
      ],
      `targets[${index}]`,
    )
    if (
      typeof target.step !== 'string' ||
      !PRODUCTION_BATCH_STEPS.includes(
        target.step as ProductionBatchStep,
      )
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        `targets[${index}].step is invalid`,
      )
    }
    return Object.freeze({
      itemId: identity(target.itemId, `targets[${index}].itemId`),
      step: target.step as ProductionBatchStep,
      expectedItemRevision: revision(
        target.expectedItemRevision,
        `targets[${index}].expectedItemRevision`,
      ),
      expectedStepHash: sha256(
        target.expectedStepHash,
        `targets[${index}].expectedStepHash`,
      ),
    })
  })
  if (
    new Set(targets.map((target) => target.itemId)).size !==
      targets.length
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'targets must contain at most one failed step per item',
    )
  }
  return Object.freeze({
    expectedBatchRevision: revision(
      body.expectedBatchRevision,
      'expectedBatchRevision',
    ),
    targets: Object.freeze(targets),
  })
}

export function presentBatchPartialRetry(
  partialRetry: Readonly<BatchPartialRetryRun>,
) {
  return Object.freeze({
    ...partialRetry,
    jobs: Object.freeze(partialRetry.jobs.map((job) =>
      Object.freeze({
        ...job,
        preservedArtifactIds: Object.freeze([
          ...job.preservedArtifactIds,
        ]),
      }))),
    preservedCompletedItemIds: Object.freeze([
      ...partialRetry.preservedCompletedItemIds,
    ]),
    preservedArtifactIds: Object.freeze([
      ...partialRetry.preservedArtifactIds,
    ]),
  })
}

export function presentBatchPartialRetryPage(input: {
  retries: readonly Readonly<BatchPartialRetryRun>[]
  nextCursor?: string
}) {
  return Object.freeze({
    partialRetries: Object.freeze(
      input.retries.map(presentBatchPartialRetry),
    ),
    ...(input.nextCursor ? { nextCursor: input.nextCursor } : {}),
  })
}
