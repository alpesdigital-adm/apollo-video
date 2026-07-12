import type { AuthenticatedExternalActor } from './authenticate-api-client.ts'
import type {
  ApiClientAdministrationRepository,
  ApiCredentialMutationResult,
} from './ports/api-client-administration-repository.ts'
import type { ApiCredentialCrypto } from './ports/api-credential-crypto.ts'
import { createApiClient, type ApiEnvironment } from '../domain/api-client.ts'
import { createApiCredential } from '../domain/api-credential.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import { calculateVersionHash } from './version-hash.ts'

export type ApiAdministrationEntityKind =
  | 'api-client'
  | 'api-credential'
  | 'idempotency-record'

export interface ApiClientAdministrationDependencies {
  repository: ApiClientAdministrationRepository
  credentialCrypto: ApiCredentialCrypto
  clock: () => Date
  createId: (kind: ApiAdministrationEntityKind) => string
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_ROTATION_OVERLAP_SECONDS = 15 * 60
const MAX_ROTATION_OVERLAP_SECONDS = 24 * 60 * 60

function assertWorkspaceActor(actor: AuthenticatedExternalActor, workspaceId: string): void {
  if (actor.workspaceId !== workspaceId) {
    throw new DomainError('WORKSPACE_NOT_FOUND', 'Workspace was not found')
  }
}

function assertClientsAdministrator(actor: AuthenticatedExternalActor): void {
  if (!actor.scopes.has('clients:admin')) {
    throw new DomainError('AUTH_SCOPE_REQUIRED', 'API client lacks the required scope', {
      requiredScope: 'clients:admin',
    })
  }
}

function assertIdempotencyKey(key: string): string {
  const normalized = key.trim()
  assertDomain(normalized.length > 0, 'INVALID_ARGUMENT', 'Idempotency-Key is required')
  assertDomain(normalized.length <= 128, 'INVALID_ARGUMENT', 'Idempotency-Key is too long')
  return normalized
}

function presentMutation(
  result: ApiCredentialMutationResult,
  token: string,
) {
  return Object.freeze({
    ...result,
    token: result.replayed ? undefined : token,
    secretAvailable: !result.replayed,
  })
}

export function createApiClientAdministrationService(
  dependencies: ApiClientAdministrationDependencies,
) {
  return async function execute(request: {
    actor: AuthenticatedExternalActor
    workspaceId: string
    name: string
    environment?: ApiEnvironment
    scopes: string[]
    idempotencyKey: string
  }) {
    assertClientsAdministrator(request.actor)
    assertWorkspaceActor(request.actor, request.workspaceId)
    const key = assertIdempotencyKey(request.idempotencyKey)
    const environment = request.environment ?? request.actor.environment
    assertDomain(
      environment === request.actor.environment,
      'INVALID_API_CLIENT',
      'ApiClient environment must match the administrative request environment',
    )
    const unauthorizedScopes = request.scopes.filter(
      (scope) => !request.actor.scopes.has(scope),
    )
    assertDomain(
      unauthorizedScopes.length === 0,
      'AUTH_SCOPE_REQUIRED',
      'ApiClient cannot be granted scopes that the administrator does not possess',
      { requiredScope: unauthorizedScopes[0] },
    )

    const now = dependencies.clock()
    const createdAt = now.toISOString()
    const client = createApiClient({
      id: dependencies.createId('api-client'),
      workspaceId: request.workspaceId,
      name: request.name,
      status: 'active',
      environment,
      scopes: request.scopes,
      createdAt,
    })
    const credential = createApiCredential({
      id: dependencies.createId('api-credential'),
      workspaceId: request.workspaceId,
      clientId: client.id,
      status: 'active',
      createdAt,
    })
    const issued = dependencies.credentialCrypto.issue(client.id, credential.id)
    const result = await dependencies.repository.createOrReplay({
      client,
      credential,
      secret: { secretSalt: issued.secretSalt, secretHash: issued.secretHash },
      idempotency: {
        id: dependencies.createId('idempotency-record'),
        workspaceId: request.workspaceId,
        actorClientId: request.actor.clientId,
        key,
        requestFingerprint: calculateVersionHash({
          operation: 'api-client.create',
          name: client.name,
          environment,
          scopes: client.scopes,
        }),
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
      },
    })

    return presentMutation(result, issued.token)
  }
}

export function rotateApiCredentialService(
  dependencies: ApiClientAdministrationDependencies,
) {
  return async function execute(request: {
    actor: AuthenticatedExternalActor
    workspaceId: string
    targetClientId: string
    idempotencyKey: string
    overlapSeconds?: number
  }) {
    assertClientsAdministrator(request.actor)
    assertWorkspaceActor(request.actor, request.workspaceId)
    const key = assertIdempotencyKey(request.idempotencyKey)
    const overlapSeconds = request.overlapSeconds ?? DEFAULT_ROTATION_OVERLAP_SECONDS
    assertDomain(
      Number.isInteger(overlapSeconds) &&
        overlapSeconds >= 0 &&
        overlapSeconds <= MAX_ROTATION_OVERLAP_SECONDS,
      'INVALID_ARGUMENT',
      'overlapSeconds must be an integer from 0 to 86400',
    )

    const now = dependencies.clock()
    const credential = createApiCredential({
      id: dependencies.createId('api-credential'),
      workspaceId: request.workspaceId,
      clientId: request.targetClientId,
      status: 'active',
      createdAt: now.toISOString(),
    })
    const issued = dependencies.credentialCrypto.issue(
      request.targetClientId,
      credential.id,
    )
    const result = await dependencies.repository.rotateOrReplay({
      workspaceId: request.workspaceId,
      targetClientId: request.targetClientId,
      credential,
      secret: { secretSalt: issued.secretSalt, secretHash: issued.secretHash },
      overlapUntil: new Date(now.getTime() + overlapSeconds * 1000).toISOString(),
      idempotency: {
        id: dependencies.createId('idempotency-record'),
        workspaceId: request.workspaceId,
        actorClientId: request.actor.clientId,
        key,
        requestFingerprint: calculateVersionHash({
          operation: 'api-credential.rotate',
          targetClientId: request.targetClientId,
          overlapSeconds,
        }),
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
      },
    })

    return presentMutation(result, issued.token)
  }
}

export function revokeApiCredentialService(
  dependencies: Pick<ApiClientAdministrationDependencies, 'repository' | 'clock'>,
) {
  return async function execute(request: {
    actor: AuthenticatedExternalActor
    workspaceId: string
    targetClientId: string
    credentialId: string
  }) {
    assertClientsAdministrator(request.actor)
    assertWorkspaceActor(request.actor, request.workspaceId)
    if (
      request.targetClientId === request.actor.clientId &&
      request.credentialId === request.actor.credentialId
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'The credential authenticating this request cannot revoke itself',
      )
    }

    return dependencies.repository.revokeCredential({
      workspaceId: request.workspaceId,
      clientId: request.targetClientId,
      credentialId: request.credentialId,
      revokedAt: dependencies.clock().toISOString(),
    })
  }
}

export function listApiClientsService(
  dependencies: Pick<ApiClientAdministrationDependencies, 'repository'>,
) {
  return async function execute(request: {
    actor: AuthenticatedExternalActor
    workspaceId: string
    limit: number
  }) {
    assertClientsAdministrator(request.actor)
    assertWorkspaceActor(request.actor, request.workspaceId)
    assertDomain(
      Number.isInteger(request.limit) && request.limit >= 1 && request.limit <= 100,
      'INVALID_ARGUMENT',
      'limit must be an integer from 1 to 100',
    )
    return dependencies.repository.listByWorkspace(request.workspaceId, request.limit)
  }
}
