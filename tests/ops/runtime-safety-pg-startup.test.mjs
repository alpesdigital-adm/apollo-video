import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startRuntimeSafetyCluster } from '../v2/helpers/runtime-safety-world.mjs'

test('owned startup overrides inherited Unix socket directory while retaining loopback TCP and high port', async (t) => {
  const scratchDir = await mkdtemp(join(tmpdir(), 'apollo-pg-socket-test-'))
  t.after(async () => { await rm(scratchDir, { recursive: true, force: true }) })
  const dataDirectory = join(scratchDir, 'pgdata-socket')
  let startupOptions
  const cluster = await startRuntimeSafetyCluster({ scratchDir, runId: 'socket' }, {
    freePort: async () => 55577,
    closedPort: async () => true,
    command: async (name, args) => {
      if (name === 'initdb') await mkdir(dataDirectory)
      if (name === 'pg_ctl' && args.includes('start')) {
        startupOptions = args[args.indexOf('-o') + 1]
        // Controlled inherited Linux configuration: without the override PG tries
        // /var/run/postgresql and fails before the TCP-only cluster becomes usable.
        if (!startupOptions.includes('-c unix_socket_directories= -c')) {
          throw new Error('FATAL: could not create lock file /var/run/postgresql/.s.PGSQL.55577.lock: Permission denied')
        }
      }
    },
  })
  try {
    assert.equal(cluster.owned, true)
    assert.match(startupOptions, /-p 55577(?: |$)/)
    assert.match(startupOptions, /-c listen_addresses=127\.0\.0\.1(?: |$)/)
    assert.equal(new URL(cluster.baseUrl).hostname, '127.0.0.1')
    assert.equal(cluster.port, 55577)
  } finally {
    assert.equal((await cluster.stop()).stopped, true)
  }
})

test('provided cluster returns before any owned startup option or command', async () => {
  const previous = process.env.APOLLO_RUNTIME_SAFETY_DATABASE_URL
  const provided = 'postgresql://postgres@127.0.0.1:55588/apollo_v2_e2e?schema=public'
  process.env.APOLLO_RUNTIME_SAFETY_DATABASE_URL = provided
  try {
    const cluster = await startRuntimeSafetyCluster({ scratchDir: 'unused', runId: 'provided' }, {
      freePort: () => { throw new Error('must not allocate a port') },
      command: () => { throw new Error('must not run PostgreSQL commands') },
    })
    assert.equal(cluster.owned, false)
    assert.equal(cluster.baseUrl, provided)
    assert.equal(cluster.port, 55588)
    assert.deepEqual(await cluster.stop(), { stopped: false, reason: 'the compose service is not owned by this run' })
  } finally {
    if (previous === undefined) delete process.env.APOLLO_RUNTIME_SAFETY_DATABASE_URL
    else process.env.APOLLO_RUNTIME_SAFETY_DATABASE_URL = previous
  }
})

async function scenario(t, { log, pid = false, listener = false, stopWorks = true,
  initFails = false, probeUnknown = false, wrongDirectory = false,
  pidDirectoryCaseMismatch = false, platform = process.platform }) {
  const scratchDir = await mkdtemp(join(tmpdir(), 'apollo-pg-start-test-'))
  t.after(async () => { await rm(scratchDir, { recursive: true, force: true }) })
  const runId = 'controlled'
  const dataDirectory = join(scratchDir, `pgdata-${runId}`)
  const original = new Error(initFails ? 'initdb exited 1: ' : 'pg_ctl exited 1: ')
  let alive = pid
  let listening = listener
  const calls = []
  const command = async (name, args) => {
    calls.push([name, args])
    if (name === 'initdb') {
      await mkdir(dataDirectory)
      if (initFails) throw original
    }
    if (name === 'pg_ctl' && args.includes('start')) {
      if (log !== undefined) await writeFile(join(dataDirectory, 'server.log'), log)
      if (pid) await writeFile(join(dataDirectory, 'postmaster.pid'),
        `12345\n${wrongDirectory ? scratchDir : pidDirectoryCaseMismatch
          ? join(scratchDir, 'Pgdata-controlled') : dataDirectory}\n`)
      throw original
    }
    if (name === 'pg_ctl' && args.includes('stop') && stopWorks) {
      alive = false
      listening = false
      await rm(join(dataDirectory, 'postmaster.pid'))
    }
  }
  let error
  try {
    await startRuntimeSafetyCluster({ scratchDir, runId }, {
      command, freePort: async () => 55577,
      closedPort: async () => probeUnknown ? false : !listening, pidAlive: async () => alive,
      platform,
    })
  } catch (caught) { error = caught }
  assert.equal(error, original, 'startup error identity is preserved')
  return { error, calls, dataDirectory, scratchDir }
}

