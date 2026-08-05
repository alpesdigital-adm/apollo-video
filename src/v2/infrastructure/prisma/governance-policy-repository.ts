import {
  Prisma,
  type PrismaClient,
  type V2GovernancePolicyCommand,
} from '../../../../generated/prisma-v2/index.js'

import type {
  GovernancePolicyMutationResult,
  GovernancePolicyRepository,
} from '../../application/ports/governance-policy-repository.ts'
import {
  createApiAccessAuditContext,
  type ApiAccessAuditContext,
} from '../../domain/api-access-control.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  createGovernancePolicy,
  type GovernanceLimits,
  type GovernancePolicy,
} from '../../domain/governance-limits.ts'
import {
  calculateGovernancePolicyCommandResultHash,
  createGovernancePolicyCommand,
  type GovernancePolicyCommand,
} from '../../domain/governance-policy-command.ts'
import { hydrateGovernancePolicy } from './governance-admission-repository.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored governance policy command ${field} is invalid`,
    )
  }
}

function hydrateCommand(row: V2GovernancePolicyCommand) {
  try {
    const audit = createApiAccessAuditContext({
      clientId: row.actorClientId,
      credentialId: row.actorCredentialId,
      workspaceId: row.workspaceId,
      environment: row.actorEnvironment as 'sandbox' | 'production',
      authenticationKind: row.actorAuthenticationKind as
        'bearer' | 'ui-session',
      ...(row.delegatedUserId
        ? { delegatedUserId: row.delegatedUserId }
        : {}),
      ...(row.delegatedIdentityId
        ? { delegatedIdentityId: row.delegatedIdentityId }
        : {}),
      ...(row.workspaceRole
        ? { workspaceRole: row.workspaceRole as ApiAccessAuditContext['workspaceRole'] }
        : {}),
    })
    if (audit.contextHash !== row.actorContextHash) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Stored governance policy actor hash is invalid',
      )
    }
    return createGovernancePolicyCommand({
      id: row.id,
      workspaceId: row.workspaceId,
      action: row.action as GovernancePolicyCommand['action'],
      policyId: row.policyId,
      scopeType: row.scopeType as GovernancePolicy['scopeType'],
      scopeId: row.scopeId,
      environment: row.environment as GovernancePolicy['environment'],
      ...(row.limitsJson
        ? { limits: parseJson(row.limitsJson, 'limits') as GovernanceLimits }
        : {}),
      ...(row.baseRevision ? { baseRevision: row.baseRevision } : {}),
      ...(row.resultRevision ? { resultRevision: row.resultRevision } : {}),
      reason: row.reason,
      audit,
      idempotencyKey: row.idempotencyKey,
      requestFingerprint: row.requestFingerprint,
      resultHash: row.resultHash,
      occurredAt: row.occurredAt.toISOString(),
      commandHash: row.commandHash,
    })
  } catch (error) {
    if (
      error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT'
    ) throw error
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored governance policy command is invalid',
    )
  }
}

function hydrateResult(
  row: V2GovernancePolicyCommand,
  replayed: boolean,
): Readonly<GovernancePolicyMutationResult> {
  const command = hydrateCommand(row)
  const parsed = parseJson(row.resultJson, 'result') as Record<string, unknown>
  let result: Readonly<{
    action: GovernancePolicyCommand['action']
    policy?: Readonly<GovernancePolicy>
    deletedPolicyId?: string
  }>
  if (parsed.action === 'set' && parsed.policy) {
    if (
      Object.keys(parsed).toSorted().join(',') !== 'action,policy' ||
      typeof parsed.policy !== 'object' || parsed.policy === null ||
      Array.isArray(parsed.policy) ||
      Object.keys(parsed.policy).toSorted().join(',') !==
        'createdAt,environment,id,limits,revision,scopeId,scopeType,updatedAt,updatedByClientId,workspaceId'
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Stored governance policy result shape is invalid',
      )
    }
    const policy = createGovernancePolicy(
      parsed.policy as Omit<GovernancePolicy, 'revision'> & { revision?: string },
    )
    if (
      policy.id !== command.policyId ||
      policy.revision !== command.resultRevision
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Stored governance policy result does not match its command',
      )
    }
    result = Object.freeze({ action: 'set', policy })
  } else if (
    parsed.action === 'delete' && parsed.deletedPolicyId === command.policyId &&
    Object.keys(parsed).toSorted().join(',') === 'action,deletedPolicyId'
  ) {
    result = Object.freeze({
      action: 'delete',
      deletedPolicyId: command.policyId,
    })
  } else {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored governance policy result is invalid',
    )
  }
  if (calculateGovernancePolicyCommandResultHash(result) !== row.resultHash) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored governance policy result hash is invalid',
    )
  }
  return Object.freeze({
    ...result,
    commandHash: command.commandHash,
    replayed,
  })
}

