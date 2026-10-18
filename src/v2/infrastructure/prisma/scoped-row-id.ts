import { calculateCanonicalHash } from '../../domain/canonical-hash.ts'

/**
 * Storage identity for rows whose natural key is only unique inside a
 * workspace.
 *
 * A capture session, a track, a marker or a protocol token is chosen by the
 * caller, so two workspaces can legitimately use the same one. A row id built
 * as `${sessionId}:clock` is global because the primary key is global: the
 * second workspace either collides on it, or - where the writer upserts by id -
 * silently takes the first workspace's row over. The workspace therefore goes
 * into the id itself.
 *
 * The encoding is a digest of the JSON array `[kind, workspaceId, ...parts]`.
 * A JSON array of strings and numbers is injective, so `('a:b', 'c')` and
 * `('a', 'b:c')` stay distinct, which concatenation with a separator would not
 * guarantee. A digest also has a fixed length: every column that holds these
 * ids is a VARCHAR(128) or VARCHAR(160), and a workspace id plus two caller ids
 * can each be 128 characters long.
 *
 * The `~` in the prefix is deliberate. No domain identifier may contain it
 * (they are `[A-Za-z0-9._:/-]`), so a scoped id can never equal an id that
 * pre-dates this format or one a caller chose, and old rows stay readable by
 * the id they were stored under without any migration: every reader looks rows
 * up by workspace and natural key, never by the id.
 */
export function scopedRowId(
  kind: string,
  workspaceId: string,
  ...parts: readonly (string | number)[]
): string {
  if (!/^[a-z]{2,8}$/.test(kind)) {
    throw new TypeError('A scoped row id kind is two to eight lowercase letters')
  }
  if (workspaceId.length === 0 || parts.length === 0 || parts.some((part) => part === '')) {
    throw new TypeError('A scoped row id needs a workspace and at least one non-empty part')
  }
  return `${kind}~${calculateCanonicalHash({ scope: 'workspace-row-id/v1', kind, workspaceId, parts })}`
}

/**
 * The same row with its primary key left out, for the `update` half of an
 * upsert. A re-write replaces what the row says, never what the row is: a row
 * stored before ids were workspace-scoped keeps the id it has.
 */
export function withoutRowId<T extends { id: string }>(data: T): Omit<T, 'id'> {
  const { id: _id, ...rest } = data
  return rest
}
