import { assertDomain } from '../domain/errors.ts'
import { FALLBACK_DESCENT_REASONS } from '../domain/transformation-fallback.ts'

function record(value: unknown, field: string): Record<string, unknown> {
  assertDomain(typeof value === 'object' && value !== null && !Array.isArray(value), 'INVALID_ARGUMENT', `${field} must be an object`)
  return value as Record<string, unknown>
}

export function parseTransformationFallbackAction(raw: unknown) {
  const body = record(raw, 'body')
  assertDomain(Object.keys(body).every((key) => key === 'action' || key === 'because') && 'action' in body, 'INVALID_ARGUMENT', 'body contains missing or unsupported properties')
  assertDomain(body.action === 'accept' || body.action === 'keep-source' || body.action === 'descend', 'INVALID_ARGUMENT', 'body.action is unsupported')
  if (body.because !== undefined) {
    assertDomain(typeof body.because === 'string' && FALLBACK_DESCENT_REASONS.includes(body.because as never), 'INVALID_ARGUMENT', 'body.because is unsupported')
  }
  assertDomain(body.action === 'descend' || body.because === undefined, 'INVALID_ARGUMENT', 'body.because only applies to descend')
  return Object.freeze({
    action: body.action,
    ...(body.because ? { because: body.because as (typeof FALLBACK_DESCENT_REASONS)[number] } : {}),
  })
}

export function presentTransformationQuality(value: Readonly<{
  ledgers: readonly Readonly<{ ledger: unknown; actions: readonly string[] }>[]
  reports: readonly unknown[]
  novelty: readonly unknown[]
}>) {
  return Object.freeze({ ledgers: value.ledgers, reports: value.reports, novelty: value.novelty })
}
