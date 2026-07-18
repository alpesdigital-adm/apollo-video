import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  MaterializationAuthorizationRepository,
  MaterializationAuthorizationResult,
} from '../../application/ports/materialization-authorization-repository.ts'
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
        (decision.rightsSnapshotId !== null && !decision.rightsSnapshot)
      ) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Stored asset use decision is invalid')
      }
      return {
        artifactId: decision.artifactId,
        assetOrdinal: decision.assetOrdinal,
        assetKind: decision.assetKind,
        outcome: decision.outcome as 'allow' | 'deny',
        reasonCodes: reasonCodes as AssetUseDenialCode[],
        ...(decision.rightsSnapshotId
          ? {
              rightsSnapshotId: decision.rightsSnapshotId,
              rightsSnapshotHash: decision.rightsSnapshot?.snapshotHash,
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
  ): Promise<MaterializationAuthorization | null> {
    const stored = await this.client.v2MaterializationAuthorization.findFirst({
      where: { id: authorizationId, workspaceId },
      include: { decisions: { include: { rightsSnapshot: true } } },
    })
    return stored ? hydrateAuthorization(stored) : null
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
    idempotencyKey: string
    requestFingerprint: string
  }): Promise<MaterializationAuthorizationResult | null> {
    const stored = await this.findStored(
      input.workspaceId,
      input.clientId,
      input.idempotencyKey,
    )
    if (!stored) return null
    if (stored.requestFingerprint !== input.requestFingerprint) {
      throw new DomainError(
        'IDEMPOTENCY_PAYLOAD_MISMATCH',
        'Idempotency key was already used with a different request',
        { authorizationId: stored.id },
      )
    }
    return { authorization: hydrateAuthorization(stored), replayed: true }
  }

  async createOrReplay(input: {
    authorization: MaterializationAuthorization
    clientId: string
    idempotencyKey: string
    requestFingerprint: string
  }, serializationAttempt = 1): Promise<MaterializationAuthorizationResult> {
    try {
      return await this.client.$transaction(async (transaction) => {
        const existing = await transaction.v2MaterializationAuthorization.findUnique({
          where: {
            workspaceId_clientId_idempotencyKey: {
              workspaceId: input.authorization.workspaceId,
              clientId: input.clientId,
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
          return { authorization: hydrateAuthorization(existing), replayed: true }
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
            clientId: input.clientId,
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
            rightsSnapshotId: decision.rightsSnapshotId,
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
        return { authorization: hydrateAuthorization(created), replayed: false }
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
          clientId: input.clientId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
        })
        if (replay) return replay
      }
      throw error
    }
  }
}
