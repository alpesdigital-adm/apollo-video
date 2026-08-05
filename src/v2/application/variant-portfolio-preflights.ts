import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  createVariantPortfolioPreflightResult,
} from '../domain/preflight-result.ts'
import {
  createVariantPortfolioPolicy,
  createVariantPortfolioPreflight,
  type VariantPortfolioPreflightRun,
} from '../domain/variant-portfolio-preflight.ts'
import type {
  PreflightCommitTokenIssuer,
} from './ports/preflight-commit-token.ts'
import type {
  VariantPortfolioPreflightRepository,
} from './ports/variant-portfolio-preflight-repository.ts'
import {
  validatePreflightCommitTokenService,
} from './validate-preflight-commit-token.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const IDEMPOTENCY = /^[\x21-\x7E]{8,128}$/

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function key(value: unknown): string {
  assertDomain(
    typeof value === 'string' && IDEMPOTENCY.test(value.trim()),
    'INVALID_ARGUMENT',
    'Idempotency-Key must contain 8 to 128 visible ASCII characters',
  )
  return value.trim()
}

function validNow(clock: () => Date): Date {
  const value = clock()
  assertDomain(
    value instanceof Date && Number.isFinite(value.getTime()),
    'INVALID_ARGUMENT',
    'Clock returned an invalid instant',
  )
  return value
}

function requestFingerprint(input: {
  workspaceId: string
  batchId: string
  compatibilityGraphId: string
  expectedCompatibilityGraphRunHash: string
  requestedRecipeCount: number
  requireProof: boolean
  actorContextHash: string
}) {
  return calculateCanonicalHash({
    schemaVersion: 'variant-portfolio-preflight-request/v1',
    ...input,
  })
}

function costFingerprint(input: {
  runHash: string
  policyHash: string
  requestedRecipeCount: number
  batchVariantCount: number
  budgetRemainingMinorUnits: number
}) {
  return calculateCanonicalHash({
    schemaVersion: 'variant-portfolio-preflight-cost/v1',
    ...input,
  })
}

function confirmationToken(
  issuer: PreflightCommitTokenIssuer,
  run: Readonly<VariantPortfolioPreflightRun>,
  fingerprint: string,
): string | undefined {
  if (!run.confirmation.required || !run.confirmation.expiresAt) {
    return undefined
  }
  return issuer.issue({
    clientId: run.createdByClientId,
    workspaceId: run.workspaceId,
    fingerprint,
    snapshot: run.compatibilityGraphRunHash,
    costFingerprint: costFingerprint({
      runHash: run.compatibilityGraphRunHash,
      policyHash: run.policy.policyHash,
      requestedRecipeCount: run.requestedRecipeCount,
      batchVariantCount: run.batchVariantCount,
      budgetRemainingMinorUnits: run.budgetRemainingMinorUnits,
    }),
    expiresAt: run.confirmation.expiresAt,
  })
}

export interface CreateVariantPortfolioPreflightRequest {
  workspaceId: string
  batchId: string
  compatibilityGraphId: string
  expectedCompatibilityGraphRunHash: string
  requestedRecipeCount: number
  requireProof?: boolean
  confirmationToken?: string
  actor: AuthenticatedExternalActor
  idempotencyKey: string
}

