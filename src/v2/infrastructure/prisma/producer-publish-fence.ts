import type { Prisma } from '../../../../generated/prisma-v2/index.js'

import { DomainError } from '../../domain/errors.ts'

/** Publication locks operation, project head, then source artifact before checking their context. */
export async function lockProducerPublishOperation(
  transaction: Prisma.TransactionClient,
  operationId: string,
  workspaceId: string,
): Promise<void> {
  const rows = await transaction.$queryRaw<readonly { id: string }[]>`
    SELECT "id" FROM "public_operations"
    WHERE "id" = ${operationId} AND "workspaceId" = ${workspaceId}
    FOR UPDATE`
  if (rows.length !== 1) throw new DomainError('PERSISTENCE_CONFLICT', 'Producer operation is missing')
}

export async function lockProducerPublishProject(
  transaction: Prisma.TransactionClient,
  projectId: string,
  workspaceId: string,
): Promise<void> {
  const rows = await transaction.$queryRaw<readonly { id: string }[]>`
    SELECT "id" FROM "projects"
    WHERE "id" = ${projectId} AND "workspaceId" = ${workspaceId}
    FOR UPDATE`
  if (rows.length !== 1) throw new DomainError('PERSISTENCE_CONFLICT', 'Producer project is missing')
}

export async function lockProducerPublishSource(
  transaction: Prisma.TransactionClient,
  artifactId: string,
  workspaceId: string,
): Promise<void> {
  const rows = await transaction.$queryRaw<readonly { id: string }[]>`
    SELECT "id" FROM "media_artifacts"
    WHERE "id" = ${artifactId} AND "workspaceId" = ${workspaceId}
    FOR UPDATE`
  if (rows.length !== 1) throw new DomainError('PERSISTENCE_CONFLICT', 'Producer source artifact is missing')
}

/** PostgreSQL NOW() is fixed at transaction start; use a fresh clock after each possible wait. */
export async function producerPublishClock(transaction: Prisma.TransactionClient): Promise<Date> {
  const rows = await transaction.$queryRaw<readonly { observedAt: Date }[]>`
    SELECT clock_timestamp() AS "observedAt"`
  const observedAt = rows[0]?.observedAt
  if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Producer publication clock is unavailable')
  }
  return observedAt
}
