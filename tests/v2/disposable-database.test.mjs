import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertDisposableTarget, dialedHostOf, DISPOSABLE_DATABASE_NAME, describeConnection, resetDisposableDatabase, TEST_APPLICATION_NAME,
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
  assert.throws(() => assertDisposableTarget({ ...good, address: '10.0.0.4' }), /not local/, 'a private address alone is not proof')
  assert.throws(() => assertDisposableTarget({ ...good, address: '203.0.113.9' }), /not local/)
  assert.throws(() => assertDisposableTarget({ databaseName: 'production', applicationName: 'app', address: '203.0.113.9' }),
    (error) => /disposable e2e database/.test(error.message) && /test connection/.test(error.message) && /not local/.test(error.message))
})

// The Compose CI jobs publish PostgreSQL on 127.0.0.1:55432; the server then sees its own container address (172.18.0.2).
test('a container database is accepted only when its address is private AND the client dialed a loopback host', () => {
  for (const address of ['172.18.0.2', '172.16.0.9', '172.31.255.1', '10.1.2.3', '192.168.0.7', 'fd12:3456::2']) {
    for (const dialedHost of ['127.0.0.1', 'localhost', '::1']) {
      assert.doesNotThrow(() => assertDisposableTarget({ ...good, address, dialedHost }), `${address} via ${dialedHost}`)
    }
    assert.throws(() => assertDisposableTarget({ ...good, address }), /not local/, `${address} without a dial host`)
    assert.throws(() => assertDisposableTarget({ ...good, address, dialedHost: 'db.example.com' }), /not local/, `${address} dialed remotely`)
    assert.throws(() => assertDisposableTarget({ ...good, address, dialedHost: '10.0.0.4' }), /not local/, `${address} dialed by a private host`)
  }
  // a public (or look-alike) server address is never accepted, whatever the client dialed
  for (const address of ['203.0.113.9', '172.32.0.1', '172.15.0.1', '34.120.1.1', '2001:db8::1', '11.0.0.1']) {
    assert.throws(() => assertDisposableTarget({ ...good, address, dialedHost: '127.0.0.1' }), /not local/, address)
  }
  // the name and the application_name still decide on their own
  assert.throws(() => assertDisposableTarget({ ...good, address: '172.18.0.2', dialedHost: '127.0.0.1', databaseName: 'apollo_v2' }), /not a disposable e2e database/)
  assert.throws(() => assertDisposableTarget({ ...good, address: '172.18.0.2', dialedHost: '127.0.0.1', applicationName: 'apollo-video-compose-ci' }), /not a test connection/)
})

test('the dialed host is the one the connection string names, without IPv6 brackets', () => {
  assert.equal(dialedHostOf('postgresql://u:p@127.0.0.1:55432/apollo_v2_e2e?schema=public'), '127.0.0.1')
  assert.equal(dialedHostOf('postgresql://u:p@localhost:5432/x'), 'localhost')
  assert.equal(dialedHostOf('postgresql://u:p@[::1]:5432/x'), '::1')
  assert.equal(dialedHostOf('postgresql://u:p@DB.Example.com/x'), 'db.example.com')
  assert.equal(dialedHostOf(''), null)
  assert.equal(dialedHostOf(undefined), null)
  assert.equal(dialedHostOf('not a url'), null)
})

test('the reset of a container database follows the dialed host of the connection string it is given', async () => {
  const connection = (address) => {
    const executed = []
    return {
      executed,
      $queryRawUnsafe: async () => [{ databaseName: 'apollo_v2_e2e', applicationName: 'apollo-video-e2e-x', address }],
      $executeRawUnsafe: async (sql) => { executed.push(sql) },
    }
  }
  const published = connection('172.18.0.2')
  await resetDisposableDatabase(published, { databaseUrl: 'postgresql://u:p@127.0.0.1:55432/apollo_v2_e2e' })
  assert.deepEqual(published.executed, ['TRUNCATE TABLE "workspaces" CASCADE'])
  const remote = connection('172.18.0.2')
  await assert.rejects(() => resetDisposableDatabase(remote, { databaseUrl: 'postgresql://u:p@postgres:5432/apollo_v2_e2e' }), /not local/)
  assert.deepEqual(remote.executed, [], 'a container address reached by name from the network is not proof')
  const unknown = connection('172.18.0.2')
  await assert.rejects(() => resetDisposableDatabase(unknown, { databaseUrl: '' }), /not local/)
  assert.deepEqual(unknown.executed, [])
})

test('the reset asks the server about the connection and never truncates when it refuses', async () => {
  const calls = []
  const client = (row) => ({
    $queryRawUnsafe: async (sql) => { calls.push(['query', sql]); return [row] },
    $executeRawUnsafe: async (sql) => { calls.push(['execute', sql]) },
  })
  assert.deepEqual(await describeConnection(client({ databaseName: 'a_e2e', applicationName: 'apollo-video-e2e-x', address: null }), { databaseUrl: 'postgresql://u:p@127.0.0.1:55432/a_e2e' }),
    { databaseName: 'a_e2e', applicationName: 'apollo-video-e2e-x', address: null, dialedHost: '127.0.0.1' })

  calls.length = 0
  await assert.rejects(() => resetDisposableDatabase(client({ databaseName: 'apollo_v2', applicationName: 'apollo-video-e2e-x', address: '127.0.0.1' })), /Refusing to reset/)
  await assert.rejects(() => resetDisposableDatabase(client({ databaseName: 'apollo_v2_e2e', applicationName: 'node', address: '127.0.0.1' })), /Refusing to reset/)
  assert.deepEqual(calls.filter(([kind]) => kind === 'execute'), [], 'no statement ran against a refused connection')

  calls.length = 0
  await resetDisposableDatabase(client({ databaseName: 'apollo_v2_e2e', applicationName: 'apollo-video-e2e-x', address: '127.0.0.1' }))
  assert.deepEqual(calls.filter(([kind]) => kind === 'execute').map(([, sql]) => sql), ['TRUNCATE TABLE "workspaces" CASCADE'])
})
