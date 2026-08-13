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
function optionalFinite(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

export function parseReframePlanRequest(value: unknown): Readonly<{
  baseVersionId: string
  format: OutputAspectRatio
  observationSet: unknown
  overrides?: readonly unknown[]
  maxVelocityPerSecond?: number
  maxAccelerationPerSecondSquared?: number
  safetyMargin?: number
}> {
  const body = record(value, 'body')
  exact(body, ['baseVersionId', 'format', 'observationSet', 'overrides', 'maxVelocityPerSecond', 'maxAccelerationPerSecondSquared', 'safetyMargin'], 'body')
  if (typeof body.format !== 'string' || !OUTPUT_ASPECT_RATIOS.includes(body.format as OutputAspectRatio)) throw new DomainError('INVALID_ARGUMENT', 'format is invalid')
  if (body.overrides !== undefined && (!Array.isArray(body.overrides) || body.overrides.length > 1_000)) throw new DomainError('INVALID_ARGUMENT', 'overrides is invalid')
  return Object.freeze({
    baseVersionId: id(body.baseVersionId, 'baseVersionId'), format: body.format as OutputAspectRatio,
    observationSet: record(body.observationSet, 'observationSet'),
    ...(body.overrides === undefined ? {} : { overrides: Object.freeze([...body.overrides]) }),
    ...(body.maxVelocityPerSecond === undefined ? {} : { maxVelocityPerSecond: optionalFinite(body.maxVelocityPerSecond, 'maxVelocityPerSecond') }),
    ...(body.maxAccelerationPerSecondSquared === undefined ? {} : { maxAccelerationPerSecondSquared: optionalFinite(body.maxAccelerationPerSecondSquared, 'maxAccelerationPerSecondSquared') }),
    ...(body.safetyMargin === undefined ? {} : { safetyMargin: optionalFinite(body.safetyMargin, 'safetyMargin') }),
  })
}
