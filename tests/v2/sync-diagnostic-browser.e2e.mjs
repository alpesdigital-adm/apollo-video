import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import net from 'node:net'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

/**
 * E2E — the Wave 19 pages in a real browser, against a production build.
 *
 * The domain decides correctly and the API says so plainly. This proves the
 * answer survives the last hop, which is where it is most often lost: the two
 * failures asserted here are the two an editor could be hurt by.
 *
 * 1. **A track nobody measured must never render as a number.** `offsetMs: null`
 *    drawn as "0,0 ms" reads as "measured, and it lines up" — the one thing
 *    nobody knows. The page has to say "não medido".
 * 2. **A blocked cut must name why it is blocked.** An operator told only
 *    "bloqueado" cannot act; every reason the server gave has to reach the
 *    screen.
 *
 * And on the pre-recording page, a required item must carry its consequence.
 * A checklist that only says what to do is a list of chores somebody running
 * late will reasonably skip.
 *
 * Needs PostgreSQL, a production build and Chrome, so it is opt-in.
 */

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Next server exited with ${child.exitCode}`)
    try { if ((await fetch(`${baseUrl}/v1/health`)).ok) return } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Next server did not become ready')
}

test('E2E-FR-147/149 the diagnostic page renders an unmeasured track as unmeasured', {
  skip: process.env.APOLLO_SYNC_DIAGNOSTIC_BROWSER_E2E !== '1'
    && 'set APOLLO_SYNC_DIAGNOSTIC_BROWSER_E2E=1 and use an isolated V2 database',
}, async () => {
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
  const { PrismaCaptureSessionRepository } = await import('../../src/v2/infrastructure/prisma/capture-session-repository.ts')
  const { PrismaSyncDiagnosticRepository } = await import('../../src/v2/infrastructure/prisma/sync-diagnostic-repository.ts')
  const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
  const { createUiPasswordHash } = await import('../../src/v2/infrastructure/security/ui-session.ts')
  const { createCaptureSession } = await import('../../src/v2/domain/capture-session.ts')
  const { createSyncDiagnostic, deriveTrackStatus } = await import('../../src/v2/domain/sync-diagnostic.ts')
  const { createTickInterval, timebaseFromRate } = await import('../../src/v2/domain/session-time.ts')

  const client = new PrismaClient()
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `w19-browser-${suffix}`
  const projectId = `w19-project-${suffix}`
  const sessionId = `w19-session-${suffix}`
  const createdAt = new Date('2029-04-01T09:00:00.000Z')
  const uiUsername = `w19-user-${suffix}`
  const uiPassword = `Sync-Diagnostic-${suffix}-secure`
  const t = (n) => BigInt(n)
  const sec = (n) => t(90_000) * t(n)
  const h = (n) => String(n).repeat(64).slice(0, 64)
  let server
  let browser

  const cleanup = async () => {
    await client.v2SyncDiagnosticHead.deleteMany({ where: { workspaceId } })
    await client.v2SyncDiagnostic.deleteMany({ where: { workspaceId } })
    await client.v2SyncMarkerDetection.deleteMany({ where: { workspaceId } })
    await client.v2SyncMarker.deleteMany({ where: { workspaceId } })
    await client.v2CaptureProtocolEvaluation.deleteMany({ where: { workspaceId } })
    await client.v2CaptureSessionProtocol.deleteMany({ where: { workspaceId } })
    await client.v2CaptureSessionVersion.deleteMany({ where: { workspaceId } })
    await client.v2CaptureSessionHead.deleteMany({ where: { workspaceId } })
    await client.v2Project.deleteMany({ where: { workspaceId } })
    // Before the API client, not after: bootstrap login provisions a UI
    // principal pointing at it, and that relation is onDelete: Restrict.
    await client.v2WorkspaceUiPrincipal.deleteMany({ where: { workspaceId } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId } })
    await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
  }

  const track = (trackId, role) => ({
    trackId,
    role,
    device: { deviceId: `${trackId}-d`, recorderId: `${trackId}-r`, make: null, model: null, serial: null },
    sourceAssetId: `asset-${trackId}`,
    timebase: timebaseFromRate(90_000),
    streamIndex: 0,
    syncAudioPolicy: role === 'camera-main' ? 'final-candidate' : 'sync-only',
    includeInFinalMix: role === 'camera-main',
    parts: [{
      partId: `part-${trackId}`,
      ordinal: 0,
      sourceAssetId: `asset-${trackId}`,
      timebase: timebaseFromRate(90_000),
      coverage: createTickInterval(t(0), sec(600)),
      streamIndex: 0,
      splitReason: 'single-file',
      evidence: {
        ingestArtifactId: `artifact-${trackId}`,
        ingestSha256: h(1),
        probeHash: h(2),
        probeSource: 'packet-scan',
        observedAt: createdAt.toISOString(),
      },
    }],
  })

  try {
    await cleanup()
    await client.v2Workspace.create({
      data: {
        id: workspaceId, slug: workspaceId, name: 'Wave 19 browser E2E',
        status: 'active', createdAt, updatedAt: createdAt,
      },
    })
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => createdAt,
    })({
      id: `w19-client-${suffix}`,
      workspaceId,
      name: 'Wave 19 browser E2E',
      environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })
    await client.v2Project.create({
      data: {
        id: projectId, workspaceId, name: 'Wave 19 browser E2E',
        status: 'reviewing-proxy', objective: 'discovery', format: '9:16', locale: 'pt-BR',
        createdByType: 'api-client', createdById: issued.client.id,
        createdAt, updatedAt: createdAt,
      },
    })

    const session = createCaptureSession({
      workspaceId,
      projectId,
      sessionId,
      clock: { timebase: timebaseFromRate(90_000), rounding: 'nearest-half-even' },
      referenceTrackId: 'track-camera-main',
      tracks: [track('track-camera-main', 'camera-main')],
      lineage: {
        commandId: `command-${suffix}`,
        operation: 'create-session',
        actorKind: 'human',
        actorId: uiUsername,
        occurredAt: createdAt.toISOString(),
        note: null,
      },
      createdAt: createdAt.toISOString(),
    })
    await new PrismaCaptureSessionRepository(client).appendVersion({
      session, occurredAt: createdAt.toISOString(),
    })

    // The state the page has to render honestly: a screen recorder nothing
    // could be aligned against. No offset, no residual, no coverage — and
    // therefore no cut.
    const diagnostic = createSyncDiagnostic({
      workspaceId,
      sessionId,
      referenceTrackId: 'track-camera-main',
      version: 1,
      previousVersionHash: null,
      sessionVersion: session.version,
      referenceEpoch: session.referenceEpoch,
      tracks: [{
        trackId: 'track-screen',
        methods: [],
        confidence: 0,
        offsetMs: null,
        residualMs: null,
        driftPpm: null,
        coverageBps: null,
        gaps: [createTickInterval(sec(120), sec(130))],
        automaticAnchors: [],
        manualAnchors: [],
        pieceIds: [],
        status: deriveTrackStatus({
          offsetMs: null,
          residualMs: null,
          coverageBps: null,
          confidence: 0,
          hasContradictoryAnchors: false,
        }),
        warnings: ['insufficient-evidence'],
        previewSampleMs: [],
      }],
      protocolCeiling: 'manual-anchors-required',
      generatedAt: createdAt.toISOString(),
    })
    assert.equal(diagnostic.status, 'needs-input')
    await new PrismaSyncDiagnosticRepository(client).appendVersion({
      diagnostic, occurredAt: createdAt.toISOString(),
    })

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
        // Without these the login page resolves to 'unavailable' and renders
        // no password form: the system fails closed when no auth mode is
        // declared, which is correct, and which a test has to opt into.
        APOLLO_AUTH_MODE: 'bootstrap',
        APOLLO_ALLOW_BOOTSTRAP_AUTH: 'true',
        APOLLO_UI_BOOTSTRAP_ROLE: 'operator',
        APOLLO_UI_USERNAME: uiUsername,
        APOLLO_UI_PASSWORD_HASH: createUiPasswordHash(uiPassword, `w19-salt-${suffix}`),
        APOLLO_UI_SESSION_SECRET: `w19-session-secret-${suffix}-at-least-32`,
        APOLLO_UI_API_CLIENT_ID: issued.client.id,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stdout.on('data', (chunk) => { serverLogs += String(chunk) })
    server.stderr.on('data', (chunk) => { serverLogs += String(chunk) })
    await waitForServer(baseUrl, server)

    // Stated plainly before the browser is involved, so a failure below is a
    // rendering failure rather than an ambiguous one.
    const authorization = `Bearer ${issued.token}`
    const apiResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/capture-sessions/${sessionId}/sync-diagnostic`,
      { headers: { authorization } },
    )
    const apiPayload = await apiResponse.json()
    assert.equal(apiResponse.status, 200, `${JSON.stringify(apiPayload)}\n${serverLogs.slice(-4_000)}`)
    assert.equal(apiPayload.data.diagnostic.tracks[0].offsetMs, null)
    assert.equal(apiPayload.data.diagnostic.tracks[0].coverageBps, null)
    assert.equal(apiPayload.data.diagnostic.autoEdit.allowed, false)
    assert.ok(apiPayload.data.diagnostic.autoEdit.blockedBy.length > 0)

    const executablePath = [
      process.env.PLAYWRIGHT_CHROME_EXECUTABLE,
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
    ].find((candidate) => candidate && existsSync(candidate))
    assert.ok(executablePath, 'set PLAYWRIGHT_CHROME_EXECUTABLE to run the sync diagnostic browser E2E')

    const { chromium } = await import('playwright-core')
    browser = await chromium.launch({ executablePath, headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } })
    const page = await context.newPage()

    // ---- the pre-recording page -----------------------------------------
    await page.goto(`${baseUrl}/login?next=${encodeURIComponent('/capture-protocols')}`)
    await page.locator('input[name="username"]').fill(uiUsername)
    await page.locator('input[name="password"]').fill(uiPassword)
    await page.getByRole('button', { name: 'Entrar no Apollo' }).click()
    await page.waitForURL('**/capture-protocols**')

    await page.getByTestId('protocol-list').waitFor({ state: 'visible' })
    await page.getByTestId('protocol-teacher-and-screen').click()
    await page.getByTestId('protocol-detail').waitFor({ state: 'visible' })
    await page.getByTestId('required-list').waitFor({ state: 'visible' })

    // Every required item carries its consequence. A checklist without it is a
    // list of chores, and the whole point of reading this before the shoot is
    // knowing what each item costs.
    const requiredItems = page.getByTestId('required-list').locator('> li')
    const requiredCount = await requiredItems.count()
    assert.ok(requiredCount > 0, 'the protocol showed no required items at all')
    for (let index = 0; index < requiredCount; index += 1) {
      const consequence = await requiredItems.nth(index).locator('[data-testid^="consequence-"]').textContent()
      assert.ok(
        (consequence ?? '').trim().length > 10,
        `a required item was shown without saying what it costs to skip it`,
      )
    }

    // ---- the diagnostic page --------------------------------------------
    await page.goto(
      `${baseUrl}/sync-diagnostic?projeto=${encodeURIComponent(projectId)}`
      + `&sessao=${encodeURIComponent(sessionId)}`,
    )
    await page.getByTestId('diagnostic').waitFor({ state: 'visible' })

    // The assertion this file exists for.
    assert.equal(
      (await page.getByTestId('offset-track-screen').textContent())?.trim(),
      'não medido',
      'an unmeasured offset was rendered as a number',
    )
    assert.equal(
      (await page.getByTestId('coverage-track-screen').textContent())?.trim(),
      'não medida',
      'unmeasured coverage was rendered as a percentage',
    )
    await page.getByTestId('unmeasured-track-screen').waitFor({ state: 'visible' })

    // And the block names its reasons, all of them.
    const autoEdit = page.getByTestId('auto-edit')
    assert.equal(await autoEdit.getAttribute('data-allowed'), 'false')
    const shownReasons = await page.getByTestId('auto-edit-blocked').locator('li').allTextContents()
    for (const reason of apiPayload.data.diagnostic.autoEdit.blockedBy) {
      assert.ok(
        shownReasons.some((shown) => shown.includes(reason)),
        `the server refused for "${reason}" and the page did not say so`,
      )
    }

    // Nowhere may this track be presented as aligned or as sitting at zero.
    const body = (await page.locator('body').textContent()) ?? ''
    assert.doesNotMatch(
      body,
      /track-screen[\s\S]{0,200}0[,.]0 ms/,
      'a track nobody measured was rendered as zero milliseconds',
    )

    console.log(
      `browser: ${requiredCount} required items each with a consequence; `
      + `unmeasured track rendered as "não medido"; `
      + `${shownReasons.length} block reasons shown`,
    )
  } finally {
    if (browser) await browser.close()
    if (server && server.exitCode === null) {
      server.kill('SIGTERM')
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    // Reported, not rethrown: a cleanup failure that masks the real assertion
    // turns one clear defect into two confusing ones.
    try {
      await cleanup()
    } catch (error) {
      console.error('cleanup failed:', error?.message ?? error)
    } finally {
      await client.$disconnect()
    }
  }
})
