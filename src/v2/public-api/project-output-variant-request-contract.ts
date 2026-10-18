import { DomainError } from '../domain/errors.ts'

/**
 * How a request names the output it is about. The name is always the STABLE State variant id (what
 * `apollo.projects.output-variants.create` returns), never an aspect ratio. Whether the id may be left out is the capability's
 * rule, and it is the same everywhere it may: only a project with exactly one output can omit it, and the application service
 * (not the parser) refuses a project with several outputs when none is named (`output-variant-required`).
 */

/** `variantId` when present: a non-empty string (trimmed); anything else is a malformed request, never "absent". */
export function parseOptionalVariantId(value: unknown, field = 'variantId'): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim()) throw new DomainError('INVALID_ARGUMENT', `${field} must be a non-empty string`)
  return value.trim()
}

/** `variantId` when the capability cannot do without it. */
export function parseRequiredVariantId(value: unknown, field = 'variantId'): string {
  const parsed = parseOptionalVariantId(value, field)
  if (parsed === undefined) throw new DomainError('INVALID_ARGUMENT', `${field} is required`)
  return parsed
}

/**
 * The optional body of `POST /v1/projects/{projectId}/proxy-renders`. The endpoint had no body: an empty body (or `{}`) is still
 * a valid request, so existing clients keep working against a project with one output. The body may only carry `variantId`.
 */
export function parseProxyRenderBody(rawText: string): Readonly<{ variantId?: string }> {
  if (!rawText.trim()) return Object.freeze({})
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch {
    throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DomainError('INVALID_ARGUMENT', 'Request body must be an object')
  }
  const body = parsed as Record<string, unknown>
  const unknown = Object.keys(body).filter((key) => key !== 'variantId')
  if (unknown.length > 0) throw new DomainError('INVALID_ARGUMENT', 'Request body contains an unsupported field', { fields: unknown })
  const variantId = parseOptionalVariantId(body.variantId)
  return Object.freeze(variantId === undefined ? {} : { variantId })
}
