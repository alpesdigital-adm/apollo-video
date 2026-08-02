import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  DurableUiSessionRecord,
  UiLoginAttemptOutcome,
  UiSessionSecurityRepository,
} from '../../application/ports/ui-session-security-repository.ts'
import { DomainError } from '../../domain/errors.ts'

function hydrate(row: {
  nonceHash: string; workspaceId: string; clientId: string; memberId: string; subjectHash: string
  issuedAt: Date; lastSeenAt: Date; idleExpiresAt: Date; expiresAt: Date; revokedAt: Date | null
}, memberRole: string, identityId: string): Readonly<DurableUiSessionRecord> {
  return Object.freeze({
    nonceHash: row.nonceHash, workspaceId: row.workspaceId, clientId: row.clientId,
    memberId: row.memberId, memberRole: memberRole as DurableUiSessionRecord['memberRole'],
    identityId,
    subjectHash: row.subjectHash, issuedAt: row.issuedAt.toISOString(), lastSeenAt: row.lastSeenAt.toISOString(),
    idleExpiresAt: row.idleExpiresAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
    ...(row.revokedAt ? { revokedAt: row.revokedAt.toISOString() } : {}),
  })
}

function prismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export class PrismaUiSessionSecurityRepository implements UiSessionSecurityRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) { this.client = client }

  async createSession(input: Parameters<UiSessionSecurityRepository['createSession']>[0]) {
    const issuedAt = new Date(input.grant.issuedAt)
    const expiresAt = new Date(input.grant.expiresAt)
    const idleExpiresAt = new Date(Math.min(expiresAt.getTime(), issuedAt.getTime() + input.idleTtlSeconds * 1000))
    const row = await this.client.v2UiSession.create({ data: {
      nonceHash: input.nonceHash, workspaceId: input.workspaceId, clientId: input.grant.clientId, memberId: input.memberId,
      subjectHash: input.subjectHash, issuedAt, lastSeenAt: issuedAt, idleExpiresAt, expiresAt,
    }, include: { member: true } })
    return hydrate(row, row.member.role, row.member.identityId)
  }

  async readActiveAndTouch(input: Parameters<UiSessionSecurityRepository['readActiveAndTouch']>[0], retry = 0): Promise<Readonly<DurableUiSessionRecord> | null> {
    const now = new Date(input.now)
    try {
      return await this.client.$transaction(async (transaction) => {
        const current = await transaction.v2UiSession.findUnique({ where: { nonceHash: input.nonceHash }, include: { member: { include: { identity: true } } } })
        if (!current || current.revokedAt || current.expiresAt <= now || current.idleExpiresAt <= now || current.member.status !== 'active' || current.member.identity.status !== 'active') return null
        const idleExpiresAt = new Date(Math.min(current.expiresAt.getTime(), now.getTime() + input.idleTtlSeconds * 1000))
        const updated = await transaction.v2UiSession.update({
          where: { nonceHash: input.nonceHash }, data: { lastSeenAt: now, idleExpiresAt }, include: { member: true },
        })
        return hydrate(updated, updated.member.role, updated.member.identityId)
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (prismaCode(error, 'P2034') && retry < 3) return this.readActiveAndTouch(input, retry + 1)
      if (prismaCode(error, 'P2034')) throw new DomainError('PERSISTENCE_CONFLICT', 'UI session could not be refreshed')
      throw error
    }
  }

  async revokeSession(input: Parameters<UiSessionSecurityRepository['revokeSession']>[0]): Promise<void> {
    await this.client.v2UiSession.updateMany({
      where: { nonceHash: input.nonceHash, revokedAt: null }, data: { revokedAt: new Date(input.revokedAt) },
    })
  }

  async rotateSession(input: Parameters<UiSessionSecurityRepository['rotateSession']>[0], retry = 0): Promise<Readonly<DurableUiSessionRecord>> {
    const now = new Date(input.now)
    const issuedAt = new Date(input.grant.issuedAt)
    const expiresAt = new Date(input.grant.expiresAt)
    const idleExpiresAt = new Date(Math.min(expiresAt.getTime(), issuedAt.getTime() + input.idleTtlSeconds * 1000))
    try {
      return await this.client.$transaction(async (transaction) => {
        const current = await transaction.v2UiSession.findUnique({
          where: { nonceHash: input.currentNonceHash },
          include: { member: { include: { identity: true } } },
        })
        if (
          !current || current.revokedAt || current.expiresAt <= now || current.idleExpiresAt <= now ||
          current.member.status !== 'active' || current.member.identity.status !== 'active'
        ) throw new DomainError('AUTH_INVALID', 'Current UI session is not active')

        const target = await transaction.v2WorkspaceMember.findFirst({
          where: {
            id: input.memberId,
            workspaceId: input.workspaceId,
            identityId: current.member.identityId,
            status: 'active',
            identity: { status: 'active' },
            workspace: {
              status: 'active',
              uiPrincipal: { is: { clientId: input.clientId, client: { status: 'active', environment: input.environment } } },
            },
          },
        })
        if (!target || input.grant.clientId !== input.clientId) {
          throw new DomainError('AUTH_INVALID', 'Target workspace is not authorized')
        }

        const revoked = await transaction.v2UiSession.updateMany({
          where: { nonceHash: input.currentNonceHash, revokedAt: null },
          data: { revokedAt: now },
        })
        if (revoked.count !== 1) throw new DomainError('PERSISTENCE_CONFLICT', 'Current UI session changed during rotation')
        const created = await transaction.v2UiSession.create({
          data: {
            nonceHash: input.nonceHash,
            workspaceId: input.workspaceId,
            clientId: input.clientId,
            memberId: input.memberId,
            subjectHash: current.subjectHash,
            issuedAt,
            lastSeenAt: issuedAt,
            idleExpiresAt,
            expiresAt,
          },
          include: { member: true },
        })
        return hydrate(created, created.member.role, created.member.identityId)
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if ((prismaCode(error, 'P2034') || prismaCode(error, 'P2002')) && retry < 3) return this.rotateSession(input, retry + 1)
      if (prismaCode(error, 'P2034') || prismaCode(error, 'P2002')) throw new DomainError('PERSISTENCE_CONFLICT', 'UI session could not be rotated')
      throw error
    }
  }

  async reserveLoginAttempt(input: Parameters<UiSessionSecurityRepository['reserveLoginAttempt']>[0], retry = 0): Promise<Readonly<{ allowed: boolean; attemptId?: string; retryAfterSeconds?: number }>> {
    const occurredAt = new Date(input.occurredAt)
    try {
      return await this.client.$transaction(async (transaction) => {
        const current = await transaction.v2UiLoginThrottle.findUnique({ where: { keyHash: input.keyHash } })
        if (current?.blockedUntil && current.blockedUntil > occurredAt) {
          await transaction.v2UiLoginAttempt.create({ data: {
            id: input.attemptId, keyHash: input.keyHash, subjectHash: input.subjectHash,
            requestId: input.requestId, outcome: 'blocked', occurredAt, settledAt: occurredAt,
          } })
          return Object.freeze({ allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.blockedUntil.getTime() - occurredAt.getTime()) / 1000)) })
        }
        const expired = !current || current.windowStartedAt.getTime() + input.windowMs <= occurredAt.getTime()
        const attemptCount = expired ? 1 : current.attemptCount + 1
        const blockedUntil = attemptCount >= input.maxAttempts ? new Date(occurredAt.getTime() + input.windowMs) : null
        await transaction.v2UiLoginThrottle.upsert({
          where: { keyHash: input.keyHash },
          create: { keyHash: input.keyHash, windowStartedAt: occurredAt, attemptCount, blockedUntil, updatedAt: occurredAt },
          update: { ...(expired ? { windowStartedAt: occurredAt } : {}), attemptCount, blockedUntil, updatedAt: occurredAt },
        })
        await transaction.v2UiLoginAttempt.create({ data: {
          id: input.attemptId, keyHash: input.keyHash, subjectHash: input.subjectHash,
          requestId: input.requestId, outcome: 'pending', occurredAt,
        } })
        return Object.freeze({ allowed: true, attemptId: input.attemptId, ...(blockedUntil ? { retryAfterSeconds: Math.ceil(input.windowMs / 1000) } : {}) })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if ((prismaCode(error, 'P2034') || prismaCode(error, 'P2002')) && retry < 3) return this.reserveLoginAttempt(input, retry + 1)
      if (prismaCode(error, 'P2034') || prismaCode(error, 'P2002')) throw new DomainError('PERSISTENCE_CONFLICT', 'Login throttle could not reserve an attempt')
      throw error
    }
  }

  async settleLoginAttempt(input: Parameters<UiSessionSecurityRepository['settleLoginAttempt']>[0], retry = 0): Promise<void> {
    const settledAt = new Date(input.settledAt)
    try {
      await this.client.$transaction(async (transaction) => {
        const attempt = await transaction.v2UiLoginAttempt.findUnique({ where: { id: input.attemptId } })
        if (!attempt || attempt.outcome !== 'pending') throw new DomainError('PERSISTENCE_CONFLICT', 'Login attempt is not pending')
        await transaction.v2UiLoginAttempt.update({ where: { id: input.attemptId }, data: { outcome: input.outcome, settledAt } })
        if (input.outcome === 'succeeded' || input.outcome === 'configuration-error') {
          await transaction.v2UiLoginThrottle.deleteMany({ where: { keyHash: attempt.keyHash } })
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (prismaCode(error, 'P2034') && retry < 3) return this.settleLoginAttempt(input, retry + 1)
      if (prismaCode(error, 'P2034')) throw new DomainError('PERSISTENCE_CONFLICT', 'Login attempt could not be settled')
      throw error
    }
  }
}
