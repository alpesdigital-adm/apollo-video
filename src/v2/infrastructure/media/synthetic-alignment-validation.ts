import { assertDomain } from '../../domain/errors.ts'

export interface ValidatedSyntheticAlignment {
  characters: readonly string[]
  startTimesSeconds: readonly number[]
  endTimesSeconds: readonly number[]
}

/** Validates untrusted provider timing. Zero-duration characters are valid. */
export function validateSyntheticAlignment(value: unknown): Readonly<ValidatedSyntheticAlignment> {
  assertDomain(typeof value === 'object' && value !== null && !Array.isArray(value), 'PERSISTENCE_CONFLICT', 'Synthetic alignment is malformed')
  const input = value as Record<string, unknown>
  const characters = input.characters
  const starts = input.startTimesSeconds
  const ends = input.endTimesSeconds
  assertDomain(
    Array.isArray(characters) && Array.isArray(starts) && Array.isArray(ends) &&
      characters.length > 0 && characters.length === starts.length && characters.length === ends.length,
    'PERSISTENCE_CONFLICT',
    'Synthetic alignment is malformed',
  )
  let previousEnd = 0
  for (let index = 0; index < characters.length; index += 1) {
    const start = starts[index]
    const end = ends[index]
    assertDomain(
      typeof characters[index] === 'string' && typeof start === 'number' && Number.isFinite(start) && start >= 0 &&
        typeof end === 'number' && Number.isFinite(end) && end >= start && start + 1e-6 >= previousEnd,
      'PERSISTENCE_CONFLICT',
      'Synthetic alignment timeline is invalid',
    )
    previousEnd = end
  }
  return Object.freeze({
    characters: Object.freeze([...(characters as string[])]),
    startTimesSeconds: Object.freeze([...(starts as number[])]),
    endTimesSeconds: Object.freeze([...(ends as number[])]),
  })
}
