import { randomUUID } from 'node:crypto'

import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'
import type {
  GovernancePolicyMutationResult,
  GovernancePolicyRepository,
} from './ports/governance-policy-repository.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  createGovernancePolicy,
  type GovernanceLimits,
  type GovernancePolicy,
} from '../domain/governance-limits.ts'
import {
  calculateGovernancePolicyCommandResultHash,
  createGovernancePolicyCommand,
} from '../domain/governance-policy-command.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const IDEMPOTENCY_KEY = /^[\x21-\x7E]{8,128}$/

function authorize(
  actor: AuthenticatedExternalActor,
  workspaceIdInput: string,
): Readonly<{ workspaceId: string; audit: ReturnType<typeof materializeActorAuditContext> }> {
  requireScope(actor, 'clients:admin')
  const workspaceId = workspaceIdInput.trim()
  if (actor.workspaceId !== workspaceId) {
    throw new DomainError('WORKSPACE_NOT_FOUND', 'Workspace was not found')
  }
  assertDomain(ID.test(workspaceId), 'INVALID_ARGUMENT', 'workspaceId is invalid')
  return Object.freeze({
    workspaceId,
    audit: materializeActorAuditContext(actor),
  })
}

function normalizeMutation(input: {
  idempotencyKey: string
  reason: string
  confirmed: boolean
}) {
  const idempotencyKey = input.idempotencyKey.trim()
  const reason = input.reason.trim().replace(/\s+/g, ' ')
  assertDomain(
    IDEMPOTENCY_KEY.test(idempotencyKey),
    'INVALID_ARGUMENT',
    'Idempotency-Key must contain 8 to 128 visible ASCII characters',
  )
  assertDomain(
    reason.length >= 3 && reason.length <= 500,
    'INVALID_ARGUMENT',
    'governance policy reason must contain 3 to 500 characters',
  )
  assertDomain(
    input.confirmed === true,
    'TOOL_CONFIRMATION_REQUIRED',
    'governance policy mutation requires explicit confirmation',
  )
  return Object.freeze({ idempotencyKey, reason })
}

export function listGovernancePoliciesService(dependencies: {
  repository: GovernancePolicyRepository
}) {
  return async function execute(input: {
    actor: AuthenticatedExternalActor
    workspaceId: string
  }) {
    const { workspaceId } = authorize(input.actor, input.workspaceId)
    return dependencies.repository.list({ workspaceId })
  }
}

