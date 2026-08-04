import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  MaterializationAuthorizationRecord,
  MaterializationAuthorizationRepository,
  MaterializationAuthorizationResult,
} from '../../application/ports/materialization-authorization-repository.ts'
import { createApiAccessAuditContext, type ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import {
  ASSET_USE_DENIAL_CODES,
  type AssetUseDenialCode,
} from '../../domain/asset-rights.ts'
import { calculateCanonicalHash, stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  createMaterializationAuthorization,
  MATERIALIZATION_ISSUE_CODES,
  type MaterializationAuthorization,
  type MaterializationAuthorizationIssue,
} from '../../domain/materialization-authorization.ts'
import type { WorkspaceMemberRole } from '../../domain/workspace-member.ts'

type StoredAuthorization = Prisma.V2MaterializationAuthorizationGetPayload<{
  include: { decisions: { include: { rightsSnapshot: true } } }
}>

function isUniqueConstraintError(error: unknown): error is { code: 'P2002' } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

function isSerializationConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2034'
}

function parseArray(value: string, field: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) throw new Error('not an array')
    return parsed
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

function parseStringArray(value: string, field: string): string[] {
  const parsed = parseArray(value, field)
  if (!parsed.every((item) => typeof item === 'string')) {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
  return parsed as string[]
}

function parseIssues(value: string): MaterializationAuthorizationIssue[] {
  const issues = parseArray(value, 'materialization issues')
  return issues.map((item) => {
    if (
      typeof item !== 'object' ||
      item === null ||
      !('code' in item) ||
      typeof item.code !== 'string' ||
      !MATERIALIZATION_ISSUE_CODES.includes(
        item.code as (typeof MATERIALIZATION_ISSUE_CODES)[number],
      )
    ) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Stored materialization issue is invalid')
    }
    const issue = item as { code: MaterializationAuthorizationIssue['code']; assetOrdinal?: unknown; assetKind?: unknown }
    if (issue.assetOrdinal !== undefined && (!Number.isInteger(issue.assetOrdinal) || Number(issue.assetOrdinal) < 0)) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Stored materialization issue ordinal is invalid')
    }
    if (issue.assetKind !== undefined && typeof issue.assetKind !== 'string') {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Stored materialization issue kind is invalid')
    }
    return {
      code: issue.code,
      ...(issue.assetOrdinal !== undefined
        ? { assetOrdinal: Number(issue.assetOrdinal) }
        : {}),
      ...(typeof issue.assetKind === 'string' ? { assetKind: issue.assetKind } : {}),
    }
  })
}

function hydrateAuthenticationAudit(row: StoredAuthorization): Readonly<ApiAccessAuditContext> {
  try {
    if (
      !row.actorCredentialId || !row.actorEnvironment ||
      !row.actorAuthenticationKind || !row.actorContextHash
    ) throw new Error('missing audit')
    const audit = createApiAccessAuditContext({
      clientId: row.clientId,
      credentialId: row.actorCredentialId,
      workspaceId: row.workspaceId,
      environment: row.actorEnvironment as 'sandbox' | 'production',
      authenticationKind: row.actorAuthenticationKind as 'bearer' | 'ui-session',
      ...(row.delegatedUserId ? { delegatedUserId: row.delegatedUserId } : {}),
      ...(row.delegatedIdentityId ? { delegatedIdentityId: row.delegatedIdentityId } : {}),
      ...(row.workspaceRole ? { workspaceRole: row.workspaceRole as WorkspaceMemberRole } : {}),
    })
    if (audit.contextHash !== row.actorContextHash) throw new Error('context hash mismatch')
    return audit
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored materialization actor audit is invalid')
  }
}

