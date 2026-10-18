import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import net from 'node:net'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Next server exited with ${child.exitCode}`)
    try { if ((await fetch(`${baseUrl}/v1/health`)).ok) return } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Next server did not become ready')
}

test('T-FR-230 persists the post-render proxy verdict and exposes an API/UI warning gate', {
  skip: process.env.APOLLO_PROXY_REVIEW_E2E !== '1' && 'set APOLLO_PROXY_REVIEW_E2E=1 and use an isolated V2 database',
}, async () => {
  const { calculateVersionHash, stableSerialize } = await import('../../src/v2/application/version-hash.ts')
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { evaluateRenderedProxy } = await import('../../src/v2/application/render-workflow.ts')
  const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
  const { PrismaProxyReviewRepository } = await import('../../src/v2/infrastructure/prisma/proxy-review-repository.ts')
  const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
  const { createUiPasswordHash } = await import('../../src/v2/infrastructure/security/ui-session.ts')
  const { createMediaArtifactManifest } = await import('../../src/v2/domain/media-artifact.ts')
  const { RECORDING_ALLOWED_USES, commitSealedChild, planPlayingRecordings, testActor } = await import('./helpers/pg-output-world.mjs')
  const { materializeActorAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
  const { grantRendering, registerColorPipeline, registerMeasuredVideo, seedReviewProject } = await import('./helpers/review-edit-world.mjs')

  const client = new PrismaClient()
  const repository = new PrismaProxyReviewRepository(client)
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `proxy-review-workspace-${suffix}`
  const projectId = `proxy-review-project-${suffix}`
  const artifactId = `proxy-review-artifact-${suffix}`
  const manifestId = `proxy-review-manifest-${suffix}`
  const operationId = `proxy-review-operation-${suffix}`
  const reviewId = `proxy-review-${suffix}`
  const createdAt = new Date('2026-07-26T18:00:00.000Z')
  const uiUsername = `proxy-review-user-${suffix}`
  const uiPassword = `Proxy-Review-${suffix}-secure`
  const uiSessionSecret = `proxy-review-session-secret-${suffix}-at-least-32`
  const proxySha256 = calculateVersionHash({ artifactId })
  const renderCompletedAt = new Date(createdAt.getTime() + 65_000)
  const lease = { owner: `proxy-review-worker-${suffix}`, attempt: 1, now: renderCompletedAt.toISOString() }
  let server
  let browser

  // Sealed rows are append-only: every identity above carries this run's suffix and nothing is deleted.
  try {
    await client.v2Workspace.create({
      data: { id: workspaceId, slug: workspaceId, name: 'Proxy review E2E', status: 'active', createdAt, updatedAt: createdAt },
    })
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => createdAt,
    })({
      id: `proxy-review-client-${suffix}`,
      workspaceId,
      name: 'Proxy review E2E',
      environment: 'production',
      scopes: ['projects:read', 'projects:write', 'projects:approve'],
    })
    // The project is the sealed world the product builds (creation Command, then one explicit 9:16 output variant as its head
    // Version); the proxy review hangs off that Version. The project is under review when the proxy is rendered.
    const actor = testActor({ workspaceId, clientId: issued.client.id, credentialId: issued.credential.id, environment: 'production',
      scopes: ['projects:read', 'projects:write', 'projects:approve'] })
    await seedReviewProject(client, { workspaceId, actor, prefix: 'proxy-review', ids: { project: projectId },
      name: 'Proxy review E2E', aspectRatio: '9:16', status: 'reviewing-proxy',
      briefing: 'Validar o proxy antes da alta.' })
    const audit = materializeActorAuditContext(actor)
    // The recording the proxy was rendered from: its persisted ingest, and the colour pipeline compilation a proxy render binds to.
    const sourceArtifactId = `proxy-review-source-${suffix}`
    const sourceManifestId = `proxy-review-source-manifest-${suffix}`
    const registered = await registerMeasuredVideo(client, { workspaceId, projectId, actor, artifactId: sourceArtifactId, artifactKey: `proxy-review/${sourceArtifactId}.mp4`,
      sha256: calculateVersionHash({ sourceArtifactId }), byteSize: 4096, probe: { width: 540, height: 960, duration: 2, fps: 30 },
      slug: `proxy-review-${suffix}`, manifestId: sourceManifestId, originalFileName: 'proxy-review-source.mp4', createdAt })
    const compilation = await registerColorPipeline(client, { workspaceId, projectId, actor, artifactId: sourceArtifactId, manifestId: sourceManifestId, createdAt })
    // The review is a critique of the output of its Version, and the one persisted consumption reader admits only an output the State
    // materialized (the empty variant is blocked with `empty-project`): the head plays the recording above, whose ingest is adopted.
    const rightsActor = testActor({ workspaceId, clientId: issued.client.id, credentialId: issued.credential.id, environment: 'production', scopes: ['artifacts:rights'] })
    await grantRendering(client, { workspaceId, artifactId: sourceArtifactId, actor: rightsActor, snapshotId: `proxy-review-source-rights-${suffix}`,
      allowedUses: [...RECORDING_ALLOWED_USES], clock: () => createdAt })
    const head = await commitSealedChild(client, { workspaceId, projectId, actor, suffix: `proxy-review-${suffix}-ingested`,
      mutatePlan: planPlayingRecordings([{ slug: `proxy-review-${suffix}`, names: { sourceArtifactId }, receipt: registered.receipt.receipt }]), adopt: [sourceArtifactId] })
    const projectVersionId = head.version.id
    const editPlanSnapshotId = head.editPlanSnapshot.id
    const editPlan = JSON.parse(head.editPlanSnapshot.contentJson)
    const inputHash = calculateVersionHash({ projectId, projectVersionId, kind: 'proxy' })
    await client.v2MediaArtifact.create({
      data: {
        id: artifactId,
        workspaceId,
        artifactKey: `proxy-review/${artifactId}.mp4`,
        sha256: proxySha256,
        byteSize: 1n,
        mediaType: 'video',
        container: 'mp4',
        status: 'available',
        createdAt,
      },
    })
    // The workspace projection and the review preview read this manifest back and bind it to the artifact row.
    const proxyManifest = createMediaArtifactManifest({
      artifactKey: `proxy-review/${artifactId}.mp4`, artifactSha256: proxySha256, byteSize: 1, mediaType: 'video', container: 'mp4',
      recipe: { id: 'proxy-review', version: '1.0.0', parameters: { manifestId } },
      probe: { width: 540, height: 960, duration: 2, fps: 30 },
    })
    await client.v2MediaArtifactManifest.create({
      data: {
        id: manifestId,
        workspaceId,
        artifactId,
        schemaVersion: proxyManifest.schemaVersion,
        manifestHash: proxyManifest.manifestHash,
        recipeId: proxyManifest.recipe.id,
        recipeVersion: proxyManifest.recipe.version,
        parametersHash: proxyManifest.recipe.parametersHash,
        manifestJson: stableSerialize(proxyManifest),
        createdAt,
      },
    })
    await client.v2ProjectMediaAsset.create({
      data: {
        id: randomUUID(),
        workspaceId,
        projectId,
        artifactId,
        role: 'editorial-proxy',
        originalFileName: 'proxy-review.mp4',
        createdAt,
      },
    })
    await client.v2PublicOperation.create({
      data: {
        id: operationId,
        workspaceId,
        projectId,
        clientId: issued.client.id,
        actorCredentialId: actor.credentialId,
        actorEnvironment: actor.environment,
        actorAuthenticationKind: 'bearer',
        actorContextHash: audit.contextHash,
        type: 'project-proxy-render',
        status: 'running',
        phase: 'persisting',
        targetType: 'media-artifact',
        targetId: artifactId,
        cancelable: true,
        retryable: false,
        attempt: 1,
        maxAttempts: 3,
        progressCompleted: 3, progressTotal: 4, progressUnit: 'render',
        leaseOwner: lease.owner, leaseExpiresAt: new Date(renderCompletedAt.getTime() + 60_000), heartbeatAt: renderCompletedAt,
        idempotencyKey: `proxy-review-render-${suffix}`,
        requestFingerprint: inputHash,
        createdAt,
        updatedAt: createdAt,
        startedAt: createdAt,
      },
    })
    await client.v2ProjectProxyRenderOperation.create({
      data: {
        operationId,
        workspaceId,
        projectId,
        projectVersionId,
        editPlanSnapshotId,
        sourceArtifactId,
        sourceManifestId,
        colorPipelineBindingsJson: stableSerialize([{ sourceArtifactId, sourceManifestId, compilationId: compilation.id,
          compilationHash: compilation.compilationHash, pipelineHash: compilation.pipeline.pipelineHash }]),
        inputHash,
        outputArtifactId: artifactId,
        outputManifestId: manifestId,
        originalFileName: 'proxy-review.mp4',
        createdAt,
      },
    })
    const review = evaluateRenderedProxy({
      projectVersionId,
      proxyArtifactId: artifactId,
      proxyManifestId: manifestId,
      proxySha256,
      inputHash,
      format: '9:16',
      sourceSha256: calculateVersionHash({ source: suffix }),
      editPlanHash: calculateVersionHash(editPlan),
      expectedDurationMs: 2_000,
      uploadReceivedAt: createdAt.toISOString(),
      renderCompletedAt: renderCompletedAt.toISOString(),
      probe: { width: 540, height: 960, duration: 2, fps: 30, codec: 'h264', container: 'mp4' },
      map: {
        schemaVersion: 'render-element-map/v1',
        mapHash: calculateVersionHash({ map: suffix }),
        proxyHash: proxySha256,
        fps: 30,
        durationFrames: 60,
        canvas: { width: 540, height: 960 },
        elements: [],
      },
      criticIssues: [{
        code: 'EDITORIAL_PACING_WARNING',
        severity: 'warning',
        category: 'editorial',
        message: 'A cadência merece confirmação humana antes da alta.',
        rangeMs: [500, 1_500],
        targetId: 'scene-1',
        correctable: true,
      }],
    })
    assert.equal(review.status, 'warning-ack-required')
    assert.equal(review.finalAllowed, false)
    const persisted = await repository.persistGenerated({
      id: reviewId,
      workspaceId,
      projectId,
      operationId,
      review,
      createdAt: renderCompletedAt.toISOString(),
      lease,
    })
    // Controlled persistence fixture: the terminal state follows the leased review commit.
    await client.v2PublicOperation.update({ where: { id: operationId }, data: {
      status: 'succeeded', phase: 'completed', cancelable: false, progressCompleted: 4,
      leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null, completedAt: renderCompletedAt,
      resultJson: stableSerialize({ resource: { type: 'media-artifact', id: artifactId, manifestId } }),
    } })
    assert.equal(persisted.revision, 1)
    assert.equal((await repository.findCurrent({ workspaceId, projectId }))?.reviewHash, review.reviewHash)

    const port = await getFreePort()
    const baseUrl = `http://127.0.0.1:${port}`
    let serverLogs = ''
    server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        __NEXT_PROCESSED_ENV: 'true',
        APOLLO_API_ENVIRONMENT: 'production',
        APOLLO_AUTH_MODE: 'bootstrap', APOLLO_ALLOW_BOOTSTRAP_AUTH: 'true', APOLLO_UI_BOOTSTRAP_ROLE: 'operator',
        APOLLO_UI_USERNAME: uiUsername,
        APOLLO_UI_PASSWORD_HASH: createUiPasswordHash(uiPassword, `proxy-review-salt-${suffix}`),
        APOLLO_UI_SESSION_SECRET: uiSessionSecret,
        APOLLO_UI_API_CLIENT_ID: issued.client.id,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stdout.on('data', (chunk) => { serverLogs += String(chunk) })
    server.stderr.on('data', (chunk) => { serverLogs += String(chunk) })
    await waitForServer(baseUrl, server)
    const authorization = `Bearer ${issued.token}`
    const getResponse = await fetch(`${baseUrl}/v1/projects/${projectId}/proxy-reviews`, {
      headers: { authorization },
    })
    const getPayload = await getResponse.json()
    assert.equal(getResponse.status, 200, `${JSON.stringify(getPayload)}\n${serverLogs.slice(-4_000)}`)
    assert.equal(getPayload.data.review.status, 'warning-ack-required')
    assert.equal(getPayload.data.review.finalAllowed, false)
    const workspaceResponse = await fetch(`${baseUrl}/v1/projects/${projectId}/workspace`, {
      headers: { authorization },
    })
    const workspacePayload = await workspaceResponse.json()
    let workspaceDiagnostic = '' // Failure diagnostics: the route hides which stored fact the projection refused.
    if (workspaceResponse.status !== 200) {
      const { PrismaProjectWorkspaceQueryRepository } = await import('../../src/v2/infrastructure/prisma/project-workspace-query-repository.ts')
      try { await new PrismaProjectWorkspaceQueryRepository(client).read({ workspaceId, projectId }) } catch (error) { workspaceDiagnostic = `${error?.code} ${error?.message} ${JSON.stringify(error?.details ?? null)}` }
    }
    assert.equal(
      workspaceResponse.status,
      200,
      `${JSON.stringify(workspacePayload)}\n${workspaceDiagnostic}\n${serverLogs.slice(-4_000)}`,
    )

    const executablePath = [
      process.env.PLAYWRIGHT_CHROME_EXECUTABLE,
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
    ].find((candidate) => candidate && existsSync(candidate))
    assert.ok(executablePath, 'set PLAYWRIGHT_CHROME_EXECUTABLE to run the proxy review browser E2E')
    const { chromium } = await import('playwright-core')
    browser = await chromium.launch({ executablePath, headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    await page.goto(`${baseUrl}/login?next=${encodeURIComponent(`/projects/${projectId}`)}`)
    await page.locator('input[name="username"]').fill(uiUsername)
    await page.locator('input[name="password"]').fill(uiPassword)
    await page.getByRole('button', { name: 'Entrar no Apollo' }).click()
    await page.waitForURL(`**/projects/${projectId}`)
    const proxyGate = page.getByTestId('proxy-review-gate')
    await page.waitForTimeout(1_500)
    const workspaceText = await page.locator('body').textContent()
    assert.match(workspaceText, /Laudo do proxy/, `${page.url()}\n${workspaceText}\n${serverLogs.slice(-4_000)}`)
    await proxyGate.waitFor({ state: 'visible' })
    await page.getByText('Ressalvas para decidir').waitFor({ state: 'visible' })
    assert.match(await proxyGate.textContent(), /Ressalvas para decidir/)
    assert.match(await proxyGate.textContent(), /EDITORIAL|cadência|Ressalvas/i)
    const acknowledgedResponse = page.waitForResponse((response) =>
      response.url().endsWith(`/v1/projects/${projectId}/proxy-reviews`)
      && response.request().method() === 'POST',
    )
    await page.getByTestId('proxy-review-acknowledge').click()
    assert.equal((await acknowledgedResponse).status(), 201)
    await page.getByText('Liberado para alta').waitFor({ state: 'visible' })
    assert.match(await proxyGate.textContent(), /0\s*Bloqueios|Bloqueios\s*0/i)

    const storedDecision = await client.v2ProxyReviewDecision.findFirst({
      where: { workspaceId, projectId },
    })
    assert.ok(storedDecision)
    const decisionBody = {
      action: 'acknowledge-warnings',
      proxyReviewId: reviewId,
      projectVersionId,
      baseRevision: review.reviewHash,
      expectedRevision: 1,
    }
    // The decision was taken by the UI session, and an idempotency key belongs to the authenticated context that used it: the
    // replay is sent by the same session (the browser context's cookies), not by the bearer client.
    const replayResponse = await page.request.post(`${baseUrl}/v1/projects/${projectId}/proxy-reviews`, {
      headers: { 'content-type': 'application/json', 'idempotency-key': storedDecision.idempotencyKey },
      data: JSON.stringify(decisionBody),
    })
    const replayPayload = await replayResponse.json()
    assert.equal(replayResponse.status(), 200, JSON.stringify(replayPayload))
    assert.equal(replayPayload.data.replayed, true)
    assert.equal(replayPayload.data.review.finalAllowed, true)
    assert.equal(replayPayload.data.review.revision, 2)

    const staleResponse = await fetch(`${baseUrl}/v1/projects/${projectId}/proxy-reviews`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': `proxy-review-stale-${suffix}`,
      },
      body: JSON.stringify(decisionBody),
    })
    const stalePayload = await staleResponse.json()
    assert.equal(staleResponse.status, 409, JSON.stringify(stalePayload))
    assert.equal(await client.v2ProxyReviewDecision.count({ where: { workspaceId, projectId } }), 1)
    const finalReview = await repository.findCurrent({ workspaceId, projectId })
    assert.equal(finalReview.finalAllowed, true)
    assert.equal(finalReview.warningsAcknowledged, true)
    assert.equal(finalReview.revision, 2)
    await context.close()
    await browser.close()
    browser = undefined
  } finally {
    if (browser) await browser.close()
    if (server && server.exitCode === null) {
      server.kill()
      await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))])
    }
    await client.$disconnect()
  }
})
