import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { describeConnection, resetDisposableDatabase } from './helpers/disposable-database.mjs'
import { seedSealedProject, testActor, uniqueRun } from './helpers/pg-output-world.mjs'

// Proves, on the real migrated schema, what the shared reset relies on: no migration defines a TRUNCATE trigger or an
// event trigger (so TRUNCATE does not bypass a guard that would otherwise have fired), the W66 immutability triggers are
// live in this very database (a row delete is refused), and the reset still empties it, but only for a connection that
// is disposable.
// Destructive by design (it resets the database it runs on): only the supervised harness, which owns a disposable cluster, sets the gate.
const enabled = process.env.V2_DATABASE_URL !== undefined && process.env.APOLLO_RUN_S2D_PG === '1'

test('resetDisposableDatabase empties a database whose immutability triggers are live, and only a disposable one', { skip: !enabled, timeout: 180_000 }, async () => {
  const db = new PrismaClient()
  try {
    // 1. nothing fires on TRUNCATE: no statement-level TRUNCATE trigger (tgtype bit 32), no event trigger
    const truncateTriggers = await db.$queryRawUnsafe(
      "SELECT c.relname AS \"table\", t.tgname AS \"trigger\" FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND (t.tgtype & 32) <> 0",
    )
    assert.deepEqual(truncateTriggers, [], 'a TRUNCATE trigger would make the reset a bypass of a product guard')
    const eventTriggers = await db.$queryRawUnsafe('SELECT evtname FROM pg_event_trigger')
    assert.deepEqual(eventTriggers, [])
    const guards = await db.$queryRawUnsafe(
      "SELECT c.relname AS \"table\", p.proname AS fn, (t.tgtype & 1) = 1 AS row_level FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid WHERE NOT t.tgisinternal AND p.proname IN ('w66_output_immutable', 'w66_output_dependency_guard')",
    )
    assert.ok(guards.length >= 10, `the W66 immutability guards exist (${guards.length})`)
    assert.deepEqual(guards.filter((guard) => !guard.row_level), [], 'every W66 immutability guard is a row trigger (the kind TRUNCATE does not fire)')

    // 2. a sealed world, and the guard that protects it from a delete
    const run = uniqueRun('s2dreset')
    const workspaceId = `${run.run}-workspace`
    const actor = testActor({ workspaceId, clientId: `${run.run}-client` })
    const world = await seedSealedProject(db, { workspaceId, actor, prefix: `s2dreset-${run.run}` })
    assert.equal(world.head.version.outputContractVersion, 3)
    await assert.rejects(() => db.v2ProjectVersion.deleteMany({ where: { id: world.head.version.id } }), (error) => /W66/.test(String(error.meta?.message ?? error.message)))
    const migrations = (await db.$queryRawUnsafe('SELECT count(*)::int AS n FROM _prisma_migrations'))[0].n
    assert.ok(migrations > 0)

    // 3. a connection that does not say it is a test is refused, and nothing is removed
    const url = new URL(process.env.V2_DATABASE_URL)
    url.searchParams.set('application_name', 'not-a-test-connection')
    const plain = new PrismaClient({ datasources: { db: { url: url.toString() } } })
    try {
      await assert.rejects(() => resetDisposableDatabase(plain), /application_name "not-a-test-connection" is not a test connection/)
    } finally { await plain.$disconnect() }
    assert.equal(await db.v2ProjectVersion.count({ where: { id: world.head.version.id } }), 1, 'the refused reset removed nothing')

    // 4. the reset itself: sealed rows included, migration history kept
    const connection = await describeConnection(db)
    assert.match(connection.applicationName, /^apollo-video-e2e-/)
    await resetDisposableDatabase(db)
    for (const [model, where] of [['v2Workspace', {}], ['v2Project', {}], ['v2ProjectVersion', {}], ['v2OutputOperationalBundle', {}], ['v2EditCommand', {}]]) {
      if (db[model]) assert.equal(await db[model].count({ where }), 0, `${model} is empty after the reset`)
    }
    assert.equal((await db.$queryRawUnsafe('SELECT count(*)::int AS n FROM _prisma_migrations'))[0].n, migrations, 'the migration history is kept')
  } finally {
    await db.$disconnect()
  }
})
