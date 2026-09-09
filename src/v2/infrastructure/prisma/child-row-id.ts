import { createHash } from 'node:crypto'

/**
 * A row id built from the ids above it, guaranteed to fit its column.
 *
 * Child rows in the V2 schema are keyed by their parent's id plus a
 * discriminator, which reads well and makes a stray row obvious in a dump. The
 * arithmetic does not always work out: a capture session id may be 128
 * characters, and `<session>:md<version>:s<ordinal>:c0:redundancyPenalty` is
 * then 161 characters in a VARCHAR(160). PostgreSQL refuses that outright, so
 * the failure would be a write that works for every id anyone tested with and
 * fails for a long one in production.
 *
 * Truncating alone would be worse than the error: two long ids sharing a
 * prefix would silently become one row. So an over-long id keeps its readable
 * head and ends in a digest of the *whole* id, which the prefixes it came from
 * cannot collide in.
 */
export function childRowId(parts: readonly string[], limit: number): string {
  const id = parts.join(':')
  if (id.length <= limit) return id
  const digest = createHash('sha256').update(id).digest('hex').slice(0, 16)
  return `${id.slice(0, Math.max(0, limit - digest.length - 1))}~${digest}`
}