test('initdb failure is owned, diagnosed and cleaned without a postmaster', async (t) => {
  const { error, calls, dataDirectory } = await scenario(t, { initFails: true })
  assert.equal(error.ownedTeardownVerified, true)
  assert.match(error.message, /stage=initdb.*cleanupVerified=true/)
  assert.match(error.message, /server.log tail.*\(not created\)/s)
  assert.deepEqual(calls.map(([name]) => name), ['initdb'])
  await assert.rejects(readFile(dataDirectory), /ENOENT/)
})

test('start fails before PID/listener: empty server log and original exit survive cleanup', async (t) => {
  const { error, calls, dataDirectory } = await scenario(t, { log: '' })
  assert.equal(error.ownedTeardownVerified, true)
  assert.match(error.message, /pg_ctl exited 1: /)
  assert.match(error.message, /stage=pg_ctl start.*cleanupVerified=true/)
  assert.match(error.message, /server.log tail.*\(empty\)/s)
  assert.equal(calls.filter(([name, args]) => name === 'pg_ctl' && args.includes('stop')).length, 0)
  await assert.rejects(readFile(join(dataDirectory, 'server.log')), /ENOENT/)
})

test('failed start with owned PID but no listener still stops by data directory and PID', async (t) => {
  const { error, calls } = await scenario(t, { log: 'FATAL: controlled startup failure', pid: true })
  assert.equal(error.ownedTeardownVerified, true)
  assert.match(error.message, /FATAL: controlled startup failure/)
  assert.equal(calls.filter(([name, args]) => name === 'pg_ctl' && args.includes('stop')).length, 1)
})

test('failed start with owned PID and listener stops both before removing data', async (t) => {
  const { error, dataDirectory } = await scenario(t, { log: 'server failed', pid: true, listener: true })
  assert.equal(error.ownedTeardownVerified, true)
  await assert.rejects(readFile(join(dataDirectory, 'postmaster.pid')), /ENOENT/)
})

test('inconclusive stop retains log and does not claim cleanup despite a free port', async (t) => {
  const { error, calls, dataDirectory } = await scenario(t, { log: 'FATAL: retained evidence', pid: true, stopWorks: false })
  assert.equal(error.ownedTeardownVerified, false)
  assert.match(error.message, /cleanupVerified=false/)
  assert.match(await readFile(join(dataDirectory, 'server.log'), 'utf8'), /retained evidence/)
  assert.equal(calls.filter(([name, args]) => name === 'pg_ctl' && args.includes('stop')).length, 4)
})

test('listener without an owned PID, and an inconclusive port probe, retain evidence without signalling', async (t) => {
  for (const options of [{ listener: true }, { probeUnknown: true }]) {
    const { error, calls, dataDirectory } = await scenario(t, { log: 'startup evidence', ...options })
    assert.equal(error.ownedTeardownVerified, false)
    assert.equal(calls.filter(([name, args]) => name === 'pg_ctl' && args.includes('stop')).length, 0)
    assert.equal(await readFile(join(dataDirectory, 'server.log'), 'utf8'), 'startup evidence')
  }
})

