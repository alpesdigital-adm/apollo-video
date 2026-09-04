/**
 * JSON that survives a round trip through `bigint`.
 *
 * The Wave 18 aggregates count time in `bigint` ticks, and `JSON.stringify`
 * throws on one rather than guessing. The obvious fix — coerce to `Number` —
 * is the failure this whole layer exists to prevent: a double holds every
 * integer only up to 2^53, so a nanosecond timebase silently starts folding
 * distinct instants together after fourteen weeks.
 *
 * So a `bigint` is written as a tagged object rather than a bare string. A bare
 * string would be indistinguishable from an identifier that happens to be all
 * digits, and the reviver would have to guess which fields to convert — a guess
 * that is wrong exactly once, on the field nobody tested.
 */

const TAG = '$tick' as const

type TaggedTick = Readonly<{ [TAG]: string }>

function isTaggedTick(value: unknown): value is TaggedTick {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as Record<string, unknown>)[TAG] === 'string'
  )
}

/**
 * Serialize a value whose leaves may be `bigint`.
 *
 * Object keys are emitted in sorted order so two runs on two machines produce
 * identical bytes: the stored JSON sits beside a hash of the aggregate, and a
 * key order that varied would make the two disagree for no reason.
 */
export function stringifyWithTicks(value: unknown): string {
  return JSON.stringify(normalize(value))
}

function normalize(value: unknown): unknown {
  if (typeof value === 'bigint') return { [TAG]: value.toString() }
  if (Array.isArray(value)) return value.map(normalize)
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return Object.fromEntries(entries.map(([key, entry]) => [key, normalize(entry)]))
  }
  return value
}

/** Restore a value written by {@link stringifyWithTicks}. */
export function parseWithTicks(text: string): unknown {
  return revive(JSON.parse(text))
}

function revive(value: unknown): unknown {
  if (isTaggedTick(value)) return BigInt(value[TAG])
  if (Array.isArray(value)) return value.map(revive)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, revive(entry)]),
    )
  }
  return value
}