export function createVariantPortfolioPreflightService(dependencies: {
  repository: VariantPortfolioPreflightRepository
  tokenIssuer: PreflightCommitTokenIssuer
  clock: () => Date
  createRunId: () => string
}) {
  return async function execute(
    request: Readonly<CreateVariantPortfolioPreflightRequest>,
  ) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const batchId = identity(request.batchId, 'batchId')
    const compatibilityGraphId = identity(
      request.compatibilityGraphId,
      'compatibilityGraphId',
    )
    assertDomain(
      HASH.test(request.expectedCompatibilityGraphRunHash ?? ''),
      'INVALID_ARGUMENT',
      'expectedCompatibilityGraphRunHash is invalid',
    )
    assertDomain(
      Number.isSafeInteger(request.requestedRecipeCount) &&
        request.requestedRecipeCount >= 1 &&
        request.requestedRecipeCount <= 1_000,
      'INVALID_ARGUMENT',
      'requestedRecipeCount must be an integer between 1 and 1000',
    )
    requireScope(request.actor, 'projects:write')
    const authenticationAudit = materializeActorAuditContext(request.actor)
    assertDomain(authenticationAudit.workspaceId === workspaceId, 'AUTH_INVALID', 'Variant portfolio actor does not belong to the workspace')
    const clientId = authenticationAudit.clientId
    const idempotencyKey = key(request.idempotencyKey)
    const fingerprint = requestFingerprint({
      workspaceId,
      batchId,
      compatibilityGraphId,
      expectedCompatibilityGraphRunHash:
        request.expectedCompatibilityGraphRunHash,
      requestedRecipeCount: request.requestedRecipeCount,
      requireProof: request.requireProof === true,
      actorContextHash: authenticationAudit.contextHash,
    })
    const replay = await dependencies.repository.findCreateReplay({
      workspaceId,
      actorClientId: clientId,
      actorContextHash: authenticationAudit.contextHash,
      idempotencyKey,
    })
    if (replay) {
      if (replay.requestFingerprint !== fingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was used with a different variant portfolio preflight request',
        )
      }
      return Object.freeze({
        run: replay.run,
        replayed: true,
        preflightResult: createVariantPortfolioPreflightResult({
          run: replay.run,
          requestFingerprint: fingerprint,
        }),
        confirmationToken: confirmationToken(
          dependencies.tokenIssuer,
          replay.run,
          fingerprint,
        ),
      })
    }
    const context = await dependencies.repository.loadCreationContext({
      workspaceId,
      batchId,
      compatibilityGraphId,
      expectedCompatibilityGraphRunHash:
        request.expectedCompatibilityGraphRunHash,
      actorClientId: clientId,
    })
    const now = validNow(dependencies.clock)
    const existingPolicy = await dependencies.repository.readPolicy({
      workspaceId,
    })
    const policy = existingPolicy ??
      await dependencies.repository.ensurePolicy(
        createVariantPortfolioPolicy({
          workspaceId,
          updatedByClientId: clientId,
          updatedAt: now.toISOString(),
        }),
      )
    assertDomain(
      request.requestedRecipeCount <= policy.maxRecipeLimit,
      'INVALID_ARGUMENT',
      `requestedRecipeCount exceeds workspace maximum ${policy.maxRecipeLimit}`,
    )
    const estimateFingerprint = costFingerprint({
      runHash: context.compatibilityGraph.runHash,
      policyHash: policy.policyHash,
      requestedRecipeCount: request.requestedRecipeCount,
      batchVariantCount: context.batchVariantCount,
      budgetRemainingMinorUnits: context.budgetRemainingMinorUnits,
    })
    let confirmationSatisfied = false
    if (request.confirmationToken) {
      validatePreflightCommitTokenService({
        issuer: dependencies.tokenIssuer,
        clock: dependencies.clock,
      })({
        token: request.confirmationToken,
        clientId,
        workspaceId,
        fingerprint,
        snapshot: context.compatibilityGraph.runHash,
        costFingerprint: estimateFingerprint,
      })
      confirmationSatisfied = true
    }
    const confirmationExpiresAt =
      request.requestedRecipeCount > policy.defaultRecipeLimit &&
      !confirmationSatisfied
        ? new Date(
            now.getTime() + policy.confirmationTtlSeconds * 1_000,
          ).toISOString()
        : undefined
    const run = createVariantPortfolioPreflight({
      id: identity(
        dependencies.createRunId(),
        'created variant portfolio preflight ID',
      ),
      workspaceId,
      projectId: context.projectId,
      batchId,
      objective: context.objective,
      compatibilityGraph: context.compatibilityGraph,
      policy,
      requestedRecipeCount: request.requestedRecipeCount,
      batchVariantCount: context.batchVariantCount,
      budgetRemainingMinorUnits: context.budgetRemainingMinorUnits,
      requireProof: request.requireProof,
      confirmationSatisfied,
      confirmationExpiresAt,
      existingRecipes: context.existingRecipes,
      createdByClientId: clientId,
      createdAt: now.toISOString(),
    })
    const created = await dependencies.repository.create({
      run,
      requestFingerprint: fingerprint,
      idempotencyKey,
      authenticationAudit,
    })
    return Object.freeze({
      ...created,
      preflightResult: createVariantPortfolioPreflightResult({
        run: created.run,
        requestFingerprint: fingerprint,
      }),
      confirmationToken: confirmationToken(
        dependencies.tokenIssuer,
        created.run,
        fingerprint,
      ),
    })
  }
}

export function readVariantPortfolioPreflightService(dependencies: {
  repository: VariantPortfolioPreflightRepository
}) {
  return async function execute(request: {
    workspaceId: string
    batchId: string
    runId: string
  }) {
    const run = await dependencies.repository.read({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      batchId: identity(request.batchId, 'batchId'),
      runId: identity(request.runId, 'variantPortfolioPreflightId'),
    })
    if (!run) {
      throw new DomainError(
        'VARIANT_PORTFOLIO_PREFLIGHT_NOT_FOUND',
        'Variant portfolio preflight was not found',
      )
    }
    return run
  }
}

export function listVariantPortfolioPreflightsService(dependencies: {
  repository: VariantPortfolioPreflightRepository
}) {
  return async function execute(request: {
    workspaceId: string
    batchId: string
    compatibilityGraphId?: string
    limit?: number
    cursor?: string
  }) {
    const limit = request.limit ?? 20
    assertDomain(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      'INVALID_ARGUMENT',
      'limit must be an integer between 1 and 100',
    )
    return dependencies.repository.list({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      batchId: identity(request.batchId, 'batchId'),
      ...(request.compatibilityGraphId
        ? {
            compatibilityGraphId: identity(
              request.compatibilityGraphId,
              'compatibilityGraphId',
            ),
          }
        : {}),
      limit,
      ...(request.cursor
        ? { cursor: identity(request.cursor, 'cursor') }
        : {}),
    })
  }
}
