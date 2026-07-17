import { createHash } from 'node:crypto'
import { DomainError } from '../../domain/errors.ts'

export class SimulatedSandboxProvider {
  execute(input: { environment: string; workspaceId: string; clientId: string; operation: string; units: number }) {
    if (input.environment !== 'sandbox') throw new DomainError('INVALID_CAPABILITY', 'Simulated provider is sandbox-only')
    if (!Number.isInteger(input.units) || input.units < 0 || input.units > 100_000) throw new DomainError('INVALID_ARGUMENT', 'Simulated provider units are invalid')
    const receipt = createHash('sha256').update(JSON.stringify(input)).digest('hex')
    return Object.freeze({ provider: 'apollo-sandbox-fake' as const, simulated: true as const, receipt, cost: Object.freeze({ currency: 'USD' as const, minorUnits: input.units * 2 }), externalCalls: 0 as const })
  }
}
