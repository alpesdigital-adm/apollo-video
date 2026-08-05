import type {
  PrismaClient,
  V2SandboxProviderExecution,
} from '../../../../generated/prisma-v2/index.js'

import type {
  SandboxProviderExecutionRecord,
  SandboxProviderExecutionRepository,
} from '../../application/ports/sandbox-provider-execution-repository.ts'
import {
  createSandboxProviderReceipt,
  type SandboxProviderOperation,
  type SandboxProviderReceipt,
} from '../../domain/sandbox-provider-execution.ts'
import { DomainError } from '../../domain/errors.ts'

function hydrate(
  row: V2SandboxProviderExecution,
): Readonly<SandboxProviderExecutionRecord> {
  try {
    const receipt = createSandboxProviderReceipt({
      workspaceId: row.workspaceId,
      clientId: row.clientId,
      environment: row.environment,
      operation: row.operation as SandboxProviderOperation,
      inputHash: row.inputHash,
      outputHash: row.outputHash,
      units: row.units,
      minorUnits: row.costMinorUnits,
      receiptHash: row.receiptHash,
    })
    if (
      row.schemaVersion !== receipt.schemaVersion ||
      row.provider !== receipt.provider || row.currency !== 'USD' ||
      row.externalCalls !== 0
    ) throw new Error('stored receipt metadata mismatch')
    return Object.freeze({
      receipt,
      createdAt: row.createdAt.toISOString(),
    })
  } catch (error) {
    if (error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT') {
      throw error
    }
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored sandbox provider receipt is invalid',
    )
  }
}

function createData(receipt: Readonly<SandboxProviderReceipt>) {
  return {
    receiptHash: receipt.receiptHash,
    schemaVersion: receipt.schemaVersion,
    workspaceId: receipt.workspaceId,
    clientId: receipt.clientId,
    environment: receipt.environment,
    provider: receipt.provider,
    operation: receipt.operation,
    inputHash: receipt.inputHash,
    outputHash: receipt.outputHash,
    units: receipt.units,
    currency: receipt.cost.currency,
    costMinorUnits: receipt.cost.minorUnits,
    externalCalls: receipt.externalCalls,
  }
}

export class PrismaSandboxProviderExecutionRepository
implements SandboxProviderExecutionRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
  }

  async record(receipt: Readonly<SandboxProviderReceipt>) {
    const canonical = createSandboxProviderReceipt({
      workspaceId: receipt.workspaceId,
      clientId: receipt.clientId,
      environment: receipt.environment,
      operation: receipt.operation,
      inputHash: receipt.inputHash,
      outputHash: receipt.outputHash,
      units: receipt.units,
      minorUnits: receipt.cost.minorUnits,
      receiptHash: receipt.receiptHash,
    })
    const row = await this.client.v2SandboxProviderExecution.upsert({
      where: { receiptHash: canonical.receiptHash },
      create: createData(canonical),
      update: {},
    })
    const stored = hydrate(row)
    if (stored.receipt.receiptHash !== canonical.receiptHash) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Sandbox provider receipt replay is invalid')
    }
    return stored
  }

  async list(input: {
    workspaceId: string
    limit: number
    after?: Readonly<{ createdAt: string; receiptHash: string }>
  }) {
    const rows = await this.client.v2SandboxProviderExecution.findMany({
      where: {
        workspaceId: input.workspaceId,
        ...(input.after ? {
          OR: [
            { createdAt: { lt: new Date(input.after.createdAt) } },
            {
              createdAt: new Date(input.after.createdAt),
              receiptHash: { lt: input.after.receiptHash },
            },
          ],
        } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { receiptHash: 'desc' }],
      take: input.limit,
    })
    return Object.freeze(rows.map(hydrate))
  }
}
