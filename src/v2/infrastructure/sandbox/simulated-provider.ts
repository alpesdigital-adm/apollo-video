import {
  createSandboxProviderReceipt,
  createSandboxProviderReceiptV2,
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

  executeV2(input: {
    environment: string
    workspaceId: string
    clientId: string
    operation: 'transcription' | 'speaker-diarization'
    inputHash: string
    outputHash: string
    units: number
  }) {
    return createSandboxProviderReceiptV2({
      ...input,
      minorUnits: input.units * 2,
    })
  }
}
