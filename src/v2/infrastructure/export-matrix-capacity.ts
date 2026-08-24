import { DomainError } from '../domain/errors.ts'
import type { ExportMatrixCapacityProvider } from '../application/ports/export-matrix-capacity.ts'

function configuredInteger(value: string | undefined, name: string, maximum: number): number {
  if (!value || !/^[0-9]+$/.test(value)) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', `${name} is not configured`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', `${name} is invalid`)
  return parsed
}

export function createExportMatrixCapacityProviderFromEnvironment(environment: NodeJS.ProcessEnv = process.env): ExportMatrixCapacityProvider {
  const capacity = Object.freeze({
    operatorMaximumCostMinorUnits: configuredInteger(environment.APOLLO_EXPORT_MATRIX_MAX_COST_MINOR_UNITS, 'APOLLO_EXPORT_MATRIX_MAX_COST_MINOR_UNITS', 100_000_000),
    operatorAvailableStorageBytes: configuredInteger(environment.APOLLO_EXPORT_MATRIX_AVAILABLE_STORAGE_BYTES, 'APOLLO_EXPORT_MATRIX_AVAILABLE_STORAGE_BYTES', Number.MAX_SAFE_INTEGER),
  })
  return Object.freeze({ async read() { return capacity } })
}
