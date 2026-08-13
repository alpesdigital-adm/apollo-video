import {
  parseDirectorToolCalls,
} from '../domain/director-tools.ts'
import { assertDomain } from '../domain/errors.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

function record(value: unknown, allowed: readonly string[], field: string) {
  assertDomain(typeof value === 'object' && value !== null && !Array.isArray(value), 'INVALID_ARGUMENT', `${field} must be an object`)
  const result = value as Record<string, unknown>
  assertDomain(Object.keys(result).every((key) => allowed.includes(key)), 'INVALID_ARGUMENT', `${field} contains unsupported properties`)
  return result
}

export function parseDirectorToolExecutionBody(value: unknown) {
  const body = record(value, ['projectId', 'calls'], 'Request body')
  assertDomain(typeof body.projectId === 'string' && ID.test(body.projectId.trim()), 'INVALID_ARGUMENT', 'projectId is invalid')
  return Object.freeze({
    projectId: body.projectId.trim(),
    calls: parseDirectorToolCalls(body.calls),
  })
}

export function presentDirectorToolExecution(result: Readonly<{
  results: readonly Readonly<{
    callId: string
    tool: string
    status: 'accepted'
    chargedCost: number
    result: unknown
  }>[]
  budgetRemaining: number
}>) {
  return Object.freeze({
    schemaVersion: 'director-tool-execution/v1' as const,
    results: result.results,
    budgetRemaining: result.budgetRemaining,
  })
}
