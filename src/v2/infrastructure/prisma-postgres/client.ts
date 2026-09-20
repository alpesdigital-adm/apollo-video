import { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import { DomainError } from '../../domain/errors.ts'

const globalForV2Prisma = globalThis as unknown as {
  apolloV2Postgres?: PrismaClient
}

const PROCESS_ROLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/

/**
 * Names this process in `pg_stat_activity` (Wave 23).
 *
 * Until now every worker and the API server opened indistinguishable backends,
 * so the 29 July 2026 incident — orphaned connections blocking a drop — could
 * only be investigated by guessing which client was reconnecting. A role is
 * taken from `APOLLO_PROCESS_ROLE`, which each worker script sets to its own
 * name before building a client.
 *
 * An `application_name` already present in the URL always wins: the E2E suites
 * declare `apollo-video-e2e-<run-id>` and the exclusivity preflight matches on
 * exactly that string, so overriding it would blind the very check that exists
 * to keep two runs off the same database.
 */
export function applyV2ApplicationName(
  databaseUrl: string,
  role = process.env.APOLLO_PROCESS_ROLE,
): string {
  const trimmedRole = role?.trim()
  if (!trimmedRole || !PROCESS_ROLE_PATTERN.test(trimmedRole)) return databaseUrl
  let url: URL
  try {
    url = new URL(databaseUrl)
  } catch {
    // An unparseable URL is Prisma's problem to report, not ours to rewrite.
    return databaseUrl
  }
  if (url.searchParams.has('application_name')) return databaseUrl
  url.searchParams.set('application_name', `apollo-video-${trimmedRole}`)
  return url.toString()
}

export function createV2PostgresClient(databaseUrl = process.env.V2_DATABASE_URL) {
  if (!databaseUrl?.startsWith('postgresql://') && !databaseUrl?.startsWith('postgres://')) {
    throw new DomainError(
      'PERSISTENCE_NOT_CONFIGURED',
      'V2_DATABASE_URL must be a PostgreSQL connection URL',
    )
  }

  return new PrismaClient({ datasourceUrl: applyV2ApplicationName(databaseUrl) })
}

export function getV2PostgresClient(): PrismaClient {
  if (!globalForV2Prisma.apolloV2Postgres) {
    globalForV2Prisma.apolloV2Postgres = createV2PostgresClient()
  }

  return globalForV2Prisma.apolloV2Postgres
}

export async function disconnectV2PostgresClient(): Promise<void> {
  const client = globalForV2Prisma.apolloV2Postgres
  globalForV2Prisma.apolloV2Postgres = undefined
  await client?.$disconnect()
}
