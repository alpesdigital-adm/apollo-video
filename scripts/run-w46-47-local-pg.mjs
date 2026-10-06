import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { startRuntimeSafetyCluster } from '../tests/v2/helpers/runtime-safety-world.mjs'

const exec = promisify(execFile)
const scratchDir = await mkdtemp(join(tmpdir(), 'apollo-w46-47-pg-'))
const runId = `w46-47-${process.pid}`
const port = Number(process.env.APOLLO_TEST_PG_PORT ?? 55575)
const syntheticJourney = process.argv.some((argument) => argument.endsWith('synthetic-wave24-journey.e2e.mjs'))
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, 'APOLLO_TEST_PG_PORT must be a valid unprivileged port')
let cluster
let observer
let failure
try {
  cluster = await startRuntimeSafetyCluster({ scratchDir, runId }, { freePort: async () => port })
  assert.equal(cluster.owned, true)
  const url = new URL(cluster.baseUrl)
  url.searchParams.set('application_name', syntheticJourney ? `apollo-video-e2e-synthetic-wave24-${runId}` : `apollo-video-e2e-${runId}`)
  url.searchParams.set('connection_limit', syntheticJourney ? '1' : '2')
  url.searchParams.set('pool_timeout', '10')
  url.searchParams.set('connect_timeout', '10')
  const { PrismaClient } = await import('../generated/prisma-v2/index.js')
  const observerApplication = `apollo-video-e2e-observer-${randomUUID().slice(0, 8)}`
  const observerUrl = new URL(url)
  observerUrl.searchParams.set('application_name', observerApplication)
  observer = new PrismaClient({ datasources: { db: { url: observerUrl.toString() } } })
  const activity = await observer.$queryRawUnsafe('SELECT application_name FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()')
  assert.deepEqual(activity, [])
  await observer.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS vector')
  const env = { ...process.env, V2_DATABASE_URL: url.toString(), APOLLO_LIBRARY_OBSERVER_APPLICATION_NAME: observerApplication,
    ...(syntheticJourney ? { APOLLO_SYNTHETIC_WAVE24_JOURNEY_E2E: '1', APOLLO_WAVE24_RUN_ID: runId,
      APOLLO_WAVE24_EVIDENCE_ROOT: process.env.APOLLO_WAVE24_EVIDENCE_ROOT ?? join(tmpdir(), 'apollo-w55-58-synthetic-proof') } : {}) }
  await exec(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'prisma/v2/schema.prisma'], { env, timeout: 600_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
  const command = process.argv.slice(2)
  assert.ok(command.length, 'Pass a Node test file path')
  const result = await exec(process.execPath, ['--experimental-transform-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--test', ...command], { env, timeout: syntheticJourney ? 1_500_000 : 600_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
  process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  const remaining = await observer.$queryRawUnsafe('SELECT application_name FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()')
  assert.deepEqual(remaining, [])
} catch (error) {
  failure = error
  if (error?.stdout) process.stdout.write(error.stdout)
  if (error?.stderr) process.stderr.write(error.stderr)
  process.stderr.write(`${String(error?.stack ?? error)}\n`)
} finally {
  if (observer) await observer.$disconnect().catch((error) => { failure ??= error })
  if (cluster) {
    const stopped = await cluster.stop().catch((error) => ({ stopped: false, error: String(error) }))
    process.stdout.write(`${JSON.stringify({ runId, port: cluster.port, clusterStop: stopped })}\n`)
    if (!stopped.stopped) failure ??= new Error('Owned PostgreSQL cluster did not stop')
  }
  if (!failure) await rm(scratchDir, { recursive: true, force: true })
}
if (failure) process.exitCode = 1
