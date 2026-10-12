import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { closeOwnedBrowser } from './library-browser-proof.mjs'
import { createDashboardPipelineObserver } from './dashboard-w36-pipeline-proof.mjs'
import { seedDashboardControlledExportFixture } from './dashboard-controlled-export-fixture.mjs'

const exec = promisify(execFile)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const CARD_EXPECTATIONS = {
  draft: { tone: 'neutral', color: 'text-[#aaa49a]', badge: 'Configuração', action: 'open-result', button: 'Abrir workspace →' },
  'rendering-proxy': { tone: 'info', color: 'text-[#79a5da]', badge: 'Renderizando proxy', action: 'view-progress', button: 'Acompanhar →' },
  'reviewing-proxy': { tone: 'warning', color: 'text-[#ca92d4]', badge: 'Revisar proxy', action: 'review-output', button: 'Revisar agora →' },
  revising: { tone: 'info', color: 'text-[#79a5da]', badge: 'Aplicando revisão', action: 'view-progress', button: 'Acompanhar →' },
  failed: { tone: 'danger', color: 'text-[#e08b8b]', badge: 'Requer atenção', action: 'inspect-error', button: 'Ver erro →' },
}

/** Real proxy workers and negative final admission; seeded review GUI is explicit. */
export async function runDashboardRuntimeJourney(input) {
  const { client, baseUrl, authorization, workspaceId, projectId, projectVersionId,
    projectVersionHash, directed, actor, sourceArtifactId, sourceManifestId, sourceSha256,
    sourceByteSize, sourceManifest, sourcePath, sourceColorProbe, artifactRoot, uiUsername, uiPassword, suffix, signal, mechanicalSeed } = input
  const directory = process.env.APOLLO_DASHBOARD_RUNTIME_EVIDENCE_ROOT
  assert.ok(directory && isAbsolute(directory), 'Runtime evidence requires an absolute external directory')
  await mkdir(directory, { recursive: true })
  const evidence = { schemaVersion: 'dashboard-real-runtime/v2', runId: suffix, ownerPid: process.pid,
    sourceCommit: process.env.GITHUB_SHA ?? null, states: [], outputs: [], screenshots: [], httpResponses: [],
    browserErrors: [], browserResponses: [],
    proofScope: 'runtime-proxy-and-negative-final-admission', editorialAcceptance: false, faceSafety: 'unknown',
    storedQualityStatus: 'review-required',
    controlledInputs: ['FFmpeg synthetic source bytes', 'aligned transcript', 'initial compiled timeline',
      'source rights', 'source color probe', 'separate seeded blocked review project', 'test-only rejected final approval claim'],
    runtimeProduced: ['public project and proxy admission', 'Director service snapshots/Command/impact/decision log',
      'real main-project proxy worker review', 'public final rejection and PostgreSQL rejection of a controlled approval claim',
      'PostgreSQL states/events/artifacts', 'public retry and version fences'],
    pendingProofs: ['W35 positive final admission with authoritative approved DirectorRun and ready proxy review',
      'W35 real final worker, rendering-final/completed GUI, final MP4 and final replay'],
    governancePolicy: { anomalyRequestMinimum: 400, scope: 'owned E2E server only', productionDefaultChanged: false },
    unmeasuredProgress: { runtimeReachable: false, reason: 'All public operations use a known canonical phase count; historical no-total proof is controlled.' },
    deployed: false, ownerAccepted: false, postflight: {} }
  const { PrismaPublicOperationRepository } = await import('../../../src/v2/infrastructure/prisma/public-operation-repository.ts')
  const factory = await import('../../../src/v2/infrastructure/repository-factory.ts')
  const { createProjectProxyRenderWorker } = factory
  const { PrismaProjectProxyRenderRepository } = await import('../../../src/v2/infrastructure/prisma/project-proxy-render-repository.ts')
  const { PrismaProjectFinalExportRepository } = await import('../../../src/v2/infrastructure/prisma/project-final-export-repository.ts')
  const { PrismaAssetRightsRepository } = await import('../../../src/v2/infrastructure/prisma/asset-rights-repository.ts')
  const { enqueueProjectFinalExportService } = await import('../../../src/v2/application/enqueue-project-final-export.ts')
  const { calculateVersionHash, stableSerialize } = await import('../../../src/v2/application/version-hash.ts')
  const { createProtectedPayloadCipherFromEnvironment } = await import('../../../src/v2/infrastructure/security/recipe-parameter-cipher.ts')
  const { probeVideo } = await import('../../../src/v2/infrastructure/media/video-probe.ts')
  const { resolveFfmpegBinary } = await import('../../../src/v2/infrastructure/media/ffmpeg-binary.ts')
  const prototype = PrismaPublicOperationRepository.prototype
  const originals = { claimNext: prototype.claimNext, advancePhase: prototype.advancePhase }
  let server, browser, context, child, primaryError, pipeline, activeObserver, observationError
  const observeWorker = async (...args) => {
    try { await activeObserver(...args) } catch (error) { observationError = error; throw error }
  }
  const runObservedWorker = async (action) => {
    const result = await action()
    if (observationError) throw observationError
    return result
  }
  const environment = { ...process.env, APOLLO_V2_ARTIFACT_ROOT: artifactRoot, APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local',
    APOLLO_V2_RENDER_LEASE_MS: '120000', APOLLO_V2_RENDER_HEARTBEAT_MS: '5000',
    APOLLO_V2_WORKER_RETRY_BASE_MS: '1', APOLLO_V2_WORKER_RETRY_MAX_MS: '1',
    APOLLO_PROTECTED_PAYLOAD_KEY_ID: 'dashboard-runtime-e2e',
    APOLLO_PROTECTED_PAYLOAD_KEY: Buffer.alloc(32, 7).toString('base64url') }
  const ffmpeg = resolveFfmpegBinary(undefined, environment)
  assert.equal(isAbsolute(ffmpeg), true, 'Resolved FFmpeg binary must be absolute')
  const safeError = (error) => {
    const message = String(error?.message ?? error ?? '')
    const errorKind = /No resource with given identifier|body.*evicted/i.test(message) ? 'BODY_RESOURCE_GONE'
      : /Target page, context or browser has been closed/i.test(message) ? 'TARGET_CLOSED'
        : /Response body is unavailable/i.test(message) ? 'BODY_UNAVAILABLE'
          : /Dashboard response evidence deadline exceeded/i.test(message) ? 'EVIDENCE_DEADLINE' : 'UNKNOWN'
    return { name: /^[A-Za-z0-9_]{1,80}$/.test(error?.name ?? '') ? error.name : null,
      errorKind, messageSha256: sha256(message), messageBytes: Buffer.byteLength(message) }
  }
  const bounded = async (action, timeoutMs) => {
    let timer
    try {
      return await Promise.race([action, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Dashboard response evidence deadline exceeded')), timeoutMs)
      })])
    } finally { clearTimeout(timer) }
  }
  const responseDiagnostic = (text) => {
    let payload
    try { payload = JSON.parse(text) } catch { /* Non-JSON remains identifiable by its byte hash. */ }
    const message = typeof payload?.error?.message === 'string' ? payload.error.message : ''
    return { bodySha256: sha256(text), bodyBytes: Buffer.byteLength(text),
      bodyKind: payload === undefined ? 'non-json' : 'json',
      apiErrorCode: /^[A-Z][A-Z0-9_]+$/.test(payload?.error?.code ?? '') ? payload.error.code : null,
      apiErrorMessageSha256: sha256(message), apiErrorMessageBytes: Buffer.byteLength(message) }
  }
  const readPublicWorkspace = async (id, stage) => {
    const path = `/v1/projects/${id}/workspace`
    const response = await fetch(`${baseUrl}${path}`, { headers: { authorization }, signal: AbortSignal.timeout(30000) })
    const text = await response.text()
    const diagnostic = { stage, method: 'GET', path, status: response.status, ...responseDiagnostic(text) }
    evidence.httpResponses.push(diagnostic)
    assert.equal(response.status, 200, `Public workspace hydration must succeed: ${JSON.stringify(diagnostic)}`)
    assert.equal(diagnostic.bodyKind, 'json', JSON.stringify(diagnostic))
    const payload = JSON.parse(text)
    assert.equal(payload.data.project.id, id)
    return payload.data
  }
  const browserResponseTasks = new Set()
  const browserRequests = new WeakMap()
  // A transport failure belongs to this exact Playwright Request, even when
  // response.finished() never settles after a cancelled RSC transfer.
  const browserRequestFailures = new WeakMap()
  const headerDiagnostics = (headers, names) => Object.fromEntries(names.map((name) => {
    const value = headers[name]
    return [name, value === undefined ? { present: false } : { present: true,
      token: value === '0' || value === '1' ? value : null,
      sha256: sha256(value), bytes: Buffer.byteLength(value) }]
  }))
  const responseOrRequestFailure = (request, action) => bounded(Promise.race([
    action.then((value) => ({ via: 'response', value })),
    browserRequestFailures.get(request).promise,
  ]), 5000)
  const activeBrowserRequests = new Set()
  const browserPages = new WeakMap()
  const browserResponseListeners = []
  const browserOrigin = new URL(baseUrl).origin
  let browserSequence = 0, browserRequestSequence = 0, browserPageSequence = 0, browserActivityAt = performance.now()
  evidence.browserRequests = []; evidence.browserTimeline = []; evidence.browserBarriers = []
  const browserEvent = (event, pageState, record, extra = {}) => {
    browserActivityAt = performance.now()
    const item = { seq: ++browserSequence, at: Date.now(), monotonicMs: browserActivityAt, event,
      pageId: pageState.pageId, navigationId: record?.navigationId ?? pageState.navigationId,
      stage: record?.stage ?? pageState.stage, layout: record?.layout ?? pageState.layout,
      ...(record ? { requestId: record.requestId } : {}), ...extra }
    evidence.browserTimeline.push(item)
    return item.seq
  }
  const markBrowserPage = (opened, stage, layout) => {
    const state = browserPages.get(opened)
    assert.ok(state, 'Browser page must be tracked before an observation')
    state.stage = stage; state.layout = layout
    return state
  }
  const beginBrowserNavigation = (opened, stage, layout, targetPath) => {
    const state = markBrowserPage(opened, stage, layout)
    state.navigationId = `${state.pageId}:navigation-${++state.navigationCount}`
    browserEvent('navigation-intent', state, null, { targetPath })
    return state.navigationId
  }
  const drainBrowserResponses = async ({ opened, navigationId, requiredPaths = [], label = 'finite-browser-barrier' } = {}) => {
    const started = performance.now(), deadline = started + 10000
    const barrier = { label, pageId: opened ? browserPages.get(opened).pageId : null, navigationId: navigationId ?? null,
      startedAt: Date.now(), budgetMs: 10000, requiredPaths: [], status: 'pending' }
    evidence.browserBarriers.push(barrier)
    try {
      while (performance.now() < deadline) {
        const records = evidence.browserRequests.filter((record) => !opened ||
          (record.pageId === barrier.pageId && record.navigationId === navigationId))
        barrier.requiredPaths = typeof requiredPaths === 'function' ? requiredPaths(records) : requiredPaths
        const missing = barrier.requiredPaths.filter((path) => !records.some((record) => record.method === 'GET' &&
          record.origin === browserOrigin && record.path === path && record.transportState === 'finished' && record.bodyState === 'captured'))
        barrier.pendingRequestIds = [...activeBrowserRequests].map((request) => browserRequests.get(request).requestId)
        barrier.pendingBodies = browserResponseTasks.size; barrier.missingPaths = missing
        if (!barrier.pendingRequestIds.length && !barrier.pendingBodies && !missing.length &&
          performance.now() - browserActivityAt >= 350) {
          barrier.status = 'completed'; barrier.completedAt = Date.now(); barrier.completedAtSeq = browserSequence
          return
        }
        const remaining = deadline - performance.now()
        assert.ok(remaining > 0, 'Browser request lifecycle barrier deadline exhausted')
        await delay(Math.min(25, remaining))
      }
      assert.fail(`Browser finite requests/bootstrap did not settle: ${JSON.stringify(barrier)}`)
    } catch (error) { barrier.status = 'failed'; barrier.error = safeError(error); throw error }
  }
  const drainWorkspaceBootstrap = async (opened, navigationId, id) => {
    const prefix = `/v1/projects/${id}`
    const requiredPaths = ['/workspace', '/policy-overrides', '/proof-needs', '/proof-integrity-runs', '/proof-mode-runs']
      .map((path) => prefix + path)
    // These three proof reads mount unconditionally. SyntheticPhaseGatePanel
    // only mounts after the real workspace hydration supplies a version.
    await drainBrowserResponses({ opened, navigationId, label: 'workspace-bootstrap', requiredPaths: (records) => {
      const workspace = records.find((record) => record.path === prefix + '/workspace' && record.bodyState === 'captured')
      return workspace?.workspaceVersionPresent ? [...requiredPaths, prefix + '/synthetic-phase-gates', '/v1/capabilities'] : requiredPaths
    } })
  }
  const post = async (path, body, key, expected) => {
    const response = await fetch(`${baseUrl}${path}`, { method: 'POST',
      headers: { authorization, 'content-type': 'application/json', 'idempotency-key': key },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) })
    const text = await response.text()
    // A missing public route returns Next HTML. Preserve enough evidence to
    // identify it without recording response bodies, credentials or cookies.
    const contentType = (response.headers.get('content-type') ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 128)
    const diagnostic = { method: 'POST', path: new URL(path, baseUrl).pathname,
      responsePath: response.url ? new URL(response.url).pathname : null, status: response.status,
      contentType, redirected: response.redirected, bodyBytes: Buffer.byteLength(text), bodyHash: sha256(text),
      bodyKind: /^\s*<(?:!doctype\s+html|html\b)/i.test(text) ? 'html' : 'other' }
    evidence.httpResponses.push(diagnostic)
    assert.match(contentType, /^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/i,
      `Public API returned a non-JSON response: ${JSON.stringify(diagnostic)}`)
    let payload
    try { payload = JSON.parse(text) } catch {
      diagnostic.jsonParseFailed = true
      throw new Error(`Public API returned invalid JSON: ${JSON.stringify(diagnostic)}`)
    }
    diagnostic.bodyKind = 'json'
    assert.equal(response.status, expected, JSON.stringify({ ...diagnostic, expected,
      apiErrorCode: /^[A-Z][A-Z0-9_]+$/.test(payload?.error?.code ?? '') ? payload.error.code : null }))
    return payload.data
  }
  const annotationScreenshot = async (artifact, name) => {
    const path = join(artifactRoot, ...artifact.artifactKey.split('/'))
    const framePath = join(directory, `${name}.png`)
    await exec(ffmpeg, ['-v', 'error', '-y', '-i', path, '-frames:v', '1', framePath], { windowsHide: true, timeout: 30000 })
    const bytes = await readFile(framePath)
    evidence.screenshots.push({ name: `${name}.png`, origin: 'real-proxy-ffmpeg-frame-0', artifactId: artifact.id, sha256: sha256(bytes) })
    return `data:image/png;base64,${bytes.toString('base64')}`
  }
  try {
    const workspacePayload = await readPublicWorkspace(projectId, 'main-upstream-before-browser')
    evidence.workspacePreflight = { status: 200, projectId,
      currentVersionId: workspacePayload.project.currentVersionId }
    const login = await fetch(`${baseUrl}/v1/session`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: uiUsername, password: uiPassword }), signal: AbortSignal.timeout(30000) })
    assert.equal(login.status, 200, await login.text())
    const cookie = /apollo_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1]
    assert.ok(cookie)
    const { chromium } = await import('playwright-core')
    const executablePath = [process.env.PLAYWRIGHT_CHROME_EXECUTABLE, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((path) => path && existsSync(path))
    assert.ok(executablePath)
    server = await chromium.launchServer({ executablePath, headless: true, timeout: 20000 })
    child = server.process(); evidence.browserPid = child.pid
    browser = await chromium.connect(server.wsEndpoint(), { timeout: 20000 })
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    context.on('page', (opened) => {
      const state = { pageId: `page-${++browserPageSequence}`, navigationId: null, navigationCount: 0,
        stage: 'page-created', layout: 'unassigned' }
      browserPages.set(opened, state)
      opened.on('pageerror', (error) => evidence.browserErrors.push({ kind: 'pageerror', ...safeError(error) }))
      opened.on('console', (message) => {
        if (message.type() === 'error') evidence.browserErrors.push({ kind: 'console-error', ...safeError(message.text()) })
      })
      const onRequest = (request) => {
        const url = new URL(request.url())
        if (request.isNavigationRequest() && state.navigationId === null) {
          state.navigationId = `${state.pageId}:navigation-${++state.navigationCount}`
          browserEvent('automatic-navigation-start', state, null, { path: url.pathname })
        }
        const record = { requestId: `request-${++browserRequestSequence}`, pageId: state.pageId,
          navigationId: state.navigationId, stage: state.stage, layout: state.layout,
          method: request.method(), origin: url.origin,
          path: ['http:', 'https:'].includes(url.protocol) ? url.pathname : 'non-http',
          resourceType: request.resourceType(), isNavigationRequest: request.isNavigationRequest(),
          redirectedFromId: browserRequests.get(request.redirectedFrom())?.requestId ?? null,
          queryClassification: { rscPresent: url.searchParams.has('_rsc') },
          requestHeaderDiagnostics: headerDiagnostics(request.headers(),
            ['rsc', 'next-router-prefetch', 'next-router-segment-prefetch']),
          startedAt: Date.now(), transportState: 'pending', bodyState: 'no-response' }
        let settleFailure
        const failurePromise = new Promise((resolve) => { settleFailure = resolve })
        browserRequestFailures.set(request, { promise: failurePromise, settle: settleFailure })
        browserRequests.set(request, record); activeBrowserRequests.add(request)
        evidence.browserRequests.push(record)
        record.requestAtSeq = browserEvent('request', state, record)
      }
      const onFinished = (request) => {
        const record = browserRequests.get(request)
        if (!record) { evidence.browserErrors.push({ kind: 'untracked-requestfinished', pageId: state.pageId }); return }
        record.transportState = 'finished'; record.finishedAt = Date.now()
        record.finishedAtSeq = browserEvent('requestfinished', state, record,
          { observedNavigationId: state.navigationId })
        activeBrowserRequests.delete(request)
      }
      const onFailed = (request) => {
        const record = browserRequests.get(request)
        if (!record) { evidence.browserErrors.push({ kind: 'untracked-requestfailed', pageId: state.pageId }); return }
        const errorText = request.failure()?.errorText ?? ''
        record.transportState = 'failed'; record.failedAt = Date.now()
        record.networkFailure = { errorCode: /^net::ERR_[A-Z0-9_]{1,80}$/.test(errorText) ? errorText : 'UNKNOWN', ...safeError(errorText) }
        record.failedAtSeq = browserEvent('requestfailed', state, record,
          { observedNavigationId: state.navigationId, errorCode: record.networkFailure.errorCode })
        activeBrowserRequests.delete(request)
        browserRequestFailures.get(request).settle({ via: 'requestfailed',
          diagnostic: record.networkFailure, failedAtSeq: record.failedAtSeq })
        // ERR_ABORTED is diagnostic, never an automatic exemption.
        evidence.browserErrors.push({ kind: 'request-failed', request: record })
      }
      const onResponse = (response) => {
        const request = response.request()
        let record = browserRequests.get(request)
        if (!record) {
          evidence.browserErrors.push({ kind: 'response-without-request', pageId: state.pageId })
          onRequest(request); record = browserRequests.get(request)
        }
        record.status = response.status()
        const responseHeaders = response.headers()
        record.contentType = (responseHeaders['content-type'] ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 128)
        record.responseHeaderDiagnostics = headerDiagnostics(responseHeaders,
          ['x-nextjs-postponed', 'x-nextjs-prerender'])
        record.headersAtSeq = browserEvent('response', state, record, { observedNavigationId: state.navigationId })
        const inspect = response.status() >= 400 || (record.origin === browserOrigin && record.path.startsWith('/v1/'))
        if (inspect) evidence.browserResponses.push(record)
        if (response.status() >= 400) evidence.browserErrors.push({ kind: 'http-error', response: record })
        // The event feed in this UI is finite JSON polling. No SSE contract is
        // mounted here; a new eventsource cannot silently bypass the barrier.
        if (record.resourceType === 'eventsource' || /^text\/event-stream(?:;|$)/i.test(record.contentType)) {
          evidence.browserErrors.push({ kind: 'unexpected-stream-contract', request: record })
        }
        const readBody = inspect && (response.status() >= 400 ||
          /^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/i.test(record.contentType))
        record.bodyState = readBody ? 'pending' : 'non-json-success-not-read'
        const pending = (async () => {
          try {
            const finished = await responseOrRequestFailure(request, response.finished())
            record.responseFinishedVia = finished.via
            if (finished.via === 'requestfailed') {
              record.responseFinishedState = 'failed'; record.responseFinishedError = finished.diagnostic
              record.responseFinishedRequestFailureSeq = finished.failedAtSeq
              record.responseFinishedErrorAtNavigation = state.navigationId
              record.responseFinishedErrorAtSeq = browserEvent('response-finished-requestfailed', state, record,
                { observedNavigationId: state.navigationId, failedAtSeq: finished.failedAtSeq,
                  errorCode: finished.diagnostic.errorCode })
              if (readBody) record.bodyState = 'transport-failed'
              // onFailed already recorded the real gate failure. This correlation
              // prevents a second, artificial response-finished deadline error.
              return
            }
            record.responseFinishedAtSeq = browserEvent('response-finished', state, record,
              { observedNavigationId: state.navigationId, result: finished.value ? 'error' : 'completed' })
            if (finished.value) throw finished.value
            record.responseFinishedState = 'completed'
          } catch (error) {
            record.responseFinishedState = 'failed'; record.responseFinishedError = safeError(error)
            record.responseFinishedErrorAtNavigation = state.navigationId
            record.responseFinishedErrorAtSeq = browserEvent('response-finished-error', state, record,
              { observedNavigationId: state.navigationId, errorKind: record.responseFinishedError.errorKind })
            evidence.browserErrors.push({ kind: 'response-finished-error', response: record })
            return
          }
          if (!readBody) return
          try {
            record.bodyCaptureAtSeq = browserEvent('body-capture-start', state, record,
              { observedNavigationId: state.navigationId })
            const body = await responseOrRequestFailure(request, response.text())
            record.bodySettledVia = body.via
            if (body.via === 'requestfailed') {
              record.bodyState = 'transport-failed'; record.bodyError = body.diagnostic
              record.bodyRequestFailureSeq = body.failedAtSeq
              record.bodyErrorAtNavigation = state.navigationId
              record.bodyErrorAfterNavigationChange = record.navigationId !== state.navigationId
              record.bodyErrorAtSeq = browserEvent('body-requestfailed', state, record,
                { observedNavigationId: state.navigationId, failedAtSeq: body.failedAtSeq,
                  errorCode: body.diagnostic.errorCode })
              return
            }
            const text = body.value
            Object.assign(record, responseDiagnostic(text), { bodyState: 'captured' })
            if (record.path.endsWith('/workspace')) {
              const payload = JSON.parse(text)
              record.workspaceVersionPresent = Boolean(payload.data?.version)
            }
            record.bodyCapturedAtSeq = browserEvent('body-captured', state, record,
              { observedNavigationId: state.navigationId })
          } catch (error) {
            record.bodyState = 'failed'; record.bodyError = safeError(error)
            record.bodyErrorAtNavigation = state.navigationId
            record.bodyErrorAfterNavigationChange = record.navigationId !== state.navigationId
            record.bodyErrorAtSeq = browserEvent('body-failed', state, record,
              { observedNavigationId: state.navigationId, errorKind: record.bodyError.errorKind })
            evidence.browserErrors.push({ kind: 'response-evidence-error', response: record })
          }
        })()
        browserResponseTasks.add(pending)
        void pending.finally(() => browserResponseTasks.delete(pending))
      }
      const onNavigation = (frame) => {
        if (frame !== opened.mainFrame()) return
        browserEvent('navigation-commit', state, null, { path: new URL(frame.url()).pathname })
      }
      const onClose = () => { browserEvent('page-close', state, null) }
      opened.on('request', onRequest)
      opened.on('response', onResponse)
      opened.on('requestfinished', onFinished); opened.on('requestfailed', onFailed)
      opened.on('framenavigated', onNavigation); opened.on('close', onClose)
      browserResponseListeners.push({ opened, handlers: { request: onRequest, response: onResponse,
        requestfinished: onFinished, requestfailed: onFailed, framenavigated: onNavigation, close: onClose } })
    })
    context.setDefaultTimeout(30000); context.setDefaultNavigationTimeout(30000)
    await context.addCookies([{ name: 'apollo_session', value: cookie, url: baseUrl, httpOnly: true, sameSite: 'Lax' }])
    const page = await context.newPage()
    const navigatedStates = new Set()
    const pipelinePage = await context.newPage()
    markBrowserPage(pipelinePage, 'pipeline-bootstrap', 'pipeline')
    pipeline = await createDashboardPipelineObserver({ page: pipelinePage, client, baseUrl, workspaceId, evidenceDir: directory })
    const observe = async ({ stage, id = projectId, operationId, operationStatus, status, phase, completed, eventTypes = [],
      origin = 'public-api+postgres+factory-worker', seededStatus = false }) => {
      const row = await client.v2Project.findUniqueOrThrow({ where: { id } })
      assert.equal(row.status, status, `${stage}: authoritative project status`)
      const response = await fetch(`${baseUrl}/v1/projects?limit=24`, { headers: { authorization }, signal: AbortSignal.timeout(30000) })
      assert.equal(response.status, 200)
      const payload = await response.json(); const projected = payload.data.projects.find((candidate) => candidate.id === id)
      assert.ok(projected); assert.equal(projected.status, status); assert.equal(projected.visibleState.label, status)
      const expected = CARD_EXPECTATIONS[status]
      assert.ok(expected, `${stage}: independent card expectation exists`)
      assert.equal(projected.visibleState.tone, expected.tone)
      assert.equal(projected.visibleState.primaryAction, expected.action)
      const operation = operationId ? await client.v2PublicOperation.findUniqueOrThrow({ where: { id: operationId } }) : null
      if (operation) {
        if (operationStatus !== undefined) assert.equal(operation.status, operationStatus)
        assert.equal(operation.phase, phase); assert.equal(operation.progressCompleted, completed)
        assert.equal(operation.progressTotal, 4); assert.equal(operation.progressUnit, 'render')
        assert.equal(projected.dashboard.latestOperation.id, operationId)
        assert.equal(projected.dashboard.latestOperation.status, operation.status)
        assert.equal(projected.dashboard.latestOperation.phase, phase)
        assert.deepEqual(projected.dashboard.latestOperation.progress, { completed, total: 4, unit: 'render' })
      }
      if (eventTypes.length) {
        markBrowserPage(pipelinePage, stage, 'pipeline')
        await pipeline.observe({ stage, projectId: id, operationId, expectedEventTypes: eventTypes, expectedState: status })
      }
      for (const [layout, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
        markBrowserPage(page, stage, layout)
        await drainBrowserResponses({ label: 'before-main-foreground' })
        const visibilityBefore = await page.evaluate(() => document.visibilityState)
        await page.bringToFront()
        await page.waitForFunction(() => document.visibilityState === 'visible')
        evidence.foregroundObservations ??= []
        evidence.foregroundObservations.push({ stage, layout, before: visibilityBefore, after: await page.evaluate(() => document.visibilityState) })
        await drainBrowserResponses({ label: 'before-dashboard-navigation' })
        const dashboardNavigation = beginBrowserNavigation(page, stage, layout, '/')
        await page.setViewportSize(viewport); await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
        const card = page.locator(`article[data-project-id="${id}"]`)
        try { await card.waitFor({ state: 'visible' }) } catch (error) {
          evidence.domFailure = { stage, layout, url: page.url(), visibility: await page.evaluate(() => document.visibilityState), text: await page.locator('body').innerText() }
          await page.screenshot({ path: join(directory, 'w35-dom-failure.png'), fullPage: true })
          throw error
        }
        await drainBrowserResponses({ opened: page, navigationId: dashboardNavigation,
          requiredPaths: ['/v1/projects', '/v1/events/feed'], label: 'dashboard-bootstrap' })
        assert.equal(await card.locator('[data-state]').getAttribute('data-state'), status)
        assert.equal(await card.locator('[data-state]').innerText(), expected.badge)
        assert.ok((await card.locator('[data-state]').getAttribute('class')).split(' ').includes(expected.color))
        const action = card.getByRole('button', { name: expected.button, exact: true })
        assert.equal(await action.isEnabled(), true)
        const bar = card.getByRole('progressbar')
        if (operation) assert.equal(await bar.getAttribute('aria-valuenow'), String(completed * 25))
        else assert.equal(await bar.count(), 0)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
        const name = `w35-${stage}-${layout}.png`; await page.screenshot({ path: join(directory, name), fullPage: true })
        evidence.screenshots.push({ name, sha256: sha256(await readFile(join(directory, name))) })
        if (layout === 'desktop' && !navigatedStates.has(status)) {
          const destination = `/projects/${id}${status === 'reviewing-proxy' ? '?mode=review' : ''}`
          await drainBrowserResponses({ label: 'before-workspace-navigation' })
          const workspaceNavigation = beginBrowserNavigation(page, stage, layout, `/projects/${id}`)
          const workspaceResponse = page.waitForResponse((candidate) => {
            const url = new URL(candidate.url())
            return candidate.request().method() === 'GET' && url.origin === new URL(baseUrl).origin &&
              url.pathname === `/v1/projects/${id}/workspace` &&
              browserRequests.get(candidate.request())?.navigationId === workspaceNavigation
          }, { timeout: 30000 }).then((response) => ({ response }), (error) => ({ error }))
          await action.click()
          await page.waitForURL(`${baseUrl}${destination}`)
          const hydrated = await workspaceResponse
          assert.ifError(hydrated.error)
          assert.equal(hydrated.response.status(), 200, `${stage}: browser workspace hydration must succeed`)
          await drainWorkspaceBootstrap(page, workspaceNavigation, id)
          navigatedStates.add(status)
        }
        await drainBrowserResponses()
        assert.deepEqual(evidence.browserErrors, [], `${stage}: browser errors are not acceptable`)
      }
      evidence.states.push({ stage, projectId: id, status, operationId, phase, completed,
        total: operation ? 4 : undefined, operationStatus: operation?.status,
        origin, seededStatus, visibleState: projected.visibleState,
        presentation: expected, actionDestination: `/projects/${id}${status === 'reviewing-proxy' ? '?mode=review' : ''}` })
    }
    await observe({ stage: 'draft', status: 'draft' })
    const draftReviewRequests = evidence.browserRequests.filter((record) => record.method === 'GET' &&
      [`/v1/projects/${projectId}/annotations`, `/v1/projects/${projectId}/proxy-reviews`].includes(record.path))
    assert.deepEqual(draftReviewRequests, [], 'Source-only draft must not request unavailable annotations or proxy reports')
    evidence.reviewAvailabilityProof = { projectId, draftRequests: 0, origin: 'browser-request-ledger', afterWorker: 'pending' }
    const created = await post('/v1/projects', { name: 'Runtime event creation', objective: 'discovery', format: '9:16' }, `runtime-event-create-${suffix}`, 201)
    await pipeline.observe({ stage: 'created', projectId: created.project.id, expectedEventTypes: ['project.created'], expectedState: 'draft' })
    prototype.claimNext = async function (...args) {
      const result = await originals.claimNext.apply(this, args)
      if (result && activeObserver) {
        const before = await client.v2Project.findUniqueOrThrow({ where: { id: result.operation.projectId } })
        const stale = await this.failOrRetry({ operationId: result.operation.id, leaseOwner: 'stale-runtime-worker',
          attempt: result.lease.attempt, now: new Date().toISOString(),
          error: { code: 'controlled_stale_failure', message: 'Rejected stale owner', retryable: false } })
        assert.equal(stale, null)
        const expiredAt = new Date(new Date(result.lease.expiresAt).getTime() + 1)
        assert.equal(await this.heartbeat({ operationId: result.operation.id, leaseOwner: result.lease.owner,
          attempt: result.lease.attempt, now: expiredAt.toISOString(), leaseUntil: new Date(expiredAt.getTime() + 60000).toISOString() }), false)
        const after = await client.v2Project.findUniqueOrThrow({ where: { id: result.operation.projectId } })
        assert.equal(after.status, before.status); assert.equal(after.currentVersionId, before.currentVersionId)
        evidence.states.push({ stage: 'stale-owner-and-expired-lease-rejected', projectId: before.id, operationId: result.operation.id,
          origin: 'real-fenced-repository', status: after.status })
        await observeWorker(result.operation, 'claimed')
      }
      return result
    }
    prototype.advancePhase = async function (command) {
      const result = await originals.advancePhase.call(this, command)
      if (result && activeObserver) {
        const row = await client.v2PublicOperation.findUniqueOrThrow({ where: { id: command.operationId } })
        await observeWorker({ id: row.id, projectId: row.projectId, phase: row.phase, progress: { completed: row.progressCompleted } }, 'advanced')
      }
      return result
    }
    activeObserver = async (operation, kind) => observe({ stage: `proxy-${operation.phase}`, operationId: operation.id,
      status: 'rendering-proxy', phase: operation.phase, completed: operation.progress.completed,
      eventTypes: [kind === 'claimed' ? 'operation.status.changed' : 'operation.progress.changed'] })
    const proxy = await post(`/v1/projects/${projectId}/proxy-renders`, undefined, `runtime-proxy-${suffix}`, 202)
    const proxyId = proxy.operation.id
    await observe({ stage: 'proxy-queued', status: 'rendering-proxy', operationId: proxyId, phase: 'queued', completed: 0, eventTypes: ['operation.status.changed'] })
    const portableDiagnostic = (value) => typeof value === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : null
    const proxyWorker = createProjectProxyRenderWorker(environment, undefined, ({ operationId, error }) => {
      const message = typeof error?.message === 'string' ? error.message : ''
      const syscall = typeof error?.syscall === 'string' ? error.syscall.split(' ')[0] : null
      evidence.proxyWorkerFailures ??= []
      evidence.proxyWorkerFailures.push({ operationId, name: portableDiagnostic(error?.name),
        code: portableDiagnostic(error?.code), errno: Number.isSafeInteger(error?.errno) ? error.errno : portableDiagnostic(error?.errno),
        syscall: ['spawn', 'open', 'stat', 'lstat', 'read', 'write', 'access', 'rename', 'unlink', 'connect'].includes(syscall) ? syscall : null,
        messageSha256: sha256(message), messageBytes: Buffer.byteLength(message) })
    })
    const firstProxyOutcome = await runObservedWorker(() => proxyWorker(`runtime-proxy-worker-${suffix}`, { workspaceId, operationId: proxyId, signal }))
    const firstProxyRow = await client.v2PublicOperation.findUniqueOrThrow({ where: { id: proxyId },
      select: { id: true, projectId: true, attempt: true, status: true, phase: true,
        errorCode: true, errorMessage: true, errorRetryable: true } })
    evidence.firstProxyWorkerDiagnostic = { operationId: firstProxyRow.id, projectId: firstProxyRow.projectId,
      attempt: firstProxyRow.attempt, operationAttemptKey: `${firstProxyRow.id}:${firstProxyRow.attempt}`,
      status: firstProxyRow.status, phase: firstProxyRow.phase, outcome: firstProxyOutcome,
      error: { code: firstProxyRow.errorCode, retryable: firstProxyRow.errorRetryable,
        messageSha256: firstProxyRow.errorMessage === null ? null : sha256(firstProxyRow.errorMessage),
        messageBytes: firstProxyRow.errorMessage === null ? 0 : Buffer.byteLength(firstProxyRow.errorMessage) } }
    assert.deepEqual(firstProxyOutcome, { operationId: proxyId, status: 'succeeded' },
      JSON.stringify(evidence.firstProxyWorkerDiagnostic))
    await observe({ stage: 'review', status: 'revising', operationId: proxyId, phase: 'completed', completed: 4, eventTypes: ['operation.status.changed'] })
    for (const path of [`/v1/projects/${projectId}/annotations`, `/v1/projects/${projectId}/proxy-reviews`]) {
      assert.ok(evidence.browserRequests.some((record) => record.method === 'GET' && record.path === path &&
        record.stage === 'review' && record.status === 200 && record.bodyState === 'captured' && record.transportState === 'finished'),
      `Published real proxy must expose a completed browser review read: ${path}`)
    }
    evidence.reviewAvailabilityProof.afterWorker = { operationId: proxyId, annotationsStatus: 200, proxyReviewStatus: 200,
      scope: 'availability-only; stored face safety remains unknown and final export blocked' }
    const replay = await post(`/v1/projects/${projectId}/proxy-renders`, undefined, `runtime-proxy-${suffix}`, 202)
    assert.equal(replay.replayed, true); assert.equal((await client.v2Project.findUniqueOrThrow({ where: { id: projectId } })).status, 'revising')
    const review = await client.v2ProxyReview.findFirstOrThrow({ where: { workspaceId, projectId, operationId: proxyId } })
    assert.equal(review.status, 'blocked')
    assert.equal(review.finalAllowed, false)
    assert.ok(JSON.parse(review.criticIssuesJson).some((issue) => issue.code === 'FACE_PERCEPTION_UNAVAILABLE_REVIEW_REQUIRED'))
    assert.ok(JSON.parse(review.criticIssuesJson).some((issue) => issue.code === 'FACE_PERCEPTION_UNAVAILABLE' && issue.severity === 'hard'))
    evidence.proxyEditorialState = { projectStatus: 'revising', reviewStatus: review.status,
      finalAllowed: review.finalAllowed, faceSafety: 'unknown', origin: 'postgres+production-proxy-review-repository' }
    const proxyArtifact = await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: review.proxyArtifactId } })
    const annotation = await post(`/v1/projects/${projectId}/annotations`, { projectVersionId, proxyArtifactId: proxyArtifact.id,
      proxyHash: proxyArtifact.sha256, frame: 0, timeRangeMs: [0, 100], scope: 'point', targetIds: [],
      screenshotRef: await annotationScreenshot(proxyArtifact, 'annotation-main-frame-0'), text: 'Controlled runtime inspection; preserve framing.' }, `runtime-annotation-${suffix}`, 201)
    await pipeline.observe({ stage: 'annotation', projectId, annotationId: annotation.annotation.id, expectedEventTypes: ['annotation.created'], expectedState: 'revising' })
    const copy = await post(`/v1/projects/${projectId}/duplicates`, { expectedVersionId: projectVersionId,
      expectedVersionHash: projectVersionHash, name: 'Runtime isolated failure' }, `runtime-copy-${suffix}`, 201)
    await pipeline.observe({ stage: 'copy', projectId: copy.project.id, expectedEventTypes: ['project.created'], expectedState: 'draft' })
    const exportBody = { projectVersionId, projectVersionHash, format: '9:16', approval: { approved: true, note: 'Controlled W35 runtime inspection.' } }
    const artifactCount = await client.v2MediaArtifact.count({ where: { workspaceId } })
    const publicRejected = await fetch(`${baseUrl}/v1/projects/${projectId}/exports`, { method: 'POST',
      headers: { authorization, 'content-type': 'application/json', 'idempotency-key': `runtime-public-final-${suffix}` },
      body: JSON.stringify(exportBody), signal: AbortSignal.timeout(30000) })
    const publicRejection = await publicRejected.json()
    assert.equal(publicRejected.status, 422, JSON.stringify(publicRejection))
    assert.equal(publicRejection.error.code, 'EDITORIAL_ACCEPTANCE_FAILED')
    assert.equal(await client.v2PublicOperation.count({ where: { workspaceId, type: 'project-final-export' } }), 0)
    assert.equal(await client.v2ProjectFinalExportOperation.count({ where: { workspaceId } }), 0)
    assert.equal(await client.v2ProjectFinalExportAttempt.count({ where: { workspaceId } }), 0)
    assert.equal(await client.v2AutomaticCatalogRecord.count({ where: { workspaceId } }), 0)
    assert.equal(await client.v2MediaArtifact.count({ where: { workspaceId } }), artifactCount)
    assert.equal((await client.v2Project.findUniqueOrThrow({ where: { id: projectId } })).status, 'revising')
    evidence.publicFinalAdmission = { status: 422, code: publicRejection.error.code,
      projectId, projectStatus: 'revising', finalOperations: 0, attempts: 0, catalogRecords: 0, artifactsCreated: 0 }

    const reviewSeal = (row) => stableSerialize({ projectVersionId: row.projectVersionId,
      operationId: row.operationId, proxyArtifactId: row.proxyArtifactId, proxyManifestId: row.proxyManifestId,
      inputHash: row.inputHash, reviewHash: row.reviewHash, status: row.status,
      finalAllowed: row.finalAllowed, warningsAcknowledged: row.warningsAcknowledged,
      technicalIssuesJson: row.technicalIssuesJson, criticIssuesJson: row.criticIssuesJson,
      formatQualityJson: row.formatQualityJson })
    const principal = { projectId, projectVersionId, exportBody, qualityId: directed.command.payload.snapshotRefs.quality,
      qualityJson: stableSerialize(directed.run.qualityReport), reviewId: review.id, reviewSeal: reviewSeal(review) }
    evidence.mainUpstream = { projectId, resultVersionId: directed.version.id, resultVersionHash: directed.version.baseHash,
      directorRunId: directed.run.id, directorBaseVersionId: directed.run.baseVersionId,
      perceptionInputVersionId: directed.run.perception.inputVersionId, perceptionHash: calculateVersionHash(directed.run.perception),
      transcriptId: directed.command.payload.sourceTranscriptId, editPlanHash: calculateVersionHash(directed.run.editPlan),
      qualitySnapshotId: principal.qualityId, qualitySnapshotHash: calculateVersionHash(directed.run.qualityReport),
      sourceArtifactId, sourceManifestId, sourceManifestHash: sourceManifest.manifestHash, sourceSha256, sourceByteSize,
      observedSourceColorProbe: { id: sourceColorProbe.id, hash: sourceColorProbe.probeHash,
        detection: sourceColorProbe.detection, producer: sourceColorProbe.producer },
      sourceObservationScope: 'synthetic media and caller-aligned transcript; no face detector authority' }
    const principalCompilation = JSON.parse((await client.v2ColorPipelineCompilation.findFirstOrThrow({ where: { workspaceId, projectId } })).compilationJson)
    const mechanical = await seedDashboardControlledExportFixture({ client, workspaceId, actor, artifactRoot, suffix,
      sourceArtifactId, sourceManifestId, sourcePath, sourceManifest, proxyArtifact, proxyManifestId: review.proxyManifestId,
      signal, ...mechanicalSeed,
      // Same public compilation as before, now completed before the seed INSERT.
      compileColorPipeline: ({ projectId: seedProjectId, sourceArtifactId: seedArtifactId, sourceManifestId: seedManifestId }) =>
        post(`/v1/projects/${seedProjectId}/color-pipeline-compilations`, {
          sourceArtifactId: seedArtifactId, sourceManifestId: seedManifestId,
          outputMetadata: principalCompilation.pipeline.outputMetadata,
          stages: principalCompilation.pipeline.stages.map(({ id, kind, version, enabled, output, implementation, lut }) =>
            ({ id, kind, version, enabled, output, implementation, ...(lut ? { lut } : {}) })),
        }, `runtime-mechanical-color-${suffix}`, 201),
    })
    assert.notEqual(mechanical.projectId, projectId)
    assert.notEqual(mechanical.projectVersionId, projectVersionId)
    assert.notEqual(mechanical.directed.command.id, directed.command.id)
    assert.notEqual(mechanical.directed.command.payload.snapshotRefs.quality, principal.qualityId)
    evidence.mechanicalFixture = mechanical.receipt
    const seededWorkspace = await readPublicWorkspace(mechanical.projectId, 'seeded-blocked-review-before-browser')
    assert.equal(seededWorkspace.project.currentVersionId, mechanical.projectVersionId)

    {
    const { projectId, projectVersionId, projectVersionHash, directed, sourceArtifactId, sourceManifestId,
      sourceSha256, sourceByteSize, sourceManifest, proxyArtifact, review } = mechanical
    const exportBody = { projectVersionId, projectVersionHash, format: '9:16',
      approval: { approved: true, note: 'Negative admission proof only; stored quality remains unknown.' } }
    const seededOperation = await client.v2PublicOperation.findUniqueOrThrow({ where: { id: review.operationId } })
    assert.equal(seededOperation.workspaceId, workspaceId)
    assert.equal(seededOperation.projectId, projectId)
    assert.equal(seededOperation.type, 'project-proxy-render')
    assert.equal(seededOperation.status, 'succeeded')
    assert.equal(seededOperation.phase, 'completed')
    assert.equal(seededOperation.progressCompleted, 4)
    assert.equal(seededOperation.progressTotal, 4)
    assert.equal(seededOperation.progressUnit, 'render')
    await observe({ stage: 'seeded-blocked-review', id: projectId, status: 'reviewing-proxy',
      operationId: seededOperation.id, operationStatus: 'succeeded', phase: 'completed', completed: 4,
      origin: 'controlled-pg-seed+real-api-projection+native-browser', seededStatus: true })
    const projectBefore = await client.v2Project.findUniqueOrThrow({ where: { id: projectId } })
    const runBefore = await client.v2DirectorRun.findUniqueOrThrow({ where: { id: directed.run.id } })
    assert.equal(runBefore.status, 'planned')
    const effects = async () => ({
      finalOperations: await client.v2PublicOperation.count({ where: { workspaceId, type: 'project-final-export' } }),
      finalDetails: await client.v2ProjectFinalExportOperation.count({ where: { workspaceId } }),
      finalAttempts: await client.v2ProjectFinalExportAttempt.count({ where: { workspaceId } }),
      catalogRecords: await client.v2AutomaticCatalogRecord.count({ where: { workspaceId } }),
      artifacts: await client.v2MediaArtifact.count({ where: { workspaceId } }),
      outboxEvents: await client.v2PublicEventOutbox.count({ where: { workspaceId } }),
    })
    const effectsBefore = await effects()
    assert.equal(effectsBefore.finalOperations, 0)
    assert.equal(effectsBefore.finalDetails, 0)
    assert.equal(effectsBefore.finalAttempts, 0)
    const mechanicalPublic = await fetch(`${baseUrl}/v1/projects/${projectId}/exports`, { method: 'POST',
      headers: { authorization, 'content-type': 'application/json', 'idempotency-key': `runtime-mechanical-public-final-${suffix}` },
      body: JSON.stringify(exportBody), signal: AbortSignal.timeout(30000) })
    const mechanicalPublicBody = await mechanicalPublic.json()
    assert.equal(mechanicalPublic.status, 422, JSON.stringify(mechanicalPublicBody))
    assert.equal(mechanicalPublicBody.error.code, 'EDITORIAL_ACCEPTANCE_FAILED')
    assert.deepEqual(await effects(), effectsBefore)
    assert.deepEqual(await client.v2Project.findUniqueOrThrow({ where: { id: projectId } }), projectBefore)
    evidence.mechanicalPublicFinalAdmission = { projectId, status: 422,
      code: mechanicalPublicBody.error.code, finalOperations: 0, finalDetails: 0, finalAttempts: 0,
      additionalCatalogRecords: 0, additionalArtifacts: 0, additionalOutboxEvents: 0,
      initialStatus: 'reviewing-proxy', seededStatus: true,
      storedQualityStatus: 'review-required', faceSafety: 'unknown', seededProxyReviewStatus: 'blocked' }

    // This port changes only the approval claim in its return value. All identity,
    // lineage, source bytes and persisted UNKNOWN quality/review are checked on
    // each current/immutable read; no API or stored report receives approval.
    const identity = Object.freeze({ workspaceId, projectId, projectVersionId, projectVersionHash,
      editPlanSnapshotId: directed.version.snapshotRefs.editPlan, directorRunId: directed.run.id,
      qualitySnapshotId: directed.command.payload.snapshotRefs.quality,
      qualitySnapshotHash: calculateVersionHash(directed.run.qualityReport),
      proxyReviewId: review.id, proxyReviewHash: review.reviewHash, proxyArtifactId: review.proxyArtifactId,
      sourceArtifactId, sourceManifestId })
    assert.ok(identity.qualitySnapshotId)
    const sourceReader = new PrismaProjectProxyRenderRepository(client)
    const finalRepository = new PrismaProjectFinalExportRepository(client)
    const qualityJson = stableSerialize(directed.run.qualityReport)
    evidence.controlledUpstream = { projectId, directorRunId: directed.run.id, directorBaseVersionId: directed.run.baseVersionId,
      resultVersionId: directed.version.id, resultVersionHash: directed.version.baseHash,
      perceptionInputVersionId: directed.run.perception.inputVersionId,
      perceptionHash: calculateVersionHash(directed.run.perception),
      transcriptId: directed.command.payload.sourceTranscriptId,
      editPlanHash: calculateVersionHash(directed.run.editPlan), qualitySnapshotHash: identity.qualitySnapshotHash,
      sourceArtifactId, sourceManifestId, sourceManifestHash: sourceManifest.manifestHash, sourceSha256, sourceByteSize,
      sourceObservationScope: 'separately seeded copied media and aligned transcript; no face detector authority' }
    const sealedReview = reviewSeal(review)
    async function readControlledSource(request, immutable) {
      const required = immutable ? Object.keys(identity) : ['workspaceId', 'projectId', 'projectVersionId', 'projectVersionHash']
      if (required.some((key) => request[key] !== identity[key])) return null
      const source = immutable ? await sourceReader.readImmutableSource(request)
        : await sourceReader.readCurrentSource({ workspaceId, projectId })
      if (!source || source.projectVersionId !== projectVersionId ||
          source.editPlanSnapshotId !== identity.editPlanSnapshotId ||
          source.editPlanHash !== calculateVersionHash(directed.run.editPlan) ||
          source.sourceArtifactId !== sourceArtifactId || source.sourceManifestId !== sourceManifestId ||
          source.sourceSha256 !== sourceSha256 || source.renderSources.length !== 1 ||
          source.renderSources[0].artifactId !== sourceArtifactId ||
          source.renderSources[0].manifestId !== sourceManifestId ||
          source.renderSources[0].sha256 !== sourceSha256 ||
          source.renderSources[0].byteSize !== sourceByteSize) return null
      const [project, version, run, quality, storedReview, artifact, manifest, storedProxy] = await Promise.all([
        client.v2Project.findFirst({ where: { id: projectId, workspaceId } }),
        client.v2ProjectVersion.findFirst({ where: { id: projectVersionId, workspaceId, projectId, baseHash: projectVersionHash } }),
        client.v2DirectorRun.findFirst({ where: { id: identity.directorRunId, workspaceId, projectId,
          resultVersionId: projectVersionId, qualitySnapshotId: identity.qualitySnapshotId, status: 'planned' } }),
        client.v2ProjectSnapshot.findFirst({ where: { id: identity.qualitySnapshotId, workspaceId, projectId, kind: 'quality-report' } }),
        client.v2ProxyReview.findFirst({ where: { id: review.id, workspaceId, projectId, projectVersionId } }),
        client.v2MediaArtifact.findFirst({ where: { id: sourceArtifactId, workspaceId, sha256: sourceSha256, status: 'available' } }),
        client.v2MediaArtifactManifest.findFirst({ where: { id: sourceManifestId, workspaceId, artifactId: sourceArtifactId } }),
        client.v2MediaArtifact.findFirst({ where: { id: proxyArtifact.id, workspaceId, sha256: proxyArtifact.sha256, status: 'available' } }),
      ])
      if (!project || (!immutable && project.currentVersionId !== projectVersionId) ||
          !version || version.editPlanSnapshotId !== identity.editPlanSnapshotId || !run || !quality ||
          quality.schemaVersion !== 3 || quality.contentHash !== identity.qualitySnapshotHash ||
          quality.contentJson !== qualityJson || !storedReview || reviewSeal(storedReview) !== sealedReview ||
          !artifact || Number(artifact.byteSize) !== sourceByteSize || !manifest ||
          manifest.manifestHash !== sourceManifest.manifestHash ||
          manifest.manifestJson !== stableSerialize(sourceManifest) || !storedProxy) return null
      return Object.freeze({ ...source, projectVersionHash, locale: project.locale,
        directorRunId: identity.directorRunId, qualitySnapshotId: identity.qualitySnapshotId,
        qualitySnapshotHash: identity.qualitySnapshotHash, qualityStatus: 'approved',
        qualityScore: directed.run.qualityReport.score, proxyReviewId: review.id,
        proxyReviewHash: review.reviewHash, proxyArtifactId: review.proxyArtifactId })
    }
    const controlledProjects = Object.freeze({
      readApprovedCurrentSource: (request) => readControlledSource(request, false),
      readImmutableApprovedSource: (request) => readControlledSource(request, true),
      convergeOutputIdentity: (request) => finalRepository.convergeOutputIdentity(request),
      attachCompletedOutput: (request) => finalRepository.attachCompletedOutput(request),
      markExportFailed: (request) => finalRepository.markExportFailed(request),
      recordAttempt: (request) => finalRepository.recordAttempt(request),
      readAttemptHistory: (request) => finalRepository.readAttemptHistory(request),
    })
    const operations = new PrismaPublicOperationRepository(client, randomUUID,
      () => createProtectedPayloadCipherFromEnvironment(environment))
    let persistenceAdmissionAttempts = 0
    let persistenceRejectedApprovalClaim = false
    const observedOperations = {
      findReplay: (request) => operations.findReplay(request),
      createOrReplay: async (request) => {
        persistenceAdmissionAttempts += 1
        try { return await operations.createOrReplay(request) } catch (error) {
          assert.equal(error.code, 'EDITORIAL_ACCEPTANCE_FAILED', 'Real PostgreSQL admission must reject the controlled approval claim')
          persistenceRejectedApprovalClaim = true
          throw error
        }
      },
    }
    const rights = new PrismaAssetRightsRepository(client)
    const enqueueFinal = enqueueProjectFinalExportService({ projects: controlledProjects, rights, operations: observedOperations,
      colorPipelines: factory.createColorPipelineCompilationRepository(), clock: () => new Date(),
      createId: (kind) => `runtime-final-${kind}-${suffix}` })
    const finalRequest = { workspaceId, projectId, ...exportBody, actor, idempotencyKey: `runtime-final-${suffix}` }
    await assert.rejects(enqueueFinal(finalRequest), (error) => error.code === 'EDITORIAL_ACCEPTANCE_FAILED')
    assert.equal(persistenceAdmissionAttempts, 1, 'The negative must reach the real persistence admission gate')
    assert.equal(persistenceRejectedApprovalClaim, true)
    await assert.rejects(enqueueFinal({ ...finalRequest, projectVersionHash: '0'.repeat(64),
      idempotencyKey: `runtime-final-wrong-version-${suffix}` }), (error) => error.code === 'EDITORIAL_ACCEPTANCE_FAILED')
    assert.equal(persistenceAdmissionAttempts, 1, 'Wrong-version rejection must happen before persistence admission')
    assert.deepEqual(await effects(), effectsBefore)
    assert.deepEqual(await client.v2Project.findUniqueOrThrow({ where: { id: projectId } }), projectBefore)
    const storedRun = await client.v2DirectorRun.findUniqueOrThrow({ where: { id: identity.directorRunId } })
    assert.deepEqual(storedRun, runBefore)
    evidence.controlledApprovalClaimRejectedByPersistence = {
      proofScope: 'negative-real-postgresql-admission', approvalClaim: 'test-only repository return value',
      errorCode: 'EDITORIAL_ACCEPTANCE_FAILED', persistenceAdmissionAttempts,
      identity, persistedProxyReview: { status: review.status, finalAllowed: review.finalAllowed },
      persistedDirectorStatus: storedRun.status, unchangedProjectStatus: projectBefore.status,
      persistedQuality: { status: directed.run.qualityReport.status, faceSafety: directed.run.qualityReport.faceSafety.status },
      finalOperations: 0, finalDetails: 0, finalAttempts: 0, additionalCatalogRecords: 0,
      additionalArtifacts: 0, additionalOutboxEvents: 0 }
    assert.equal((await client.v2ProjectSnapshot.findUniqueOrThrow({ where: { id: identity.qualitySnapshotId } })).contentJson, qualityJson)
    assert.equal(reviewSeal(await client.v2ProxyReview.findUniqueOrThrow({ where: { id: review.id } })), sealedReview)
    const rejectedAgain = await fetch(`${baseUrl}/v1/projects/${principal.projectId}/exports`, { method: 'POST',
      headers: { authorization, 'content-type': 'application/json', 'idempotency-key': `runtime-public-final-after-${suffix}` },
      body: JSON.stringify(principal.exportBody), signal: AbortSignal.timeout(30000) })
    const rejectedAgainBody = await rejectedAgain.json()
    assert.equal(rejectedAgain.status, 422, JSON.stringify(rejectedAgainBody))
    assert.equal(rejectedAgainBody.error.code, 'EDITORIAL_ACCEPTANCE_FAILED')
    assert.deepEqual(await effects(), effectsBefore)
    assert.deepEqual(await client.v2Project.findUniqueOrThrow({ where: { id: projectId } }), projectBefore)
    assert.deepEqual(await client.v2DirectorRun.findUniqueOrThrow({ where: { id: identity.directorRunId } }), runBefore)
    assert.equal((await client.v2Project.findUniqueOrThrow({ where: { id: principal.projectId } })).status, 'revising')
    assert.equal(await client.v2PublicOperation.count({ where: { workspaceId, projectId: principal.projectId, type: 'project-final-export' } }), 0)
    assert.equal(await client.v2ProjectFinalExportOperation.count({ where: { workspaceId, projectId: principal.projectId } }), 0)
    assert.equal(await client.v2ProjectFinalExportAttempt.count({ where: { workspaceId, operation: { projectId: principal.projectId } } }), 0)
    assert.equal((await client.v2ProjectSnapshot.findUniqueOrThrow({ where: { id: principal.qualityId } })).contentJson, principal.qualityJson)
    assert.equal(reviewSeal(await client.v2ProxyReview.findUniqueOrThrow({ where: { id: principal.reviewId } })), principal.reviewSeal)
    evidence.publicFinalAdmissionAfterRejectedClaim = { status: 422, code: rejectedAgainBody.error.code,
      projectId: principal.projectId, projectStatus: 'revising', finalOperationsForMain: 0,
      additionalOperations: 0, additionalArtifacts: 0, storedQualityStatus: 'review-required', faceSafety: 'unknown' }
    }
    for (const operationId of [proxyId]) {
      const operation = await client.v2PublicOperation.findUniqueOrThrow({ where: { id: operationId } })
      const outputId = JSON.parse(operation.resultJson).resource.id
      const artifact = await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: outputId } })
      const path = join(artifactRoot, ...artifact.artifactKey.split('/')); const bytes = await readFile(path)
      assert.equal(sha256(bytes), artifact.sha256); assert.equal(BigInt(bytes.length), artifact.byteSize)
      await exec(ffmpeg, ['-v', 'error', '-xerror', '-i', path, '-f', 'null', '-'], { windowsHide: true, timeout: 60000 })
      const probe = await probeVideo(path); const name = `${operation.type}.mp4`; await copyFile(path, join(directory, name))
      await exec(ffmpeg, ['-v', 'error', '-y', '-ss', '1', '-i', path, '-frames:v', '1', join(directory, `${operation.type}-frame.png`)], { windowsHide: true, timeout: 30000 })
      evidence.outputs.push({ operationId, projectId: operation.projectId, artifactId: artifact.id,
        proofScope: 'main-project-runtime-proxy',
        sha256: artifact.sha256, byteSize: bytes.length, name, probe, fullDecode: true })
    }
    activeObserver = null
    const compilation = JSON.parse((await client.v2ColorPipelineCompilation.findFirstOrThrow({ where: { workspaceId, projectId } })).compilationJson)
    const copyCompilationBody = {
      sourceArtifactId: compilation.sourceArtifactId, sourceManifestId: compilation.sourceManifestId,
      outputMetadata: compilation.pipeline.outputMetadata,
      stages: compilation.pipeline.stages.map(({ id, kind, version, enabled, output, implementation, lut }) =>
        ({ id, kind, version, enabled, output, implementation, ...(lut ? { lut } : {}) })),
    }
    const { parseCreateColorPipelineCompilationBody } = await import('../../../src/v2/public-api/color-pipeline-compilation-contract.ts')
    assert.deepEqual(parseCreateColorPipelineCompilationBody(copyCompilationBody), copyCompilationBody)
    await post(`/v1/projects/${copy.project.id}/color-pipeline-compilations`, copyCompilationBody, `runtime-copy-color-${suffix}`, 201)
    const selected = await post(`/v1/projects/${copy.project.id}/lut-selection`, {
      baseVersionId: copy.version.id, baseHash: copy.version.baseHash, selection: { mode: 'none' },
      reason: 'Controlled neutral rendering for independent runtime fence proof.',
    }, `runtime-copy-lut-${suffix}`, 201)
    const failedProxy = selected
    assert.equal(failedProxy.operation.status, 'queued', 'LUT selection admits a physical render for the new version')
    const duplicateProxy = await fetch(`${baseUrl}/v1/projects/${copy.project.id}/proxy-renders`, { method: 'POST',
      headers: { authorization, 'idempotency-key': `runtime-duplicate-input-${suffix}` }, signal: AbortSignal.timeout(30000) })
    const duplicateBody = await duplicateProxy.json()
    assert.equal(duplicateProxy.status, 409); assert.equal(duplicateBody.error.code, 'PERSISTENCE_CONFLICT')
    assert.equal(await client.v2ProjectProxyRenderOperation.count({ where: { workspaceId, projectVersionId: selected.version.id } }), 1)
    assert.equal((await client.v2PublicOperation.findUniqueOrThrow({ where: { id: selected.operation.id } })).status, 'queued')
    evidence.duplicateAdmission = { status: duplicateProxy.status, errorCode: duplicateBody.error.code,
      projectVersionId: selected.version.id, unchangedOperationId: selected.operation.id }
    const hidden = `${sourcePath}.owned-unavailable`
    await rename(sourcePath, hidden)
    try {
      const outcome = await proxyWorker(`runtime-failure-worker-${suffix}`, { workspaceId, operationId: failedProxy.operation.id, signal })
      assert.equal(outcome.operationId, failedProxy.operation.id)
      assert.equal(outcome.status, 'failed')
    } finally { await rename(hidden, sourcePath) }
    const failedRow = await client.v2PublicOperation.findUniqueOrThrow({ where: { id: failedProxy.operation.id } })
    assert.equal(failedRow.status, 'failed')
    assert.equal(failedRow.attempt, 1)
    assert.equal(failedRow.errorCode, 'persistence_conflict')
    assert.equal(failedRow.errorRetryable, false)
    evidence.workerFailure = { operationId: failedRow.id, attempt: failedRow.attempt, code: failedRow.errorCode,
      retryable: failedRow.errorRetryable, origin: 'production-source-materializer' }
    assert.equal((await client.v2Project.findUniqueOrThrow({ where: { id: copy.project.id } })).status, 'failed')
    await observe({ stage: 'worker-failed', id: copy.project.id, status: 'failed', operationId: failedRow.id, phase: 'failed', completed: failedRow.progressCompleted, eventTypes: ['operation.status.changed'] })
    await post(`/v1/operations/${failedRow.id}/retry`, undefined, `runtime-worker-retry-${suffix}`, 200)
    assert.equal((await client.v2Project.findUniqueOrThrow({ where: { id: copy.project.id } })).status, 'rendering-proxy')
    await delay(1100)
    assert.deepEqual(await proxyWorker(`runtime-recovered-worker-${suffix}`, { workspaceId, operationId: failedRow.id, signal }), { operationId: failedRow.id, status: 'succeeded' })
    await observe({ stage: 'copy-review', id: copy.project.id, status: 'revising', operationId: failedRow.id, phase: 'completed', completed: 4, eventTypes: ['operation.status.changed'] })
    const copyReview = await client.v2ProxyReview.findUniqueOrThrow({ where: { operationId: failedRow.id } })
    assert.equal(copyReview.status, 'blocked'); assert.equal(copyReview.finalAllowed, false)
    const copyArtifact = await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: copyReview.proxyArtifactId } })
    const copyAnnotation = await post(`/v1/projects/${copy.project.id}/annotations`, {
      projectVersionId: selected.version.id, proxyArtifactId: copyArtifact.id, proxyHash: copyArtifact.sha256,
      frame: 0, timeRangeMs: [0, 100], scope: 'point', targetIds: [],
      screenshotRef: await annotationScreenshot(copyArtifact, 'annotation-copy-frame-0'), text: 'Ajustar enquadramento central.',
    }, `runtime-copy-annotation-${suffix}`, 201)
    await pipeline.observe({ stage: 'copy-annotation', projectId: copy.project.id, annotationId: copyAnnotation.annotation.id,
      expectedEventTypes: ['annotation.created'], expectedState: 'revising' })
    const proposal = await post(`/v1/projects/${copy.project.id}/patch-proposals`, { annotationId: copyAnnotation.annotation.id }, `runtime-proposal-${suffix}`, 201)
    assert.equal(proposal.proposal.status, 'ready')
    const applied = await post(`/v1/projects/${copy.project.id}/patch-proposals/${proposal.proposal.id}/apply`, { confirmed: true }, `runtime-patch-${suffix}`, 201)
    assert.equal((await client.v2ReviewAnnotation.findUniqueOrThrow({ where: { id: copyAnnotation.annotation.id } })).status, 'applied')
    await pipeline.observe({ stage: 'annotation-resolved', projectId: copy.project.id, annotationId: copyAnnotation.annotation.id,
      expectedEventTypes: ['annotation.resolved'], expectedState: 'rendering-proxy' })
    assert.deepEqual(await proxyWorker(`runtime-patch-worker-${suffix}`, { workspaceId, operationId: applied.operation.id, signal }), { operationId: applied.operation.id, status: 'succeeded' })
    const patchedReview = await client.v2ProxyReview.findUniqueOrThrow({ where: { operationId: applied.operation.id } })
    assert.equal(patchedReview.status, 'blocked'); assert.equal(patchedReview.finalAllowed, false)
    await observe({ stage: 'patched-review', id: copy.project.id, status: 'revising', operationId: applied.operation.id, phase: 'completed', completed: 4, eventTypes: ['operation.status.changed'] })
    // Exhaust actual durable claims without any status seed or mutation. Each
    // abandoned claim owns a short lease; the next runtime claim settles it.
    const abandoned = await post(`/v1/projects/${copy.project.id}/lut-selection`, {
      baseVersionId: applied.version.id, baseHash: applied.version.baseHash, selection: { mode: 'none' },
      reason: 'Admit a new immutable version for expired lease recovery proof.',
    }, `runtime-abandoned-${suffix}`, 201)
    assert.equal(abandoned.operation.status, 'queued')
    assert.notEqual(abandoned.version.id, applied.version.id)
    const repository = new PrismaPublicOperationRepository(client)
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const now = new Date()
      const claim = await repository.claimNext({ type: 'project-proxy-render', workspaceId, operationId: abandoned.operation.id,
        leaseOwner: `abandoned-owned-${suffix}-${attempt}`, now: now.toISOString(), leaseUntil: new Date(now.getTime() + 50).toISOString() })
      assert.equal(claim.lease.attempt, attempt); await delay(70)
    }
    const afterLease = new Date()
    assert.equal(await repository.claimNext({ type: 'project-proxy-render', workspaceId, operationId: abandoned.operation.id,
      leaseOwner: `exhaustion-observer-${suffix}`, now: afterLease.toISOString(), leaseUntil: new Date(afterLease.getTime() + 120000).toISOString() }), null)
    const exhausted = await client.v2PublicOperation.findUniqueOrThrow({ where: { id: abandoned.operation.id } })
    assert.equal(exhausted.errorCode, 'worker_lease_expired')
    await observe({ stage: 'failed', id: copy.project.id, status: 'failed', operationId: exhausted.id, phase: 'failed', completed: exhausted.progressCompleted, eventTypes: ['operation.status.changed'] })
    await post(`/v1/operations/${exhausted.id}/retry`, undefined, `runtime-retry-${suffix}`, 200)
    assert.equal((await client.v2Project.findUniqueOrThrow({ where: { id: copy.project.id } })).status, 'rendering-proxy')
    await delay(1100)
    assert.deepEqual(await proxyWorker(`runtime-retry-worker-${suffix}`, { workspaceId, operationId: exhausted.id, signal }), { operationId: exhausted.id, status: 'succeeded' })
    const retriedReview = await client.v2ProxyReview.findUniqueOrThrow({ where: { operationId: exhausted.id } })
    assert.equal(retriedReview.status, 'blocked'); assert.equal(retriedReview.finalAllowed, false)
    await observe({ stage: 'retried-review', id: copy.project.id, status: 'revising', operationId: exhausted.id, phase: 'completed', completed: 4, eventTypes: ['operation.status.changed'] })
    // Advance the version through the real Command service while an older
    // admitted task still owns a lease. No newer admission masks this CAS test.
    const staleVersionJob = await post(`/v1/projects/${copy.project.id}/lut-selection`, {
      baseVersionId: abandoned.version.id, baseHash: abandoned.version.baseHash, selection: { mode: 'none' },
      reason: 'Admit a physical render before an independently committed newer Command.',
    }, `runtime-stale-version-${suffix}`, 201)
    assert.equal(staleVersionJob.operation.status, 'queued')
    assert.notEqual(staleVersionJob.version.id, abandoned.version.id)
    const claimAt = new Date()
    const staleClaim = await repository.claimNext({ type: 'project-proxy-render', workspaceId, operationId: staleVersionJob.operation.id,
      leaseOwner: `version-fence-worker-${suffix}`, now: claimAt.toISOString(), leaseUntil: new Date(claimAt.getTime() + 120000).toISOString() })
    const { setProjectLutSelectionService } = await import('../../../src/v2/application/project-lut-selections.ts')
    const { PrismaProjectLutSelectionRepository } = await import('../../../src/v2/infrastructure/prisma/project-lut-selection-repository.ts')
    const versionBeforeEdit = await client.v2ProjectVersion.findUniqueOrThrow({ where: { id: staleVersionJob.version.id } })
    const changed = await setProjectLutSelectionService({ repository: new PrismaProjectLutSelectionRepository(client),
      createId: (kind) => `runtime-version-${kind}-${randomUUID()}`, createEventId: randomUUID })({
      workspaceId, projectId: copy.project.id, baseVersionId: versionBeforeEdit.id, baseHash: versionBeforeEdit.baseHash,
      selection: { mode: 'none' }, actor: { type: 'system', id: 'controlled-version-fence-command' },
      idempotencyKey: `runtime-version-edit-${suffix}`, reason: 'Verify an older task cannot change the current version status.' })
    assert.notEqual(changed.version.id, staleClaim.context.projectVersionId)
    await repository.failOrRetry({ operationId: staleClaim.operation.id, leaseOwner: staleClaim.lease.owner, attempt: staleClaim.lease.attempt,
      now: new Date().toISOString(), error: { code: 'controlled_version_changed', message: 'Original version superseded by a real Command', retryable: false } })
    const afterVersionFailure = await client.v2Project.findUniqueOrThrow({ where: { id: copy.project.id } })
    assert.equal(afterVersionFailure.currentVersionId, changed.version.id)
    assert.equal(afterVersionFailure.status, 'rendering-proxy', 'older version failure does not change current project status')
    const versionRetryResponse = await fetch(`${baseUrl}/v1/operations/${staleClaim.operation.id}/retry`, { method: 'POST', headers: { authorization }, signal: AbortSignal.timeout(30000) })
    assert.equal(versionRetryResponse.status, 409)
    evidence.states.push({ stage: 'current-version-cas-rejected', projectId: copy.project.id, operationId: staleClaim.operation.id,
      currentVersionId: changed.version.id, operationVersionId: staleClaim.context.projectVersionId,
      status: afterVersionFailure.status, origin: 'real-command-service+fenced-repository' })
    await drainBrowserResponses()
    assert.deepEqual(evidence.browserErrors, [], 'No page errors, HTTP errors or unexplained browser conflicts are accepted')
    evidence.pipeline = await pipeline.finish(); evidence.outcome = 'passed'
  } catch (error) { primaryError = error; evidence.outcome = 'failed'; evidence.failure = { name: error.name, message: error.message }; throw error }
  finally {
    prototype.claimNext = originals.claimNext; prototype.advancePhase = originals.advancePhase
    let postflightError
    try { await drainBrowserResponses() }
    catch (error) { evidence.browserEvidencePostflightError = safeError(error); postflightError = error }
    if (!primaryError && evidence.browserErrors.length) {
      postflightError ??= new Error('Browser error ledger is nonempty at postflight')
      evidence.outcome = 'failed'
    }
    try { evidence.postflight = await closeOwnedBrowser({ context, browser, server, child }); assert.equal(evidence.postflight.browserTerminal, true) }
    catch (error) { evidence.postflight.cleanupError = safeError(error); postflightError ??= error }
    // Keep lifecycle and error observers active through closure. An unfinished
    // request or a late body failure cannot become terminal by closing a page.
    try { await drainBrowserResponses({ label: 'after-browser-close' }) }
    catch (error) { evidence.browserEvidenceAfterCloseError = safeError(error); postflightError ??= error }
    for (const { opened, handlers } of browserResponseListeners) {
      for (const [event, listener] of Object.entries(handlers)) opened.off(event, listener)
    }
    // pageerror/console observers remain active through close. A late error must
    // turn the persisted outcome into FAIL while preserving an earlier failure.
    if (evidence.browserErrors.length) postflightError ??= new Error('Browser error ledger is nonempty after browser close')
    if (postflightError) evidence.outcome = 'failed'
    try { await writeFile(join(directory, 'w35-runtime.json'), JSON.stringify(evidence, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2)) }
    catch (error) { postflightError ??= error }
    if (!primaryError && postflightError) throw postflightError
  }
}
