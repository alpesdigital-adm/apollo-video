import type {
  CreateVariantPortfolioPreflightRequest,
} from '../application/variant-portfolio-preflights.ts'
import { assertDomain } from '../domain/errors.ts'
import type {
  VariantPortfolioPreflightRun,
} from '../domain/variant-portfolio-preflight.ts'

type ParsedCreateVariantPortfolioPreflightBody = Omit<
  CreateVariantPortfolioPreflightRequest,
  'workspaceId' | 'batchId' | 'actor' | 'idempotencyKey'
>

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/

function record(value: unknown): Record<string, unknown> {
  assertDomain(
    typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value),
    'INVALID_ARGUMENT',
    'Request body must be a JSON object',
  )
  return value as Record<string, unknown>
}

function exact(
  value: Record<string, unknown>,
  allowed: readonly string[],
) {
  const unexpected = Object.keys(value).filter(
    (key) => !allowed.includes(key),
  )
  assertDomain(
    unexpected.length === 0,
    'INVALID_ARGUMENT',
    `Request body contains unexpected fields: ${unexpected.join(', ')}`,
  )
}

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

export function parseCreateVariantPortfolioPreflightBody(
  value: unknown,
): Readonly<ParsedCreateVariantPortfolioPreflightBody> {
  const body = record(value)
  exact(body, [
    'compatibilityGraphId',
    'expectedCompatibilityGraphRunHash',
    'requestedRecipeCount',
    'requireProof',
    'confirmationToken',
  ])
  assertDomain(
    typeof body.expectedCompatibilityGraphRunHash === 'string' &&
      HASH.test(body.expectedCompatibilityGraphRunHash),
    'INVALID_ARGUMENT',
    'expectedCompatibilityGraphRunHash is invalid',
  )
  assertDomain(
    Number.isSafeInteger(body.requestedRecipeCount) &&
      Number(body.requestedRecipeCount) >= 1 &&
      Number(body.requestedRecipeCount) <= 1_000,
    'INVALID_ARGUMENT',
    'requestedRecipeCount must be an integer between 1 and 1000',
  )
  assertDomain(
    body.requireProof === undefined ||
      typeof body.requireProof === 'boolean',
    'INVALID_ARGUMENT',
    'requireProof must be a boolean',
  )
  assertDomain(
    body.confirmationToken === undefined ||
      (
        typeof body.confirmationToken === 'string' &&
        body.confirmationToken.length >= 32 &&
        body.confirmationToken.length <= 4_096 &&
        /^[\x21-\x7E]+$/.test(body.confirmationToken)
      ),
    'INVALID_ARGUMENT',
    'confirmationToken is invalid',
  )
  return Object.freeze({
    compatibilityGraphId: identity(
      body.compatibilityGraphId,
      'compatibilityGraphId',
    ),
    expectedCompatibilityGraphRunHash:
      body.expectedCompatibilityGraphRunHash,
    requestedRecipeCount: Number(body.requestedRecipeCount),
    ...(body.requireProof !== undefined
      ? { requireProof: body.requireProof }
      : {}),
    ...(body.confirmationToken !== undefined
      ? { confirmationToken: body.confirmationToken }
      : {}),
  })
}

export function presentVariantPortfolioPreflight(
  run: Readonly<VariantPortfolioPreflightRun>,
) {
  return run
}

export function presentVariantPortfolioPreflightPage(input: {
  runs: readonly Readonly<VariantPortfolioPreflightRun>[]
  nextCursor?: string
}) {
  return Object.freeze({
    preflights: Object.freeze(
      input.runs.map(presentVariantPortfolioPreflight),
    ),
    ...(input.nextCursor ? { nextCursor: input.nextCursor } : {}),
  })
}
