import { DomainError } from '../domain/errors.ts'
import type { TickInterval } from '../domain/session-time.ts'

/**
 * The primitives the three capture-session derivations share at the boundary
 * (F4.012, F4.013/F4.014, F4.015).
 *
 * Every `*-contract.ts` before this one carries its own private copies of
 * `record`, `exactFields`, `identifier` and `sha256`. Three more copies landing
 * in one wave is three places for the tick grammar to drift apart, and the tick
 * grammar is the one thing all three boundaries agree on: **ticks cross as
 * decimal strings**, because a 64-bit tick handed to a JSON parser as a number
 * comes back rounded with nothing raised.
 *
 * The rules these encode, in one place:
 *
 * - **A caller names positions, never measurements.** There is no parser here
 *   for a score, a confidence, a residual or an approval; the services derive
 *   all of those from stored projections, and a request that could contribute
 *   to them could contribute a lie.
 * - **An unknown field is a refusal, not a shrug.** `exactFields` names the
 *   keys that went nowhere, because a key that is accepted and dropped teaches
 *   the next caller to keep sending it.
 * - **A fence is a pair.** A version number can be reused after a write that
 *   failed halfway; the hash it carried cannot.
 */

export function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be an object`)
  }
  return value as Record<string, unknown>
}

export function exactFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    throw new DomainError('INVALID_ARGUMENT', `${field} contains unknown fields`, { fields: unknown })
  }
}

export function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length < 3 || value.trim().length > 200) {
    throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  }
  return value.trim()
}

export function sha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be a sha256 digest`)
  }
  return value
}

export function member<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be one of ${allowed.join(', ')}`)
  }
  return value as T
}

export function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maximum) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must say something, in at most ${maximum} characters`)
  }
  return value.trim()
}

export function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

export function boundedNumber(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be a finite number between ${minimum} and ${maximum}`)
  }
  return value
}

/**
 * A tick position as the wire carries it.
 *
 * Nineteen digits is the widest decimal a signed 64-bit tick can be, and the
 * bound is on the string rather than on the parsed value because `BigInt` is
 * happy to build a number no clock in this system could produce.
 */
const TICK_STRING = /^[0-9]{1,19}$/

export function tick(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !TICK_STRING.test(value)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be a decimal string of ticks`)
  }
  return BigInt(value)
}

/** The same grammar, for a value that arrived in the query string. */
export function tickParameter(value: string | null, field: string): bigint | undefined {
  if (value === null) return undefined
  return tick(value, field)
}

export function integerParameter(
  value: string | null,
  field: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === null) return undefined
  if (!/^[0-9]{1,9}$/.test(value)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be a whole number`)
  }
  return boundedInteger(Number(value), field, minimum, maximum)
}

/**
 * The version a fence names, checked against the chain it claims to be on.
 *
 * `<sessionId>:<kind>:v<n>` is how every derivation of a capture session names
 * a link. Parsing it here rather than accepting a bare number does two things a
 * number cannot: it refuses a fence computed against another session's chain,
 * and it refuses one computed against the diagnostic when the caller meant the
 * match plan.
 */
export function derivationVersion(
  baseVersionId: string,
  sessionId: string,
  kind: string,
  field: string,
): number {
  const prefix = `${sessionId}:${kind}:v`
  if (!baseVersionId.startsWith(prefix)) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must name a ${kind} version of capture session ${sessionId}`,
      { expectedPrefix: prefix },
    )
  }
  const digits = baseVersionId.slice(prefix.length)
  if (!/^[1-9][0-9]{0,8}$/.test(digits)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} does not end in a version number`)
  }
  return Number(digits)
}

export function presentInterval(interval: Readonly<TickInterval>) {
  return Object.freeze({ start: interval.start.toString(), end: interval.end.toString() })
}

export function presentOptionalInterval(interval: Readonly<TickInterval> | null) {
  return interval === null ? null : presentInterval(interval)
}