function commandData(
  command: Readonly<GovernancePolicyCommand>,
  result: Readonly<{
    action: GovernancePolicyCommand['action']
    policy?: Readonly<GovernancePolicy>
    deletedPolicyId?: string
  }>,
) {
  return {
    id: command.id,
    workspaceId: command.workspaceId,
    action: command.action,
    policyId: command.policyId,
    scopeType: command.scopeType,
    scopeId: command.scopeId,
    environment: command.environment,
    limitsJson: command.limits ? JSON.stringify(command.limits) : null,
    baseRevision: command.baseRevision,
    resultRevision: command.resultRevision,
    reason: command.reason,
    actorClientId: command.audit.clientId,
    actorCredentialId: command.audit.credentialId,
    actorEnvironment: command.audit.environment,
    actorAuthenticationKind: command.audit.authenticationKind,
    actorContextHash: command.audit.contextHash,
    delegatedUserId: command.audit.delegatedUserId,
    delegatedIdentityId: command.audit.delegatedIdentityId,
    workspaceRole: command.audit.workspaceRole,
    idempotencyKey: command.idempotencyKey,
    requestFingerprint: command.requestFingerprint,
    resultJson: JSON.stringify(result),
    resultHash: command.resultHash,
    commandHash: command.commandHash,
    occurredAt: new Date(command.occurredAt),
  }
}

function isRetryable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error.code === 'P2002' || error.code === 'P2034')
}

function assertAuditBinding(
  command: Readonly<GovernancePolicyCommand>,
  audit: Readonly<ApiAccessAuditContext>,
): void {
  if (
    audit.contextHash !== command.audit.contextHash ||
    audit.clientId !== command.audit.clientId ||
    audit.workspaceId !== command.workspaceId
  ) {
    throw new DomainError(
      'AUTH_INVALID',
      'governance policy persistence audit does not match its command',
    )
  }
}

function assertSetBinding(
  policy: Readonly<GovernancePolicy>,
  command: Readonly<GovernancePolicyCommand>,
): void {
  const result = Object.freeze({ action: 'set' as const, policy })
  if (
    command.action !== 'set' || command.policyId !== policy.id ||
    command.workspaceId !== policy.workspaceId ||
    command.scopeType !== policy.scopeType || command.scopeId !== policy.scopeId ||
    command.environment !== policy.environment ||
    command.resultRevision !== policy.revision ||
    command.audit.clientId !== policy.updatedByClientId ||
    calculateGovernancePolicyCommandResultHash(result) !== command.resultHash
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'governance policy does not match its set command',
    )
  }
}

function assertDeleteBinding(command: Readonly<GovernancePolicyCommand>): void {
  const result = Object.freeze({
    action: 'delete' as const,
    deletedPolicyId: command.policyId,
  })
  if (
    command.action !== 'delete' ||
    calculateGovernancePolicyCommandResultHash(result) !== command.resultHash
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'governance policy delete command result is invalid',
    )
  }
}

