import { createHash } from 'node:crypto'

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Version snapshots cannot contain non-finite numbers')
    }
    return value
  }

  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    )
  }

  throw new TypeError(`Unsupported snapshot value: ${typeof value}`)
}
export function stableSerialize(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function calculateVersionHash(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex')
}