export function setGovernancePolicyService(dependencies: {
  repository: GovernancePolicyRepository
  clock?: () => Date
  createId?: (kind: 'policy' | 'command') => string
}) {
  const clock = dependencies.clock ?? (() => new Date())
  const createId = dependencies.createId ??
    ((kind) => `governance-${kind}-${randomUUID()}`)
  return async function execute(input: {
    actor: AuthenticatedExternalActor
    workspaceId: string
    scopeType: GovernancePolicy['scopeType']
    scopeId: string
    environment: GovernancePolicy['environment']
    limits: GovernanceLimits
    baseRevision?: string
    reason: string
    confirmed: boolean
    idempotencyKey: string
  }): Promise<Readonly<GovernancePolicyMutationResult>> {
    const { workspaceId, audit } = authorize(input.actor, input.workspaceId)
    const mutation = normalizeMutation(input)
    const scopeId = input.scopeId.trim()
    assertDomain(
      ID.test(scopeId) &&
        ((input.scopeType === 'workspace' && scopeId === workspaceId) ||
          input.scopeType === 'client') &&
        (input.environment === 'sandbox' || input.environment === 'production'),
      'INVALID_ARGUMENT',
      'governance policy scope is invalid',
    )
    assertDomain(
      input.baseRevision === undefined || HASH.test(input.baseRevision),
      'INVALID_ARGUMENT',
      'governance policy base revision is invalid',
    )
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'set-governance-policy-request/v1',
      actorContextHash: audit.contextHash,
      workspaceId,
      scopeType: input.scopeType,
      scopeId,
      environment: input.environment,
      limits: input.limits,
      baseRevision: input.baseRevision ?? null,
      reason: mutation.reason,
    })
    const replay = await dependencies.repository.findReplay({
      workspaceId,
      actorContextHash: audit.contextHash,
      idempotencyKey: mutation.idempotencyKey,
      requestFingerprint,
    })
    if (replay) return replay
    const current = await dependencies.repository.findByScope({
      workspaceId,
      scopeType: input.scopeType,
      scopeId,
      environment: input.environment,
    })
    if (
      (current && input.baseRevision !== current.revision) ||
      (!current && input.baseRevision !== undefined)
    ) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'governance policy changed before this command',
        {
          expectedRevision: input.baseRevision ?? null,
          currentRevision: current?.revision ?? null,
        },
      )
    }
    const occurredAt = clock().toISOString()
    const policy = createGovernancePolicy({
      id: current?.id ?? createId('policy'),
      workspaceId,
      scopeType: input.scopeType,
      scopeId,
      environment: input.environment,
      limits: input.limits,
      updatedByClientId: audit.clientId,
      createdAt: current?.createdAt ?? occurredAt,
      updatedAt: occurredAt,
    })
    assertDomain(
      current?.revision !== policy.revision,
      'INVALID_ARGUMENT',
      'governance policy mutation does not change any limit',
    )
    const result = Object.freeze({ action: 'set' as const, policy })
    const resultHash = calculateGovernancePolicyCommandResultHash(result)
    const command = createGovernancePolicyCommand({
      id: createId('command'),
      workspaceId,
      action: 'set',
      policyId: policy.id,
      scopeType: policy.scopeType,
      scopeId: policy.scopeId,
      environment: policy.environment,
      limits: policy.limits,
      ...(current ? { baseRevision: current.revision } : {}),
      resultRevision: policy.revision,
      reason: mutation.reason,
      audit,
      idempotencyKey: mutation.idempotencyKey,
      requestFingerprint,
      resultHash,
      occurredAt,
    })
    return dependencies.repository.applySet({ policy, command, audit })
  }
}

export function deleteGovernancePolicyService(dependencies: {
  repository: GovernancePolicyRepository
  clock?: () => Date
  createId?: () => string
}) {
  const clock = dependencies.clock ?? (() => new Date())
  const createId = dependencies.createId ??
    (() => `governance-command-${randomUUID()}`)
  return async function execute(input: {
    actor: AuthenticatedExternalActor
    workspaceId: string
    policyId: string
    baseRevision: string
    reason: string
    confirmed: boolean
    idempotencyKey: string
  }): Promise<Readonly<GovernancePolicyMutationResult>> {
    const { workspaceId, audit } = authorize(input.actor, input.workspaceId)
    const mutation = normalizeMutation(input)
    const policyId = input.policyId.trim()
    assertDomain(
      ID.test(policyId) && HASH.test(input.baseRevision),
      'INVALID_ARGUMENT',
      'governance policy deletion target is invalid',
    )
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'delete-governance-policy-request/v1',
      actorContextHash: audit.contextHash,
      workspaceId,
      policyId,
      baseRevision: input.baseRevision,
      reason: mutation.reason,
    })
    const replay = await dependencies.repository.findReplay({
      workspaceId,
      actorContextHash: audit.contextHash,
      idempotencyKey: mutation.idempotencyKey,
      requestFingerprint,
    })
    if (replay) return replay
    const current = await dependencies.repository.findById({
      workspaceId,
      policyId,
    })
    if (!current) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'governance policy was not found')
    }
    if (current.revision !== input.baseRevision) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'governance policy changed before deletion',
        {
          expectedRevision: input.baseRevision,
          currentRevision: current.revision,
        },
      )
    }
    const occurredAt = clock().toISOString()
    const result = Object.freeze({
      action: 'delete' as const,
      deletedPolicyId: current.id,
    })
    const resultHash = calculateGovernancePolicyCommandResultHash(result)
    const command = createGovernancePolicyCommand({
      id: createId(),
      workspaceId,
      action: 'delete',
      policyId: current.id,
      scopeType: current.scopeType,
      scopeId: current.scopeId,
      environment: current.environment,
      baseRevision: current.revision,
      reason: mutation.reason,
      audit,
      idempotencyKey: mutation.idempotencyKey,
      requestFingerprint,
      resultHash,
      occurredAt,
    })
    return dependencies.repository.applyDelete({ command, audit })
  }
}
