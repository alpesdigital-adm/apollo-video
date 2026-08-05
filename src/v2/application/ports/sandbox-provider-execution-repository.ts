import type {
  SandboxProviderExecutionReceipt,
} from '../../domain/sandbox-provider-execution.ts'

export interface SandboxProviderExecutionRecord {
  receipt: Readonly<SandboxProviderExecutionReceipt>
  createdAt: string
}

export interface SandboxProviderExecutionRepository {
  record(
    receipt: Readonly<SandboxProviderExecutionReceipt>,
  ): Promise<Readonly<SandboxProviderExecutionRecord>>
  list(input: {
    workspaceId: string
    limit: number
    after?: Readonly<{ createdAt: string; receiptHash: string }>
  }): Promise<readonly Readonly<SandboxProviderExecutionRecord>[]>
}
