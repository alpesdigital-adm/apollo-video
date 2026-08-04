import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import {
  createBatchEditCommand,
  createBatchEditPolicy,
  createBatchEditPreflight,
  type BatchEditCommand,
  type BatchEditMode,
  type BatchEditOperation,
  type BatchEditPreflightRun,
} from '../domain/batch-edit.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import type {
  BatchEditRepository,
} from './ports/batch-edit-repository.ts'
import type {
  PreflightCommitTokenIssuer,
} from './ports/preflight-commit-token.ts'
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

function hash(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && HASH.test(value),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value
}

function key(value: unknown): string {
  assertDomain(
    typeof value === 'string' && IDEMPOTENCY.test(value.trim()),
    'INVALID_ARGUMENT',
    'Idempotency-Key must contain 8 to 128 visible ASCII characters',
  )
  return value.trim()
}

function integer(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  assertDomain(
    Number.isSafeInteger(value) &&
      Number(value) >= minimum &&
      Number(value) <= maximum,
    'INVALID_ARGUMENT',
    `${field} must be an integer between ${minimum} and ${maximum}`,
  )
  return Number(value)
}

function now(clock: () => Date): Date {
  const value = clock()
  assertDomain(
    value instanceof Date && Number.isFinite(value.getTime()),
    'INVALID_ARGUMENT',
    'Clock returned an invalid instant',
  )
  return value
}

function ids(
  value: readonly string[],
  field: string,
): readonly string[] {
  assertDomain(
    Array.isArray(value) && value.length >= 1 && value.length <= 1_000,
    'INVALID_ARGUMENT',
    `${field} must contain one to 1000 IDs`,
  )
  const normalized = value.map((item, index) =>
    identity(item, `${field}[${index}]`))
  assertDomain(
    new Set(normalized).size === normalized.length,
    'INVALID_ARGUMENT',
    `${field} contains duplicate IDs`,
  )
  return Object.freeze(normalized.toSorted())
}

function edit(value: Readonly<BatchEditOperation>) {
  assertDomain(
    value &&
      ['replace-cta', 'subtitle-style', 'brand-kit'].includes(
        value.type,
      ),
    'INVALID_ARGUMENT',
    'operation.type is invalid',
  )
  return Object.freeze({
    type: value.type,
    valueRef: identity(value.valueRef, 'operation.valueRef'),
  })
}

function mode(value: BatchEditMode | undefined): BatchEditMode | undefined {
  assertDomain(
    value === undefined ||
      value === 'all-or-nothing' ||
      value === 'skip-failures',
    'INVALID_ARGUMENT',
    'mode is invalid',
  )
  return value
}

function preflightRequestFingerprint(input: {
  workspaceId: string
  batchId: string
  expectedBatchRevision: number
  expectedBatchDefinitionHash: string
  recipeIds: readonly string[]
  outputSpecIds: readonly string[]
  itemIds: readonly string[]
  operation: Readonly<BatchEditOperation>
  mode?: BatchEditMode
  actorContextHash: string
}) {
  return calculateCanonicalHash({
    schemaVersion: 'batch-edit-preflight-request/v1',
    ...input,
  })
}

function commandRequestFingerprint(input: {
  workspaceId: string
  batchId: string
  preflightId: string
  expectedPreflightHash: string
  expectedScopeHash: string
  actorContextHash: string
}) {
  return calculateCanonicalHash({
    schemaVersion: 'batch-edit-command-request/v1',
    ...input,
  })
}

function commitToken(
  issuer: PreflightCommitTokenIssuer,
  run: Readonly<BatchEditPreflightRun>,
  requestFingerprint: string,
): string | undefined {
  if (
    !['ready', 'partial-ready'].includes(run.status) ||
    !run.confirmationExpiresAt
  ) {
    return undefined
  }
  return issuer.issue({
    clientId: run.createdByClientId,
    workspaceId: run.workspaceId,
    fingerprint: requestFingerprint,
    snapshot: run.scope.scopeHash,
    costFingerprint: run.costFingerprint,
    expiresAt: run.confirmationExpiresAt,
  })
}

export interface CreateBatchEditPreflightRequest {
  workspaceId: string
  batchId: string
  expectedBatchRevision: number
  expectedBatchDefinitionHash: string
  recipeIds: readonly string[]
  outputSpecIds: readonly string[]
  itemIds: readonly string[]
  operation: Readonly<BatchEditOperation>
  mode?: BatchEditMode
  actor: AuthenticatedExternalActor
  idempotencyKey: string
}

