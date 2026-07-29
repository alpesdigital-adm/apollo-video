import type {
  PersistedProofIntegrityRun,
  ProofIntegrityRunPage,
} from '../application/ports/proof-integrity-repository.ts'
import { DomainError } from '../domain/errors.ts'
import type {
  ProofIntegrityUseInput,
} from '../domain/proof-integrity.ts'

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

function use(
  value: unknown,
  index: number,
): Readonly<ProofIntegrityUseInput> {
  const field = `uses[${index}]`
  const input = record(value, field)
  exactFields(
    input,
    [
      'proofNeedItemId',
      'includedContextRangeMs',
      'includedAdjacentEvidenceIds',
    ],
    field,
  )
  if (
    input.includedContextRangeMs !== undefined &&
    (
      !Array.isArray(input.includedContextRangeMs) ||
      input.includedContextRangeMs.length !== 2 ||
      !input.includedContextRangeMs.every(Number.isSafeInteger)
    )
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field}.includedContextRangeMs must contain two integers`,
    )
  }
  if (
    !Array.isArray(input.includedAdjacentEvidenceIds) ||
    input.includedAdjacentEvidenceIds.length > 64
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field}.includedAdjacentEvidenceIds must contain at most 64 references`,
    )
  }
  const adjacent = input.includedAdjacentEvidenceIds.map(
    (entry, adjacentIndex) => string(
      entry,
      `${field}.includedAdjacentEvidenceIds[${adjacentIndex}]`,
      3,
      128,
    ),
  )
  return Object.freeze({
    proofNeedItemId: string(
      input.proofNeedItemId,
      `${field}.proofNeedItemId`,
      3,
      128,
    ),
    ...(input.includedContextRangeMs
      ? {
          includedContextRangeMs: Object.freeze([
            input.includedContextRangeMs[0] as number,
            input.includedContextRangeMs[1] as number,
          ]) as readonly [number, number],
        }
      : {}),
    includedAdjacentEvidenceIds: Object.freeze(adjacent),
  })
}

export function parseCreateProofIntegrityBody(raw: unknown) {
  const body = record(raw, 'body')
  exactFields(
    body,
    [
      'proofNeedRunId',
      'expectedProofNeedRunHash',
      'policyVersion',
      'uses',
    ],
    'body',
  )
  if (!Array.isArray(body.uses) || body.uses.length > 16) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'uses must contain at most sixteen entries',
    )
  }
  return Object.freeze({
    proofNeedRunId: string(
      body.proofNeedRunId,
      'proofNeedRunId',
      3,
      128,
    ),
    expectedProofNeedRunHash: sha256(
      body.expectedProofNeedRunHash,
      'expectedProofNeedRunHash',
    ),
    policyVersion: string(
      body.policyVersion,
      'policyVersion',
      3,
      64,
    ),
    uses: Object.freeze(body.uses.map(use)),
  })
}

export function presentProofIntegrityRun(
  value: Readonly<PersistedProofIntegrityRun>,
) {
  const {
    requestFingerprint: _requestFingerprint,
    idempotencyKey: _idempotencyKey,
    ...run
  } = value
  return Object.freeze(run)
}

export function presentProofIntegrityRunPage(
  page: Readonly<ProofIntegrityRunPage>,
) {
  return Object.freeze({
    runs: Object.freeze(
      page.runs.map(presentProofIntegrityRun),
    ),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  })
}