test('mismatched PID file cannot authorize pg_ctl stop', async (t) => {
  const { error, calls, dataDirectory } = await scenario(t, {
    log: 'retained', pid: true, listener: true, wrongDirectory: true,
  })
  assert.equal(error.ownedTeardownVerified, false)
  assert.match(error.message, /postmaster.pid does not belong to this run/)
  assert.equal(calls.filter(([name, args]) => name === 'pg_ctl' && args.includes('stop')).length, 0)
  assert.equal(await readFile(join(dataDirectory, 'server.log'), 'utf8'), 'retained')
})

test('Linux case-mismatched PID directory aborts without signalling or deletion (controlled seam)', async (t) => {
  const { error, calls, dataDirectory } = await scenario(t, {
    log: 'retained', pid: true, listener: true, pidDirectoryCaseMismatch: true, platform: 'linux',
  })
  assert.equal(error.ownedTeardownVerified, false)
  assert.match(error.message, /postmaster.pid does not belong to this run/)
  assert.equal(calls.filter(([name, args]) => name === 'pg_ctl' && args.includes('stop')).length, 0)
  assert.equal(await readFile(join(dataDirectory, 'server.log'), 'utf8'), 'retained')
  assert.match(await readFile(join(dataDirectory, 'postmaster.pid'), 'utf8'), /Pgdata-controlled/)
})

test('Windows case-mismatched PID directory is accepted (controlled seam)', async (t) => {
  const { error, calls, dataDirectory } = await scenario(t, {
    log: 'retained', pid: true, pidDirectoryCaseMismatch: true, platform: 'win32',
  })
  assert.equal(error.ownedTeardownVerified, true)
  assert.equal(calls.filter(([name, args]) => name === 'pg_ctl' && args.includes('stop')).length, 1)
  await assert.rejects(readFile(join(dataDirectory, 'postmaster.pid')), /ENOENT/)
})

test('log tail is bounded and redacts URLs/credentials before console reporting', async (t) => {
  const log = `old-marker${'x'.repeat(9000)}\nFATAL tail postgresql://alice:sample@localhost/db password="example"`
  const { error } = await scenario(t, { log })
  assert.equal(error.ownedTeardownVerified, true)
  assert.doesNotMatch(error.message, /old-marker|alice:sample|password=|example/)
  assert.match(error.message, /\[redacted URL\].*\[redacted credential\]/)
  assert.ok(error.message.length < 9500)
})

test('startup diagnostics redact common labeled fake credentials and authorization headers', async (t) => {
  const fakes = [
    'FAKE_API_UNDERSCORE', 'FAKE_API_DASH', 'FAKE_API_PLAIN',
    'FAKE_BEARER', 'FAKE_BASIC', 'FAKE_PROXY_BEARER', 'FAKE_PROXY_BASIC',
    'FAKE_PASSWORD_IS', 'FAKE_PASSWORD_DOUBLE', 'FAKE_PASSWORD_SINGLE',
  ]
  const log = [
    'api_key=FAKE_API_UNDERSCORE',
    'api-key: "FAKE_API_DASH"',
    "apikey='FAKE_API_PLAIN'",
    'Authorization: Bearer FAKE_BEARER',
    'Authorization: Basic "FAKE_BASIC"',
    'Proxy-Authorization: Bearer FAKE_PROXY_BEARER',
    "Proxy-Authorization: Basic 'FAKE_PROXY_BASIC'",
    'password is FAKE_PASSWORD_IS',
    'password is "FAKE_PASSWORD_DOUBLE"',
    "password is 'FAKE_PASSWORD_SINGLE'",
    'FATAL: controlled marker',
  ].join('\n')
  const { error } = await scenario(t, { log })
  assert.equal(error.ownedTeardownVerified, true)
  for (const fake of fakes) assert.ok(!error.message.includes(fake), `leaked ${fake}`)
  assert.match(error.message, /FATAL: controlled marker/)
  assert.match(error.message, /\[redacted credential\]/)
})
