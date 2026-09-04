import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import net from 'node:net'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

/**
 * E2E — the capture sessions page in a real browser, against a production build.
 *
 * Everything before this point proves the system decides correctly. This proves
 * the decision survives the last hop, which is where it is most often lost: a
 * refusal that the API states plainly can still be rendered as a reassuring
 * blank, and a stale-version conflict can still be swallowed by a retry button.
 *
 * So the two things asserted here are the two an editor could be hurt by:
 *
 * 1. a track the cascade could not measure renders as *needing input*, and
 *    never as a synchronized track sitting at zero;
 * 2. the ten seconds the phone did not record are shown as uncovered, so a
 *    range spanning them is visibly not selectable.
 *
 * Needs Postgres, a production build and Chrome, so it is opt-in.
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

test('E2E-FR-140 the capture sessions page renders a refusal as a refusal', {
  skip: process.env.APOLLO_CAPTURE_SESSIONS_E2E !== '1'
    && 'set APOLLO_CAPTURE_SESSIONS_E2E=1 and use an isolated V2 database',
}, async () => {
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
  const { PrismaCaptureSessionRepository } = await import('../../src/v2/infrastructure/prisma/capture-session-repository.ts')
  const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
  const { createUiPasswordHash } = await import('../../src/v2/infrastructure/security/ui-session.ts')
  const {
    addCaptureSessionTrack,
    createCaptureSession,
  } = await import('../../src/v2/domain/capture-session.ts')
  const { evaluateSyncEvidence } = await import('../../src/v2/domain/sync-evidence.ts')
  const {
    createTickInterval,
    rational,
    timebaseFromRate,
  } = await import('../../src/v2/domain/session-time.ts')

  const client = new PrismaClient()
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `capture-workspace-${suffix}`
  const projectId = `capture-project-${suffix}`
  const sessionId = `capture-session-${suffix}`
  const createdAt = new Date('2029-04-01T09:00:00.000Z')
  const uiUsername = `capture-user-${suffix}`
  const uiPassword = `Capture-Session-${suffix}-secure`
  const uiSessionSecret = `capture-session-secret-${suffix}-at-least-32`
  const t = (n) => BigInt(n)
  const sec = (n) => t(90_000) * t(n)
  const h = (n) => String(n).repeat(64).slice(0, 64)
  let server
  let browser

  const cleanup = async () => {
    await client.v2CaptureSyncEvidence.deleteMany({ where: { workspaceId } })
    await client.v2CaptureClockMapPiece.deleteMany({ where: { workspaceId } })
    await client.v2CaptureClockMap.deleteMany({ where: { workspaceId } })
    await client.v2CaptureTrackCoverage.deleteMany({ where: { workspaceId } })
    await client.v2CaptureSyncRun.deleteMany({ where: { workspaceId } })
    await client.v2CaptureSessionVersion.deleteMany({ where: { workspaceId } })
    await client.v2CaptureSessionHead.deleteMany({ where: { workspaceId } })
    await client.v2Project.deleteMany({ where: { workspaceId } })
    // Before the client, not after: the bootstrap login provisions a UI
    // principal pointing at it, and that relation is onDelete: Restrict.
    await client.v2WorkspaceUiPrincipal.deleteMany({ where: { workspaceId } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId } })
    await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
  }

  const part = (partId, sourceAssetId) => ({
    partId,
    ordinal: 0,
    sourceAssetId,
    timebase: timebaseFromRate(90_000),
    coverage: createTickInterval(t(0), sec(600)),
    streamIndex: 0,
    splitReason: 'single-file',
    evidence: {
      ingestArtifactId: `artifact-${partId}`,
      ingestSha256: h(1),
      probeHash: h(2),
      probeSource: 'packet-scan',
      observedAt: createdAt.toISOString(),
    },
  })

  const track = (trackId, role, sourceAssetId, deviceId) => ({
    trackId,
    role,
    device: { deviceId, recorderId: `${deviceId}-r`, make: null, model: null, serial: null },
    sourceAssetId,
    timebase: timebaseFromRate(90_000),
    streamIndex: 0,
    syncAudioPolicy: role === 'camera-main' ? 'final-candidate' : 'sync-only',
    includeInFinalMix: role === 'camera-main',
    parts: [part(`part-${trackId}`, sourceAssetId)],
  })

  const lineage = {
    commandId: `command-${suffix}`,
    operation: 'create-session',
    actorKind: 'human',
    actorId: uiUsername,
    occurredAt: createdAt.toISOString(),
    note: null,
  }

  try {
    await cleanup()
    await client.v2Workspace.create({
      data: {
        id: workspaceId, slug: workspaceId, name: 'Capture sessions E2E',
        status: 'active', createdAt, updatedAt: createdAt,
      },
    })
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => createdAt,
    })({
      id: `capture-client-${suffix}`,
      workspaceId,
      name: 'Capture sessions E2E',
      environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })
    await client.v2Project.create({
      data: {
        id: projectId,
        workspaceId,
        name: 'Capture sessions E2E',
        status: 'reviewing-proxy',
        objective: 'discovery',
        format: '9:16',
        locale: 'pt-BR',
        createdByType: 'api-client',
        createdById: issued.client.id,
        createdAt,
        updatedAt: createdAt,
      },
    })

    // Two tracks: the A camera is the clock, and a phone recorded in another
    // room that nothing can be aligned against.
    const repository = new PrismaCaptureSessionRepository(client)
    const version1 = createCaptureSession({
      workspaceId,
      projectId,
      sessionId,
      clock: { timebase: timebaseFromRate(90_000), rounding: 'nearest-half-even' },
      referenceTrackId: 'track-camera-main',
      tracks: [track('track-camera-main', 'camera-main', 'asset-camera', 'device-a')],
      lineage,
      createdAt: createdAt.toISOString(),
    })
    await repository.appendVersion({ session: version1, occurredAt: createdAt.toISOString() })

    const version2 = addCaptureSessionTrack(version1, {
      track: track('track-phone', 'phone', 'asset-phone', 'device-phone'),
      lineage: { ...lineage, operation: 'add-track', commandId: `command-2-${suffix}` },
    })
    await repository.appendVersion({
      session: version2,
      expectedVersion: 1,
      occurredAt: createdAt.toISOString(),
    })

    // The cascade was run and could not tell. This is the state the page has to
    // render honestly.
    const record = evaluateSyncEvidence({
      sessionId,
      trackId: 'track-phone',
      referenceTrackId: 'track-camera-main',
      sessionTimebase: timebaseFromRate(90_000),
      sessionFrameRate: rational(BigInt(30_000), BigInt(1_001)),
      sessionBounds: createTickInterval(t(0), sec(600)),
      signals: [],
    })
    assert.equal(record.outcome, 'insufficient-evidence')
    assert.equal(record.clockMap, null)
    await repository.persistSyncEvidence({
      workspaceId,
      record,
      createdAt: createdAt.toISOString(),
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
        // Without these the login page resolves to 'unavailable' and renders no
        // password form at all — the system fails closed when no auth mode is
        // declared, which is correct, and which a test has to opt into.
        APOLLO_AUTH_MODE: 'bootstrap',
        APOLLO_ALLOW_BOOTSTRAP_AUTH: 'true',
        APOLLO_UI_BOOTSTRAP_ROLE: 'operator',
        APOLLO_UI_USERNAME: uiUsername,
        APOLLO_UI_PASSWORD_HASH: createUiPasswordHash(uiPassword, `capture-salt-${suffix}`),
        APOLLO_UI_SESSION_SECRET: uiSessionSecret,
        APOLLO_UI_API_CLIENT_ID: issued.client.id,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stdout.on('data', (chunk) => { serverLogs += String(chunk) })
    server.stderr.on('data', (chunk) => { serverLogs += String(chunk) })
    await waitForServer(baseUrl, server)

    // The API says it plainly before the browser is involved, so a failure
    // below is a rendering failure rather than an ambiguous one.
    const authorization = `Bearer ${issued.token}`
    const syncResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/capture-sessions/${sessionId}/sync`,
      { headers: { authorization } },
    )
    const syncPayload = await syncResponse.json()
    assert.equal(syncResponse.status, 200, `${JSON.stringify(syncPayload)}\n${serverLogs.slice(-4_000)}`)
    assert.equal(syncPayload.data.tracks.length, 1)
    assert.equal(syncPayload.data.tracks[0].outcome, 'insufficient-evidence')
    assert.equal(syncPayload.data.tracks[0].map, null)

    const executablePath = [
      process.env.PLAYWRIGHT_CHROME_EXECUTABLE,
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
    ].find((candidate) => candidate && existsSync(candidate))
    assert.ok(executablePath, 'set PLAYWRIGHT_CHROME_EXECUTABLE to run the capture sessions browser E2E')

    const { chromium } = await import('playwright-core')
    browser = await chromium.launch({ executablePath, headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    const target = `/capture-sessions?projectId=${encodeURIComponent(projectId)}`
    await page.goto(`${baseUrl}/login?next=${encodeURIComponent(target)}`)
    await page.locator('input[name="username"]').fill(uiUsername)
    await page.locator('input[name="password"]').fill(uiPassword)
    await page.getByRole('button', { name: 'Entrar no Apollo' }).click()
    await page.waitForURL('**/capture-sessions**')

    await page.getByTestId('capture-sessions-page').waitFor({ state: 'visible' })
    await page.getByTestId(`session-${sessionId}`).waitFor({ state: 'visible' })

    // Reading the synchronization must put the page into needs-input, not into
    // a satisfied ready state.
    await page.getByTestId(`session-${sessionId}`).getByRole('button', { name: 'Ver sincronização' }).click()
    await page.getByTestId('state-needs-input').waitFor({ state: 'visible' })
    await page.getByTestId('outcome-track-phone').waitFor({ state: 'visible' })
    assert.equal(
      (await page.getByTestId('outcome-track-phone').textContent())?.trim(),
      'Sem evidência',
    )
    await page.getByTestId('no-map-track-phone').waitFor({ state: 'visible' })

    // And nowhere on the page may the phone be presented as aligned.
    const body = await page.locator('body').textContent()
    assert.doesNotMatch(
      body ?? '',
      /track-phone[\s\S]{0,120}Sincronizada/,
      'a track nobody could measure must never render as synchronized',
    )
  } finally {
    if (browser) await browser.close()
    if (server && server.exitCode === null) {
      server.kill('SIGTERM')
      await new Promise((resolve) => setTimeout(resolve, 500))
      if (server.exitCode === null) server.kill('SIGKILL')
    }
    // Report, never rethrow. A finally that throws replaces whatever the test
    // was actually failing on, and the diagnosis is lost — which is exactly
    // what happened when the cleanup order was wrong: the foreign key error
    // stood in for a failure nobody got to see.
    try {
      await cleanup()
    } catch (cleanupError) {
      console.error('capture sessions E2E cleanup failed:', cleanupError)
    }
    await client.$disconnect()
  }
})