export function createBatchEditPreflightService(dependencies: {
  repository: BatchEditRepository
  tokenIssuer: PreflightCommitTokenIssuer
  clock: () => Date
  createPreflightId: () => string
}) {
  return async function execute(
    request: Readonly<CreateBatchEditPreflightRequest>,
  ) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const batchId = identity(request.batchId, 'batchId')
    const expectedBatchRevision = integer(
      request.expectedBatchRevision,
      'expectedBatchRevision',
      1,
      1_000_000,
    )
    const expectedBatchDefinitionHash = hash(
      request.expectedBatchDefinitionHash,
      'expectedBatchDefinitionHash',
    )
    const recipeIds = ids(request.recipeIds, 'recipeIds')
    const outputSpecIds = ids(request.outputSpecIds, 'outputSpecIds')
    const itemIds = ids(request.itemIds, 'itemIds')
    const operation = edit(request.operation)
    const resolvedMode = mode(request.mode)
    requireScope(request.actor, 'projects:write')
    const authenticationAudit = materializeActorAuditContext(request.actor)
    assertDomain(authenticationAudit.workspaceId === workspaceId, 'AUTH_INVALID', 'Batch edit preflight actor does not belong to the workspace')
    const clientId = authenticationAudit.clientId
    const idempotencyKey = key(request.idempotencyKey)
    const fingerprint = preflightRequestFingerprint({
      workspaceId,
      batchId,
      expectedBatchRevision,
      expectedBatchDefinitionHash,
      recipeIds,
      outputSpecIds,
      itemIds,
      operation,
      ...(resolvedMode ? { mode: resolvedMode } : {}),
      actorContextHash: authenticationAudit.contextHash,
    })
    const replay = await dependencies.repository.findPreflightReplay({
      workspaceId,
      actorClientId: clientId,
      actorContextHash: authenticationAudit.contextHash,
      idempotencyKey,
    })
    if (replay) {
      if (replay.requestFingerprint !== fingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was used with a different batch edit preflight request',
        )
      }
      return Object.freeze({
        run: replay.run,
        replayed: true,
        commitToken: commitToken(
          dependencies.tokenIssuer,
          replay.run,
          fingerprint,
        ),
      })
    }
    const createdAt = now(dependencies.clock).toISOString()
    const context = await dependencies.repository.loadPreflightContext({
      workspaceId,
      batchId,
      expectedBatchRevision,
      expectedBatchDefinitionHash,
      itemIds,
      actorClientId: clientId,
      createdAt,
    })
    const existingPolicy = await dependencies.repository.readPolicy({
      workspaceId,
    })
    const policy = existingPolicy ??
      await dependencies.repository.ensurePolicy(
        createBatchEditPolicy({
          workspaceId,
          updatedByClientId: clientId,
          updatedAt: createdAt,
        }),
      )
    const run = createBatchEditPreflight({
      id: identity(
        dependencies.createPreflightId(),
        'created batch edit preflight ID',
      ),
      workspaceId,
      projectId: context.projectId,
      batchId,
      batchRevision: context.batchRevision,
      batchDefinitionHash: context.batchDefinitionHash,
      policy,
      ...(resolvedMode ? { mode: resolvedMode } : {}),
      operation,
      recipeIds,
      outputSpecIds,
      itemIds,
      availableRecipeIds: context.availableRecipeIds,
      availableOutputSpecIds: context.availableOutputSpecIds,
      availableItemIds: context.availableItemIds,
      items: context.items,
      budgetRemainingMinorUnits: context.budgetRemainingMinorUnits,
      createdByClientId: clientId,
      createdAt,
    })
    const created = await dependencies.repository.createPreflight({
      run,
      requestFingerprint: fingerprint,
      idempotencyKey,
      authenticationAudit,
    })
    return Object.freeze({
      ...created,
      commitToken: commitToken(
        dependencies.tokenIssuer,
        created.run,
        fingerprint,
      ),
    })
  }
}

export interface CommitBatchEditRequest {
  workspaceId: string
  batchId: string
  preflightId: string
  expectedPreflightHash: string
  expectedScopeHash: string
  commitToken: string
  actor: AuthenticatedExternalActor
  idempotencyKey: string
}

