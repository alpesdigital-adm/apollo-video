import type {
  PersistedProofNeedRun,
  ProofNeedRunPage,
} from '../application/ports/proof-need-repository.ts'
import { DomainError } from '../domain/errors.ts'
import {
  PROOF_CLAIM_KINDS,
  type ProofClaimKind,
  type ProofNeedDeclarationInput,
} from '../domain/proof-need.ts'

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

function optionalString(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string | undefined {
  return value === undefined
    ? undefined
    : string(value, field, minimum, maximum)
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

function declaration(
  value: unknown,
  index: number,
): Readonly<ProofNeedDeclarationInput> {
  const field = `declarations[${index}]`
  const input = record(value, field)
  exactFields(
    input,
    [
      'storyBlockId',
      'claimId',
      'claimText',
      'claimKind',
      'offerId',
      'objection',
    ],
    field,
  )
  if (
    !PROOF_CLAIM_KINDS.includes(
      input.claimKind as ProofClaimKind,
    )
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field}.claimKind is invalid`,
    )
  }
  const offerId = optionalString(
    input.offerId,
    `${field}.offerId`,
    3,
    128,
  )
  const objection = optionalString(
    input.objection,
    `${field}.objection`,
    2,
    500,
  )
  return Object.freeze({
    storyBlockId: string(
      input.storyBlockId,
      `${field}.storyBlockId`,
      3,
      128,
    ),
    claimId: string(
      input.claimId,
      `${field}.claimId`,
      3,
      128,
    ),
    claimText: string(
      input.claimText,
      `${field}.claimText`,
      2,
      2_000,
    ),
    claimKind: input.claimKind as ProofClaimKind,
    ...(offerId ? { offerId } : {}),
    ...(objection ? { objection } : {}),
  })
}

export function parseCreateProofNeedBody(raw: unknown) {
  const body = record(raw, 'body')
  exactFields(
    body,
    [
      'batchId',
      'targetRecipeId',
      'expectedTargetRecipeHash',
      'policyVersion',
      'declarations',
    ],
    'body',
  )
  if (
    !Array.isArray(body.declarations) ||
    body.declarations.length < 1 ||
    body.declarations.length > 16
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'declarations must contain one to sixteen entries',
    )
  }
  const declarations = Object.freeze(
    body.declarations.map(declaration),
  )
  const keys = declarations.map((entry) =>
    `${entry.storyBlockId}\u0000${entry.claimId}`)
  if (new Set(keys).size !== keys.length) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'declarations must not repeat a StoryPlan claim',
    )
  }
  return Object.freeze({
    batchId: string(body.batchId, 'batchId', 3, 128),
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
    declarations,
  })
}

export function presentProofNeedRun(
  value: Readonly<PersistedProofNeedRun>,
) {
  const {
    requestFingerprint: _requestFingerprint,
    idempotencyKey: _idempotencyKey,
    ...run
  } = value
  return Object.freeze(run)
}

export function presentProofNeedRunPage(
  page: Readonly<ProofNeedRunPage>,
) {
  return Object.freeze({
    runs: Object.freeze(page.runs.map(presentProofNeedRun)),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  })
}
