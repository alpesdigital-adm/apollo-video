import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import {
  createCompatibilityGraph,
  type CompatibilityNodeContextInput,
} from '../domain/compatibility-graph.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import type {
  CompatibilityGraphRepository,
} from './ports/compatibility-graph-repository.ts'
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

function idempotencyKey(value: unknown): string {
  assertDomain(
    typeof value === 'string' && IDEMPOTENCY.test(value.trim()),
    'INVALID_ARGUMENT',
    'Idempotency-Key must contain 8 to 128 visible ASCII characters',
  )
  return value.trim()
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
      'Idempotency key was used with a different compatibility graph request',
    )
  }
}

export interface CreateCompatibilityGraphRequest {
  workspaceId: string
  batchId: string
  takeLibraryId: string
  expectedTakeLibraryRunHash: string
  contexts: readonly Readonly<CompatibilityNodeContextInput>[]
  acceptThreshold?: number
  reviewThreshold?: number
  actor: AuthenticatedExternalActor
  idempotencyKey: string
}

export function createCompatibilityGraphService(dependencies: {
  repository: CompatibilityGraphRepository
  clock: () => Date
  createRunId: () => string
}) {
  return async function execute(
    request: Readonly<CreateCompatibilityGraphRequest>,
  ) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const batchId = identity(request.batchId, 'batchId')
    const takeLibraryId = identity(
      request.takeLibraryId,
      'takeLibraryId',
    )
    assertDomain(
      HASH.test(request.expectedTakeLibraryRunHash ?? ''),
      'INVALID_ARGUMENT',
      'expectedTakeLibraryRunHash is invalid',
    )
    assertDomain(
      Array.isArray(request.contexts) &&
      request.contexts.length <= 2_000,
      'INVALID_ARGUMENT',
      'contexts must contain at most 2000 entries',
    )
    requireScope(request.actor, 'projects:write')
    const authenticationAudit = materializeActorAuditContext(request.actor)
    assertDomain(
      authenticationAudit.workspaceId === workspaceId,
      'AUTH_INVALID',
      'Compatibility graph actor does not belong to the workspace',
    )
    const clientId = authenticationAudit.clientId
    const key = idempotencyKey(request.idempotencyKey)
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'compatibility-graph-create-request/v1',
      workspaceId,
      batchId,
      takeLibraryId,
      expectedTakeLibraryRunHash: request.expectedTakeLibraryRunHash,
      contexts: request.contexts,
      acceptThreshold: request.acceptThreshold ?? 70,
      reviewThreshold: request.reviewThreshold ?? 60,
      actorContextHash: authenticationAudit.contextHash,
    })
    const existing = await dependencies.repository.findCreateReplay({
      workspaceId,
      actorClientId: clientId,
      actorContextHash: authenticationAudit.contextHash,
      idempotencyKey: key,
    })
    if (existing) {
      replay(existing, requestFingerprint)
      return Object.freeze({ run: existing.run, replayed: true })
    }
    const context = await dependencies.repository.loadCreationContext({
      workspaceId,
      batchId,
      takeLibraryId,
      expectedTakeLibraryRunHash:
        request.expectedTakeLibraryRunHash,
      actorClientId: clientId,
    })
    const run = createCompatibilityGraph({
      id: identity(
        dependencies.createRunId(),
        'created compatibility graph ID',
      ),
      workspaceId,
      projectId: identity(context.projectId, 'projectId'),
      batchId,
      takeLibrary: context.takeLibrary,
      contexts: request.contexts,
      ...(request.acceptThreshold !== undefined
        ? { acceptThreshold: request.acceptThreshold }
        : {}),
      ...(request.reviewThreshold !== undefined
        ? { reviewThreshold: request.reviewThreshold }
        : {}),
      createdByClientId: clientId,
      createdAt: now(dependencies.clock),
    })
    return dependencies.repository.create({
      run,
      requestFingerprint,
      idempotencyKey: key,
      authenticationAudit,
    })
  }
}

export function readCompatibilityGraphService(dependencies: {
  repository: CompatibilityGraphRepository
}) {
  return async function execute(request: {
    workspaceId: string
    batchId: string
    runId: string
  }) {
    const run = await dependencies.repository.read({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      batchId: identity(request.batchId, 'batchId'),
      runId: identity(request.runId, 'compatibilityGraphId'),
    })
    if (!run) {
      throw new DomainError(
        'COMPATIBILITY_GRAPH_NOT_FOUND',
        'Compatibility graph was not found',
      )
    }
    return run
  }
}

export function listCompatibilityGraphsService(dependencies: {
  repository: CompatibilityGraphRepository
}) {
  return async function execute(request: {
    workspaceId: string
    batchId: string
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
      limit,
      ...(request.cursor
        ? { cursor: identity(request.cursor, 'cursor') }
        : {}),
    })
  }
}
