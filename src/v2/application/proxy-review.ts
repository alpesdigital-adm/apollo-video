import { assertDomain, DomainError } from '../domain/errors.ts'
import type { ProxyReviewRepository } from './ports/proxy-review-repository.ts'
import { calculateVersionHash } from './version-hash.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'

function validateId(value: string, field: string): string {
  const normalized = value.trim()
  assertDomain(
    /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(normalized),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return normalized
}

function validateHash(value: string, field: string): string {
  const normalized = value.trim().toLowerCase()
  assertDomain(/^[a-f0-9]{64}$/.test(normalized), 'INVALID_ARGUMENT', `${field} must be a SHA-256 hash`)
  return normalized
}

export function readProxyReviewService(dependencies: {
  repository: ProxyReviewRepository
}) {
  return async function read(request: {
    workspaceId: string
    projectId: string
    projectVersionId?: string
  }) {
    const workspaceId = validateId(request.workspaceId, 'workspaceId')
    const projectId = validateId(request.projectId, 'projectId')
    const projectVersionId = request.projectVersionId
      ? validateId(request.projectVersionId, 'projectVersionId')
      : undefined
    const review = await dependencies.repository.findCurrent({
      workspaceId,
      projectId,
      ...(projectVersionId ? { projectVersionId } : {}),
    })
    if (!review) throw new DomainError('PROJECT_NOT_FOUND', 'A rendered proxy review was not found for this project version')
    return review
  }
}

export function acknowledgeProxyWarningsService(dependencies: {
  repository: ProxyReviewRepository
  clock: () => Date
  createId: () => string
}) {
  return async function acknowledge(request: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    proxyReviewId: string
    baseReviewHash: string
    expectedRevision: number
    action: 'acknowledge-warnings'
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }) {
    const workspaceId = validateId(request.workspaceId, 'workspaceId')
    const projectId = validateId(request.projectId, 'projectId')
    const projectVersionId = validateId(request.projectVersionId, 'projectVersionId')
    const proxyReviewId = validateId(request.proxyReviewId, 'proxyReviewId')
    requireScope(request.actor, 'projects:write')
    const authenticationAudit = materializeActorAuditContext(request.actor)
    assertDomain(authenticationAudit.workspaceId === workspaceId, 'AUTH_INVALID', 'Proxy review actor does not belong to the workspace')
    const actorId = validateId(authenticationAudit.clientId, 'actor.id')
    const baseReviewHash = validateHash(request.baseReviewHash, 'baseReviewHash')
    assertDomain(
      Number.isSafeInteger(request.expectedRevision) && request.expectedRevision >= 1,
      'INVALID_ARGUMENT',
      'expectedRevision must be a positive integer',
    )
    assertDomain(request.action === 'acknowledge-warnings', 'INVALID_ARGUMENT', 'Unsupported proxy review action')
    const idempotencyKey = request.idempotencyKey.trim()
    assertDomain(
      idempotencyKey.length >= 1 && idempotencyKey.length <= 128,
      'INVALID_ARGUMENT',
      'Idempotency-Key must contain 1 to 128 characters',
    )
    const requestFingerprint = calculateVersionHash({
      kind: 'proxy-review-decision/v1',
      workspaceId,
      projectId,
      projectVersionId,
      proxyReviewId,
      action: request.action,
      baseReviewHash,
      expectedRevision: request.expectedRevision,
      actorContextHash: authenticationAudit.contextHash,
    })
    return dependencies.repository.acknowledgeWarnings({
      workspaceId,
      projectId,
      projectVersionId,
      proxyReviewId,
      baseReviewHash,
      expectedRevision: request.expectedRevision,
      decisionId: dependencies.createId(),
      actor: { type: 'api-client', id: actorId },
      authenticationAudit,
      idempotencyKey,
      requestFingerprint,
      createdAt: dependencies.clock().toISOString(),
    })
  }
}
