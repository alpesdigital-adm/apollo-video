// The one way a PostgreSQL suite gets a clean slate.
//
// The W66 output rows are append-only: BEFORE UPDATE OR DELETE triggers refuse to change or remove a sealed Version, its
// State, an ingest intent, a manifest or an operational dependency. A suite must therefore not clean up with `deleteMany`
// (the trigger refuses it, rightly) and must never disable, drop or bypass those triggers. Two ways remain:
//
//   1. Unique identities per invocation (`uniqueRun`, in pg-output-world.mjs) with assertions scoped to those identities,
//      and no deletes at all. This is the default, and the only choice on a database shared with other suites.
//   2. When a suite truly needs an empty database, `resetDisposableDatabase`, below.
//
// Why TRUNCATE is allowed to be the reset: the immutability guards are row triggers (FOR EACH ROW). TRUNCATE does not
// fire row triggers, and the migrations define no TRUNCATE trigger (statement-level, tgtype bit 32) and no event
// trigger; `disposable-database.pg.integration.mjs` proves both against the real migrated schema, so the day someone
// adds one this reset fails loudly instead of the guard being silently skipped. This is a reset of a DISPOSABLE
// database, not a deletion path of the product.
//
// What makes a database disposable (and nothing else will do):
//   - its name carries the `e2e` word (`apollo_v2_e2e_library`, `apollo_contamination_e2e`...), the pattern every CI job
//     and the supervised local harness give their throwaway databases;
//   - the connection says it is a test: application_name starts with `apollo-video-e2e-` (CI and the harness set it);
//   - the server is local (loopback address or a Unix socket): never a hosted database.
// The values are read from the SERVER for the very connection that will run the TRUNCATE (current_database(),
// application_name, inet_server_addr()), not from the environment, so a stale or wrong V2_DATABASE_URL cannot lie.

/** The database-name rule shared by CI, the harness and the older inline guards: an `e2e` word delimited by `_` or the ends. */
export const DISPOSABLE_DATABASE_NAME = /(?:^|_)e2e(?:_|$)/
/** Every test connection names itself; CI jobs and the supervised harness use this prefix. */
export const TEST_APPLICATION_NAME = /^apollo-video-e2e-/

const LOOPBACK = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1)$/

/** Pure: throws unless all three facts say "disposable". `address` is null for a Unix-socket connection. */
export function assertDisposableTarget({ databaseName, applicationName, address }) {
  const problems = []
  if (typeof databaseName !== 'string' || !DISPOSABLE_DATABASE_NAME.test(databaseName)) {
    problems.push(`database "${databaseName}" is not a disposable e2e database (its name needs an "e2e" word)`)
  }
  if (typeof applicationName !== 'string' || !TEST_APPLICATION_NAME.test(applicationName)) {
    problems.push(`application_name "${applicationName}" is not a test connection (it must start with "apollo-video-e2e-")`)
  }
  if (address !== null && address !== undefined && !LOOPBACK.test(address)) {
    problems.push(`the server address "${address}" is not local`)
  }
  if (problems.length) throw new Error(`Refusing to reset a database that is not disposable: ${problems.join('; ')}`)
}

/** What the server says about the connection `client` is using. */
export async function describeConnection(client) {
  const [row] = await client.$queryRawUnsafe(
    "SELECT current_database() AS \"databaseName\", current_setting('application_name') AS \"applicationName\", host(inet_server_addr()) AS address",
  )
  return { databaseName: row.databaseName, applicationName: row.applicationName, address: row.address ?? null }
}

/**
 * Empties the disposable database: `TRUNCATE TABLE "workspaces" CASCADE`, the statement the suites used inline, which
 * removes every row reachable from a workspace (all project, media, ingest and output rows) and keeps the migration
 * history. Refuses, before touching anything, unless the connection is disposable (see the top of this file).
 *
 * `client` is a PrismaClient (or transaction client) opened on the database to reset; nothing else is opened.
 */
export async function resetDisposableDatabase(client) {
  assertDisposableTarget(await describeConnection(client))
  await client.$executeRawUnsafe('TRUNCATE TABLE "workspaces" CASCADE')
}
