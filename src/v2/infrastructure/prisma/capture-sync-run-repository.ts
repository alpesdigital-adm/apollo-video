import { createHash, randomBytes } from 'node:crypto'

import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  CaptureSyncClaim,
  CaptureSyncRun,
  CaptureSyncRunRepository,
  CaptureSyncRunStatus,
} from '../../application/ports/capture-sync-run-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

type Row = {
  id: string
  workspaceId: string
  projectId: string
  sessionId: string
  baseVersionId: string
  baseSessionHash: string
  baseVersion: number
  status: string
  fencingToken: bigint
  attemptCount: number
  maxAttempts: number
  trackCount: number
  resolvedCount: number | null
  reviewCount: number | null
  insufficientCount: number | null
  failureReason: string | null
  leaseExpiresAt: Date | null
  heartbeatAt: Date | null
  startedAt: Date | null
  settledAt: Date | null
  createdAt: Date
  updatedAt: Date
}

function hydrate(row: Row): Readonly<CaptureSyncRun> {
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    sessionId: row.sessionId,
    baseVersionId: row.baseVersionId,
    baseSessionHash: row.baseSessionHash,
    baseVersion: row.baseVersion,
    status: row.status as CaptureSyncRunStatus,
    fencingToken: row.fencingToken,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    trackCount: row.trackCount,
    resolvedCount: row.resolvedCount,
    reviewCount: row.reviewCount,
    insufficientCount: row.insufficientCount,
    failureReason: row.failureReason,
    leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
    heartbeatAt: row.heartbeatAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    settledAt: row.settledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

export class PrismaCaptureSyncRunRepository implements CaptureSyncRunRepository {
  constructor(private readonly client: PrismaClient = getV2PostgresClient()) {}

  async request(input: {
    id: string
    workspaceId: string
    projectId: string
    sessionId: string
    baseVersionId: string
    baseSessionHash: string
    baseVersion: number
    trackCount: number
    idempotencyKey: string
    createdByClientId: string
    requestedAt: string
  }): Promise<Readonly<{ run: Readonly<CaptureSyncRun>; replayed: boolean }>> {
    const at = new Date(input.requestedAt)
    try {
      // The fencing token is the next integer for this session, taken inside
      // the same transaction as the insert. Deriving it from a clock would let
      // two requests in the same millisecond collide, and deriving it from a
      // global sequence would order runs of unrelated sessions against each
      // other for no reason.
      const row = await this.client.$transaction(async (transaction) => {
        const highest = await transaction.v2CaptureSyncRun.findFirst({
          where: { workspaceId: input.workspaceId, sessionId: input.sessionId },
          orderBy: { fencingToken: 'desc' },
          select: { fencingToken: true },
        })
        const fencingToken = (highest?.fencingToken ?? BigInt(0)) + BigInt(1)
        // Everything still queued or running for this session is now stale: a
        // newer request exists, and letting an older run settle would file a
        // result measured against a session the operator has already replaced.
        await transaction.v2CaptureSyncRun.updateMany({
          where: {
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            status: { in: ['queued', 'running'] },
          },
          data: {
            status: 'superseded',
            leaseOwner: null,
            leaseTokenHash: null,
            leaseExpiresAt: null,
            settledAt: at,
            updatedAt: at,
          },
        })
        return transaction.v2CaptureSyncRun.create({
          data: {
            id: input.id,
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            sessionId: input.sessionId,
            baseVersionId: input.baseVersionId,
            baseSessionHash: input.baseSessionHash,
            baseVersion: input.baseVersion,
            status: 'queued',
            fencingToken,
            attemptCount: 0,
            maxAttempts: 3,
            trackCount: input.trackCount,
            idempotencyKey: input.idempotencyKey,
            createdByClientId: input.createdByClientId,
            createdAt: at,
            updatedAt: at,
          },
        })
      })
      return Object.freeze({ run: hydrate(row), replayed: false })
    } catch (error) {
      if (!isPrismaCode(error, 'P2002')) throw error
      // A retried request rejoins the run it already started rather than
      // starting a second pass over the same media.
      const existing = await this.client.v2CaptureSyncRun.findFirst({
        where: {
          workspaceId: input.workspaceId,
          createdByClientId: input.createdByClientId,
          idempotencyKey: input.idempotencyKey,
        },
      })
      if (!existing) throw error
      if (existing.sessionId !== input.sessionId || existing.baseSessionHash !== input.baseSessionHash) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'This idempotency key already started a synchronization of a different session version',
        )
      }
      return Object.freeze({ run: hydrate(existing), replayed: true })
    }
  }

  async read(input: { workspaceId: string; runId: string }): Promise<Readonly<CaptureSyncRun> | null> {
    const row = await this.client.v2CaptureSyncRun.findFirst({
      where: { id: input.runId, workspaceId: input.workspaceId },
    })
    return row ? hydrate(row) : null
  }

  async readLatestForSession(input: {
    workspaceId: string
    sessionId: string
  }): Promise<Readonly<CaptureSyncRun> | null> {
    const row = await this.client.v2CaptureSyncRun.findFirst({
      where: { workspaceId: input.workspaceId, sessionId: input.sessionId },
      orderBy: { fencingToken: 'desc' },
    })
    return row ? hydrate(row) : null
  }

  async claim(input: {
    owner: string
    now: string
    leaseMs: number
  }): Promise<Readonly<CaptureSyncClaim> | null> {
    const now = new Date(input.now)
    const expiresAt = new Date(now.getTime() + input.leaseMs)
    const leaseToken = randomBytes(32).toString('hex')

    // One statement, so the row is selected and claimed atomically. A SELECT
    // followed by an UPDATE would let two workers both read the same queued
    // run; SKIP LOCKED lets a second worker move past a row the first has
    // already taken instead of blocking behind it.
    const rows = await this.client.$queryRaw<Row[]>(Prisma.sql`
      UPDATE "capture_sync_runs" SET
        "status" = 'running',
        "leaseOwner" = ${input.owner},
        "leaseTokenHash" = ${hashToken(leaseToken)},
        "leaseExpiresAt" = ${expiresAt},
        "heartbeatAt" = ${now},
        "startedAt" = COALESCE("startedAt", ${now}),
        "attemptCount" = "attemptCount" + 1,
        "updatedAt" = ${now}
      WHERE "id" = (
        SELECT "id" FROM "capture_sync_runs"
        WHERE ("status" = 'queued')
           OR ("status" = 'running' AND "leaseExpiresAt" < ${now})
        ORDER BY "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *
    `)
    const row = rows[0]
    if (!row) return null
    // A run that has burned its attempts is failed here rather than claimed
    // again: retrying forever hides a broken session behind a busy worker.
    if (row.attemptCount > row.maxAttempts) {
      await this.client.v2CaptureSyncRun.updateMany({
        where: { id: row.id, workspaceId: row.workspaceId },
        data: {
          status: 'failed',
          failureReason: `synchronization gave up after ${row.maxAttempts} attempts`,
          leaseOwner: null,
          leaseTokenHash: null,
          leaseExpiresAt: null,
          settledAt: now,
          updatedAt: now,
        },
      })
      return null
    }
    return Object.freeze({ run: hydrate(row), leaseToken })
  }

  async heartbeat(input: {
    workspaceId: string
    runId: string
    leaseToken: string
    now: string
    leaseMs: number
  }): Promise<boolean> {
    const now = new Date(input.now)
    const result = await this.client.v2CaptureSyncRun.updateMany({
      where: {
        id: input.runId,
        workspaceId: input.workspaceId,
        status: 'running',
        leaseTokenHash: hashToken(input.leaseToken),
      },
      data: {
        leaseExpiresAt: new Date(now.getTime() + input.leaseMs),
        heartbeatAt: now,
        updatedAt: now,
      },
    })
    // False means the lease is gone — reclaimed, superseded or settled. The
    // worker learns while it still has work in hand rather than at the end.
    return result.count === 1
  }

  async settle(input: {
    workspaceId: string
    runId: string
    leaseToken: string
    now: string
    outcome:
      | Readonly<{ status: 'succeeded'; resolvedCount: number; reviewCount: number; insufficientCount: number }>
      | Readonly<{ status: 'failed'; failureReason: string }>
  }): Promise<Readonly<{ settled: boolean; run: Readonly<CaptureSyncRun> | null; reason?: 'lease-lost' | 'superseded' | 'not-running' }>> {
    const now = new Date(input.now)
    const settled = await this.client.$transaction(async (transaction) => {
      const current = await transaction.v2CaptureSyncRun.findFirst({
        where: { id: input.runId, workspaceId: input.workspaceId },
      })
      if (!current) return { settled: false as const, run: null, reason: 'not-running' as const }
      if (current.status !== 'running') {
        return { settled: false as const, run: hydrate(current), reason: 'not-running' as const }
      }
      if (current.leaseTokenHash !== hashToken(input.leaseToken)) {
        // The lease expired and somebody else took the work. This worker's
        // result is not a late answer; it describes a claim that no longer
        // exists.
        return { settled: false as const, run: hydrate(current), reason: 'lease-lost' as const }
      }
      const newest = await transaction.v2CaptureSyncRun.findFirst({
        where: { workspaceId: input.workspaceId, sessionId: current.sessionId },
        orderBy: { fencingToken: 'desc' },
        select: { fencingToken: true },
      })
      if ((newest?.fencingToken ?? current.fencingToken) > current.fencingToken) {
        // A newer request exists for this session. Fencing, not the lease, is
        // what catches this: a lease is a timeout, and a process that was
        // paused cannot be told it was paused.
        return { settled: false as const, run: hydrate(current), reason: 'superseded' as const }
      }
      const row = await transaction.v2CaptureSyncRun.update({
        where: { id: input.runId },
        data: input.outcome.status === 'succeeded'
          ? {
            status: 'succeeded',
            resolvedCount: input.outcome.resolvedCount,
            reviewCount: input.outcome.reviewCount,
            insufficientCount: input.outcome.insufficientCount,
            leaseOwner: null,
            leaseTokenHash: null,
            leaseExpiresAt: null,
            settledAt: now,
            updatedAt: now,
          }
          : {
            status: 'failed',
            failureReason: input.outcome.failureReason.slice(0, 512),
            leaseOwner: null,
            leaseTokenHash: null,
            leaseExpiresAt: null,
            settledAt: now,
            updatedAt: now,
          },
      })
      return { settled: true as const, run: hydrate(row) }
    })
    return Object.freeze(settled)
  }
}