export class PrismaGovernancePolicyRepository
implements GovernancePolicyRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
  }

  async list(input: { workspaceId: string }) {
    if (!ID.test(input.workspaceId)) {
      throw new DomainError('INVALID_ARGUMENT', 'workspaceId is invalid')
    }
    const rows = await this.client.v2GovernancePolicy.findMany({
      where: { workspaceId: input.workspaceId },
      orderBy: [
        { scopeType: 'asc' },
        { scopeId: 'asc' },
        { environment: 'asc' },
        { id: 'asc' },
      ],
    })
    return Object.freeze(rows.map(hydrateGovernancePolicy))
  }

  async findByScope(input: {
    workspaceId: string
    scopeType: GovernancePolicy['scopeType']
    scopeId: string
    environment: GovernancePolicy['environment']
  }) {
    const row = await this.client.v2GovernancePolicy.findUnique({
      where: {
        workspaceId_scopeType_scopeId_environment: input,
      },
    })
    return row ? hydrateGovernancePolicy(row) : null
  }

  async findById(input: { workspaceId: string; policyId: string }) {
    const row = await this.client.v2GovernancePolicy.findFirst({
      where: { id: input.policyId, workspaceId: input.workspaceId },
    })
    return row ? hydrateGovernancePolicy(row) : null
  }

  async findReplay(input: {
    workspaceId: string
    actorContextHash: string
    idempotencyKey: string
    requestFingerprint: string
  }) {
    const row = await this.client.v2GovernancePolicyCommand.findUnique({
      where: {
        workspaceId_actorContextHash_idempotencyKey: {
          workspaceId: input.workspaceId,
          actorContextHash: input.actorContextHash,
          idempotencyKey: input.idempotencyKey,
        },
      },
    })
    if (!row) return null
    if (row.requestFingerprint !== input.requestFingerprint) {
      throw new DomainError(
        'IDEMPOTENCY_PAYLOAD_MISMATCH',
        'Idempotency-Key was already used for another governance policy command',
      )
    }
    return hydrateResult(row, true)
  }

  async applySet(input: {
    policy: Readonly<GovernancePolicy>
    command: Readonly<GovernancePolicyCommand>
    audit: Readonly<ApiAccessAuditContext>
  }, attempt = 1): Promise<Readonly<GovernancePolicyMutationResult>> {
    const { policy, command } = input
    assertAuditBinding(command, input.audit)
    assertSetBinding(policy, command)
    const result = Object.freeze({ action: 'set' as const, policy })
    try {
      const row = await this.client.$transaction(async (transaction) => {
        await transaction.$queryRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`${policy.workspaceId}:governance:${policy.environment}`}, 0)
          )
        `)
        if (policy.scopeType === 'client') {
          const client = await transaction.v2ApiClient.findUnique({
            where: {
              id_workspaceId: {
                id: policy.scopeId,
                workspaceId: policy.workspaceId,
              },
            },
            select: { allowedEnvironmentsJson: true },
          })
          let environments: unknown = null
          try {
            environments = client
              ? JSON.parse(client.allowedEnvironmentsJson)
              : null
          } catch {
            environments = null
          }
          if (
            !Array.isArray(environments) ||
            !environments.includes(policy.environment)
          ) {
            throw new DomainError(
              'API_CLIENT_NOT_FOUND',
              'governance policy client was not found in this environment',
            )
          }
        }
        const current = await transaction.v2GovernancePolicy.findUnique({
          where: {
            workspaceId_scopeType_scopeId_environment: {
              workspaceId: policy.workspaceId,
              scopeType: policy.scopeType,
              scopeId: policy.scopeId,
              environment: policy.environment,
            },
          },
        })
        if (
          command.baseRevision === undefined
            ? current !== null
            : !current || current.id !== policy.id ||
              current.revision !== command.baseRevision
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'governance policy changed before persistence',
          )
        }
        if (current) {
          await transaction.v2GovernancePolicy.update({
            where: { id: current.id },
            data: {
              requestsPerMinute: policy.limits.requestsPerMinute,
              maxConcurrency: policy.limits.maxConcurrency,
              quotaUnits: policy.limits.quotaUnits,
              spendBudgetMinorUnits: policy.limits.spendBudgetMinorUnits,
              revision: policy.revision,
              updatedByClientId: policy.updatedByClientId,
              updatedAt: new Date(policy.updatedAt),
            },
          })
        } else {
          await transaction.v2GovernancePolicy.create({
            data: {
              id: policy.id,
              workspaceId: policy.workspaceId,
              scopeType: policy.scopeType,
              scopeId: policy.scopeId,
              environment: policy.environment,
              requestsPerMinute: policy.limits.requestsPerMinute,
              maxConcurrency: policy.limits.maxConcurrency,
              quotaUnits: policy.limits.quotaUnits,
              spendBudgetMinorUnits: policy.limits.spendBudgetMinorUnits,
              revision: policy.revision,
              updatedByClientId: policy.updatedByClientId,
              createdAt: new Date(policy.createdAt),
              updatedAt: new Date(policy.updatedAt),
            },
          })
        }
        return transaction.v2GovernancePolicyCommand.create({
          data: commandData(command, result),
        })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      return Object.freeze({
        ...result,
        commandHash: row.commandHash,
        replayed: false,
      })
    } catch (error) {
      if (isRetryable(error)) {
        const replay = await this.findReplay({
          workspaceId: command.workspaceId,
          actorContextHash: command.audit.contextHash,
          idempotencyKey: command.idempotencyKey,
          requestFingerprint: command.requestFingerprint,
        })
        if (replay) return replay
        if (attempt < 3) return this.applySet(input, attempt + 1)
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'governance policy command collided with concurrent persistence',
        )
      }
      throw error
    }
  }

  async applyDelete(input: {
    command: Readonly<GovernancePolicyCommand>
    audit: Readonly<ApiAccessAuditContext>
  }, attempt = 1): Promise<Readonly<GovernancePolicyMutationResult>> {
    const { command } = input
    assertAuditBinding(command, input.audit)
    assertDeleteBinding(command)
    const result = Object.freeze({
      action: 'delete' as const,
      deletedPolicyId: command.policyId,
    })
    try {
      const row = await this.client.$transaction(async (transaction) => {
        await transaction.$queryRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`${command.workspaceId}:governance:${command.environment}`}, 0)
          )
        `)
        const current = await transaction.v2GovernancePolicy.findFirst({
          where: { id: command.policyId, workspaceId: command.workspaceId },
        })
        if (
          !current || current.revision !== command.baseRevision ||
          current.scopeType !== command.scopeType ||
          current.scopeId !== command.scopeId ||
          current.environment !== command.environment
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'governance policy changed before deletion',
          )
        }
        await transaction.v2GovernancePolicy.delete({
          where: { id: command.policyId },
        })
        return transaction.v2GovernancePolicyCommand.create({
          data: commandData(command, result),
        })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      return Object.freeze({
        ...result,
        commandHash: row.commandHash,
        replayed: false,
      })
    } catch (error) {
      if (isRetryable(error)) {
        const replay = await this.findReplay({
          workspaceId: command.workspaceId,
          actorContextHash: command.audit.contextHash,
          idempotencyKey: command.idempotencyKey,
          requestFingerprint: command.requestFingerprint,
        })
        if (replay) return replay
        if (attempt < 3) return this.applyDelete(input, attempt + 1)
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'governance policy deletion collided with concurrent persistence',
        )
      }
      throw error
    }
  }
}
