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

test('T-FR-216 manual editing persists optimistic Commands, immutable undo/redo and public API timeline gestures', {
  skip: process.env.APOLLO_MANUAL_EDIT_E2E !== '1' && 'set APOLLO_MANUAL_EDIT_E2E=1 and use an isolated V2 database',
}, async () => {
  const { applyManualEditService, readManualTimelineService } = await import('../../src/v2/application/manual-edit.ts')
  const { calculateVersionHash, stableSerialize } = await import('../../src/v2/application/version-hash.ts')
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { DomainError } = await import('../../src/v2/domain/errors.ts')
  const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
  const { PrismaManualEditRepository } = await import('../../src/v2/infrastructure/prisma/manual-edit-repository.ts')
  const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
  const { createUiPasswordHash } = await import('../../src/v2/infrastructure/security/ui-session.ts')

  const client = new PrismaClient()
  const repository = new PrismaManualEditRepository(client)
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `manual-workspace-${suffix}`
  const projectId = `manual-project-${suffix}`
  const sourceA = `manual-artifact-a-${suffix}`
  const sourceB = `manual-artifact-b-${suffix}`
  const initialVersionId = `manual-version-${suffix}`
  const createdAt = new Date('2026-07-26T17:30:00.000Z')
  const uiUsername = `manual-user-${suffix}`
  const uiPassword = `Manual-E2E-${suffix}-secure`
  const uiSessionSecret = `manual-session-secret-${suffix}-at-least-32-characters`
  let clockTick = 0
  let server
  let browser

  const cleanup = async () => {
    await client.v2PublicEventOutbox.deleteMany({ where: { workspaceId } })
    await client.v2ProjectProxyRenderOperation.deleteMany({ where: { workspaceId } })
    await client.v2PublicOperation.deleteMany({ where: { workspaceId } })
    await client.v2ProjectMediaAsset.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifactManifest.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifact.deleteMany({ where: { workspaceId } })
    await client.v2Project.deleteMany({ where: { workspaceId } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId } })
    await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
  }

  const execute = (request) => applyManualEditService({
    repository,
    clock: () => new Date(createdAt.getTime() + ++clockTick * 1000),
    createId: (kind) => `${kind}-${randomUUID()}`,
    createEventId: randomUUID,
  })({
    workspaceId,
    projectId,
    actor: { type: 'api-client', id: `manual-client-${suffix}` },
    ...request,
  })

  try {
    await cleanup()
    const brief = { schemaVersion: 1, objective: 'discovery', createdAt: createdAt.toISOString() }
    const policies = { schemaVersion: 1, state: 'configured', createdAt: createdAt.toISOString() }
    const editPlan = {
      schemaVersion: 2,
      state: 'compiled',
      id: `edit-plan-${initialVersionId}`,
      projectVersionId: initialVersionId,
      storyPlanId: 'manual-story',
      treatmentPlanId: 'manual-treatment',
      directorRunId: 'manual-director',
      fps: 30,
      durationFrames: 180,
      sources: [
        { id: sourceA, artifactId: sourceA, kind: 'video', durationSeconds: 6 },
        { id: sourceB, artifactId: sourceB, kind: 'video', durationSeconds: 6 },
      ],
      videoTracks: [{
        id: 'track-primary-video',
        kind: 'base-video',
        clips: [
          { id: 'clip-1', sourceArtifactId: sourceA, sourceInFrame: 0, sourceOutFrame: 90, timelineInFrame: 0, timelineOutFrame: 90, rate: 1 },
          { id: 'clip-2', sourceArtifactId: sourceA, sourceInFrame: 90, sourceOutFrame: 180, timelineInFrame: 90, timelineOutFrame: 180, rate: 1 },
        ],
      }],
      overlayTracks: [],
      subtitleTracks: [{
        id: 'track-captions',
        kind: 'captions',
        presetId: 'clean-color',
        anchor: 'bottom',
        faceProtection: true,
        maxLines: 2,
        maxCharactersPerBlock: 32,
        cues: [
          { id: 'cue-1', startFrame: 0, endFrame: 90, text: 'Primeira frase', anchor: 'bottom' },
          { id: 'cue-2', startFrame: 90, endFrame: 180, text: 'Segunda frase', anchor: 'bottom' },
        ],
      }],
      audioTracks: [],
      effectTracks: [],
      markers: [],
      transitions: [{ id: 'transition-1', fromClipId: 'clip-1', toClipId: 'clip-2', atFrame: 90, type: 'straight-cut', audioFadeMs: 24, reason: 'change' }],
      protectedElements: [],
      localeVariantRefs: [],
      formatVariantRefs: [],
      lineageRefs: [sourceA],
      movementPolicy: { automaticZoom: false, protectedOpeningFrames: 120 },
      subtitlePolicy: { faceProtection: true, anchor: 'bottom', maxCharactersPerBlock: 32 },
      composition: { layout: 'landscape-inset', background: 'blurred-source', foregroundScale: 1, verticalPosition: 0.5 },
      director: { plannerVersion: 'manual-e2e', decisions: [], assumptions: [] },
      createdAt: createdAt.toISOString(),
    }
    const briefId = `manual-brief-${suffix}`
    const policyId = `manual-policy-${suffix}`
    const editPlanId = `manual-edit-plan-${suffix}`
    await client.v2Workspace.create({ data: { id: workspaceId, slug: workspaceId, name: 'Manual E2E', status: 'active', createdAt, updatedAt: createdAt } })
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => createdAt,
    })({
      id: `manual-client-${suffix}`,
      workspaceId,
      name: 'Manual editing E2E',
      environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })
    await client.v2Project.create({ data: {
      id: projectId, workspaceId, name: 'Manual Project', status: 'reviewing-proxy',
      objective: 'discovery', format: '9:16', locale: 'pt-BR',
      createdByType: 'api-client', createdById: issued.client.id, createdAt, updatedAt: createdAt,
    } })
    for (const [id, kind, content] of [
      [briefId, 'brief', brief],
      [policyId, 'policies', policies],
      [editPlanId, 'edit-plan', editPlan],
    ]) {
      await client.v2ProjectSnapshot.create({ data: {
        id, workspaceId, projectId, kind, schemaVersion: kind === 'edit-plan' ? 2 : 1,
        contentJson: stableSerialize(content), contentHash: calculateVersionHash(content), createdAt,
      } })
    }
    const initialBaseHash = calculateVersionHash({ projectId, editPlan })
    await client.v2ProjectVersion.create({ data: {
      id: initialVersionId, workspaceId, projectId, sequence: 1,
      briefSnapshotId: briefId, editPlanSnapshotId: editPlanId, policiesSnapshotId: policyId,
      baseHash: initialBaseHash, createdBy: issued.client.id, createdAt,
    } })
    await client.v2Project.update({ where: { id: projectId }, data: { currentVersionId: initialVersionId } })
    for (const artifactId of [sourceA, sourceB]) {
      const artifactKey = `manual/${artifactId}.mp4`
      await client.v2MediaArtifact.create({ data: {
        id: artifactId, workspaceId, artifactKey,
        sha256: calculateVersionHash({ artifactId }), byteSize: 1n,
        mediaType: 'video', container: 'mp4', status: 'available', createdAt,
      } })
      await client.v2MediaArtifactManifest.create({ data: {
        id: `manifest-${artifactId}`, workspaceId, artifactId,
        schemaVersion: 'media-artifact-manifest/v2',
        manifestHash: calculateVersionHash({ artifactId, manifest: true }),
        recipeId: 'manual-source', recipeVersion: '1.0.0',
        parametersHash: calculateVersionHash({ artifactId, parameters: true }),
        manifestJson: stableSerialize({
          artifact: { artifactKey },
          probe: { width: 640, height: 360, duration: 6, fps: 30 },
        }),
        createdAt,
      } })
      await client.v2ProjectMediaAsset.create({ data: {
        id: randomUUID(), workspaceId, projectId, artifactId,
        role: 'source-master', originalFileName: `${artifactId}.mp4`, createdAt,
      } })
    }

    const initial = await readManualTimelineService({ repository })({ workspaceId, projectId })
    assert.equal(initial.timeline.clips.length, 2)
    assert.deepEqual(initial.timeline.snapPointsMs, [0, 3000, 6000])

    const split = await execute({
      baseVersionId: initialVersionId,
      baseHash: initialBaseHash,
      expectedRevision: 1,
      action: 'apply',
      variantId: '9:16',
      targetId: 'clip-1',
      operation: { kind: 'split', clipId: 'clip-1', atMs: 1505 },
      idempotencyKey: `manual-split-${suffix}`,
    })
    assert.equal(split.version.sequence, 2)
    assert.deepEqual(split.timeline.clips.map((clip) => clip.id), ['clip-1:a', 'clip-1:b', 'clip-2'])
    assert.equal(split.timeline.clips[0].endMs, 1500)
    assert.equal((await client.v2EditCommand.findUnique({ where: { id: split.command.id } })).type, 'manual-edit')

    await assert.rejects(() => execute({
      baseVersionId: initialVersionId,
      baseHash: initialBaseHash,
      expectedRevision: 1,
      action: 'apply',
      variantId: '9:16',
      targetId: 'clip-2',
      operation: { kind: 'replace', clipId: 'clip-2', sourceId: sourceB },
      idempotencyKey: `manual-stale-${suffix}`,
    }), (error) => error instanceof DomainError && error.code === 'VERSION_CONFLICT')

    const inspect = await execute({
      baseVersionId: split.version.id,
      baseHash: split.version.baseHash,
      expectedRevision: 2,
      action: 'apply',
      variantId: '9:16',
      targetId: 'clip-1:a',
      operation: { kind: 'inspect', clipId: 'clip-1:a', patch: {
        layout: 'close-up', text: 'Texto ajustado', subtitle: 'bold',
        color: 'warm-lut', motion: 'static', audioGain: 0.9,
      } },
      idempotencyKey: `manual-inspect-${suffix}`,
    })
    assert.equal(inspect.version.sequence, 3)
    assert.match(JSON.stringify(inspect.editPlan), /Texto ajustado/)
    assert.match(JSON.stringify(inspect.editPlan), /warm-lut/)

    const undo = await execute({
      baseVersionId: inspect.version.id,
      baseHash: inspect.version.baseHash,
      expectedRevision: 3,
      action: 'undo',
      variantId: '9:16',
      targetId: 'clip-1:a',
      targetVersionId: split.version.id,
      idempotencyKey: `manual-undo-${suffix}`,
    })
    assert.equal(undo.version.sequence, 4)
    assert.doesNotMatch(JSON.stringify(undo.editPlan), /Texto ajustado/)
    assert.equal(undo.command.payload.restoresVersionId, split.version.id)

    const redo = await execute({
      baseVersionId: undo.version.id,
      baseHash: undo.version.baseHash,
      expectedRevision: 4,
      action: 'redo',
      variantId: '9:16',
      targetId: 'clip-1:a',
      targetVersionId: inspect.version.id,
      idempotencyKey: `manual-redo-${suffix}`,
    })
    assert.equal(redo.version.sequence, 5)
    assert.match(JSON.stringify(redo.editPlan), /Texto ajustado/)
    const replay = await execute({
      baseVersionId: undo.version.id,
      baseHash: undo.version.baseHash,
      expectedRevision: 4,
      action: 'redo',
      variantId: '9:16',
      targetId: 'clip-1:a',
      targetVersionId: inspect.version.id,
      idempotencyKey: `manual-redo-${suffix}`,
    })
    assert.equal(replay.replayed, true)
    assert.equal(replay.version.id, redo.version.id)

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
        APOLLO_UI_USERNAME: uiUsername,
        APOLLO_UI_PASSWORD_HASH: createUiPasswordHash(uiPassword, `manual-salt-${suffix}`),
        APOLLO_UI_SESSION_SECRET: uiSessionSecret,
        APOLLO_UI_API_CLIENT_ID: issued.client.id,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stdout.on('data', (chunk) => { serverLogs += String(chunk) })
    server.stderr.on('data', (chunk) => { serverLogs += String(chunk) })
    await waitForServer(baseUrl, server)
    const authorization = `Bearer ${issued.token}`
    const timelineResponse = await fetch(`${baseUrl}/v1/projects/${projectId}/timeline`, {
      headers: { authorization },
    })
    const timeline = await timelineResponse.json()
    assert.equal(timelineResponse.status, 200, JSON.stringify(timeline))
    assert.equal(timeline.data.timeline.revision, 5)
    assert.equal(timeline.data.history[0].action, 'redo')

    const apiResponse = await fetch(`${baseUrl}/v1/projects/${projectId}/manual-edits`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': `manual-public-${suffix}`,
      },
      body: JSON.stringify({
        action: 'apply',
        baseVersionId: timeline.data.timeline.versionId,
        baseHash: timeline.data.baseHash,
        expectedRevision: timeline.data.timeline.revision,
        variantId: '9:16',
        targetId: 'clip-2',
        operation: { kind: 'replace', clipId: 'clip-2', sourceId: sourceB },
      }),
    })
    const publicApplied = await apiResponse.json()
    assert.equal(apiResponse.status, 201, `${JSON.stringify(publicApplied)}\n${serverLogs.slice(-4_000)}`)
    assert.equal(publicApplied.data.version.sequence, 6)
    assert.equal(publicApplied.data.operation.status, 'queued')
    assert.equal(publicApplied.data.timeline.clips.find((clip) => clip.id === 'clip-2').sourceId, sourceB)

    const executablePath = [
      process.env.PLAYWRIGHT_CHROME_EXECUTABLE,
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
    ].find((candidate) => candidate && existsSync(candidate))
    assert.ok(executablePath, 'set PLAYWRIGHT_CHROME_EXECUTABLE to run the manual editor browser E2E')
    const { chromium } = await import('playwright-core')
    browser = await chromium.launch({ executablePath, headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    await page.goto(`${baseUrl}/login?next=${encodeURIComponent(`/projects/${projectId}`)}`)
    await page.locator('input[name="username"]').fill(uiUsername)
    await page.locator('input[name="password"]').fill(uiPassword)
    await page.getByRole('button', { name: 'Entrar no Apollo' }).click()
    await page.waitForURL(`**/projects/${projectId}`)
    const manualEditor = page.getByTestId('manual-editor')
    await manualEditor.waitFor({ state: 'visible' })
    await page.getByTestId('manual-clip-clip-2').click()
    await assert.doesNotReject(async () => {
      await page.getByTestId('manual-selected-clip').waitFor({ state: 'visible' })
      assert.equal(await page.getByTestId('manual-selected-clip').textContent(), 'clip-2')
    })

    const clipBox = await page.getByTestId('manual-clip-clip-2').boundingBox()
    assert.ok(clipBox)
    const moved = page.waitForResponse((response) =>
      response.url().endsWith(`/v1/projects/${projectId}/manual-edits`)
      && response.request().method() === 'POST',
    )
    await page.mouse.move(clipBox.x + clipBox.width / 2, clipBox.y + clipBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(clipBox.x - 180, clipBox.y + clipBox.height / 2, { steps: 8 })
    await page.mouse.up()
    assert.equal((await moved).status(), 201)
    await page.getByText(/Edição registrada na versão 7/).waitFor({ state: 'visible' })

    const undoButton = page.getByTestId('manual-undo')
    let undoReady = false
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (await undoButton.isEnabled()) {
        undoReady = true
        break
      }
      await page.waitForTimeout(100)
    }
    assert.equal(undoReady, true, 'manual history must enable undo after the mouse Command is persisted')
    const undone = page.waitForResponse((response) =>
      response.url().endsWith(`/v1/projects/${projectId}/manual-edits`)
      && response.request().method() === 'POST',
    )
    await manualEditor.focus()
    await page.keyboard.press('Control+z')
    assert.equal((await undone).status(), 201)
    await page.getByText(/Undo registrado como versão 8/).waitFor({ state: 'visible' })
    assert.match(await manualEditor.textContent(), /V8/)
    await context.close()
    await browser.close()
    browser = undefined
  } finally {
    if (browser) await browser.close()
    if (server && server.exitCode === null) {
      server.kill()
      await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))])
    }
    await cleanup()
    await client.$disconnect()
  }
})
