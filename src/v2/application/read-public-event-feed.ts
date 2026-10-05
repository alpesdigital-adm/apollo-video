import { createHash } from 'node:crypto'

import { DomainError, assertDomain } from '../domain/errors.ts'
import type { PublicEvent } from '../domain/public-event.ts'
import {
  PROJECT_DASHBOARD_EVENT_TYPES,
  PUBLIC_EVENT_FEED_DEFAULT_LIMIT,
  PUBLIC_EVENT_FEED_CURSOR_SLACK_MS,
  PUBLIC_EVENT_FEED_FLOOR_ID,
  PUBLIC_EVENT_FEED_MAX_LIMIT,
  comparePublicEventFeedPositions,
  type PublicEventFeedPosition,
} from '../domain/public-event-feed.ts'
import type { PublicEventFeedRepository } from './ports/public-event-feed-repository.ts'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{8,1024}$/

interface FeedCursor extends PublicEventFeedPosition {
  v: 1
  queryHash: string
}

function encodeCursor(position: PublicEventFeedPosition, queryHash: string): string {
  const cursor: FeedCursor = {
    v: 1, createdAt: position.createdAt, id: position.id, queryHash,
  }
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeCursor(value: string, queryHash: string): FeedCursor {
  assertDomain(
    CURSOR_PATTERN.test(value),
    'INVALID_ARGUMENT',
    'after must be a valid event feed cursor',
  )
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Record<string, unknown>
    assertDomain(
      parsed.v === 1 && Object.keys(parsed).length === 4 &&
        typeof parsed.createdAt === 'string' &&
        new Date(parsed.createdAt).toISOString() === parsed.createdAt &&
        typeof parsed.id === 'string' && UUID_PATTERN.test(parsed.id) &&
        parsed.queryHash === queryHash,
      'INVALID_ARGUMENT',
      'after does not match this event feed query',
    )
    return parsed as unknown as FeedCursor
  } catch (error) {
    if (error instanceof DomainError) throw error
    throw new DomainError('INVALID_ARGUMENT', 'after must be a valid event feed cursor')
  }
}

export interface PublicEventFeedPage {
  events: readonly Readonly<PublicEvent>[]
  nextCursor: string
  hasMore: boolean
  watermark: string
}

/**
 * Typed, workspace-scoped read of persisted dashboard invalidation events.
 *
 * Contract: every event whose transaction committed is delivered exactly once
 * per cursor lineage, in `(createdAt, id)` order, and never behind the cursor
 * (see `PrismaPublicEventFeedRepository` for the commit-safety argument).
 * A page that exhausts the committed rows moves the cursor to the watermark,
 * so quiet reads stay cheap; a truncated page keeps the cursor on its last row.
 */
export function readPublicEventFeedService(dependencies: {
  feed: PublicEventFeedRepository
}) {
  return async function readPublicEventFeed(input: {
    workspaceId: string
    limit?: number
    after?: string
    startAt?: string
  }): Promise<Readonly<PublicEventFeedPage>> {
    const limit = input.limit ?? PUBLIC_EVENT_FEED_DEFAULT_LIMIT
    assertDomain(
      Number.isInteger(limit) && limit >= 1 && limit <= PUBLIC_EVENT_FEED_MAX_LIMIT,
      'INVALID_ARGUMENT',
      `limit must be an integer from 1 to ${PUBLIC_EVENT_FEED_MAX_LIMIT}`,
    )
    assertDomain(
      input.startAt === undefined || input.startAt === 'latest',
      'INVALID_ARGUMENT',
      'startAt must be latest',
    )
    const afterValue = input.after?.trim()
    assertDomain(
      !(afterValue && input.startAt !== undefined),
      'INVALID_ARGUMENT',
      'after and startAt cannot be combined',
    )
    const types = [...PROJECT_DASHBOARD_EVENT_TYPES]
    const queryHash = createHash('sha256')
      .update(JSON.stringify({ workspaceId: input.workspaceId, types }))
      .digest('hex')
    const after = afterValue ? decodeCursor(afterValue, queryHash) : undefined

    const watermark = await dependencies.feed.readCommittedWatermark()
    const head: PublicEventFeedPosition = {
      createdAt: watermark, id: PUBLIC_EVENT_FEED_FLOOR_ID,
    }
    if (input.startAt === 'latest') {
      return Object.freeze({
        events: Object.freeze([]),
        nextCursor: encodeCursor(head, queryHash),
        hasMore: false,
        watermark,
      })
    }
    // The watermark is monotonic except for sub-second jitter between two
    // reads (a writer can start in the same millisecond as the previous
    // read). A cursor further ahead than the slack cannot have been issued.
    assertDomain(
      !after || Date.parse(after.createdAt) <=
        Date.parse(watermark) + PUBLIC_EVENT_FEED_CURSOR_SLACK_MS,
      'INVALID_ARGUMENT',
      'after is ahead of the committed event watermark',
    )
    const entries = await dependencies.feed.listCommitted({
      workspaceId: input.workspaceId,
      types,
      ...(after ? { after: { createdAt: after.createdAt, id: after.id } } : {}),
      committedBefore: watermark,
      limit: limit + 1,
    })
    const page = entries.slice(0, limit)
    const truncated = entries.length > limit
    const last = page.at(-1)
    const reached: PublicEventFeedPosition = truncated && last
      ? last.position
      : head
    // A cursor is never moved backwards: that could only repeat events.
    const position = after && comparePublicEventFeedPositions(after, reached) > 0
      ? after
      : reached
    return Object.freeze({
      events: Object.freeze(page.map((entry) => entry.event)),
      nextCursor: encodeCursor(position, queryHash),
      hasMore: truncated,
      watermark,
    })
  }
}
