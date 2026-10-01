// Standalone real-PG regression. Never part of the 100s disposable unit gate.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startRuntimeSafetyCluster, processIsAlive } from '../../tests/v2/helpers/runtime-safety-world.mjs'
import { closeOwnedClients, probeClosedPort } from './postgres-activity-cleanup.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const run = randomUUID().slice(0, 8)
const scratch = join(process.env.RUNNER_TEMP || process.env.TMPDIR || tmpdir(), `apollo-pg-observer-${run}`)
const bin = process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/16/bin' : '/usr/lib/postgresql/16/bin'
const cli = (name) => {
  const path = join(bin, name + (process.platform === 'win32' ? '.exe' : ''))
  assert.ok(existsSync(path), `PostgreSQL 16 binary required: ${path}`)
  return path
}
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
const app = `apollo-video-e2e-synthetic-wave24-${run}`
const db = 'apollo_synthetic_wave24_e2e'
let cluster
let postmasterPid
let proofComplete = false
let startupError
const clients = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const deadline = Date.now() + 115_000
function psql(sql, { database = db, user = 'postgres', application = 'observer-pg-regression' } = {}) {
  assert.ok(Date.now() < deadline, 'experiment deadline exceeded')
  const result = spawnSync(cli('psql'), [
    '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(cluster.port),
    '-U', user, '-d', database, '-c', sql,
  ], { cwd: scratch, env: { ...process.env, PGPASSWORD: '', PGAPPNAME: application, PGCONNECT_TIMEOUT: '10' },
    timeout: 10_000, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, `psql failed: ${result.stderr?.slice(0, 500) || result.error}`)
  return result.stdout.trim()
}
function guardSql() {
  const code = `import sys; sys.path.insert(0, ${JSON.stringify(join(root, 'scripts/ops/digitalocean-bootstrap'))}); import remote_guard as g; print(g.pg_activity_sql(${JSON.stringify(run)}))`
  const result = spawnSync(python, ['-c', code], { encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, cwd: scratch })
  assert.equal(result.status, 0, `guard SQL unavailable: ${result.stderr?.slice(0, 300) || result.error}`)
  return result.stdout.trim()
}
function counts(sql = guardSql()) {
  const values = psql(sql, { database: 'postgres' }).split('|').map(Number)
  assert.equal(values.length, 4, 'guard must retain four integer fields')
  assert.ok(values.every(Number.isInteger), `noninteger guard output ${values}`)
  return values
}
function startClient(user, application) {
  const child = spawn(cli('psql'), ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1',
    '-p', String(cluster.port), '-U', user, '-d', db, '-c', 'SELECT pg_sleep(40)'], {
    cwd: scratch, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, PGPASSWORD: '', PGAPPNAME: application, PGCONNECT_TIMEOUT: '10' },
  })
  const closed = new Promise((resolve) => { child.once('close', resolve); child.once('error', () => {}) })
  clients.push({ child, closed })
  return child.pid
}
async function awaitClient(user, application) {
  const osPid = startClient(user, application)
  const until = Date.now() + 5_000
  while (Date.now() < until) {
    const found = psql(`select pid from pg_stat_activity where datname='${db}' and backend_type='client backend' and usename='${user}' and application_name='${application}' and wait_event='PgSleep'`)
    if (found) { clients.at(-1).backendPid = Number(found); return Number(found) }
    await sleep(100)
  }
  throw new Error(`client backend not visible (owned OS pid ${osPid})`)
}
async function closeClients() {
  await closeOwnedClients(clients, {
    terminateBackend: cluster?.owned ? (pid) => psql(`SELECT pg_terminate_backend(${pid})`, { database: 'postgres' }) : undefined,
    countBackends: cluster?.owned ? (pids) => psql(`SELECT count(*) FROM pg_stat_activity WHERE pid IN (${pids.join(',')})`, { database: 'postgres' }) : undefined,
  })
}
try {
  cli('initdb'); cli('pg_ctl'); cli('psql'); cli('pg_isready'); cli('createdb')
  await mkdir(scratch, { recursive: true })
  // The helper's opt-in external DB is forbidden in this child only; never consume product URLs.
  delete process.env.APOLLO_RUNTIME_SAFETY_DATABASE_URL
  try {
    cluster = await startRuntimeSafetyCluster({ scratchDir: scratch, runId: run })
  } catch (error) {
    startupError = error
    throw error
  }
  assert.equal(cluster.owned, true)
  assert.notEqual(cluster.port, 5432)
  assert.equal(new URL(cluster.baseUrl).hostname, '127.0.0.1')
  const socketDirectories = psql('SHOW unix_socket_directories', { database: 'postgres' })
  const listenAddresses = psql('SHOW listen_addresses', { database: 'postgres' })
  assert.equal(socketDirectories, '', 'owned cluster must disable Unix sockets')
  assert.equal(listenAddresses, '127.0.0.1', 'owned cluster must bind loopback TCP only')
  console.log(JSON.stringify({ phase: 'connection-config', unix_socket_directories: socketDirectories, listen_addresses: listenAddresses }))
  postmasterPid = Number((await readFile(join(cluster.dataDirectory, 'postmaster.pid'), 'utf8')).split('\n')[0])
  assert.ok(await processIsAlive(postmasterPid))
  psql(`CREATE ROLE apollo_e2e LOGIN CONNECTION LIMIT 5; ALTER ROLE apollo_e2e SET idle_in_transaction_session_timeout='10s'; ALTER ROLE apollo_e2e SET statement_timeout='50s'`, { database: 'postgres' })
  psql(`CREATE DATABASE ${db} OWNER apollo_e2e`, { database: 'postgres' })
  psql(`ALTER SYSTEM SET autovacuum_naptime='1s'`, { database: 'postgres' })
  psql(`SELECT pg_reload_conf()`, { database: 'postgres' })
  psql(`CREATE TABLE observer_dead (n int, padding text) WITH (autovacuum_vacuum_threshold=0, autovacuum_vacuum_scale_factor=0, autovacuum_vacuum_cost_delay=20, autovacuum_vacuum_cost_limit=1); ALTER TABLE observer_dead OWNER TO apollo_e2e; INSERT INTO observer_dead SELECT n, repeat('x', 900) FROM generate_series(1, 8000) n; UPDATE observer_dead SET padding=repeat('y', 900)`, { user: 'apollo_e2e' })
  const sql = guardSql()
  let worker
  const until = Math.min(deadline - 15_000, Date.now() + 55_000)
  while (Date.now() < until) {
    const rows = psql(`SELECT pid,backend_type FROM pg_stat_activity WHERE datname='${db}' AND backend_type='autovacuum worker'`)
    if (rows) { worker = rows; break }
    await sleep(150)
  }
  assert.ok(worker, 'no actual autovacuum worker observed in owned database')
  const [workerPid, workerType] = worker.split('|')
  assert.equal(workerType, 'autovacuum worker')
  const active = psql(`SELECT backend_type FROM pg_stat_activity WHERE pid=${workerPid} AND datname='${db}'`)
  assert.equal(active, 'autovacuum worker', 'worker ended before guard sample')
  const internal = counts(sql)
  console.log(JSON.stringify({ phase: 'autovacuum', backend_type: active, counts: internal, workerObserved: true }))
  assert.equal(internal[3], 0, 'real internal backend must not be counted as stranger')
  assert.ok(internal[0] >= 1 && internal[0] * 2 <= internal[1], 'total/capacity invariant')

  // Real connections: owned exact, unnamed, wrong run/case/prefix and wrong role.
  const cases = [
    ['ours', 'apollo_e2e', app, 1, 0],
    ['unnamed', 'apollo_e2e', '', 0, 1],
    ['other-run', 'apollo_e2e', `${app}-other`, 0, 1],
    ['wrong-case', 'apollo_e2e', app.toUpperCase(), 0, 1],
    ['wrong-prefix', 'apollo_e2e', `prefix-${app}`, 0, 1],
    ['wrong-role', 'postgres', app, 0, 1],
  ]
  for (const [label, user, application, ours, strangers] of cases) {
    await closeClients()
    const pid = await awaitClient(user, application)
    const type = psql(`SELECT backend_type FROM pg_stat_activity WHERE pid=${pid}`)
    assert.equal(type, 'client backend')
    const result = counts(sql)
    console.log(JSON.stringify({ phase: label, backend_type: type, counts: result }))
    assert.equal(result[2], ours, `${label}: ours`)
    assert.equal(result[3], strangers, `${label}: strangers`)
  }
  await closeClients()
  assert.equal(Number(psql(`SELECT count(*) FROM pg_stat_activity WHERE datname='${db}' AND application_name='${app}' AND pid<>pg_backend_pid()`)), 0, 'orphan proof')
  // pg_stat_activity is not restricted to clients. Synthetic rows exercise impossible
  // backend_type NULL/unknown and SQL NULL semantics in actual PostgreSQL (not a JS mock).
  const source = 'from pg_stat_activity'
  assert.ok(sql.endsWith(source), 'guard query shape changed; adapt regression explicitly')
  const fixture = (type, user, application, pid = 'pg_backend_pid()+1') => {
    const value = (s) => s === null ? 'NULL' : `'${s.replaceAll("'", "''")}'`
    const rows = `(values (${pid}, ${value(db)}, ${value(type)}, ${value(user)}, ${value(application)})) as pg_stat_activity(pid,datname,backend_type,usename,application_name)`
    return counts(sql.slice(0, -source.length) + `from ${rows}`)
  }
  for (const [type, user, application, expected, pid] of [
    ['autovacuum worker', 'postgres', '', 0], ['parallel worker', 'postgres', '', 0],
    ['client backend', 'apollo_e2e', null, 1], ['client backend', 'apollo_e2e', '', 1],
    ['client backend', 'postgres', app, 1], [null, 'postgres', '', 1], ['novel backend', 'postgres', '', 1],
    [null, 'postgres', '', 1, 'NULL::integer'], ['novel backend', 'postgres', '', 1, 'NULL::integer'],
  ]) {
    const result = fixture(type, user, application, pid)
    console.log(JSON.stringify({ phase: 'sql-values', backend_type: type, pid: pid === 'NULL::integer' ? 'NULL' : 'synthetic', application: application === null ? 'NULL' : application === '' ? 'empty' : 'named', counts: result }))
    assert.equal(result[3], expected, `synthetic ${type}/${user}/${application}/pid=${pid}`)
  }
  proofComplete = true
} finally {
  let clientError
  try { await closeClients() } catch (error) { clientError = error }
  let stopError
  try {
    if (cluster?.owned) {
      const result = await cluster.stop()
      const free = await probeClosedPort(cluster.port)
      const dead = !(await processIsAlive(postmasterPid))
      assert.ok(result.stopped && free && dead, `cluster cleanup incomplete: ${JSON.stringify({ result, free, dead })}`)
      assert.equal(existsSync(cluster.dataDirectory), false, 'cluster data dir persists')
      if (!clientError) console.log(JSON.stringify({ phase: 'cleanup', portFree: free, postmasterDead: dead, directoryRemoved: true, clientCount: clients.length }))
    }
  } catch (error) {
    stopError = error
  } finally {
    if (!clientError && !stopError &&
      (cluster?.owned && !existsSync(cluster.dataDirectory) || startupError?.ownedTeardownVerified === true)) {
      try {
        await rm(scratch, { recursive: true, force: true })
        assert.equal(existsSync(scratch), false, 'scratch directory persists')
      } catch (error) {
        if (startupError) startupError.message += '\ncaller scratch cleanup inconclusive; evidence retained'
        else stopError = error
      }
    }
  }
  if (startupError) {
    if (clientError || stopError) startupError.message += '\ncaller cleanup inconclusive; scratch retained'
    // The startup failure, with its bounded log tail, remains the reported exception.
  } else {
    if (clientError) throw clientError
    if (stopError) throw stopError
  }
  if (proofComplete) console.log(JSON.stringify({ phase: 'green', port: cluster.port, postmasterPid }))
}
