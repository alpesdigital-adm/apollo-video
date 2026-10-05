import {
  Prisma,
  type PrismaClient,
  type V2PublicEventOutbox,
} from '../../../../generated/prisma-v2/index.js'

import type {
  PublicEventFeedRepository,
} from '../../application/ports/public-event-feed-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import { createPublicEvent } from '../../domain/public-event.ts'
import {
  PUBLIC_EVENT_FEED_SAFETY_MARGIN_MS,
  type PublicEventFeedEntry,
} from '../../domain/public-event-feed.ts'

function hydrate(row: V2PublicEventOutbox): Readonly<PublicEventFeedEntry> {
  let data: unknown
  try {
    data = JSON.parse(row.dataJson)
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Outbox event contains invalid JSON')
  }
  try {
    const event = createPublicEvent({
      id: row.id,
      workspaceId: row.workspaceId,
      type: row.type,
      version: row.version,
      occurredAt: row.occurredAt.toISOString(),
      ...(row.sequence !== null ? { sequence: row.sequence } : {}),
      ...(row.actorClientId || row.actorUserId
        ? {
            actor: {
              ...(row.actorClientId ? { clientId: row.actorClientId } : {}),
              ...(row.actorUserId ? { userId: row.actorUserId } : {}),
            },
          }
        : {}),
      resource: { type: row.resourceType, id: row.resourceId },
      data: data as Record<string, unknown>,
    })
    return Object.freeze({
      event,
      position: Object.freeze({
        createdAt: row.createdAt.toISOString(),
        id: row.id,
      }),
    })
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Outbox event is invalid')
  }
}

/**
 * Reads persisted public events in a commit-safe order.
 *
 * `createdAt` is the PostgreSQL `CURRENT_TIMESTAMP` default, i.e. the START of
 * the writing transaction, so commit order is not `createdAt` order. A row can
 * only appear behind an already-served position if its transaction was still
 * open when that position was served. `pg_stat_activity.xact_start` of an open
 * transaction equals the `createdAt` its rows will receive, so the minimum of
 * the open transactions' start times is a watermark below which no future row
 * can appear.
 *
 * Limit: `pg_stat_activity` reveals `xact_start` only for sessions of the
 * reader's own role (and to superusers / pg_read_all_stats). Every outbox
 * writer of this application connects through the same `V2_DATABASE_URL` role,
 * so all of them are observed; a writer using another unprivileged role would
 * not be, and its late commits could then land behind the cursor.
 */
export class PrismaPublicEventFeedRepository implements PublicEventFeedRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
  }

  async readCommittedWatermark(): Promise<string> {
    const rows = await this.client.$queryRaw<{ watermark: Date }[]>(
      Prisma.sql`
        SELECT
          date_trunc(
            'milliseconds',
            least(clock_timestamp(), coalesce(min(xact_start), clock_timestamp()))
          ) - make_interval(secs => ${PUBLIC_EVENT_FEED_SAFETY_MARGIN_MS / 1000}::double precision) AS "watermark"
        FROM pg_stat_activity
        WHERE datname = current_database() AND backend_type = 'client backend'
      `,
    )
    const watermark = rows[0]?.watermark
    if (!(watermark instanceof Date) || Number.isNaN(watermark.getTime())) {
      throw new DomainError(
        'PERSISTENCE_NOT_CONFIGURED',
        'Event feed watermark could not be established',
      )
    }
    return watermark.toISOString()
  }

  async listCommitted(input: Parameters<PublicEventFeedRepository['listCommitted']>[0]) {
    const committedBefore = new Date(input.committedBefore)
    const after = input.after
      ? { createdAt: new Date(input.after.createdAt), id: input.after.id }
      : undefined
    const rows = await this.client.v2PublicEventOutbox.findMany({
      where: {
        workspaceId: input.workspaceId,
        type: { in: [...input.types] },
        createdAt: { lt: committedBefore },
        ...(after
          ? {
              OR: [
                { createdAt: { gt: after.createdAt } },
                { createdAt: after.createdAt, id: { gt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: input.limit,
    })
    return Object.freeze(rows.map(hydrate))
  }
}
