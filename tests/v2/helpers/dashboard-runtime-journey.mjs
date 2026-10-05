import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { closeOwnedBrowser } from './library-browser-proof.mjs'
import { createDashboardPipelineObserver } from './dashboard-w36-pipeline-proof.mjs'

const exec = promisify(execFile)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const CARD_EXPECTATIONS = {
  draft: { tone: 'neutral', color: 'text-[#aaa49a]', badge: 'Configuração', action: 'open-result', button: 'Abrir workspace →' },
  'rendering-proxy': { tone: 'info', color: 'text-[#79a5da]', badge: 'Renderizando proxy', action: 'view-progress', button: 'Acompanhar →' },
  'reviewing-proxy': { tone: 'warning', color: 'text-[#ca92d4]', badge: 'Revisar proxy', action: 'review-output', button: 'Revisar agora →' },
  'rendering-final': { tone: 'info', color: 'text-[#79a5da]', badge: 'Exportando final', action: 'view-progress', button: 'Acompanhar →' },
  completed: { tone: 'success', color: 'text-[#7ec397]', badge: 'Concluído', action: 'open-result', button: 'Abrir workspace →' },
  failed: { tone: 'danger', color: 'text-[#e08b8b]', badge: 'Requer atenção', action: 'inspect-error', button: 'Ver erro →' },
}

