import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

// The W66 Version guards are DEFERRED constraint triggers. What the application sees when one of them refuses the COMMIT
// decides whether a refusal is an error or a false success, so this suite pins the behaviour of the Prisma in use against a
// trigger of its own: a refused deferred check at COMMIT leaves the interactive transaction's callback value returned (the
// outcome is recorded, not required) and the rows rolled back, while `SET CONSTRAINTS ALL IMMEDIATE` as the callback's last
// statement raises inside the callback. Every Version writer takes the second path (settleDeferredOutputGuards).
test('a deferred guard refusing at COMMIT is only an error when the writer settles it inside the transaction', { skip: process.env.APOLLO_RUN_S2D_PG !== '1' || !process.env.V2_DATABASE_URL }, async () => {
  const table = `s2d_probe_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const db = new PrismaClient()
  const options = { maxWait: 5000, timeout: 20_000 }
  const count = async () => (await db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM ${table}`))[0].n
  const attempt = async (work) => {
    try { return { resolved: await db.$transaction(work, options) } } catch (error) { return { rejected: String(error.meta?.message ?? error.message), code: error.code } }
  }
  try {
    await db.$executeRawUnsafe(`CREATE TABLE ${table} (a int)`)
    await db.$executeRawUnsafe(`CREATE FUNCTION ${table}_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused at commit' USING ERRCODE='23514'; END $$`)
    await db.$executeRawUnsafe(`CREATE CONSTRAINT TRIGGER ${table}_trg AFTER INSERT ON ${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${table}_fn()`)

    const unsettled = await attempt(async (tx) => { await tx.$executeRawUnsafe(`INSERT INTO ${table} (a) VALUES (1)`); return 'callback-value' })
    assert.equal(await count(), 0, 'nothing is stored when the COMMIT is refused')
    console.log('deferred-commit-semantics unsettled:', JSON.stringify(unsettled))

    const settled = await attempt(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO ${table} (a) VALUES (2)`)
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
      return 'callback-value'
    })
    assert.match(settled.rejected ?? '', /refused at commit/, 'settled inside the callback, the refusal rejects the transaction')
    assert.equal(await count(), 0, 'and nothing is stored')
  } finally {
    await db.$executeRawUnsafe(`DROP TABLE IF EXISTS ${table} CASCADE`)
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${table}_fn()`)
    await db.$disconnect()
  }
})