function hydrateAuthorization(row: StoredAuthorization): MaterializationAuthorization {
  const decisions = [...row.decisions]
    .sort((left, right) => left.assetOrdinal - right.assetOrdinal)
    .map((decision) => {
      const reasonCodes = parseStringArray(decision.reasonCodesJson, 'rights reason codes')
      if (
        !reasonCodes.every((code) =>
          ASSET_USE_DENIAL_CODES.includes(code as AssetUseDenialCode),
        ) ||
        (decision.outcome === 'allow' && reasonCodes.length > 0) ||
        (decision.outcome === 'deny' && reasonCodes.length === 0) ||
        ((decision.policySnapshotId === null) !== (decision.policySnapshotHash === null)) ||
        (decision.rightsSnapshotId !== null && !decision.rightsSnapshot) ||
        (decision.assetKind === 'lut' && decision.rightsSnapshotId !== null) ||
        (decision.assetKind !== 'lut' && decision.rightsSnapshotId !== decision.policySnapshotId) ||
        (decision.rightsSnapshot?.snapshotHash !== undefined && decision.rightsSnapshot.snapshotHash !== decision.policySnapshotHash)
      ) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Stored asset use decision is invalid')
      }
      return {
        artifactId: decision.artifactId,
        assetOrdinal: decision.assetOrdinal,
        assetKind: decision.assetKind,
        outcome: decision.outcome as 'allow' | 'deny',
        reasonCodes: reasonCodes as AssetUseDenialCode[],
        ...(decision.policySnapshotId
          ? {
              rightsSnapshotId: decision.policySnapshotId,
              rightsSnapshotHash: decision.policySnapshotHash as string,
            }
          : {}),
        ...(decision.validUntil
          ? { validUntil: decision.validUntil.toISOString() }
          : {}),
      }
    })
  const authorization = createMaterializationAuthorization({
    id: row.id,
    workspaceId: row.workspaceId,
    artifactId: row.artifactId,
    manifestId: row.manifestId,
    inputHash: row.inputHash,
    use: row.rightsUse,
    ...(row.market ? { market: row.market } : {}),
    locale: row.locale,
    syntheticOperations: parseStringArray(row.syntheticOpsJson, 'synthetic operations'),
    issues: parseIssues(row.issuesJson),
    decisions,
    evaluatedAt: row.evaluatedAt.toISOString(),
    actor: { type: 'api-client', id: row.clientId },
  })
  if (
    authorization.status !== row.status ||
    (authorization.validUntil ?? null) !== (row.validUntil?.toISOString() ?? null)
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored materialization authorization failed integrity validation',
      { authorizationId: row.id },
    )
  }
  return authorization
}

function hydrateRecord(row: StoredAuthorization): MaterializationAuthorizationRecord {
  return {
    authorization: hydrateAuthorization(row),
    authenticationAudit: hydrateAuthenticationAudit(row),
  }
}

