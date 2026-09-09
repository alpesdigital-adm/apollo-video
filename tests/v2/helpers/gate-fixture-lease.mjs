import { PrismaClient } from '../../../generated/prisma-v2/index.js'

/**
 * A lease over the F4.016 fixture ids, held for the life of one suite.
 *
 * `multicam-longform-gate.e2e.mjs` and `phase-gate-journey.e2e.mjs` seed worlds
 * through `buildGateWorld`, which writes fixed ids — `media_artifacts.id`
 * among them, and that column is unique across the whole database rather than
 * per workspace. Each suite therefore cleans the OTHER one's workspaces, so a
 * crashed run cannot block the next seed. Today they are separate, sequential
 * CI steps and the coupling is harmless; nothing in the workflow enforces that,
 * and the day the steps are split across parallel jobs sharing one PostgreSQL
 * service — or a developer runs both scripts at once — one run silently empties
 * the other's fixture mid-flight and the failure reads as a domain bug.
 *
 * A PostgreSQL advisory lock makes the second runner WAIT instead. It is
 * session-level, which is exactly why it needs a connection of its own: the
 * suite's pooled client hands the next statement a different connection and
 * `pg_advisory_unlock` on that one would answer `false`. `connection_limit=1`
 * pins one connection to this client for its lifetime — measured on
 * PostgreSQL 16 before this file existed: a second client's
 * `pg_try_advisory_lock` on the same key answered `false` across intervening
 * queries and `true` again only after the holder released.
 *
 * The lock dies with the connection, so a crashed run leaves nothing stale
 * behind for the next one to wait on.
 */

/** One key for the whole F4.016 fixture family. Arbitrary, but shared. */
const GATE_FIXTURE_LOCK_KEY = 40_160_016

function leaseUrl() {
  const raw = process.env.V2_DATABASE_URL
  if (!raw) throw new Error('the gate fixture lease needs V2_DATABASE_URL')
  const url = new URL(raw)
  // One connection, and a short pool timeout: this client only ever runs two
  // statements, and a lease that queues behind the suite's own pool would be a
  // second way to hang.
  url.searchParams.set('connection_limit', '1')
  url.searchParams.set('pool_timeout', '10')
  url.searchParams.set('application_name', 'apollo-v2-gate-fixture-lease')
  return url.toString()
}

/**
 * Wait for the fixture to be free, then hold it.
 *
 * Returns `{ release }`, which the caller must run in `t.after` — releasing
 * the lock and closing the connection it lives on.
 */
export async function acquireGateFixtureLease({
  timeoutMs = 10 * 60_000,
  pollMs = 500,
  key = GATE_FIXTURE_LOCK_KEY,
} = {}) {
  const client = new PrismaClient({ datasources: { db: { url: leaseUrl() } } })
  const startedAt = Date.now()
  let waitedMs = 0
  try {
    for (;;) {
      const [row] = await client.$queryRawUnsafe(
        `SELECT pg_try_advisory_lock(${key}) AS locked`,
      )
      if (row?.locked === true) break
      waitedMs = Date.now() - startedAt
      if (waitedMs > timeoutMs) {
        throw new Error(
          `another suite has held the F4.016 fixture lease (${key}) for ${Math.round(waitedMs / 1_000)}s; `
          + 'refusing to seed on top of a world that is still being written',
        )
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  } catch (error) {
    await client.$disconnect().catch(() => {})
    throw error
  }
  return {
    waitedMs,
    release: async () => {
      // Reported, not rethrown: a lease that would not go is not a failed
      // measurement, and the connection closing releases it either way.
      try {
        await client.$queryRawUnsafe(`SELECT pg_advisory_unlock(${key}) AS released`)
      } catch (error) {
        console.error('gate fixture lease release reported:', error?.message ?? error)
      }
      await client.$disconnect().catch(() => {})
    },
  }
}
