import type {
  SandboxProviderReceipt,
} from '../../domain/sandbox-provider-execution.ts'

export interface SandboxProviderExecutionRecord {
  receipt: Readonly<SandboxProviderReceipt>
  createdAt: string
}

export interface SandboxProviderExecutionRepository {
  record(
    receipt: Readonly<SandboxProviderReceipt>,
  ): Promise<Readonly<SandboxProviderExecutionRecord>>
  list(input: {
    workspaceId: string
    limit: number
    after?: Readonly<{ createdAt: string; receiptHash: string }>
  }): Promise<readonly Readonly<SandboxProviderExecutionRecord>[]>
}
