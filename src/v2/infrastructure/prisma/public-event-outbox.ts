import { Prisma } from '../../../../generated/prisma-v2/index.js'

import { stableSerialize } from '../../domain/canonical-hash.ts'
import type { PublicEvent } from '../../domain/public-event.ts'

export type PublicEventOutboxTransaction = Pick<
  Prisma.TransactionClient,
  'v2PublicEventOutbox'
>

export async function persistPublicEvents(
  transaction: PublicEventOutboxTransaction,
  events: readonly Readonly<PublicEvent>[],
): Promise<void> {
  if (events.length === 0) return
  await transaction.v2PublicEventOutbox.createMany({
    data: events.map((event) => ({
      id: event.id,
      workspaceId: event.workspaceId,
      type: event.type,
      version: event.version,
      occurredAt: new Date(event.occurredAt),
      sequence: event.sequence,
      actorClientId: event.actor?.clientId,
      actorUserId: event.actor?.userId,
      resourceType: event.resource.type,
      resourceId: event.resource.id,
      dataJson: stableSerialize(event.data),
    })),
  })
}
