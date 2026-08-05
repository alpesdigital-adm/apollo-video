import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'

export const SANDBOX_PROVIDER_RECEIPT_SCHEMA_VERSION =
  'sandbox-provider-receipt/v1' as const

export const SANDBOX_PROVIDER_OPERATIONS = [
  'semantic-embedding',
] as const

export type SandboxProviderOperation =
  (typeof SANDBOX_PROVIDER_OPERATIONS)[number]

export interface SandboxProviderReceipt {
  schemaVersion: typeof SANDBOX_PROVIDER_RECEIPT_SCHEMA_VERSION
  workspaceId: string
  clientId: string
  environment: 'sandbox'
  provider: 'apollo-sandbox-fake'
  operation: SandboxProviderOperation
  inputHash: string
  outputHash: string
  units: number
  cost: Readonly<{ currency: 'USD'; minorUnits: number }>
  externalCalls: 0
  receiptHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const SHA256 = /^[a-f0-9]{64}$/
const MAX_UNITS = 100_000
const MAX_COST = 1_000_000_000

export function createSandboxProviderReceipt(
  input: Omit<SandboxProviderReceipt, 'schemaVersion' | 'provider' |
    'environment' | 'cost' | 'externalCalls' | 'receiptHash'> & {
      environment: string
      minorUnits: number
      receiptHash?: string
    },
): Readonly<SandboxProviderReceipt> {
  assertDomain(
    ID.test(input.workspaceId) && ID.test(input.clientId),
    'INVALID_ARGUMENT',
    'Sandbox provider scope is invalid',
  )
  assertDomain(
    input.environment === 'sandbox',
    'INVALID_CAPABILITY',
    'Simulated provider is sandbox-only',
  )
  assertDomain(
    SANDBOX_PROVIDER_OPERATIONS.includes(input.operation),
    'INVALID_ARGUMENT',
    'Sandbox provider operation is invalid',
  )
  assertDomain(
    SHA256.test(input.inputHash) && SHA256.test(input.outputHash),
    'INVALID_ARGUMENT',
    'Sandbox provider content hash is invalid',
  )
  assertDomain(
    Number.isSafeInteger(input.units) && input.units >= 1 &&
      input.units <= MAX_UNITS && Number.isSafeInteger(input.minorUnits) &&
      input.minorUnits >= 0 && input.minorUnits <= MAX_COST,
    'INVALID_ARGUMENT',
    'Sandbox provider usage is invalid',
  )
  const content = Object.freeze({
    workspaceId: input.workspaceId,
    clientId: input.clientId,
    environment: 'sandbox' as const,
    provider: 'apollo-sandbox-fake' as const,
    operation: input.operation,
    inputHash: input.inputHash,
    outputHash: input.outputHash,
    units: input.units,
    cost: Object.freeze({
      currency: 'USD' as const,
      minorUnits: input.minorUnits,
    }),
    externalCalls: 0 as const,
  })
  const receiptHash = calculateCanonicalHash({
    schemaVersion: SANDBOX_PROVIDER_RECEIPT_SCHEMA_VERSION,
    ...content,
  })
  assertDomain(
    input.receiptHash === undefined || input.receiptHash === receiptHash,
    'PERSISTENCE_CONFLICT',
    'Sandbox provider receipt hash is invalid',
  )
  return Object.freeze({
    schemaVersion: SANDBOX_PROVIDER_RECEIPT_SCHEMA_VERSION,
    ...content,
    receiptHash,
  })
}
