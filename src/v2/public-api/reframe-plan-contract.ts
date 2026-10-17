import { DomainError } from '../domain/errors.ts'
import { OUTPUT_ASPECT_RATIOS, type OutputAspectRatio } from '../domain/output-spec.ts'

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
export function parseReframePlanRequest(value: unknown): Readonly<{
  baseVersionId: string
  format: OutputAspectRatio
}> {
  const body = record(value, 'body')
  exact(body, ['baseVersionId', 'format'], 'body')
  if (typeof body.format !== 'string' || !OUTPUT_ASPECT_RATIOS.includes(body.format as OutputAspectRatio)) throw new DomainError('INVALID_ARGUMENT', 'format is invalid')
  return Object.freeze({
    baseVersionId: id(body.baseVersionId, 'baseVersionId'), format: body.format as OutputAspectRatio,
  })
}