export function commitBatchEditService(dependencies: {
  repository: BatchEditRepository
  tokenIssuer: PreflightCommitTokenIssuer
  clock: () => Date
  createCommandId: () => string
}) {
  return async function execute(
    request: Readonly<CommitBatchEditRequest>,
  ) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const batchId = identity(request.batchId, 'batchId')
    const preflightId = identity(request.preflightId, 'preflightId')
    const expectedPreflightHash = hash(
      request.expectedPreflightHash,
      'expectedPreflightHash',
    )
    const expectedScopeHash = hash(
      request.expectedScopeHash,
      'expectedScopeHash',
    )
    requireScope(request.actor, 'projects:write')
    const authenticationAudit = materializeActorAuditContext(request.actor)
    assertDomain(authenticationAudit.workspaceId === workspaceId, 'AUTH_INVALID', 'Batch edit command actor does not belong to the workspace')
    const clientId = authenticationAudit.clientId
    const idempotencyKey = key(request.idempotencyKey)
    assertDomain(
      typeof request.commitToken === 'string' &&
        request.commitToken.length >= 32 &&
        request.commitToken.length <= 4_096 &&
        /^[\x21-\x7E]+$/.test(request.commitToken),
      'INVALID_ARGUMENT',
      'commitToken is invalid',
    )
    const fingerprint = commandRequestFingerprint({
      workspaceId,
      batchId,
      preflightId,
      expectedPreflightHash,
      expectedScopeHash,
      actorContextHash: authenticationAudit.contextHash,
    })
    const replay = await dependencies.repository.findCommandReplay({
      workspaceId,
      actorClientId: clientId,
      actorContextHash: authenticationAudit.contextHash,
      idempotencyKey,
    })
    if (replay) {
      if (replay.requestFingerprint !== fingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was used with a different batch edit commit request',
        )
      }
      return Object.freeze({
        command: replay.command,
        replayed: true,
      })
    }
    const preflightRecord =
      await dependencies.repository.readPreflightRecord({
        workspaceId,
        batchId,
        preflightId,
      })
    if (!preflightRecord) {
      throw new DomainError(
        'BATCH_EDIT_PREFLIGHT_NOT_FOUND',
        'Batch edit preflight was not found',
      )
    }
    const preflight = preflightRecord.run
    assertDomain(
      preflight.preflightHash === expectedPreflightHash &&
        preflight.scope.scopeHash === expectedScopeHash,
      'VERSION_CONFLICT',
      'Batch edit preflight or explicit scope is stale',
    )
    assertDomain(
      preflight.createdByClientId === clientId &&
        preflightRecord.authenticationAudit.contextHash === authenticationAudit.contextHash,
      'AUTH_INVALID',
      'Batch edit commit actor differs from the preflight actor',
    )
    validatePreflightCommitTokenService({
      issuer: dependencies.tokenIssuer,
      clock: dependencies.clock,
    })({
      token: request.commitToken,
      clientId,
      workspaceId,
      fingerprint: preflightRecord.requestFingerprint,
      snapshot: preflight.scope.scopeHash,
      costFingerprint: preflight.costFingerprint,
    })
    const states = await dependencies.repository.loadCommitStates({
      workspaceId,
      batchId,
      itemIds: preflight.scope.itemIds,
    })
    const createdAt = now(dependencies.clock).toISOString()
    const command = createBatchEditCommand({
      id: identity(
        dependencies.createCommandId(),
        'created batch edit command ID',
      ),
      preflight,
      currentStates: states,
      createdByClientId: clientId,
      createdAt,
    })
    return dependencies.repository.commit({
      command,
      requestFingerprint: fingerprint,
      idempotencyKey,
      authenticationAudit,
    })
  }
}

export function readBatchEditPreflightService(dependencies: {
  repository: BatchEditRepository
}) {
  return async function execute(request: {
    workspaceId: string
    batchId: string
    preflightId: string
  }): Promise<Readonly<BatchEditPreflightRun>> {
    const record = await dependencies.repository.readPreflightRecord({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      batchId: identity(request.batchId, 'batchId'),
      preflightId: identity(request.preflightId, 'preflightId'),
    })
    if (!record) {
      throw new DomainError(
        'BATCH_EDIT_PREFLIGHT_NOT_FOUND',
        'Batch edit preflight was not found',
      )
    }
    return record.run
  }
}

export function listBatchEditPreflightsService(dependencies: {
  repository: BatchEditRepository
}) {
  return async function execute(request: {
    workspaceId: string
    batchId: string
    limit?: number
    cursor?: string
  }) {
    const limit = integer(request.limit ?? 20, 'limit', 1, 100)
    return dependencies.repository.listPreflights({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      batchId: identity(request.batchId, 'batchId'),
      limit,
      ...(request.cursor
        ? { cursor: identity(request.cursor, 'cursor') }
        : {}),
    })
  }
}

export function readBatchEditCommandService(dependencies: {
  repository: BatchEditRepository
}) {
  return async function execute(request: {
    workspaceId: string
    batchId: string
    commandId: string
  }): Promise<Readonly<BatchEditCommand>> {
    const command = await dependencies.repository.readCommand({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      batchId: identity(request.batchId, 'batchId'),
      commandId: identity(request.commandId, 'commandId'),
    })
    if (!command) {
      throw new DomainError(
        'BATCH_EDIT_COMMAND_NOT_FOUND',
        'Batch edit command was not found',
      )
    }
    return command
  }
}

export function listBatchEditCommandsService(dependencies: {
  repository: BatchEditRepository
}) {
  return async function execute(request: {
    workspaceId: string
    batchId: string
    limit?: number
    cursor?: string
  }) {
    const limit = integer(request.limit ?? 20, 'limit', 1, 100)
    return dependencies.repository.listCommands({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      batchId: identity(request.batchId, 'batchId'),
      limit,
      ...(request.cursor
        ? { cursor: identity(request.cursor, 'cursor') }
        : {}),
    })
  }
}
