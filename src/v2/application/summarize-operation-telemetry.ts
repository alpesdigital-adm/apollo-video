import { assertDomain } from '../domain/errors.ts'
import type { OperationTelemetryQueryRepository } from './ports/operation-telemetry-query-repository.ts'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000

function parseInstant(value: string, field: string): Date {
  const instant = new Date(value)
  assertDomain(
    typeof value === 'string' && Number.isFinite(instant.getTime()) && instant.toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} must be an ISO 8601 UTC instant`,
  )
  return instant
}

export function summarizeOperationTelemetryService(dependencies: {
  telemetry: OperationTelemetryQueryRepository
  now?: () => Date
}) {
  return async function summarize(input: { workspaceId: string; from?: string; to?: string }) {
    const workspaceId = input.workspaceId.trim()
    assertDomain(ID_PATTERN.test(workspaceId), 'INVALID_ARGUMENT', 'workspaceId must contain 3 to 128 safe characters')
    const now = dependencies.now?.() ?? new Date()
    const to = input.to ? parseInstant(input.to, 'to') : now
    const from = input.from ? parseInstant(input.from, 'from') : new Date(to.getTime() - 24 * 60 * 60 * 1000)
    assertDomain(from.getTime() < to.getTime(), 'INVALID_ARGUMENT', 'from must be before to')
    assertDomain(to.getTime() - from.getTime() <= MAX_WINDOW_MS, 'INVALID_ARGUMENT', 'telemetry window cannot exceed 31 days')
    assertDomain(to.getTime() <= now.getTime() + 60_000, 'INVALID_ARGUMENT', 'to cannot be in the future')
    return dependencies.telemetry.summarize({ workspaceId, from: from.toISOString(), to: to.toISOString() })
  }
}
