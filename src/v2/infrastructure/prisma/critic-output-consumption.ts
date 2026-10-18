import type { PrismaClient, Prisma } from '../../../../generated/prisma-v2/index.js'
import { DomainError } from '../../domain/errors.ts'
import { requirePersistedOutputConsumptionV3, type RequiredOutputConsumptionV3 } from './output-state-consumption.ts'

type Reader = Pick<PrismaClient | Prisma.TransactionClient, '$queryRawUnsafe'>

/**
 * What a critic (a reader that reviews, annotates or scores the output of a Version) takes from the one persisted consumption
 * reader: the exact State, entry and seal of the Version it was asked about, and the format of that output.
 *
 * `formatId` is the aspect ratio the entry's sealed spec carries, never a project column and never a default. An output whose spec
 * carries none cannot be critiqued as "a format"; it is refused with the published `output-not-consumable` instead of guessed.
 */
export type CriticOutputConsumption = RequiredOutputConsumptionV3 & Readonly<{ formatId: string }>

export async function requireCriticOutputConsumption(client: Reader,
  input: Readonly<{ workspaceId: string; projectId: string; versionId: string; variantId?: string }>): Promise<CriticOutputConsumption> {
  const consumption = await requirePersistedOutputConsumptionV3(client, { ...input, purpose: 'critic' })
  if (consumption.aspectRatio === null) {
    throw new DomainError('PRECONDITION_REQUIRED', 'The output of this Version carries no format to critique',
      { reason: 'output-not-consumable', purpose: 'critic', outputStateId: consumption.state.document.id })
  }
  return Object.freeze({ ...consumption, formatId: consumption.aspectRatio })
}
