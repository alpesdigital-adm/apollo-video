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
//   - the server is local: a loopback address or a Unix socket; or, for a database in a container (the Compose jobs
//     publish it on 127.0.0.1:55432 and the server then sees its own container address, e.g. 172.18.0.2), a PRIVATE-network
//     server address reached through a LOOPBACK host dialed by the client, which is the rule every older journey guard
//     states with `['localhost', '127.0.0.1', '::1'].includes(url.hostname)`. A public or remote server address is never
//     accepted, and a private address is not accepted without that loopback dial: never a hosted database.
// The database name, the application_name and the server address are read from the SERVER for the very connection that
// will run the TRUNCATE (current_database(), application_name, inet_server_addr()). The dialed host is the one fact the
// server cannot know (it sees the container side of a published port); it is read from the connection string the client
// uses (V2_DATABASE_URL, or the `databaseUrl` option), so it can only add trust to a private server address, never to a
// name or to an application_name.

/** The database-name rule shared by CI, the harness and the older inline guards: an `e2e` word delimited by `_` or the ends. */
export const DISPOSABLE_DATABASE_NAME = /(?:^|_)e2e(?:_|$)/
/** Every test connection names itself; CI jobs and the supervised harness use this prefix. */
export const TEST_APPLICATION_NAME = /^apollo-video-e2e-/

const LOOPBACK = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1)$/
/** RFC 1918 and unique-local IPv6: the addresses a container network gives its members. */
const PRIVATE_NETWORK = /^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|f[cd][0-9a-f]{2}:[0-9a-f:]+)$/i
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/** The host a connection string dials, without IPv6 brackets; null when there is none or it is not a URL. */
export function dialedHostOf(databaseUrl) {
  if (typeof databaseUrl !== 'string' || databaseUrl.length === 0) return null
  try {
    return new URL(databaseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase() || null
  } catch {
    return null
  }
}

/**
 * Pure: throws unless the facts say "disposable". `address` is null for a Unix-socket connection; `dialedHost` is the host the
 * client dialed (see the top of this file) and only matters for a private server address.
 */
export function assertDisposableTarget({ databaseName, applicationName, address, dialedHost = null }) {
  const problems = []
  if (typeof databaseName !== 'string' || !DISPOSABLE_DATABASE_NAME.test(databaseName)) {
    problems.push(`database "${databaseName}" is not a disposable e2e database (its name needs an "e2e" word)`)
  }
  if (typeof applicationName !== 'string' || !TEST_APPLICATION_NAME.test(applicationName)) {
    problems.push(`application_name "${applicationName}" is not a test connection (it must start with "apollo-video-e2e-")`)
  }
  if (address !== null && address !== undefined && !LOOPBACK.test(address)) {
    const publishedOnLoopback = PRIVATE_NETWORK.test(address) && typeof dialedHost === 'string' && LOOPBACK_HOSTS.has(dialedHost)
    if (!publishedOnLoopback) {
      problems.push(`the server address "${address}" is not local (a container address needs a loopback host dialed by the client; dialed: ${dialedHost ?? 'unknown'})`)
    }
  }
  if (problems.length) throw new Error(`Refusing to reset a database that is not disposable: ${problems.join('; ')}`)
}

/** What the server says about the connection `client` is using, plus the host the client's connection string dials. */
export async function describeConnection(client, { databaseUrl = process.env.V2_DATABASE_URL } = {}) {
  const [row] = await client.$queryRawUnsafe(
    "SELECT current_database() AS \"databaseName\", current_setting('application_name') AS \"applicationName\", host(inet_server_addr()) AS address",
  )
  return { databaseName: row.databaseName, applicationName: row.applicationName, address: row.address ?? null, dialedHost: dialedHostOf(databaseUrl) }
}

/**
 * Empties the disposable database: `TRUNCATE TABLE "workspaces" CASCADE`, the statement the suites used inline, which
 * removes every row reachable from a workspace (all project, media, ingest and output rows) and keeps the migration
 * history. Refuses, before touching anything, unless the connection is disposable (see the top of this file).
 *
 * `client` is a PrismaClient (or transaction client) opened on the database to reset; nothing else is opened. `options.databaseUrl`
 * names the connection string that client dials when it is not V2_DATABASE_URL.
 */
export async function resetDisposableDatabase(client, options = {}) {
  assertDisposableTarget(await describeConnection(client, options))
  await client.$executeRawUnsafe('TRUNCATE TABLE "workspaces" CASCADE')
}
