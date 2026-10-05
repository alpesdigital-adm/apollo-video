import type { PublicEvent } from './public-event.ts'

/**
 * Dashboard invalidation events. Every producer uses the transactional outbox;
 * worker writes obey the same database watermark as administration writes.
 */
export const PROJECT_DASHBOARD_EVENT_TYPES = Object.freeze([
  'project.created',
  'project.name.changed',
  'project.status.changed',
  'operation.status.changed',
  'operation.progress.changed',
  'operation.succeeded',
  'operation.failed',
  'annotation.created',
  'annotation.resolved',
] as const)

export const PUBLIC_EVENT_FEED_DEFAULT_LIMIT = 50
export const PUBLIC_EVENT_FEED_MAX_LIMIT = 100

/**
 * Subtracted from the database watermark so that millisecond rounding of
 * `createdAt` and the gap between a transaction taking its start timestamp and
 * publishing it in `pg_stat_activity` can never place a still-open writer's row
 * behind the watermark.
 */
export const PUBLIC_EVENT_FEED_SAFETY_MARGIN_MS = 50

/** A cursor further ahead of the watermark than this was never issued. */
export const PUBLIC_EVENT_FEED_CURSOR_SLACK_MS = 1_000

/** Smallest UUID: the position "before every row with this createdAt". */
export const PUBLIC_EVENT_FEED_FLOOR_ID = '00000000-0000-0000-0000-000000000000'

/** Total order of the feed: database `createdAt`, then event id. */
export interface PublicEventFeedPosition {
  createdAt: string
  id: string
}

export interface PublicEventFeedEntry {
  event: Readonly<PublicEvent>
  position: Readonly<PublicEventFeedPosition>
}

export function comparePublicEventFeedPositions(
  left: Readonly<PublicEventFeedPosition>,
  right: Readonly<PublicEventFeedPosition>,
): number {
  const byTime = Date.parse(left.createdAt) - Date.parse(right.createdAt)
  if (byTime !== 0) return byTime < 0 ? -1 : 1
  if (left.id === right.id) return 0
  return left.id < right.id ? -1 : 1
}
