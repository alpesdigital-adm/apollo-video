import assert from 'node:assert/strict'
import test from 'node:test'

const availabilityNamespace = await import('../../src/v2/infrastructure/live-avatar-evidence-availability.ts')
const availabilityExports = availabilityNamespace.default ?? availabilityNamespace
const { createLiveAvatarEvidenceAvailability } = availabilityExports
assert.equal(typeof createLiveAvatarEvidenceAvailability, 'function')

function required(name) {
  const value = process.env[name]?.trim()
  assert.ok(value, `${name} is required for the canonical live harness`)
  return value
}

async function api(baseUrl, token, path, init = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    signal: AbortSignal.timeout(120_000),
  })
  const body = await response.json()
  assert.ok(response.ok, `${init.method ?? 'GET'} ${path} failed ${response.status}/${body?.error?.code ?? 'UNKNOWN'}`)
  return body.data
}

/**
 * The live gate deliberately stops before TTS, avatar submission, credentials,
 * budget reservation or catalog selection. A canonical API + provider-worker
 * execution can only be enabled after the runtime has a measured live output
 * speech/identity evaluator; transport marked `live` is not that evidence.
 */
test('T-FR-101 live provider preflight refuses before every paid call while output evaluation is unavailable', async () => {
  const previousFetch = globalThis.fetch
  let networkCalls = 0
  globalThis.fetch = async () => {
    networkCalls += 1
    throw new Error('live preflight must not reach the network')
  }
  try {
    const availability = createLiveAvatarEvidenceAvailability({
      APOLLO_V2_PROVIDER_LIVE_SMOKE: '1',
      APOLLO_V2_ELEVENLABS_API_KEY: 'must-not-be-read',
      APOLLO_V2_HEYGEN_API_KEY: 'must-not-be-read',
    })
    assert.equal(
      await availability.isAvailable({ adapterId: 'heygen-v3', adapterVersion: '3.0.0', operation: 'audio-avatar' }),
      false,
    )
    assert.equal(networkCalls, 0)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('T-FR-101 paid live contract stays explicitly pending instead of using adapter-direct smoke as gate', {
  skip: process.env.APOLLO_V2_PROVIDER_LIVE_SMOKE !== '1' && 'explicit live authorization is required',
}, async () => {
  const availability = createLiveAvatarEvidenceAvailability(process.env)
  assert.equal(
    await availability.isAvailable({ adapterId: 'heygen-v3', adapterVersion: '3.0.0', operation: 'audio-avatar' }),
    true,
    'live output speech and identity evaluator is unavailable; refusing before credentials, estimate, TTS or avatar spend',
  )

  // Every durable identity is supplied explicitly from an already approved,
  // currently consented profile/audio master. No catalog-first selection and
  // no fixture-created consent is allowed in a live run.
  const baseUrl = required('APOLLO_V2_PROVIDER_LIVE_API_BASE_URL')
  const token = required('APOLLO_V2_PROVIDER_LIVE_API_TOKEN')
  const projectId = required('APOLLO_V2_PROVIDER_LIVE_PROJECT_ID')
  const projectVersionId = required('APOLLO_V2_PROVIDER_LIVE_PROJECT_VERSION_ID')
  const projectVersionHash = required('APOLLO_V2_PROVIDER_LIVE_PROJECT_VERSION_HASH')
  const profileSnapshotId = required('APOLLO_V2_PROVIDER_LIVE_PROFILE_SNAPSHOT_ID')
  const audioMasterId = required('APOLLO_V2_PROVIDER_LIVE_AUDIO_MASTER_ID')
  const audioArtifactId = required('APOLLO_V2_PROVIDER_LIVE_AUDIO_ARTIFACT_ID')
  const adapterId = required('APOLLO_V2_PROVIDER_LIVE_AVATAR_ADAPTER_ID')
  const adapterVersion = required('APOLLO_V2_PROVIDER_LIVE_AVATAR_ADAPTER_VERSION')
  const use = required('APOLLO_V2_PROVIDER_LIVE_USE')
  const market = required('APOLLO_V2_PROVIDER_LIVE_MARKET')
  const locale = required('APOLLO_V2_PROVIDER_LIVE_LOCALE')
  const runId = required('APOLLO_V2_PROVIDER_LIVE_RUN_ID')
  const maximumCostMinorUnits = Number(required('APOLLO_V2_PROVIDER_LIVE_MAXIMUM_COST_MINOR_UNITS'))
  const endWordIndex = Number(required('APOLLO_V2_PROVIDER_LIVE_AUDIO_END_WORD_INDEX'))
  const databaseUrl = new URL(required('V2_DATABASE_URL'))
  const apiUrl = new URL(baseUrl)
  assert.ok(Number.isSafeInteger(maximumCostMinorUnits) && maximumCostMinorUnits >= 0)
  assert.ok(Number.isSafeInteger(endWordIndex) && endWordIndex > 0)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname), 'live harness database must be disposable and local')
  assert.match(databaseUrl.pathname, /_e2e$/, 'live harness database must have an _e2e name')
  assert.match(databaseUrl.searchParams.get('application_name') ?? '', /^apollo-video-e2e-[A-Za-z0-9_-]+$/)
  for (const [name, maximum] of [['connection_limit', 5], ['pool_timeout', 10], ['connect_timeout', 10]]) {
    const value = Number(databaseUrl.searchParams.get(name))
    assert.ok(Number.isSafeInteger(value) && value >= 1 && value <= maximum, `${name} exceeds the disposable harness bound`)
  }
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(apiUrl.hostname), 'live harness API must be an isolated local process')
  assert.match(runId, /^[A-Za-z0-9_-]{8,80}$/)

  const [{ PrismaClient }, factory, postgres] = await Promise.all([
    import('../../generated/prisma-v2/index.js'),
    import('../../src/v2/infrastructure/repository-factory.ts'),
    import('../../src/v2/infrastructure/prisma-postgres/client.ts'),
  ])
  const inspection = new PrismaClient({ datasourceUrl: databaseUrl.toString() })
  let jobId = null
  let observed = null
  const terminal = new Set(['approved', 'rejected', 'failed', 'cancelled'])
  try {
    const foreignQueue = await inspection.v2ProviderJob.count({ where: { status: { notIn: [...terminal] } } })
    assert.equal(foreignQueue, 0, 'isolated live harness database contains a foreign claimable provider job')
    const idempotencyKey = `provider-live-avatar-${runId}`
    const enqueued = await api(baseUrl, token, `/v1/projects/${encodeURIComponent(projectId)}/provider-jobs`, {
      method: 'POST', headers: { 'idempotency-key': idempotencyKey }, body: JSON.stringify({
        projectVersionId, profileSnapshotId, operation: 'audio-avatar', adapterId, adapterVersion,
        providerInput: { aspectRatio: '9:16' }, sourceArtifactIds: [audioArtifactId], audioMasterId,
        audioRange: { startWordIndex: 0, endWordIndex }, use, market, locale,
      }),
    })
    jobId = enqueued.job.id
    assert.equal(await inspection.v2ProviderJob.count({ where: { status: { notIn: [...terminal] } } }), 1)
    const worker = factory.createProviderJobWorker(process.env)
    const workerOwner = `provider-live-${runId}`

    // One and only one job was claimable before this tick. Verify that the
    // tick estimated this exact job and did not submit it before the cap check.
    await worker(`${workerOwner}-estimate`)
    observed = (await api(baseUrl, token, `/v1/projects/${encodeURIComponent(projectId)}/provider-jobs/${encodeURIComponent(jobId)}`)).job
    assert.equal(observed.status, 'estimated', 'first live worker tick was not estimate-only for the owned job')
    assert.ok(observed.estimate, 'live provider job did not persist its estimate before submission')
    assert.equal(observed.estimate.currency, 'BRL')
    assert.ok(observed.estimate.costMinorUnits <= maximumCostMinorUnits, 'live estimate exceeds the explicitly authorized cap')

    const deadline = Date.now() + 20 * 60_000
    for (let tick = 0; tick < 40 && Date.now() < deadline && !terminal.has(observed.status); tick += 1) {
      await worker(`${workerOwner}-${tick}`)
      observed = (await api(baseUrl, token, `/v1/projects/${encodeURIComponent(projectId)}/provider-jobs/${encodeURIComponent(jobId)}`)).job
      if (!terminal.has(observed.status)) await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    assert.ok(terminal.has(observed.status), `live avatar job did not reach terminal state before deadline: ${observed.status}`)
    assert.equal(observed.status, 'approved', `live avatar job ended ${observed.status}`)
    assert.ok(observed.resultArtifact, 'live worker did not persist its canonical result artifact')

    const gate = await api(baseUrl, token, `/v1/projects/${encodeURIComponent(projectId)}/synthetic-phase-gates`, {
      method: 'POST', headers: { 'idempotency-key': `provider-live-gate-${runId}` },
      body: JSON.stringify({ projectVersionId, projectVersionHash }),
    })
    assert.equal(gate.gate?.report?.approved, true, 'canonical collector did not approve the persisted live execution evidence')
  } finally {
    // No public generic cancellation contract exists. Stop admission by never
    // ticking again; the isolated E2E owner tears down this database only after
    // the persisted owned job is terminal or reported as the cleanup blocker.
    let ownedCleanupBlocker = null
    if (jobId) {
      const stored = await inspection.v2ProviderJob.findFirst({ where: { id: jobId }, select: { status: true, leaseOwner: true } })
      if (stored && !terminal.has(stored.status)) ownedCleanupBlocker = `owned live job requires isolated-run cleanup: ${stored.status}/${stored.leaseOwner ?? 'unclaimed'}`
    }
    const disconnected = await Promise.allSettled([inspection.$disconnect(), postgres.disconnectV2PostgresClient()])
    const disconnectFailures = disconnected.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
    if (disconnectFailures.length > 0) throw new AggregateError(disconnectFailures, 'live harness database disconnect failed')
    if (ownedCleanupBlocker) assert.fail(ownedCleanupBlocker)
  }
})
