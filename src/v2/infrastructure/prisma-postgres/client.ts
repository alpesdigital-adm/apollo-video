import { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import { DomainError } from '../../domain/errors.ts'

const globalForV2Prisma = globalThis as unknown as {
  apolloV2Postgres?: PrismaClient
}

export function createV2PostgresClient(databaseUrl = process.env.V2_DATABASE_URL) {
  if (!databaseUrl?.startsWith('postgresql://') && !databaseUrl?.startsWith('postgres://')) {
    throw new DomainError(
      'PERSISTENCE_NOT_CONFIGURED',
      'V2_DATABASE_URL must be a PostgreSQL connection URL',
    )
  }

  return new PrismaClient({ datasourceUrl: databaseUrl })
}

export function getV2PostgresClient(): PrismaClient {
  if (!globalForV2Prisma.apolloV2Postgres) {
    globalForV2Prisma.apolloV2Postgres = createV2PostgresClient()
  }

  return globalForV2Prisma.apolloV2Postgres
}
