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
  rotatedAt: Date | null; successorNonceHash: string | null
}, memberRole: string, identityId: string): Readonly<DurableUiSessionRecord> {
  return Object.freeze({
    nonceHash: row.nonceHash, workspaceId: row.workspaceId, clientId: row.clientId,
    memberId: row.memberId, memberRole: memberRole as DurableUiSessionRecord['memberRole'],
    identityId,
    subjectHash: row.subjectHash, issuedAt: row.issuedAt.toISOString(), lastSeenAt: row.lastSeenAt.toISOString(),
    idleExpiresAt: row.idleExpiresAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
    ...(row.revokedAt ? { revokedAt: row.revokedAt.toISOString() } : {}),
    ...(row.rotatedAt ? { rotatedAt: row.rotatedAt.toISOString() } : {}),
    ...(row.successorNonceHash ? { successorNonceHash: row.successorNonceHash } : {}),
  })
}

function prismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

const SHA256 = /^[a-f0-9]{64}$/

function validSeconds(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 24 * 60 * 60
}

class RetryableUiSessionConflict extends Error {}

const retryDelay = (attempt: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, 10 * (2 ** attempt))
})

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
    if (!SHA256.test(input.nonceHash) || !Number.isFinite(now.getTime()) || !validSeconds(input.idleTtlSeconds) || !validSeconds(input.identifierMaxAgeSeconds)) {
      throw new DomainError('INVALID_ARGUMENT', 'UI session refresh input is invalid')
    }
    try {
      return await this.client.$transaction(async (transaction) => {
        const current = await transaction.v2UiSession.findUnique({ where: { nonceHash: input.nonceHash }, include: { member: { include: { identity: true } } } })
        if (
          !current || current.revokedAt || current.expiresAt <= now || current.idleExpiresAt <= now ||
          current.issuedAt.getTime() + input.identifierMaxAgeSeconds * 1000 <= now.getTime() ||
          current.member.status !== 'active' || current.member.identity.status !== 'active'
        ) return null
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

  async refreshActiveSession(
    input: Parameters<UiSessionSecurityRepository['refreshActiveSession']>[0],
    retry = 0,
  ): Promise<Awaited<ReturnType<UiSessionSecurityRepository['refreshActiveSession']>>> {
    const now = new Date(input.now)
    if (
      !SHA256.test(input.currentNonceHash) || !SHA256.test(input.successorNonceHash) ||
      input.currentNonceHash === input.successorNonceHash || !Number.isFinite(now.getTime()) ||
      !validSeconds(input.idleTtlSeconds) || !validSeconds(input.rotateAfterSeconds) ||
      !validSeconds(input.identifierMaxAgeSeconds) || !validSeconds(input.recoverySeconds) ||
      input.rotateAfterSeconds >= input.identifierMaxAgeSeconds || input.recoverySeconds > input.identifierMaxAgeSeconds
    ) throw new DomainError('INVALID_ARGUMENT', 'Periodic UI session rotation input is invalid')
    try {
      return await this.client.$transaction(async (transaction) => {
        const current = await transaction.v2UiSession.findUnique({
          where: { nonceHash: input.currentNonceHash },
          include: { member: { include: { identity: true } } },
        })
        if (!current || current.expiresAt <= now || current.idleExpiresAt <= now) return null

        if (current.revokedAt) {
          if (!current.rotatedAt || current.successorNonceHash !== input.successorNonceHash) return null
          const recoveryUntil = Math.min(
            current.issuedAt.getTime() + input.identifierMaxAgeSeconds * 1000,
            current.rotatedAt.getTime() + input.recoverySeconds * 1000,
          )
          if (recoveryUntil <= now.getTime()) return null
          const successor = await transaction.v2UiSession.findUnique({
            where: { nonceHash: input.successorNonceHash },
            include: { member: { include: { identity: true } } },
          })
          if (
            !successor || successor.revokedAt || successor.expiresAt <= now || successor.idleExpiresAt <= now ||
            successor.issuedAt.getTime() + input.identifierMaxAgeSeconds * 1000 <= now.getTime() ||
            successor.member.status !== 'active' || successor.member.identity.status !== 'active'
          ) return null
          return Object.freeze({
            session: hydrate(successor, successor.member.role, successor.member.identityId),
            rotated: true,
          })
        }

        if (
          current.member.status !== 'active' || current.member.identity.status !== 'active' ||
          current.issuedAt.getTime() + input.identifierMaxAgeSeconds * 1000 <= now.getTime()
        ) return null
        if (current.issuedAt.getTime() + input.rotateAfterSeconds * 1000 > now.getTime()) {
          const idleExpiresAt = new Date(Math.min(current.expiresAt.getTime(), now.getTime() + input.idleTtlSeconds * 1000))
          const touched = await transaction.v2UiSession.update({
            where: { nonceHash: current.nonceHash },
            data: { lastSeenAt: now, idleExpiresAt },
            include: { member: true },
          })
          return Object.freeze({ session: hydrate(touched, touched.member.role, touched.member.identityId), rotated: false })
        }

        const revoked = await transaction.v2UiSession.updateMany({
          where: { nonceHash: current.nonceHash, revokedAt: null },
          data: { revokedAt: now, rotatedAt: now, successorNonceHash: input.successorNonceHash },
        })
        if (revoked.count !== 1) throw new RetryableUiSessionConflict('UI session changed during periodic rotation')
        const idleExpiresAt = new Date(Math.min(current.expiresAt.getTime(), now.getTime() + input.idleTtlSeconds * 1000))
        const successor = await transaction.v2UiSession.create({
          data: {
            nonceHash: input.successorNonceHash,
            workspaceId: current.workspaceId,
            clientId: current.clientId,
            memberId: current.memberId,
            subjectHash: current.subjectHash,
            issuedAt: now,
            lastSeenAt: now,
            idleExpiresAt,
            expiresAt: current.expiresAt,
          },
          include: { member: true },
        })
        return Object.freeze({ session: hydrate(successor, successor.member.role, successor.member.identityId), rotated: true })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (
        (error instanceof RetryableUiSessionConflict || prismaCode(error, 'P2034') || prismaCode(error, 'P2002')) &&
        retry < 3
      ) {
        await retryDelay(retry)
        return this.refreshActiveSession(input, retry + 1)
      }
      if (error instanceof RetryableUiSessionConflict || prismaCode(error, 'P2034') || prismaCode(error, 'P2002')) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'UI session could not be rotated periodically')
      }
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
              uiPrincipal: { is: { clientId: input.clientId, client: { status: 'active' } } },
            },
          },
          include: {
            workspace: { include: { uiPrincipal: { include: { client: true } } } },
          },
        })
        let allowedEnvironments: unknown = null
        try {
          allowedEnvironments = target?.workspace.uiPrincipal
            ? JSON.parse(target.workspace.uiPrincipal.client.allowedEnvironmentsJson)
            : null
        } catch {
          allowedEnvironments = null
        }
        if (
          !target ||
          input.grant.clientId !== input.clientId ||
          !Array.isArray(allowedEnvironments) ||
          !allowedEnvironments.includes(input.environment)
        ) {
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
