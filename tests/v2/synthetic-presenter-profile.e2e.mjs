import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import http from 'node:http'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path

const workspaceId = 'presenter-e2e-workspace'
const storageDriver = (process.env.APOLLO_V2_ARTIFACT_STORAGE_DRIVER ?? 'local').trim().toLowerCase()
const hash = (character) => character.repeat(64)
const at = (second) => new Date(Date.parse('2026-08-01T00:00:00.000Z') + second * 1_000).toISOString()

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function waitForServer(baseUrl, server) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next server exited with ${server.exitCode}`)
    try {
      if ((await globalThis.fetch(`${baseUrl}/v1/health`)).ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Timed out waiting for Next server')
}

test('T-FR-103 presenter lifecycle and generation gates hold from the browser to PostgreSQL', {
  skip: !process.env.V2_DATABASE_URL && 'V2_DATABASE_URL is required',
  timeout: 900_000,
}, async () => {
  const client = new PrismaClient({ datasources: { db: { url: process.env.V2_DATABASE_URL } } })
  const root = await mkdtemp(join(tmpdir(), 'apollo-presenter-e2e-'))
  const shotsDirectory = process.env.APOLLO_PRESENTER_SHOTS_DIR?.trim() || join(root, 'shots')
  await mkdir(shotsDirectory, { recursive: true })
  const suffix = randomUUID().slice(0, 8)
  const uiUsername = `presenter-user-${suffix}`
  const uiPassword = `Presenter-E2E-${suffix}-secure`
  const uiSessionSecret = `presenter-session-secret-${suffix}-32-characters-min`
  let stub = null
  let server = null
  let worker = null
  let browser = null
  let objectStore = null
  let serverLogs = ''
  let workerLogs = ''

  const cleanup = async () => {
    const identityIds = (await client.v2WorkspaceMember.findMany({
      where: { workspaceId }, select: { identityId: true },
    })).map((member) => member.identityId)
    await client.v2SyntheticScriptPlan.updateMany({ where: { workspaceId }, data: { currentVersionId: null } })
    await client.v2SyntheticBlockConcatenation.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticBlockGeneration.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticScriptBlock.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticScriptPlanVersion.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticScriptPlan.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticAudioMaster.deleteMany({ where: { workspaceId } })
    await client.v2ProviderResultArtifact.deleteMany({ where: { workspaceId } })
    await client.v2ProviderJobTransition.deleteMany({ where: { workspaceId } })
    await client.v2ProviderJob.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticPresenterProfileHead.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticPresenterProfile.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifactLineage.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifactManifest.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifact.deleteMany({ where: { workspaceId } })
    await client.v2PublicEventOutbox.deleteMany({ where: { workspaceId } })
    await client.v2IdempotencyRecord.deleteMany({ where: { workspaceId } })
    await client.v2ProjectCreationCommand.deleteMany({ where: { workspaceId } })
    await client.v2Project.deleteMany({ where: { workspaceId } })
    await client.v2UiSession.deleteMany({ where: { workspaceId } })
    const { uiLoginThrottleKey, uiSessionSubjectHash } = await import('../../src/v2/infrastructure/security/ui-session.ts')
    const sessionEnvironment = { APOLLO_UI_SESSION_SECRET: uiSessionSecret }
    await client.v2UiLoginAttempt.deleteMany({ where: { subjectHash: uiSessionSubjectHash(uiUsername, sessionEnvironment) } })
    await client.v2UiLoginThrottle.deleteMany({ where: { keyHash: uiLoginThrottleKey('direct', uiUsername, sessionEnvironment) } })
    await client.v2WorkspaceUiPrincipal.deleteMany({ where: { workspaceId } })
    await client.v2WorkspaceMember.deleteMany({ where: { workspaceId } })
    if (identityIds.length > 0) await client.v2HumanIdentity.deleteMany({ where: { id: { in: identityIds } } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId } })
    await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
  }

  try {
    await cleanup()
    const { createProjectService } = await import('../../src/v2/application/create-project.ts')
    const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
    const { createExternalAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
    const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
    const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
    const { createUiPasswordHash } = await import('../../src/v2/infrastructure/security/ui-session.ts')
    const { PrismaWorkspaceRepository } = await import('../../src/v2/infrastructure/prisma/workspace-repository.ts')
    const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
    const { PrismaProjectCreationRepository } = await import('../../src/v2/infrastructure/prisma/project-creation-repository.ts')

    if (storageDriver === 's3') {
      const aws = await import('@aws-sdk/client-s3')
      const { createArtifactS3ClientFromEnvironment } = await import('../../src/v2/infrastructure/media/s3-artifact-storage.ts')
      const { bucket, client: s3Client } = createArtifactS3ClientFromEnvironment()
      await s3Client.send(new aws.CreateBucketCommand({ Bucket: bucket }))
      await s3Client.send(new aws.PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } }))
      objectStore = { aws, bucket, client: s3Client }
    }

    await new PrismaWorkspaceRepository(client).create(createWorkspace({
      id: workspaceId, slug: workspaceId, name: 'Presenter browser E2E', status: 'active', createdAt: at(0),
    }))
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client), credentialCrypto: nodeApiCredentialCrypto, clock: () => new Date(),
    })({ id: 'presenter-e2e-client', workspaceId, name: 'Presenter E2E', environment: 'production', scopes: ['projects:read', 'projects:write'] })
    const auditContext = createExternalAuditContext({
      clientId: issued.client.id, credentialId: issued.credential.id, workspaceId, environment: 'production',
    })
    const actor = Object.freeze({
      ...auditContext, scopes: new Set(['projects:read', 'projects:write']), authenticationKind: 'bearer',
      clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
      clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
    })
    let entity = 0
    let event = 0
    const project = await createProjectService({
      repository: new PrismaProjectCreationRepository(client), clock: () => new Date(),
      createId: (kind) => `${kind}-presenter-e2e-${++entity}`,
      createEventId: () => `00000000-0000-4000-8000-${String(300_000 + ++event).padStart(12, '0')}`,
    })({ workspaceId, name: 'Projeto do presenter', objective: 'awareness', format: '9:16', actor, idempotency: { clientId: issued.client.id, key: 'presenter-e2e-project' } })
    const projectId = project.project.id
    const projectVersionId = project.version.id

    for (const [artifactId, character] of [['presenter-e2e-consent-1', 'a'], ['presenter-e2e-consent-2', 'b']]) {
      await client.v2MediaArtifact.create({
        data: {
          id: artifactId, workspaceId, artifactKey: `presenter-e2e/${artifactId}.json`,
          sha256: hash(character), byteSize: 512n, mediaType: 'data', container: 'json', status: 'available', createdAt: new Date(at(0)),
        },
      })
    }

    // Controlled ElevenLabs loopback stub for the real adapter.
    const providerCalls = []
    let requestSequence = 0
    const audioBytes = new Map()
    stub = http.createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', async () => {
        const payload = JSON.parse(body)
        providerCalls.push(payload.text)
        requestSequence += 1
        if (!audioBytes.has(requestSequence)) {
          const path = join(root, `tts-${requestSequence}.mp3`)
          execFileSync(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${240 + requestSequence * 31}:sample_rate=44100:duration=2`, '-c:a', 'libmp3lame', '-b:a', '128k', path], { windowsHide: true })
          audioBytes.set(requestSequence, await readFile(path))
        }
        const characters = [...payload.text]
        const step = 2 / characters.length
        response.writeHead(200, { 'content-type': 'application/json', 'request-id': `presenter_req_${requestSequence}` })
        response.end(JSON.stringify({
          audio_base64: audioBytes.get(requestSequence).toString('base64'),
          alignment: {
            characters,
            character_start_times_seconds: characters.map((_, index) => index * step),
            character_end_times_seconds: characters.map((_, index) => (index + 1) * step),
          },
        }))
      })
    })
    const stubPort = await freePort()
    await new Promise((resolve) => stub.listen(stubPort, '127.0.0.1', resolve))

    const port = await freePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const runtimeEnv = {
      ...process.env,
      NODE_ENV: 'production',
      __NEXT_PROCESSED_ENV: 'true',
      APOLLO_API_ENVIRONMENT: 'production',
      APOLLO_GOVERNANCE_ANOMALY_REQUEST_MINIMUM: '400',
      APOLLO_V2_PERSISTENCE: 'postgres',
      APOLLO_AUTH_MODE: 'bootstrap',
      APOLLO_ALLOW_BOOTSTRAP_AUTH: 'true',
      APOLLO_UI_BOOTSTRAP_ROLE: 'operator',
      APOLLO_UI_USERNAME: uiUsername,
      APOLLO_UI_PASSWORD_HASH: createUiPasswordHash(uiPassword, `presenter-salt-${suffix}`),
      APOLLO_UI_SESSION_SECRET: uiSessionSecret,
      APOLLO_UI_API_CLIENT_ID: issued.client.id,
      APOLLO_V2_ARTIFACT_ROOT: join(root, 'artifacts'),
      APOLLO_V2_RENDER_WORK_ROOT: join(root, 'work'),
      APOLLO_V2_PROVIDER_WORK_ROOT: join(root, 'work', 'provider'),
      APOLLO_PROTECTED_PAYLOAD_KEY_ID: 'presenter-e2e-protected-payload',
      APOLLO_PROTECTED_PAYLOAD_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      APOLLO_V2_ELEVENLABS_API_KEY: 'presenter-e2e-stub-secret',
      APOLLO_V2_ELEVENLABS_BASE_URL: `http://127.0.0.1:${stubPort}`,
      APOLLO_V2_ELEVENLABS_COST_MINOR_UNITS_PER_THOUSAND_CHARACTERS: '30',
      APOLLO_V2_PROVIDER_POLL_MS: '200',
      FFMPEG_PATH: ffmpegPath,
      FFPROBE_PATH: ffprobePath,
    }
    await mkdir(join(root, 'artifacts'), { recursive: true })
    await mkdir(join(root, 'work'), { recursive: true })
    // Production server (next start): the dev-mode HMR websocket forces the
    // page into a reload loop under the browser, so the browser journey runs
    // against the real production build (requires `npm run build` first).
    server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], {
      cwd: process.cwd(), env: runtimeEnv, stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stdout.on('data', (chunk) => { serverLogs += String(chunk) })
    server.stderr.on('data', (chunk) => { serverLogs += String(chunk) })
    await waitForServer(baseUrl, server)
    worker = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/run-v2-provider-worker.mjs'], {
      cwd: process.cwd(), env: runtimeEnv, stdio: ['ignore', 'pipe', 'pipe'],
    })
    worker.stdout.on('data', (chunk) => { workerLogs += String(chunk) })
    worker.stderr.on('data', (chunk) => { workerLogs += String(chunk) })

    const executablePath = [
      process.env.PLAYWRIGHT_CHROME_EXECUTABLE,
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
    ].find((candidate) => candidate && existsSync(candidate))
    assert.ok(executablePath, 'set PLAYWRIGHT_CHROME_EXECUTABLE to run the presenter browser E2E')
    // Warm the dev-mode lazy compilation before the browser navigates so the
    // navigation timeouts measure the app, not the compiler.
    for (const path of ['/login', '/presenters', '/v1/session', `/v1/workspaces/${workspaceId}/synthetic-presenters`]) {
      const warmDeadline = Date.now() + 180_000
      for (;;) {
        try {
          const warm = await globalThis.fetch(`${baseUrl}${path}`, { redirect: 'manual' })
          if (warm.status < 500) break
        } catch {}
        assert.ok(Date.now() < warmDeadline, `timed out warming ${path}`)
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }

    const { chromium } = await import('playwright-core')
    browser = await chromium.launch({ executablePath, headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    context.setDefaultTimeout(60_000)
    context.setDefaultNavigationTimeout(120_000)
    const browserEvents = []
    page.on('console', (message) => { browserEvents.push(`console.${message.type()}: ${message.text()}`) })
    page.on('pageerror', (error) => { browserEvents.push(`pageerror: ${error.message}`) })
    page.on('requestfailed', (request) => { browserEvents.push(`requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`) })

    // 1. Real human login through the real /login page.
    await page.goto(`${baseUrl}/login?next=%2Fpresenters`)
    await page.locator('input[name="username"]').fill(uiUsername)
    await page.locator('input[name="password"]').fill(uiPassword)
    const loginCompleted = page.waitForResponse((response) =>
      response.url().endsWith('/v1/session') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Entrar no Apollo' }).click()
    // 200 = fetch-based login; 303 = native form submission with safe
    // redirect. Both set the session cookie and land on /presenters.
    const loginStatus = (await loginCompleted).status()
    assert.ok([200, 303].includes(loginStatus), `unexpected login status ${loginStatus}`)
    // The landing route after login depends on a hydration race (fetch-based
    // login honours ?next=, the native form submission may land on /). The
    // session cookie is set either way; navigate deterministically.
    await page.goto(`${baseUrl}/presenters`, { waitUntil: 'domcontentloaded' })

    // 2. Empty state, then create the profile entirely through the UI form.
    try {
      await page.getByTestId('presenters-manager').waitFor({ state: 'visible', timeout: 120_000 })
    } catch (error) {
      await page.screenshot({ path: join(shotsDirectory, 'debug-presenters-load.png'), fullPage: true }).catch(() => undefined)
      throw new Error(`presenters manager never rendered (url=${page.url()}): ${error}\nbrowser events:\n${browserEvents.slice(-40).join('\n')}`)
    }
    await page.getByTestId('presenters-empty').waitFor({ state: 'visible', timeout: 60_000 })
    await page.getByTestId('presenter-create-toggle').click()
    const profileId = `presenter-e2e-${suffix}`
    const fill = async (id, value) => page.locator(`#${id}`).fill(value)
    await fill('profileId', profileId)
    await fill('actorIdentityId', 'presenter-e2e-identity')
    await fill('avatarIdentityRef', 'avatar_presenter_e2e')
    await fill('voiceId', 'voice_presenter_e2e')
    await fill('consentId', 'presenter-e2e-consent-v1')
    await fill('consentEvidenceArtifactId', 'presenter-e2e-consent-1')
    await fill('consentExpiresAt', '2030-01-01T00:00:00.000Z')
    await page.getByTestId('presenter-create-submit').click()
    await page.getByTestId(`presenter-card-${profileId}`).waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal(await page.getByTestId(`presenter-status-${profileId}`).innerText(), 'Ativo')

    // Restrictions arrive as their own immutable version through /v1 with the
    // SAME authenticated browser session.
    const versionResponse = await page.request.post(
      `${baseUrl}/v1/workspaces/${workspaceId}/synthetic-presenters/${profileId}/versions`,
      {
        headers: { 'content-type': 'application/json', 'idempotency-key': `presenter-e2e-restrictions-${suffix}` },
        data: { baseRevision: 1, changes: { restrictions: ['nunca conteúdo político', 'nunca resultados garantidos'] } },
      },
    )
    assert.equal(versionResponse.status(), 201, await versionResponse.text())

    // 3. Detail view: status, consent, restrictions, disclosure, eligibility.
    await page.getByTestId(`presenter-card-${profileId}`).click()
    await page.getByTestId('presenter-detail').waitFor({ state: 'visible', timeout: 30_000 })
    await page.getByTestId('presenter-detail-restrictions').waitFor({ state: 'visible' })
    assert.match(await page.getByTestId('presenter-detail-disclosure').innerText(), /Conteúdo gerado com IA/)
    await page.screenshot({ path: join(shotsDirectory, 'presenter-active-consent-restrictions.png'), fullPage: true })
    await page.getByTestId('presenter-eligibility-submit').click()
    await page.getByTestId('presenter-eligibility-result').waitFor({ state: 'visible', timeout: 15_000 })
    assert.match(await page.getByTestId('presenter-eligibility-result').innerText(), /Elegível/)
    await page.screenshot({ path: join(shotsDirectory, 'presenter-eligible.png'), fullPage: true })

    // 4. A block plan generates one block through the durable worker using
    //    the same browser session against /v1.
    const planResponse = await page.request.post(`${baseUrl}/v1/projects/${projectId}/synthetic-script-plans`, {
      headers: { 'content-type': 'application/json', 'idempotency-key': `presenter-e2e-plan-${suffix}` },
      data: {
        projectVersionId, profileSnapshotId: profileId, locale: 'pt-BR',
        scriptText: 'Uma frase completa para o bloco.', use: 'ads', market: 'BRA',
      },
    })
    assert.equal(planResponse.status(), 201, await planResponse.text())
    const plan = (await planResponse.json()).data
    const planId = plan.plan.head.id
    const deadline = Date.now() + 120_000
    for (;;) {
      const read = await page.request.get(`${baseUrl}/v1/projects/${projectId}/synthetic-script-plans/${planId}`)
      assert.equal(read.status(), 200)
      const data = (await read.json()).data
      const generation = data.generations.at(-1)
      if (generation?.status === 'approved') break
      assert.ok(Date.now() < deadline, `generation never approved: ${JSON.stringify(data.generations)}\n${workerLogs.slice(-2000)}`)
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    assert.equal(providerCalls.length, 1)
    assert.equal(await client.v2SyntheticBlockGeneration.count({ where: { workspaceId, status: 'approved' } }), 1)

    // 5. Deactivation through the UI with its proportional confirmation.
    await page.getByTestId(`presenter-card-${profileId}`).click()
    await page.getByTestId('presenter-detail').waitFor({ state: 'visible' })
    await page.getByTestId('presenter-deactivate').click()
    await page.getByTestId('presenter-deactivate-confirm').click()
    await page.getByTestId('presenter-detail-status').filter({ hasText: 'Desativado' }).waitFor({ timeout: 30_000 })

    // 6. Generation is now blocked with zero reservations and zero calls.
    const generationsBefore = await client.v2SyntheticBlockGeneration.count({ where: { workspaceId } })
    const jobsBefore = await client.v2ProviderJob.count({ where: { workspaceId } })
    const blockedPlan = await page.request.post(`${baseUrl}/v1/projects/${projectId}/synthetic-script-plans`, {
      headers: { 'content-type': 'application/json', 'idempotency-key': `presenter-e2e-blocked-${suffix}` },
      data: {
        projectVersionId, profileSnapshotId: profileId, locale: 'pt-BR',
        scriptText: 'Outra frase que não deve gerar nada.', use: 'ads', market: 'BRA',
      },
    })
    assert.ok(blockedPlan.status() >= 400, await blockedPlan.text())
    assert.equal((await blockedPlan.json()).error.code, 'ASSET_RIGHTS_BLOCKED')
    assert.equal(providerCalls.length, 1, 'a deactivated profile must never trigger a paid call')
    assert.equal(await client.v2SyntheticBlockGeneration.count({ where: { workspaceId } }), generationsBefore, 'zero generations reserved')
    assert.equal(await client.v2ProviderJob.count({ where: { workspaceId } }), jobsBefore, 'zero provider jobs reserved')

    // The UI explains why: eligibility now denies with the current-state code.
    await page.getByTestId('presenter-eligibility-submit').click()
    await page.getByTestId('presenter-eligibility-result').filter({ hasText: 'Não elegível' }).waitFor({ timeout: 15_000 })
    assert.match(await page.getByTestId('presenter-eligibility-result').innerText(), /PROFILE_NOT_ACTIVE|CURRENT_VERSION_NOT_ACTIVE/)
    await page.screenshot({ path: join(shotsDirectory, 'presenter-deactivated-blocked.png'), fullPage: true })

    // 7. Security posture through the same session: stale revision conflicts,
    //    replay converges, and a foreign workspace stays invisible.
    const staleActivation = await page.request.post(
      `${baseUrl}/v1/workspaces/${workspaceId}/synthetic-presenters/${profileId}/activation`,
      { headers: { 'content-type': 'application/json', 'idempotency-key': `presenter-e2e-stale-${suffix}` }, data: { baseRevision: 1 } },
    )
    assert.equal(staleActivation.status(), 409, await staleActivation.text())
    const activation = await page.request.post(
      `${baseUrl}/v1/workspaces/${workspaceId}/synthetic-presenters/${profileId}/activation`,
      { headers: { 'content-type': 'application/json', 'idempotency-key': `presenter-e2e-reactivate-${suffix}` }, data: { baseRevision: 3 } },
    )
    assert.equal(activation.status(), 201, await activation.text())
    const replayedActivation = await page.request.post(
      `${baseUrl}/v1/workspaces/${workspaceId}/synthetic-presenters/${profileId}/activation`,
      { headers: { 'content-type': 'application/json', 'idempotency-key': `presenter-e2e-reactivate-${suffix}` }, data: { baseRevision: 3 } },
    )
    assert.equal(replayedActivation.status(), 200)
    assert.equal((await replayedActivation.json()).data.replayed, true)
    const foreign = await page.request.get(`${baseUrl}/v1/workspaces/other-workspace/synthetic-presenters`)
    assert.ok(foreign.status() >= 400, await foreign.text())

    // 8. Reopening the page shows the full auditable history.
    await page.goto(`${baseUrl}/presenters`)
    await page.getByTestId(`presenter-card-${profileId}`).waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal(await page.getByTestId(`presenter-status-${profileId}`).innerText(), 'Ativo')
    await page.getByTestId(`presenter-card-${profileId}`).click()
    await page.getByTestId('presenter-versions').waitFor({ state: 'visible', timeout: 30_000 })
    for (const version of [1, 2, 3, 4]) {
      await page.getByTestId(`presenter-version-${version}`).waitFor({ state: 'visible' })
    }
    const heads = await client.v2SyntheticPresenterProfileHead.findMany({ where: { workspaceId } })
    assert.equal(heads.length, 1)
    assert.equal(heads[0].currentVersion, 4)
  } finally {
    const stopProcess = async (child) => {
      if (!child || child.exitCode !== null) return
      await new Promise((resolve) => {
        const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 10_000)
        timeout.unref?.()
        child.once('exit', () => { clearTimeout(timeout); resolve() })
        child.kill('SIGTERM')
      })
    }
    if (browser) await browser.close().catch(() => undefined)
    await stopProcess(worker)
    await stopProcess(server)
    if (stub) await new Promise((resolve) => stub.close(resolve))
    await cleanup()
    await client.$disconnect()
    if (objectStore) {
      const versions = await objectStore.client.send(new objectStore.aws.ListObjectVersionsCommand({ Bucket: objectStore.bucket }))
      const stored = [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])].map(({ Key, VersionId }) => ({ Key, VersionId }))
      if (stored.length > 0) {
        await objectStore.client.send(new objectStore.aws.DeleteObjectsCommand({ Bucket: objectStore.bucket, Delete: { Objects: stored, Quiet: true } }))
      }
      const after = await objectStore.client.send(new objectStore.aws.ListObjectVersionsCommand({ Bucket: objectStore.bucket }))
      assert.deepEqual([...(after.Versions ?? []), ...(after.DeleteMarkers ?? [])], [], 'object storage must hold zero orphan objects after cleanup')
      await objectStore.client.send(new objectStore.aws.DeleteBucketCommand({ Bucket: objectStore.bucket }))
      objectStore.client.destroy()
    }
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
    if (process.env.APOLLO_PRESENTER_E2E_DEBUG === '1') {
      console.error('server logs tail:', serverLogs.slice(-4000))
      console.error('worker logs tail:', workerLogs.slice(-4000))
    }
  }
})
