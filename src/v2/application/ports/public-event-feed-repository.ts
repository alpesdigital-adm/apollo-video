import type {
  PublicEventFeedEntry,
  PublicEventFeedPosition,
} from '../../domain/public-event-feed.ts'

export interface PublicEventFeedRepository {
  /**
   * ISO instant before which every transaction that wrote outbox rows has
   * already finished (committed or aborted), on the same database clock that
   * produces `createdAt`.
   */
  readCommittedWatermark(): Promise<string>

  /**
   * Rows of one workspace strictly after `after` and strictly before
   * `committedBefore`, ordered by (createdAt, id).
   */
  listCommitted(input: {
    workspaceId: string
    types: readonly string[]
    after?: Readonly<PublicEventFeedPosition>
    committedBefore: string
    limit: number
  }): Promise<readonly Readonly<PublicEventFeedEntry>[]>
}