export class PrismaMaterializationAuthorizationRepository
  implements MaterializationAuthorizationRepository
{
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
  }

  async findById(
    workspaceId: string,
    authorizationId: string,
  ): Promise<MaterializationAuthorizationRecord | null> {
    const stored = await this.client.v2MaterializationAuthorization.findFirst({
      where: { id: authorizationId, workspaceId },
      include: { decisions: { include: { rightsSnapshot: true } } },
    })
    return stored ? hydrateRecord(stored) : null
  }

  private async findStored(
    workspaceId: string,
    clientId: string,
    idempotencyKey: string,
  ): Promise<StoredAuthorization | null> {
    return this.client.v2MaterializationAuthorization.findUnique({
      where: {
        workspaceId_clientId_idempotencyKey: {
          workspaceId,
          clientId,
          idempotencyKey,
        },
      },
      include: {
        decisions: { include: { rightsSnapshot: true } },
      },
    })
  }

  async findReplay(input: {
    workspaceId: string
    clientId: string
    actorContextHash: string
    idempotencyKey: string
    requestFingerprint: string
  }): Promise<MaterializationAuthorizationResult | null> {
    const stored = await this.findStored(
      input.workspaceId,
      input.clientId,
      input.idempotencyKey,
    )
    if (!stored) return null
    const authenticationAudit = hydrateAuthenticationAudit(stored)
    if (authenticationAudit.contextHash !== input.actorContextHash) {
      throw new DomainError(
        'IDEMPOTENCY_PAYLOAD_MISMATCH',
        'Idempotency key belongs to a different authentication context',
      )
    }
    if (stored.requestFingerprint !== input.requestFingerprint) {
      throw new DomainError(
        'IDEMPOTENCY_PAYLOAD_MISMATCH',
        'Idempotency key was already used with a different request',
        { authorizationId: stored.id },
      )
    }
    return { ...hydrateRecord(stored), replayed: true }
  }

  async createOrReplay(input: {
    authorization: MaterializationAuthorization
    authenticationAudit: Readonly<ApiAccessAuditContext>
    idempotencyKey: string
    requestFingerprint: string
  }, serializationAttempt = 1): Promise<MaterializationAuthorizationResult> {
    let audit: Readonly<ApiAccessAuditContext>
    try {
      audit = createApiAccessAuditContext({
        clientId: input.authenticationAudit.clientId,
        credentialId: input.authenticationAudit.credentialId,
        workspaceId: input.authenticationAudit.workspaceId,
        environment: input.authenticationAudit.environment,
        authenticationKind: input.authenticationAudit.authenticationKind,
        ...(input.authenticationAudit.delegatedUserId ? { delegatedUserId: input.authenticationAudit.delegatedUserId } : {}),
        ...(input.authenticationAudit.delegatedIdentityId ? { delegatedIdentityId: input.authenticationAudit.delegatedIdentityId } : {}),
        ...(input.authenticationAudit.workspaceRole ? { workspaceRole: input.authenticationAudit.workspaceRole } : {}),
      })
    } catch {
      throw new DomainError('AUTH_INVALID', 'Materialization authorization actor audit is invalid')
    }
    if (
      audit.contextHash !== input.authenticationAudit.contextHash ||
      audit.workspaceId !== input.authorization.workspaceId ||
      audit.clientId !== input.authorization.actor.id ||
      input.authorization.actor.type !== 'api-client'
    ) {
      throw new DomainError('AUTH_INVALID', 'Materialization authorization actor audit is inconsistent')
    }
    try {
      return await this.client.$transaction(async (transaction) => {
        const existing = await transaction.v2MaterializationAuthorization.findUnique({
          where: {
            workspaceId_clientId_idempotencyKey: {
              workspaceId: input.authorization.workspaceId,
              clientId: audit.clientId,
              idempotencyKey: input.idempotencyKey,
            },
          },
          include: { decisions: { include: { rightsSnapshot: true } } },
        })
        if (existing) {
          if (existing.requestFingerprint !== input.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was already used with a different request',
              { authorizationId: existing.id },
            )
          }
          const existingAudit = hydrateAuthenticationAudit(existing)
          if (existingAudit.contextHash !== audit.contextHash) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key belongs to a different authentication context',
            )
          }
          return { ...hydrateRecord(existing), replayed: true }
        }

        await transaction.v2MaterializationAuthorization.create({
          data: {
            id: input.authorization.id,
            workspaceId: input.authorization.workspaceId,
            artifactId: input.authorization.artifactId,
            manifestId: input.authorization.manifestId,
            inputHash: input.authorization.inputHash,
            rightsUse: input.authorization.use,
            market: input.authorization.market,
            locale: input.authorization.locale,
            syntheticOpsJson: stableSerialize(input.authorization.syntheticOperations),
            status: input.authorization.status,
            issuesJson: stableSerialize(input.authorization.issues),
            clientId: audit.clientId,
            actorCredentialId: audit.credentialId,
            actorEnvironment: audit.environment,
            actorAuthenticationKind: audit.authenticationKind,
            actorContextHash: audit.contextHash,
            delegatedUserId: audit.delegatedUserId,
            delegatedIdentityId: audit.delegatedIdentityId,
            workspaceRole: audit.workspaceRole,
            idempotencyKey: input.idempotencyKey,
            requestFingerprint: input.requestFingerprint,
            evaluatedAt: new Date(input.authorization.evaluatedAt),
            validUntil: input.authorization.validUntil
              ? new Date(input.authorization.validUntil)
              : undefined,
          },
        })
        await transaction.v2AssetUseDecision.createMany({
          data: input.authorization.decisions.map((decision) => ({
            id: `asset-use-${calculateCanonicalHash({
              authorizationId: input.authorization.id,
              ordinal: decision.assetOrdinal,
            }).slice(0, 48)}`,
            workspaceId: input.authorization.workspaceId,
            authorizationId: input.authorization.id,
            artifactId: decision.artifactId,
            assetOrdinal: decision.assetOrdinal,
            assetKind: decision.assetKind,
            rightsSnapshotId: decision.assetKind === 'lut' ? undefined : decision.rightsSnapshotId,
            policySnapshotId: decision.rightsSnapshotId,
            policySnapshotHash: decision.rightsSnapshotHash,
            outcome: decision.outcome,
            reasonCodesJson: stableSerialize(decision.reasonCodes),
            evaluatedAt: new Date(input.authorization.evaluatedAt),
            validUntil: decision.validUntil ? new Date(decision.validUntil) : undefined,
          })),
        })
        const created = await transaction.v2MaterializationAuthorization.findUnique({
          where: { id: input.authorization.id },
          include: { decisions: { include: { rightsSnapshot: true } } },
        })
        if (!created) {
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'Materialization authorization was not persisted',
          )
        }
        return { ...hydrateRecord(created), replayed: false }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (isSerializationConflict(error)) {
        if (serializationAttempt < 3) {
          return this.createOrReplay(input, serializationAttempt + 1)
        }
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Materialization authorization conflicted with another transaction',
        )
      }
      if (isUniqueConstraintError(error)) {
        const replay = await this.findReplay({
          workspaceId: input.authorization.workspaceId,
          clientId: audit.clientId,
          actorContextHash: audit.contextHash,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
        })
        if (replay) return replay
      }
      throw error
    }
  }
}
