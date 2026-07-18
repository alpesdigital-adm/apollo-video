import { DomainError, assertDomain } from '../domain/errors.ts'
import { createQueuedPublicOperation } from '../domain/public-operation.ts'
import type { MaterializationAuthorizationRepository } from './ports/materialization-authorization-repository.ts'
import type { PublicOperationRepository } from './ports/public-operation-repository.ts'
import { calculateVersionHash } from './version-hash.ts'

function validateId(value: string, field: string): string {
  const normalized = value.trim()
  assertDomain(
    normalized.length >= 3 && normalized.length <= 128,
    'INVALID_ARGUMENT',
    `${field} must contain 3 to 128 characters`,
  )
  return normalized
}

export function enqueueAuthorizedRenderService(dependencies: {
  authorizations: MaterializationAuthorizationRepository
  operations: PublicOperationRepository
  clock: () => Date
  createId: () => string
  maxAttempts?: number
}) {
  return async function enqueueAuthorizedRender(request: {
    workspaceId: string
    artifactId: string
    manifestId: string
    authorizationId: string
    actor: { type: 'api-client'; id: string }
    idempotencyKey: string
  }) {
    const workspaceId = validateId(request.workspaceId, 'workspaceId')
    const artifactId = validateId(request.artifactId, 'artifactId')
    const manifestId = validateId(request.manifestId, 'manifestId')
    const authorizationId = validateId(request.authorizationId, 'authorizationId')
    const clientId = validateId(request.actor.id, 'actor.id')
    const idempotencyKey = request.idempotencyKey.trim()
    assertDomain(
      idempotencyKey.length > 0 && idempotencyKey.length <= 128,
      'INVALID_ARGUMENT',
      'Idempotency-Key must contain 1 to 128 characters',
    )
    const requestFingerprint = calculateVersionHash({
      type: 'artifact-render',
      artifactId,
      manifestId,
      authorizationId,
    })
    const replay = await dependencies.operations.findReplay({
      workspaceId,
      clientId,
      idempotencyKey,
      requestFingerprint,
    })
    if (replay) return replay

    const authorization = await dependencies.authorizations.findById(
      workspaceId,
      authorizationId,
    )
    if (!authorization) {
      throw new DomainError(
        'MATERIALIZATION_AUTHORIZATION_NOT_FOUND',
        'Materialization authorization was not found',
      )
    }
    assertDomain(
      authorization.artifactId === artifactId &&
        authorization.manifestId === manifestId,
      'INVALID_ARGUMENT',
      'Authorization does not target the requested artifact manifest',
    )
    assertDomain(
      authorization.actor.type === 'api-client' && authorization.actor.id === clientId,
      'MATERIALIZATION_AUTHORIZATION_REJECTED',
      'Authorization belongs to a different API client',
    )
    if (authorization.status !== 'authorized') {
      throw new DomainError(
        'MATERIALIZATION_AUTHORIZATION_REJECTED',
        'Materialization authorization was rejected',
      )
    }
    const now = dependencies.clock()
    assertDomain(!Number.isNaN(now.getTime()), 'INVALID_ARGUMENT', 'clock returned an invalid date')
    if (
      !authorization.validUntil ||
      Date.parse(authorization.validUntil) <= now.getTime()
    ) {
      throw new DomainError(
        'MATERIALIZATION_AUTHORIZATION_EXPIRED',
        'Materialization authorization expired before enqueue',
      )
    }

    const operation = createQueuedPublicOperation({
      id: dependencies.createId(),
      workspaceId,
      clientId,
      type: 'artifact-render',
      target: { type: 'media-artifact', id: artifactId, manifestId },
      maxAttempts: dependencies.maxAttempts,
      createdAt: now.toISOString(),
    })
    return dependencies.operations.createOrReplay({
      operation,
      context: {
        kind: 'artifact-render',
        authorizationId,
        inputHash: authorization.inputHash,
      },
      idempotencyKey,
      requestFingerprint,
    })
  }
}