/** Timing-only observation: every mutation still executes the production factory worker. */
export async function runDashboardRuntimeJourney(input) {
  const { client, baseUrl, authorization, workspaceId, projectId, projectVersionId,
    projectVersionHash, sourcePath, artifactRoot, uiUsername, uiPassword, suffix, signal } = input
  const directory = process.env.APOLLO_DASHBOARD_RUNTIME_EVIDENCE_ROOT
  assert.ok(directory && isAbsolute(directory), 'Runtime evidence requires an absolute external directory')
  await mkdir(directory, { recursive: true })
  const evidence = { schemaVersion: 'dashboard-real-runtime/v1', runId: suffix, ownerPid: process.pid,
    sourceCommit: process.env.GITHUB_SHA ?? null, states: [], outputs: [], screenshots: [],
    controlledInputs: ['Director snapshots', 'FFmpeg synthetic source bytes', 'source color probe'],
    governancePolicy: { anomalyRequestMinimum: 400, scope: 'owned E2E server only', productionDefaultChanged: false },
    unmeasuredProgress: { runtimeReachable: false, reason: 'All public operations use a known canonical phase count; historical no-total proof is controlled.' },
    deployed: false, ownerAccepted: false, postflight: {} }
  const { PrismaPublicOperationRepository } = await import('../../../src/v2/infrastructure/prisma/public-operation-repository.ts')
  const { createProjectProxyRenderWorker, createProjectFinalExportWorker } = await import('../../../src/v2/infrastructure/repository-factory.ts')
  const { probeVideo } = await import('../../../src/v2/infrastructure/media/video-probe.ts')
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
  const environment = { ...process.env, APOLLO_V2_ARTIFACT_ROOT: artifactRoot,
    APOLLO_V2_RENDER_LEASE_MS: '120000', APOLLO_V2_RENDER_HEARTBEAT_MS: '5000',
    APOLLO_V2_WORKER_RETRY_BASE_MS: '1', APOLLO_V2_WORKER_RETRY_MAX_MS: '1',
    APOLLO_PROTECTED_PAYLOAD_KEY_ID: 'dashboard-runtime-e2e',
    APOLLO_PROTECTED_PAYLOAD_KEY: Buffer.alloc(32, 7).toString('base64url') }
  const post = async (path, body, key, expected) => {
    const response = await fetch(`${baseUrl}${path}`, { method: 'POST',
      headers: { authorization, 'content-type': 'application/json', 'idempotency-key': key },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) })
    const payload = await response.json()
    assert.equal(response.status, expected, `${path}: ${JSON.stringify(payload)}`)
    return payload.data
  }
  const annotationScreenshot = async (artifact, name) => {
    const path = join(artifactRoot, ...artifact.artifactKey.split('/'))
    const framePath = join(directory, `${name}.png`)
    const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')
    await exec(ffmpeg, ['-v', 'error', '-y', '-i', path, '-frames:v', '1', framePath], { windowsHide: true, timeout: 30000 })
    const bytes = await readFile(framePath)
    evidence.screenshots.push({ name: `${name}.png`, origin: 'real-proxy-ffmpeg-frame-0', artifactId: artifact.id, sha256: sha256(bytes) })
    return `data:image/png;base64,${bytes.toString('base64')}`
  }
  try {
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
    evidence.browserErrors = []
    context.on('page', (opened) => {
      opened.on('pageerror', (error) => evidence.browserErrors.push(String(error)))
      opened.on('console', (message) => { if (message.type() === 'error') evidence.browserErrors.push(message.text()) })
      opened.on('response', (response) => { if (response.status() >= 400) evidence.browserErrors.push(`${response.status()} ${response.url()}`) })
    })
    context.setDefaultTimeout(30000); context.setDefaultNavigationTimeout(30000)
    await context.addCookies([{ name: 'apollo_session', value: cookie, url: baseUrl, httpOnly: true, sameSite: 'Lax' }])
    const page = await context.newPage()
    const navigatedStates = new Set()
    pipeline = await createDashboardPipelineObserver({ page: await context.newPage(), client, baseUrl, workspaceId, evidenceDir: directory })
    const observe = async ({ stage, id = projectId, operationId, status, phase, completed, eventTypes = [] }) => {
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
        assert.equal(operation.phase, phase); assert.equal(operation.progressCompleted, completed)
        assert.equal(operation.progressTotal, 4); assert.equal(operation.progressUnit, 'render')
        assert.equal(projected.dashboard.latestOperation.id, operationId)
        assert.equal(projected.dashboard.latestOperation.phase, phase)
        assert.deepEqual(projected.dashboard.latestOperation.progress, { completed, total: 4, unit: 'render' })
      }
      if (eventTypes.length) await pipeline.observe({ stage, projectId: id, operationId, expectedEventTypes: eventTypes, expectedState: status })
      for (const [layout, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
        await page.setViewportSize(viewport); await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
        const card = page.locator(`article[data-project-id="${id}"]`); await card.waitFor({ state: 'visible' })
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
          await action.click()
          await page.waitForURL(`${baseUrl}${destination}`)
          navigatedStates.add(status)
        }
      }
      evidence.states.push({ stage, projectId: id, status, operationId, phase, completed,
        total: operation ? 4 : undefined, origin: 'public-api+postgres+factory-worker', visibleState: projected.visibleState,
        presentation: expected, actionDestination: `/projects/${id}${status === 'reviewing-proxy' ? '?mode=review' : ''}` })
    }
    await observe({ stage: 'draft', status: 'draft' })
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
    const proxyWorker = createProjectProxyRenderWorker(environment)
    assert.deepEqual(await runObservedWorker(() => proxyWorker(`runtime-proxy-worker-${suffix}`, { workspaceId, operationId: proxyId, signal })), { operationId: proxyId, status: 'succeeded' })
    await observe({ stage: 'review', status: 'reviewing-proxy', operationId: proxyId, phase: 'completed', completed: 4, eventTypes: ['operation.status.changed'] })
    const replay = await post(`/v1/projects/${projectId}/proxy-renders`, undefined, `runtime-proxy-${suffix}`, 202)
    assert.equal(replay.replayed, true); assert.equal((await client.v2Project.findUniqueOrThrow({ where: { id: projectId } })).status, 'reviewing-proxy')
    const review = await client.v2ProxyReview.findFirstOrThrow({ where: { workspaceId, projectId, operationId: proxyId } })
    assert.equal(review.status, 'ready-for-final')
    const proxyArtifact = await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: review.proxyArtifactId } })
    const annotation = await post(`/v1/projects/${projectId}/annotations`, { projectVersionId, proxyArtifactId: proxyArtifact.id,
      proxyHash: proxyArtifact.sha256, frame: 0, timeRangeMs: [0, 100], scope: 'point', targetIds: [],
      screenshotRef: await annotationScreenshot(proxyArtifact, 'annotation-main-frame-0'), text: 'Controlled runtime inspection; preserve framing.' }, `runtime-annotation-${suffix}`, 201)
    await pipeline.observe({ stage: 'annotation', projectId, annotationId: annotation.annotation.id, expectedEventTypes: ['annotation.created'], expectedState: 'reviewing-proxy' })
    const copy = await post(`/v1/projects/${projectId}/duplicates`, { expectedVersionId: projectVersionId,
      expectedVersionHash: projectVersionHash, name: 'Runtime isolated failure' }, `runtime-copy-${suffix}`, 201)
    await pipeline.observe({ stage: 'copy', projectId: copy.project.id, expectedEventTypes: ['project.created'], expectedState: 'draft' })
    const exportBody = { projectVersionId, projectVersionHash, format: '9:16', approval: { approved: true, note: 'Controlled W35 runtime inspection.' } }
    const final = await post(`/v1/projects/${projectId}/exports`, exportBody, `runtime-final-${suffix}`, 202)
    await observe({ stage: 'final-queued', status: 'rendering-final', operationId: final.operation.id, phase: 'queued', completed: 0, eventTypes: ['operation.status.changed'] })
    activeObserver = async (operation, kind) => observe({ stage: `final-${operation.phase}`, operationId: operation.id,
      status: 'rendering-final', phase: operation.phase, completed: operation.progress.completed,
      eventTypes: [kind === 'claimed' ? 'operation.status.changed' : 'operation.progress.changed'] })
    assert.deepEqual(await runObservedWorker(() => createProjectFinalExportWorker(environment)(`runtime-final-worker-${suffix}`, signal)), { operationId: final.operation.id, status: 'succeeded' })
    await observe({ stage: 'completed', status: 'completed', operationId: final.operation.id, phase: 'completed', completed: 4, eventTypes: ['operation.status.changed'] })
    const finalReplay = await post(`/v1/projects/${projectId}/exports`, exportBody, `runtime-final-${suffix}`, 202)
    assert.equal(finalReplay.replayed, true); assert.equal((await client.v2Project.findUniqueOrThrow({ where: { id: projectId } })).status, 'completed')
    const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')
    for (const operationId of [proxyId, final.operation.id]) {
      const operation = await client.v2PublicOperation.findUniqueOrThrow({ where: { id: operationId } })
      const outputId = JSON.parse(operation.resultJson).resource.id
      const artifact = await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: outputId } })
      const path = join(artifactRoot, ...artifact.artifactKey.split('/')); const bytes = await readFile(path)
      assert.equal(sha256(bytes), artifact.sha256); assert.equal(BigInt(bytes.length), artifact.byteSize)
      await exec(ffmpeg, ['-v', 'error', '-i', path, '-f', 'null', '-'], { windowsHide: true, timeout: 60000 })
      const probe = await probeVideo(path); const name = `${operation.type}.mp4`; await copyFile(path, join(directory, name))
      await exec(ffmpeg, ['-v', 'error', '-y', '-ss', '1', '-i', path, '-frames:v', '1', join(directory, `${operation.type}-frame.png`)], { windowsHide: true, timeout: 30000 })
      evidence.outputs.push({ operationId, artifactId: artifact.id, sha256: artifact.sha256, byteSize: bytes.length, name, probe, fullDecode: true })
    }
    activeObserver = null
    const compilation = JSON.parse((await client.v2ColorPipelineCompilation.findFirstOrThrow({ where: { workspaceId, projectId } })).compilationJson)
    await post(`/v1/projects/${copy.project.id}/color-pipeline-compilations`, {
      sourceArtifactId: compilation.sourceArtifactId, sourceManifestId: compilation.sourceManifestId,
      outputMetadata: compilation.pipeline.outputMetadata, stages: compilation.pipeline.stages,
    }, `runtime-copy-color-${suffix}`, 201)
    const selected = await post(`/v1/projects/${copy.project.id}/lut-selection`, {
      baseVersionId: copy.version.id, baseHash: copy.version.baseHash, selection: { mode: 'none' },
      reason: 'Controlled neutral rendering for independent runtime fence proof.',
    }, `runtime-copy-lut-${suffix}`, 201)
    const failedProxy = selected
    const newerProxy = await post(`/v1/projects/${copy.project.id}/proxy-renders`, undefined, `runtime-newer-proxy-${suffix}`, 202)
    const hidden = `${sourcePath}.owned-unavailable`
    await rename(sourcePath, hidden)
    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const outcome = await proxyWorker(`runtime-failure-worker-${suffix}`, { workspaceId, operationId: failedProxy.operation.id, signal })
        assert.equal(outcome.operationId, failedProxy.operation.id)
        assert.equal(outcome.status, attempt === 3 ? 'failed' : 'retrying'); await delay(10)
      }
    } finally { await rename(hidden, sourcePath) }
    const failedRow = await client.v2PublicOperation.findUniqueOrThrow({ where: { id: failedProxy.operation.id } })
    assert.equal(failedRow.status, 'failed')
    assert.equal((await client.v2Project.findUniqueOrThrow({ where: { id: copy.project.id } })).status, 'rendering-proxy', 'older failure cannot replace newer same-version admission')
    const rejectedRetry = await fetch(`${baseUrl}/v1/operations/${failedRow.id}/retry`, { method: 'POST', headers: { authorization }, signal: AbortSignal.timeout(30000) })
    const rejectedRetryBody = await rejectedRetry.json()
    assert.equal(rejectedRetryBody.error?.code, 'PROJECT_TRANSITION_REJECTED')
    assert.equal((await client.v2PublicOperation.findUniqueOrThrow({ where: { id: failedRow.id } })).status, 'failed', 'rejected retry rolls back its operation transition')
    assert.deepEqual(await proxyWorker(`runtime-newer-worker-${suffix}`, { workspaceId, operationId: newerProxy.operation.id, signal }), { operationId: newerProxy.operation.id, status: 'succeeded' })
    await observe({ stage: 'copy-review', id: copy.project.id, status: 'reviewing-proxy', operationId: newerProxy.operation.id, phase: 'completed', completed: 4, eventTypes: ['operation.status.changed'] })
    const copyReview = await client.v2ProxyReview.findUniqueOrThrow({ where: { operationId: newerProxy.operation.id } })
    const copyArtifact = await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: copyReview.proxyArtifactId } })
    const copyAnnotation = await post(`/v1/projects/${copy.project.id}/annotations`, {
      projectVersionId: selected.version.id, proxyArtifactId: copyArtifact.id, proxyHash: copyArtifact.sha256,
      frame: 0, timeRangeMs: [0, 100], scope: 'point', targetIds: [],
      screenshotRef: await annotationScreenshot(copyArtifact, 'annotation-copy-frame-0'), text: 'Ajustar enquadramento central.',
    }, `runtime-copy-annotation-${suffix}`, 201)
    await pipeline.observe({ stage: 'copy-annotation', projectId: copy.project.id, annotationId: copyAnnotation.annotation.id,
      expectedEventTypes: ['annotation.created'], expectedState: 'reviewing-proxy' })
    const proposal = await post(`/v1/projects/${copy.project.id}/patch-proposals`, { annotationId: copyAnnotation.annotation.id }, `runtime-proposal-${suffix}`, 201)
    assert.equal(proposal.proposal.status, 'ready')
    const applied = await post(`/v1/projects/${copy.project.id}/patch-proposals/${proposal.proposal.id}/apply`, { confirmed: true }, `runtime-patch-${suffix}`, 201)
    assert.equal((await client.v2ReviewAnnotation.findUniqueOrThrow({ where: { id: copyAnnotation.annotation.id } })).status, 'applied')
    await pipeline.observe({ stage: 'annotation-resolved', projectId: copy.project.id, annotationId: copyAnnotation.annotation.id,
      expectedEventTypes: ['annotation.resolved'], expectedState: 'rendering-proxy' })
    assert.deepEqual(await proxyWorker(`runtime-patch-worker-${suffix}`, { workspaceId, operationId: applied.operation.id, signal }), { operationId: applied.operation.id, status: 'succeeded' })
    await observe({ stage: 'patched-review', id: copy.project.id, status: 'reviewing-proxy', operationId: applied.operation.id, phase: 'completed', completed: 4, eventTypes: ['operation.status.changed'] })
    // Exhaust actual durable claims without any status seed or mutation. Each
    // abandoned claim owns a short lease; the next runtime claim settles it.
    const abandoned = await post(`/v1/projects/${copy.project.id}/proxy-renders`, undefined, `runtime-abandoned-${suffix}`, 202)
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
    await observe({ stage: 'retried-review', id: copy.project.id, status: 'reviewing-proxy', operationId: exhausted.id, phase: 'completed', completed: 4, eventTypes: ['operation.status.changed'] })
    // Advance the version through the real Command service while an older
    // admitted task still owns a lease. No newer admission masks this CAS test.
    const staleVersionJob = await post(`/v1/projects/${copy.project.id}/proxy-renders`, undefined, `runtime-stale-version-${suffix}`, 202)
    const claimAt = new Date()
    const staleClaim = await repository.claimNext({ type: 'project-proxy-render', workspaceId, operationId: staleVersionJob.operation.id,
      leaseOwner: `version-fence-worker-${suffix}`, now: claimAt.toISOString(), leaseUntil: new Date(claimAt.getTime() + 120000).toISOString() })
    const { setProjectLutSelectionService } = await import('../../../src/v2/application/project-lut-selections.ts')
    const { PrismaProjectLutSelectionRepository } = await import('../../../src/v2/infrastructure/prisma/project-lut-selection-repository.ts')
    const { randomUUID } = await import('node:crypto')
    const versionBeforeEdit = await client.v2ProjectVersion.findUniqueOrThrow({ where: { id: applied.version.id } })
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
    evidence.pipeline = await pipeline.finish(); evidence.outcome = 'passed'
  } catch (error) { primaryError = error; evidence.outcome = 'failed'; evidence.failure = { name: error.name, message: error.message }; throw error }
  finally {
    prototype.claimNext = originals.claimNext; prototype.advancePhase = originals.advancePhase
    try { evidence.postflight = await closeOwnedBrowser({ context, browser, server, child }); assert.equal(evidence.postflight.browserTerminal, true) }
    catch (error) { if (!primaryError) throw error; evidence.postflight.cleanupError = String(error) }
    finally { await writeFile(join(directory, 'w35-runtime.json'), JSON.stringify(evidence, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2)) }
  }
}
