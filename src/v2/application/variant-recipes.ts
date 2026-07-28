import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  createVariantRecipe,
  type VariantRecipeAssumptionInput,
  type VariantRecipeColdOpenInput,
  type VariantRecipeSelectionInput,
} from '../domain/variant-recipe.ts'
import type {
  VariantRecipeRepository,
} from './ports/variant-recipe-repository.ts'

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

function idempotencyKey(value: unknown): string {
  assertDomain(
    typeof value === 'string' && IDEMPOTENCY.test(value.trim()),
    'INVALID_ARGUMENT',
    'Idempotency-Key must contain 8 to 128 visible ASCII characters',
  )
  return value.trim()
}

function actorClientId(
  actor: Readonly<{ type: 'api-client'; id: string }>,
): string {
  assertDomain(
    actor?.type === 'api-client',
    'AUTH_INVALID',
    'Variant recipe requires an API client actor',
  )
  return identity(actor.id, 'actor.id')
}

function now(clock: () => Date): string {
  const value = clock()
  assertDomain(
    value instanceof Date && Number.isFinite(value.getTime()),
    'INVALID_ARGUMENT',
    'Clock returned an invalid instant',
  )
  return value.toISOString()
}

function replay(
  value: Readonly<{ requestFingerprint: string }>,
  expected: string,
) {
  if (value.requestFingerprint !== expected) {
    throw new DomainError(
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
      'Idempotency key was used with a different variant recipe request',
    )
  }
}

export interface CreateVariantRecipeRequest {
  workspaceId: string
  batchId: string
  compatibilityGraphId: string
  expectedCompatibilityGraphRunHash: string
  selection: Readonly<VariantRecipeSelectionInput>
  orderedNodeIds: readonly string[]
  assumptions?: readonly Readonly<VariantRecipeAssumptionInput>[]
  requireProof?: boolean
  coldOpen?: Readonly<VariantRecipeColdOpenInput>
  actor: Readonly<{ type: 'api-client'; id: string }>
  idempotencyKey: string
}

export function createVariantRecipeService(dependencies: {
  repository: VariantRecipeRepository
  clock: () => Date
  createRunId: () => string
}) {
  return async function execute(
    request: Readonly<CreateVariantRecipeRequest>,
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
    const clientId = actorClientId(request.actor)
    const key = idempotencyKey(request.idempotencyKey)
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'variant-recipe-create-request/v1',
      workspaceId,
      batchId,
      compatibilityGraphId,
      expectedCompatibilityGraphRunHash:
        request.expectedCompatibilityGraphRunHash,
      selection: request.selection,
      orderedNodeIds: request.orderedNodeIds,
      assumptions: request.assumptions ?? [],
      requireProof: request.requireProof ?? false,
      coldOpen: request.coldOpen ?? null,
      actorClientId: clientId,
    })
    const existing = await dependencies.repository.findCreateReplay({
      workspaceId,
      actorClientId: clientId,
      idempotencyKey: key,
    })
    if (existing) {
      replay(existing, requestFingerprint)
      return Object.freeze({ run: existing.run, replayed: true })
    }
    const context = await dependencies.repository.loadCreationContext({
      workspaceId,
      batchId,
      compatibilityGraphId,
      expectedCompatibilityGraphRunHash:
        request.expectedCompatibilityGraphRunHash,
      actorClientId: clientId,
    })
    const run = createVariantRecipe({
      id: identity(
        dependencies.createRunId(),
        'created variant recipe ID',
      ),
      workspaceId,
      projectId: identity(context.projectId, 'projectId'),
      batchId,
      objective: identity(context.objective, 'objective'),
      compatibilityGraph: context.compatibilityGraph,
      selection: request.selection,
      orderedNodeIds: request.orderedNodeIds,
      ...(request.assumptions
        ? { assumptions: request.assumptions }
        : {}),
      ...(request.requireProof !== undefined
        ? { requireProof: request.requireProof }
        : {}),
      ...(request.coldOpen ? { coldOpen: request.coldOpen } : {}),
      createdByClientId: clientId,
      createdAt: now(dependencies.clock),
    })
    return dependencies.repository.create({
      run,
      requestFingerprint,
      idempotencyKey: key,
    })
  }
}

export function readVariantRecipeService(dependencies: {
  repository: VariantRecipeRepository
}) {
  return async function execute(request: {
    workspaceId: string
    batchId: string
    runId: string
  }) {
    const run = await dependencies.repository.read({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      batchId: identity(request.batchId, 'batchId'),
      runId: identity(request.runId, 'variantRecipeId'),
    })
    if (!run) {
      throw new DomainError(
        'VARIANT_RECIPE_NOT_FOUND',
        'Variant recipe was not found',
      )
    }
    return run
  }
}

export function listVariantRecipesService(dependencies: {
  repository: VariantRecipeRepository
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
