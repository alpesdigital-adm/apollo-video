import { DomainError } from '../domain/errors.ts'

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('INVALID_ARGUMENT', `${field} must be an object`)
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new DomainError('INVALID_ARGUMENT', `${field} contains unsupported fields`, { fields: unknown })
}
function id(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(value)) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

/**
 * W66r. A reframe plan is requested for one STABLE output variant of one Version. The body carries neither observations nor overrides
 * (the server derives the one from sealed evidence, and an override is a Command), and an aspect ratio is not a variant.
 */
export function parseReframePlanRequest(value: unknown): Readonly<{ baseVersionId: string; variantId: string }> {
  const body = record(value, 'body')
  exact(body, ['baseVersionId', 'variantId'], 'body')
  return Object.freeze({ baseVersionId: id(body.baseVersionId, 'baseVersionId'), variantId: id(body.variantId, 'variantId') })
}
