import {
  createSandboxProviderReceipt,
  type SandboxProviderOperation,
} from '../../domain/sandbox-provider-execution.ts'

export class SimulatedSandboxProvider {
  execute(input: {
    environment: string
    workspaceId: string
    clientId: string
    operation: SandboxProviderOperation
    inputHash: string
    outputHash: string
    units: number
  }) {
    return createSandboxProviderReceipt({
      ...input,
      minorUnits: input.units * 2,
    })
  }
}
