import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

const TERMINAL_JOB_STATUSES = new Set(['approved', 'rejected', 'failed', 'cancelled'])

function boundedString(value, field, maximum = 256) {
  assert.equal(typeof value, 'string', `${field} must be a string`)
  const normalized = value.trim()
  assert.ok(normalized.length > 0 && normalized.length <= maximum, `${field} must be bounded`)
  return normalized
}

async function responseJson(response, label) {
  let body
  try { body = await response.json() } catch { assert.fail(`${label} returned non-JSON status ${response.status}`) }
  assert.ok(response.ok, `${label} failed with ${response.status}/${body?.error?.code ?? 'UNKNOWN'}`)
  assert.ok(body && typeof body === 'object' && body.data && typeof body.data === 'object', `${label} returned no data envelope`)
  return body.data
}

async function apiRequest({ baseUrl, bearerToken, path, method = 'GET', body, idempotencyKey, signal, label }) {
  assert.ok(signal instanceof AbortSignal, 'signal is required')
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      authorization: `Bearer ${bearerToken}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal,
  })
  return responseJson(response, label)
}

/**
 * Exercises the public fallback dispatch against an already rejected ledger.
 *
 * `workerTick` owns the controlled provider worker and must return the durable
 * evidence it observes (`ledger`, `receipt`, and `claim`). `approveReview`
 * owns the authenticated human action; this helper never manufactures that
 * identity or writes an approval directly.
 */
export async function runControlledTransformationFallback(input) {
  const baseUrl = boundedString(input.baseUrl, 'baseUrl', 2_048)
  const bearerToken = boundedString(input.bearerToken, 'bearerToken', 8_192)
  const projectId = boundedString(input.projectId, 'projectId')
  const ledgerId = boundedString(input.ledgerId, 'ledgerId')
  const ledgerHash = boundedString(input.ledgerHash, 'ledgerHash', 64)
  assert.match(ledgerHash, /^[a-f0-9]{64}$/, 'ledgerHash must be SHA-256')
  const idempotencyKey = boundedString(input.idempotencyKey, 'idempotencyKey', 128)
  assert.ok(idempotencyKey.length >= 8, 'idempotencyKey must contain at least 8 characters')
  assert.equal(typeof input.workerTick, 'function', 'workerTick is required')
  assert.equal(typeof input.approveReview, 'function', 'approveReview is required')
  assert.ok(input.signal instanceof AbortSignal, 'signal is required')

  const dispatchPath = `/v1/projects/${encodeURIComponent(projectId)}/transformation-fallback-ledgers/${encodeURIComponent(ledgerId)}/dispatches`
  const dispatchBody = Object.freeze({
    expectedLedgerHash: ledgerHash,
    use: boundedString(input.use, 'use', 128),
    market: boundedString(input.market, 'market', 64),
    locale: boundedString(input.locale, 'locale', 35),
  })
  const dispatch = await apiRequest({
    baseUrl, bearerToken, path: dispatchPath, method: 'POST', body: dispatchBody,
    idempotencyKey, signal: input.signal, label: 'fallback dispatch',
  })
  assert.equal(dispatch.outcome, 'enqueued', 'controlled fallback must enqueue generated-cutaway')
  assert.equal(dispatch.job?.operation, 'generated-cutaway')
  assert.equal(dispatch.job?.transformation?.fallback?.ledgerId, ledgerId)
  assert.equal(dispatch.job?.transformation?.fallback?.ledgerHash, ledgerHash)
  const jobId = boundedString(dispatch.job.id, 'dispatch.job.id')

  const dispatchReplay = await apiRequest({
    baseUrl, bearerToken, path: dispatchPath, method: 'POST', body: dispatchBody,
    idempotencyKey, signal: input.signal, label: 'fallback dispatch replay',
  })
  assert.ok(['enqueued', 'replayed'].includes(dispatchReplay.outcome), 'dispatch replay returned an unsupported outcome')
  assert.equal(dispatchReplay.job?.id, jobId, 'dispatch replay created another provider job')

  let fallbackJob = dispatch.job
  let fallbackLedger = null
  let receipt = null
  let claim = null
  for (let iteration = 0; iteration < 24 && !TERMINAL_JOB_STATUSES.has(fallbackJob.status); iteration += 1) {
    const observed = await input.workerTick({ projectId, jobId, iteration, signal: input.signal })
    if (observed?.ledger) fallbackLedger = observed.ledger
    if (observed?.receipt) receipt = observed.receipt
    if (observed?.claim) claim = observed.claim
    const read = await apiRequest({
      baseUrl, bearerToken,
      path: `/v1/projects/${encodeURIComponent(projectId)}/transformation-jobs/${encodeURIComponent(jobId)}`,
      signal: input.signal, label: 'fallback job read',
    })
    fallbackJob = read.job
  }
  assert.equal(fallbackJob.status, 'approved', `controlled fallback ended ${fallbackJob.status}`)
  assert.ok(fallbackJob.resultArtifact, 'approved fallback has no canonical result artifact')
  assert.ok(fallbackLedger, 'worker did not expose the durable fallback result ledger')
  assert.ok(receipt, 'worker did not expose the canonical provider execution receipt')
  assert.ok(claim, 'worker did not expose the settled fallback dispatch claim')
  assert.equal(claim.providerJobId, jobId)
  assert.equal(claim.outcome, 'enqueued')

  const approval = await input.approveReview({
    projectId,
    ledger: fallbackLedger,
    action: 'accept',
    signal: input.signal,
  })
  assert.equal(approval?.ledger?.reviewDecision, 'accepted', 'human review did not accept the fallback ledger')

  return Object.freeze({
    dispatch,
    dispatchReplay,
    fallbackJob,
    fallbackResult: fallbackJob.resultArtifact,
    receipt,
    claim,
    approval,
  })
}

/**
 * Prepares the complete controlled stylization ladder before the Next process
 * starts. The returned environment is the only bridge into the production
 * factory; the provider remains a loopback HTTP boundary and never becomes a
 * test-only registry bypass.
 */
export async function prepareControlledTransformationFallbackFixture(input) {
  assert.ok(input.signal instanceof AbortSignal, 'signal is required')
  assert.equal(input.actor?.workspaceId, input.workspaceId)
  const suffix = input.runId ?? randomUUID().slice(0, 12)
  const adapterId = `controlled-cutaway-${suffix}`
  const rejectedPath = join(input.workRoot, `fallback-rejected-${suffix}.mp4`)
  const approvedPath = join(input.workRoot, `fallback-approved-${suffix}.mp4`)
  execFileSync(ffmpegPath, ['-v', 'error', '-i', input.sourcePath, '-vf', 'hue=s=0.65', '-af', 'atrim=duration=0.8', '-c:v', 'libx264', '-c:a', 'aac', '-y', rejectedPath], { windowsHide: true, timeout: 120_000 })
  execFileSync(ffmpegPath, ['-v', 'error', '-i', input.sourcePath, '-vf', 'hue=s=0.65', '-c:v', 'libx264', '-c:a', 'aac', '-y', approvedPath], { windowsHide: true, timeout: 120_000 })
  const outputs = [await readFile(rejectedPath), await readFile(approvedPath)]
  const submissions = new Map()
  const sockets = new Set()
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/capabilities') return void response.end(JSON.stringify({ minSeconds: 1, maxSeconds: 600 }))
      if (request.method === 'POST' && request.url === '/transformations') {
        let raw = ''
        for await (const chunk of request) raw += chunk
        const body = JSON.parse(raw)
        assert.ok(['video-to-video', 'generated-cutaway'].includes(body.operation))
        const ref = `controlled-fallback-ref-${submissions.size + 1}-${suffix}`
        submissions.set(ref, { polls: 0, bytes: outputs[submissions.size] })
        response.statusCode = 202
        response.setHeader('content-type', 'application/json')
        return void response.end(JSON.stringify({ providerJobId: ref }))
      }
      const ref = [...submissions.keys()].find((candidate) => request.url?.includes(candidate))
      const stored = ref ? submissions.get(ref) : null
      if (!stored) { response.statusCode = 404; return void response.end('{}') }
      response.setHeader('content-type', 'application/json')
      if (request.url.endsWith('/result')) return void response.end(JSON.stringify({
        mediaBase64: stored.bytes.toString('base64'), mediaSha256: sha256(stored.bytes),
        observedCost: { currency: 'BRL', costMinorUnits: 1 },
      }))
      stored.polls += 1
      return void response.end(JSON.stringify({ status: stored.polls === 1 ? 'processing' : 'completed' }))
    } catch {
      response.statusCode = 500
      response.end('{}')
    }
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  let closed = false
  const closeServer = async () => {
    if (closed) return
    closed = true
    input.signal.removeEventListener('abort', abortListener)
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
  const abortListener = () => { void closeServer() }
  input.signal.addEventListener('abort', abortListener, { once: true })
  try {
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const providerBaseUrl = `http://127.0.0.1:${address.port}`

  const [{ createTransformationBrief }, { createNoveltyBudgetPolicy, createNoveltyBudgetDecision, DEFAULT_NOVELTY_BUDGET_POLICY }, registryApp, jobsApp, workerApp, qualityApp, registryModule, qualityModule, jobsModule, provenanceModule, resultsModule, artifactsModule, projectsModule, noveltyModule, rightsModule, materializerModule, adapterModule, criticModule, ingestionModule, audioModule, probeModule] = await Promise.all([
    import('../../../src/v2/domain/transformation-brief.ts'),
    import('../../../src/v2/domain/novelty-budget.ts'),
    import('../../../src/v2/application/transformation-provider-registry.ts'),
    import('../../../src/v2/application/transformation-jobs.ts'),
    import('../../../src/v2/application/provider-jobs.ts'),
    import('../../../src/v2/application/transformation-quality.ts'),
    import('../../../src/v2/infrastructure/prisma/transformation-provider-registry-repository.ts'),
    import('../../../src/v2/infrastructure/prisma/transformation-quality-repository.ts'),
    import('../../../src/v2/infrastructure/prisma/provider-job-repository.ts'),
    import('../../../src/v2/infrastructure/prisma/provider-execution-provenance-repository.ts'),
    import('../../../src/v2/infrastructure/prisma/provider-result-artifact-repository.ts'),
    import('../../../src/v2/infrastructure/prisma/media-artifact-repository.ts'),
    import('../../../src/v2/infrastructure/prisma/project-workspace-query-repository.ts'),
    import('../../../src/v2/infrastructure/prisma/novelty-budget-repository.ts'),
    import('../../../src/v2/infrastructure/prisma/asset-rights-repository.ts'),
    import('../../../src/v2/infrastructure/provider-submission-input-materializer.ts'),
    import('../../../src/v2/infrastructure/transformation/http-transformation-provider.ts'),
    import('../../../src/v2/infrastructure/transformation/ffmpeg-transformation-critic.ts'),
    import('../../../src/v2/infrastructure/transformation/transformation-result-ingestion.ts'),
    import('../../../src/v2/infrastructure/media/ffmpeg-avatar-audio-comparison.ts'),
    import('../../../src/v2/infrastructure/media/video-probe.ts'),
  ])
  const registry = new registryModule.PrismaTransformationProviderRegistryRepository(input.client)
  const quality = new qualityModule.PrismaTransformationQualityRepository(input.client)
  const jobs = new jobsModule.PrismaProviderJobRepository(input.client)
  const artifacts = new artifactsModule.PrismaMediaArtifactRepository(input.client)
  const novelty = new noveltyModule.PrismaNoveltyBudgetRepository(input.client)
  const rights = new rightsModule.PrismaAssetRightsRepository(input.client)
  const createdAt = new Date().toISOString()
  const capability = (operation) => ({ id: `${adapterId}-${operation}`, operation, capabilityVersion: '1.0.0', modes: ['stylization'], regions: ['br'], maximumDurationFrames: 18_000, maximumWidth: 3840, maximumHeight: 2160, supportsAudio: true, price: { currency: 'BRL', fixedMinorUnits: 1, perSecondMinorUnits: 0 }, qualityScoreBps: 9_000, dataRetention: 'transient' })
  await registryApp.registerTransformationProviderService({ repository: registry, provider: { id: adapterId, workspaceId: input.workspaceId, displayName: 'Controlled generated cutaway', adapterId, adapterVersion: '1.0.0', transport: 'api', credentialRef: `controlled/${adapterId}`, enabled: true, capabilities: [capability('video-to-video'), capability('generated-cutaway')], createdAt, updatedAt: createdAt } })
  await registryApp.recordTransformationProviderHealthService({ repository: registry, health: { providerId: adapterId, workspaceId: input.workspaceId, status: 'healthy', circuitState: 'closed', consecutiveFailures: 0, observedLatencyMs: 1, observedAt: createdAt } })
  const sourceProbe = await probeModule.probeVideo(input.sourcePath, { requireAudio: true })
  const durationFrames = Math.max(1, Math.round(sourceProbe.duration * sourceProbe.fps))
  const brief = createTransformationBrief({
    workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: input.projectVersionId,
    storyPlanId: `controlled-fallback-story-${suffix}`, storyPlanHash: sha256(`story:${suffix}`),
    sourceArtifactId: input.sourceArtifact.id, sourceArtifactHash: input.sourceArtifact.sha256,
    sourceRange: { startFrame: 0, endFrame: durationFrames }, intent: 'stylized-cutaway',
    editorialIntent: 'Create a stylized cutaway while preserving the complete approved speech and timing.',
    mode: 'stylization', prompt: 'Measured controlled stylization.', negativeConstraints: ['do not replace or truncate speech'],
    preserve: ['audio', 'speech', 'timing'], allowedChanges: ['visual style'], target: { style: 'controlled-muted' },
    outputSpecIds: ['controlled-fallback-output'], intensityBps: 2_000, noveltyBps: 1_000, safety: ['audio-locked'], safeZones: [],
    fallbackLadder: ['video-to-video', 'generated-cutaway', 'source-unchanged'],
    rightsSnapshotId: input.sourceArtifact.rightsSnapshotId, rightsSnapshotHash: input.sourceArtifact.rightsSnapshotHash,
    identitySnapshotId: `controlled-fallback-identity-${suffix}`, identitySnapshotHash: sha256(`identity:${suffix}`), createdAt,
  })
  await registryApp.persistTransformationBriefService({ repository: registry, brief })
  const selection = await registryApp.routeTransformationBriefService({ repository: registry, workspaceId: input.workspaceId, projectId: input.projectId, briefId: brief.id, policy: { region: 'br', maximumCostMinorUnits: 100, minimumQualityScoreBps: 8_000, output: { width: sourceProbe.width, height: sourceProbe.height, includeAudio: true, fps: sourceProbe.fps } }, createdAt })
  const policy = createNoveltyBudgetPolicy({ ...DEFAULT_NOVELTY_BUDGET_POLICY, id: `controlled-fallback-policy-${suffix}` })
  await novelty.persistPolicy({ workspaceId: input.workspaceId, policy, createdAt })
  const noveltyDecision = createNoveltyBudgetDecision({ workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: input.projectVersionId, treatmentPlanId: `controlled-fallback-treatment-${suffix}`, storyPlanId: brief.storyPlanId, policy, candidates: [{ id: `controlled-fallback-candidate-${suffix}`, briefId: brief.id, mode: brief.mode, intensityBps: brief.intensityBps, startFrame: 0, endFrame: durationFrames, fps: sourceProbe.fps, servedFromCache: false }], evaluatedAt: createdAt })
  await novelty.persistDecision({ decision: noveltyDecision, createdAt })
  const adapter = new adapterModule.HttpTransformationProviderAdapter({ id: adapterId, adapterVersion: '1.0.0', baseUrl: providerBaseUrl, apiKey: `controlled-key-${suffix}`, completion: 'polling', modes: ['stylization'], operations: ['video-to-video', 'generated-cutaway'], supportsCancellation: false, priceFixedMinorUnits: 1, currency: 'BRL' })
  const adapters = { get: ({ adapterId: requestedId, adapterVersion }) => requestedId === adapter.id && adapterVersion === adapter.adapterVersion ? adapter : null }
  let sequence = 0
  let clockMs = Date.now()
  const clock = () => new Date(clockMs += 1_000)
  const requestJob = jobsApp.requestTransformationJobService({ jobs, registry, adapters, projects: new projectsModule.PrismaProjectWorkspaceQueryRepository(input.client), artifacts, rights, novelty, clock, createJobId: () => `controlled-fallback-job-${suffix}-${++sequence}`, createTransitionId: () => `controlled-fallback-transition-${suffix}-${++sequence}` })
  const materializer = new materializerModule.AuthorizedProviderSubmissionInputMaterializer({ profiles: { readProfile: async () => null }, artifacts, sources: input.sourceMaterializer })
  const resultArtifacts = new resultsModule.PrismaProviderResultArtifactRepository(input.client)
  const provenance = new provenanceModule.PrismaProviderExecutionProvenanceRepository(input.client, clock)
  const ingestor = new ingestionModule.VerifiedTransformationResultIngestor({ workRoot: input.workRoot, storage: input.storage, artifacts, artifactQuery: artifacts, resultArtifacts, prober: { probe: (path, options) => probeModule.probeVideo(path, { ...options, requireAudio: true }) }, clock })
  const critic = new qualityApp.PersistedTransformationResultCritic({ registry, quality, artifacts, novelty, evaluator: new criticModule.FfmpegTransformationCriticEvaluator({ sources: input.sourceMaterializer, prober: { probe: (path, options) => probeModule.probeVideo(path, { ...options, requireAudio: true }) }, audioComparison: new audioModule.FfmpegAvatarAudioComparison({ ...process.env, FFMPEG_PATH: ffmpegPath }) }), clock })
  const worker = workerApp.runProviderJobWorkerOnce({ jobs, provenance, resultArtifacts, adapters, materializer, ingestor, critic, clock, createLeaseToken: () => `controlled-fallback-lease-${suffix}-${++sequence}`, createTransitionId: () => `controlled-fallback-transition-${suffix}-${++sequence}` })
  const initial = await requestJob({ workspaceId: input.workspaceId, projectId: input.projectId, briefId: brief.id, selectionId: selection.selection.id, use: input.use, market: input.market, locale: input.locale, actor: input.actor, idempotencyKey: `controlled-initial-${suffix}` })
  for (let tick = 0; tick < 12; tick += 1) {
    const persisted = await jobs.read({ workspaceId: input.workspaceId, projectId: input.projectId, jobId: initial.persisted.job.id })
    if (TERMINAL_JOB_STATUSES.has(persisted.job.status)) break
    await worker(`controlled-fallback-worker-${suffix}-${tick}`)
  }
  const rejected = await jobs.read({ workspaceId: input.workspaceId, projectId: input.projectId, jobId: initial.persisted.job.id })
  assert.equal(rejected.job.status, 'rejected', 'controlled first rung must be rejected by measured truncated audio')
  const rejectedLedger = await quality.readLatestFallbackLedger({ workspaceId: input.workspaceId, projectId: input.projectId, briefId: brief.id })
  assert.equal(rejectedLedger.currentRung, 'generated-cutaway')
  const envPrefix = `APOLLO_V2_TRANSFORMATION_${adapterId.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`
  return Object.freeze({
    environment: Object.freeze({ [`${envPrefix}_BASE_URL`]: providerBaseUrl, [`${envPrefix}_API_KEY`]: `controlled-key-${suffix}`, [`${envPrefix}_COMPLETION`]: 'polling', [`${envPrefix}_MODES`]: 'stylization', [`${envPrefix}_OPERATIONS`]: 'video-to-video,generated-cutaway', [`${envPrefix}_ADAPTER_VERSION`]: '1.0.0' }),
    rejectedJob: rejected.job, rejectedLedger,
    async run(runInput) {
      return runControlledTransformationFallback({
        ...runInput, projectId: input.projectId, ledgerId: rejectedLedger.id, ledgerHash: rejectedLedger.ledgerHash,
        use: input.use, market: input.market, locale: input.locale,
        workerTick: async ({ jobId, iteration, signal }) => {
          await worker(`controlled-fallback-worker-${suffix}-dispatch-${iteration}`)
          const [ledger, receipt, claim] = await Promise.all([
            quality.readLatestFallbackLedger({ workspaceId: input.workspaceId, projectId: input.projectId, briefId: brief.id }),
            input.client.v2ProviderExecutionReceipt.findFirst({ where: { workspaceId: input.workspaceId, jobId } }),
            input.client.v2TransformationFallbackDispatchClaim.findFirst({ where: { workspaceId: input.workspaceId, providerJobId: jobId } }),
          ])
          if (signal.aborted) throw signal.reason
          return { ledger, receipt, claim }
        },
      })
    },
    async close() { await closeServer() },
  })
  } catch (error) {
    await closeServer()
    throw error
  }
}
