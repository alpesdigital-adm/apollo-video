import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertDisposableTarget, DISPOSABLE_DATABASE_NAME, describeConnection, resetDisposableDatabase, TEST_APPLICATION_NAME,
} from './helpers/disposable-database.mjs'

const good = { databaseName: 'apollo_v2_e2e_library', applicationName: 'apollo-video-e2e-library-123', address: '127.0.0.1' }

test('the disposable pattern accepts the databases CI and the harness create', () => {
  for (const name of ['apollo_v2_e2e_library', 'apollo_v2_e2e_capture', 'apollo_contamination_e2e', 'apollo_synthetic_gate_e2e', 'apollo_v2_e2e_runtime_safety', 'e2e', 'apollo_v2_e2e']) {
    assert.match(name, DISPOSABLE_DATABASE_NAME, name)
  }
  for (const name of ['apollo_v2', 'apollo_v2_perception', 'postgres', 'apollo_v2_e2eprod', 'apollo_v2_prod_e2ex', 'apollo_e2e2', 'production']) {
    assert.doesNotMatch(name, DISPOSABLE_DATABASE_NAME, name)
  }
  assert.match('apollo-video-e2e-s2d-1a2b', TEST_APPLICATION_NAME)
  assert.doesNotMatch('apollo-video', TEST_APPLICATION_NAME)
  assert.doesNotMatch('prisma-client', TEST_APPLICATION_NAME)
  assert.doesNotMatch('', TEST_APPLICATION_NAME)
})

test('a disposable, test-named, local connection is accepted (loopback addresses and a Unix socket)', () => {
  assert.doesNotThrow(() => assertDisposableTarget(good))
  assert.doesNotThrow(() => assertDisposableTarget({ ...good, address: '::1' }))
  assert.doesNotThrow(() => assertDisposableTarget({ ...good, address: '127.0.0.5' }))
  assert.doesNotThrow(() => assertDisposableTarget({ ...good, address: null }))
})

test('each fact is enough to refuse, and the refusal names every fact that failed', () => {
  assert.throws(() => assertDisposableTarget({ ...good, databaseName: 'apollo_v2' }), /not a disposable e2e database/)
  assert.throws(() => assertDisposableTarget({ ...good, databaseName: undefined }), /not a disposable e2e database/)
  assert.throws(() => assertDisposableTarget({ ...good, applicationName: '' }), /not a test connection/)
  assert.throws(() => assertDisposableTarget({ ...good, applicationName: 'psql' }), /not a test connection/)
  assert.throws(() => assertDisposableTarget({ ...good, address: '10.0.0.4' }), /not local/)
  assert.throws(() => assertDisposableTarget({ ...good, address: '203.0.113.9' }), /not local/)
  assert.throws(() => assertDisposableTarget({ databaseName: 'production', applicationName: 'app', address: '203.0.113.9' }),
    (error) => /disposable e2e database/.test(error.message) && /test connection/.test(error.message) && /not local/.test(error.message))
})

test('the reset asks the server about the connection and never truncates when it refuses', async () => {
  const calls = []
  const client = (row) => ({
    $queryRawUnsafe: async (sql) => { calls.push(['query', sql]); return [row] },
    $executeRawUnsafe: async (sql) => { calls.push(['execute', sql]) },
  })
  assert.deepEqual(await describeConnection(client({ databaseName: 'a_e2e', applicationName: 'apollo-video-e2e-x', address: null })), { databaseName: 'a_e2e', applicationName: 'apollo-video-e2e-x', address: null })

  calls.length = 0
  await assert.rejects(() => resetDisposableDatabase(client({ databaseName: 'apollo_v2', applicationName: 'apollo-video-e2e-x', address: '127.0.0.1' })), /Refusing to reset/)
  await assert.rejects(() => resetDisposableDatabase(client({ databaseName: 'apollo_v2_e2e', applicationName: 'node', address: '127.0.0.1' })), /Refusing to reset/)
  assert.deepEqual(calls.filter(([kind]) => kind === 'execute'), [], 'no statement ran against a refused connection')

  calls.length = 0
  await resetDisposableDatabase(client({ databaseName: 'apollo_v2_e2e', applicationName: 'apollo-video-e2e-x', address: '127.0.0.1' }))
  assert.deepEqual(calls.filter(([kind]) => kind === 'execute').map(([, sql]) => sql), ['TRUNCATE TABLE "workspaces" CASCADE'])
})
