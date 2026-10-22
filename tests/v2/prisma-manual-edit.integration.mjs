import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
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
  const { createColorPipelineCompilationService } = await import('../../src/v2/application/color-pipeline-compilations.ts')
  const { setExternalAssetRightsService } = await import('../../src/v2/application/set-asset-rights.ts')
  const { assetRightsRevision, evaluateAssetUse } = await import('../../src/v2/domain/asset-rights.ts')
  const { PrismaAssetRightsRepository } = await import('../../src/v2/infrastructure/prisma/asset-rights-repository.ts')
  const { calculateVersionHash, stableSerialize } = await import('../../src/v2/application/version-hash.ts')
  const { calculateCanonicalHash } = await import('../../src/v2/domain/canonical-hash.ts')
  const { createMediaColorProbe } = await import('../../src/v2/domain/color-and-export.ts')
  const { buildRenderElementMap, renderElementMapHash } = await import('../../src/v2/domain/review-system.ts')
  const { projectProxyRenderInputHash } = await import('../../src/v2/application/project-render-sources.ts')
  const { EDITORIAL_PROXY_RECIPE_VERSION, FFMPEG_EDITORIAL_RENDERER_VERSION } = await import('../../src/v2/application/ports/editorial-proxy-renderer.ts')
  const { PrismaRenderElementMapRepository } = await import('../../src/v2/infrastructure/prisma/render-element-map-repository.ts')
  const { PrismaProjectProxyRenderRepository } = await import('../../src/v2/infrastructure/prisma/project-proxy-render-repository.ts')
  const { assertMediaArtifactManifest, createMediaArtifactManifestV2 } = await import('../../src/v2/domain/media-artifact.ts')
  const { createApiAccessAuditContext } = await import('../../src/v2/domain/api-access-control.ts')
  const { createDesiredAction, parseDesiredAction } = await import('../../src/v2/domain/desired-action.ts')
  const { parseCompareActionImpact } = await import('../../src/v2/domain/compare-action-impact.ts')
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { createExternalAuditContext, materializeActorAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
  const { DomainError } = await import('../../src/v2/domain/errors.ts')
  const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
  const { PrismaManualEditRepository } = await import('../../src/v2/infrastructure/prisma/manual-edit-repository.ts')
  const { PrismaColorPipelineCompilationRepository } = await import('../../src/v2/infrastructure/prisma/color-pipeline-compilation-repository.ts')
  const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
  const { createUiPasswordHash } = await import('../../src/v2/infrastructure/security/ui-session.ts')
  const { commitSealedChild, persistRecording } = await import('./helpers/pg-output-world.mjs')
  const { recordingNames } = await import('./helpers/operational-editorial-fixture.mjs')
  const { seedReviewProject } = await import('./helpers/review-edit-world.mjs')
  const { resetDisposableDatabase } = await import('./helpers/disposable-database.mjs')

  const client = new PrismaClient()
  const repository = new PrismaManualEditRepository(client)
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `manual-workspace-${suffix}`
  const projectId = `manual-project-${suffix}`
  // Two ingested recordings: the product only plays sources whose sealed ingest receipt a Version adopts.
  const slugA = `manual-a-${suffix}`, slugB = `manual-b-${suffix}`
  const namesA = recordingNames(slugA), namesB = recordingNames(slugB)
  const sourceA = namesA.sourceArtifactId, sourceB = namesB.sourceArtifactId
  const manifestA = namesA.sourceManifestId
  const currentTranscriptId = `manual-transcript-current-${suffix}`
  const replacementTranscriptId = `manual-transcript-replacement-${suffix}`
  const completedProxyArtifactId = `manual-proxy-initial-${suffix}`
  const initialVersionId = `manual-version-${suffix}`
  // Observe this run's clock; service TTLs must follow current PostgreSQL time.
  const createdAt = new Date()
  const uiUsername = `manual-user-${suffix}`
  const uiPassword = `Manual-E2E-${suffix}-secure`
  const uiSessionSecret = `manual-session-secret-${suffix}-at-least-32-characters`
  let clockTick = 0
  let server
  let browser
  let authenticatedActor
  const colorCompilations = new Map()

  const execute = (request) => applyManualEditService({
    repository,
    clock: () => new Date(createdAt.getTime() + ++clockTick * 1000),
    createId: (kind) => `${kind}-${randomUUID()}`,
    createEventId: randomUUID,
  })({
    workspaceId,
    projectId,
    actor: authenticatedActor,
    ...request,
  })

  try {
    // The manual-edit API names the output by the id of its State entry and checks it against the project's aspect ratio, so the
    // project's one variant is created with the id '9:16'. An output variant id is unique across the database: this suite owns a
    // clean slate (the reset refuses anything that is not a disposable e2e database).
    await resetDisposableDatabase(client)
    // The project's brief is born with its creation Command: this is the briefing and desired action it was created with.
    const briefing = 'Público: equipes criativas. Oferta: demonstração. Tom: direto.'
    const brief = {
      desiredAction: createDesiredAction({
        objective: 'discovery',
        desiredAction: { disclosures: [] },
      }),
    }
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
      retimedTranscript: {
        sourceTranscriptId: currentTranscriptId,
        words: [
          { text: 'Primeira', sourceStartSeconds: 0.2, sourceEndSeconds: 0.5, timelineStartFrame: 6, timelineEndFrame: 15 },
          { text: 'frase', sourceStartSeconds: 1.2, sourceEndSeconds: 1.6, timelineStartFrame: 36, timelineEndFrame: 48 },
          { text: 'Segunda', sourceStartSeconds: 3.2, sourceEndSeconds: 3.6, timelineStartFrame: 96, timelineEndFrame: 108 },
        ],
      },
      createdAt: createdAt.toISOString(),
    }
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
      scopes: ['projects:read', 'projects:write', 'artifacts:rights'],
    })
    const auditContext = createExternalAuditContext({
      clientId: issued.client.id,
      credentialId: issued.credential.id,
      workspaceId,
      environment: 'production',
    })
    authenticatedActor = Object.freeze({
      ...auditContext,
      scopes: new Set(['projects:read', 'projects:write', 'artifacts:rights']),
      authenticationKind: 'bearer',
      clientKillSwitchEngaged: false,
      workspaceKillSwitchEngaged: false,
      clientAccessStatus: 'active',
      workspaceAccessStatus: 'active',
      auditContext,
    })
    const operationAuditContext = materializeActorAuditContext(authenticatedActor)
    const operationActorAudit = Object.freeze({
      actorCredentialId: operationAuditContext.credentialId,
      actorEnvironment: operationAuditContext.environment,
      actorAuthenticationKind: operationAuditContext.authenticationKind,
      actorContextHash: operationAuditContext.contextHash,
    })
    // The project is the sealed world the product builds: the creation Command (with its briefing and desired action), one
    // explicit 9:16 output variant, the two recordings' persisted ingests, and a child Command that adopts the first one and plays it.
    await seedReviewProject(client, { workspaceId, actor: authenticatedActor, prefix: 'manual', ids: { project: projectId, 'output-variant': '9:16' },
      name: 'Manual Project', objective: 'discovery', aspectRatio: '9:16', status: 'reviewing-proxy', briefing,
      desiredAction: { disclosures: [] } })
    for (const [slug, artifactId] of [[slugA, sourceA], [slugB, sourceB]]) {
      // Both recordings are 6 s at 30 fps; their source grants are the ones this test writes below, through the production service.
      await persistRecording(client, { workspaceId, projectId, actor: authenticatedActor, slug, durationFrames: 180, rights: { source: false } })
      // The second recording is a library insert of the project: its ingest receipt is what a Version adopts to play it, and its link
      // is the insert one (a project has one source master).
      if (artifactId === sourceB) await client.v2ProjectMediaAsset.updateMany({ where: { workspaceId, projectId, artifactId, role: 'source-master' }, data: { role: 'selected-insert' } })
      const sourceMetadata = Object.freeze({
        colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709',
        matrix: 'bt709', range: 'limited', bitDepth: 8,
      })
      const colorProbe = createMediaColorProbe({
        id: `manual-color-probe-${artifactId}`,
        workspaceId,
        artifactId,
        manifestId: recordingNames(slug).sourceManifestId,
        detection: {
          state: 'ready', metadata: sourceMetadata,
          pixelFormat: 'yuv420p', hdrMode: 'sdr',
        },
        producer: {
          provider: 'ffprobe', version: '7.1.1',
          binaryDigest: calculateVersionHash({ tool: 'ffprobe', version: '7.1.1' }),
        },
        createdAt: createdAt.toISOString(),
      })
      await client.v2MediaColorProbe.create({ data: {
        id: colorProbe.id,
        workspaceId,
        artifactId,
        manifestId: colorProbe.manifestId,
        schemaVersion: colorProbe.schemaVersion,
        state: colorProbe.detection.state,
        metadataJson: stableSerialize(colorProbe.detection.metadata),
        pixelFormat: colorProbe.detection.pixelFormat,
        hdrMode: colorProbe.detection.hdrMode,
        reasonsJson: '[]',
        producerProvider: colorProbe.producer.provider,
        producerVersion: colorProbe.producer.version,
        producerBinaryDigest: colorProbe.producer.binaryDigest,
        createdAt,
        probeHash: colorProbe.probeHash,
      } })
      const implementation = (provider, parameters) => Object.freeze({
        provider, version: 'v1', parameters: Object.freeze(parameters),
        parametersHash: calculateCanonicalHash(parameters),
      })
      const colorCompilation = await createColorPipelineCompilationService({
        repository: new PrismaColorPipelineCompilationRepository(client),
        createId: () => `manual-color-compilation-${artifactId}`,
        clock: () => createdAt,
      })({
        workspaceId,
        projectId,
        sourceArtifactId: artifactId,
        sourceManifestId: colorProbe.manifestId,
        outputMetadata: sourceMetadata,
        stages: [
          { id: `technical-${artifactId}`, kind: 'technical', version: 'v1', enabled: true, output: sourceMetadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
          { id: `match-${artifactId}`, kind: 'match', version: 'v1', enabled: false, output: sourceMetadata, implementation: implementation('apollo-match', { mode: 'bypass' }) },
          { id: `creative-${artifactId}`, kind: 'creative-lut', version: 'v1', enabled: false, output: sourceMetadata, implementation: implementation('apollo-lut', { mode: 'none' }) },
          { id: `output-${artifactId}`, kind: 'output', version: 'v1', enabled: true, output: sourceMetadata, implementation: implementation('ffmpeg-zscale', { dither: false }) },
        ],
        actor: authenticatedActor,
        idempotencyKey: `manual-color-${artifactId}`,
      })
      colorCompilations.set(artifactId, colorCompilation.value.compilation)
      // These are synthetic fixture sources, with grants for their exact roles.
      // Persist the real snapshot and external actor audit; a row alone is no grant.
      // The first recording is the project's source master (rendering); the second is a selected insert (editorial reuse). Each use is
      // allowed for its own role only.
      const rightsRepository = new PrismaAssetRightsRepository(client)
      const allowedUse = artifactId === sourceA ? 'rendering' : 'editorial-reuse'
      const rightsSnapshotId = `rights-${artifactId}`
      const baseRevision = assetRightsRevision(artifactId, 0)
      const granted = await setExternalAssetRightsService({
        repository: rightsRepository,
        clock: () => createdAt,
        createId: () => rightsSnapshotId,
      })({
        workspaceId, artifactId, baseRevision, actor: authenticatedActor,
        draft: {
          owner: 'Apollo synthetic manual-edit fixture', license: 'test-owned',
          status: 'approved', allowedUses: [allowedUse], prohibitedUses: [],
          allowedLocales: ['pt-BR'],
          consent: { status: 'not-required', allowedUses: [] },
          sourceNote: 'Controlled metadata-only source for manual-edit invariants; no media acceptance claim',
        },
      })
      const rightsReadback = await rightsRepository.findCurrent(workspaceId, artifactId)
      assert.deepEqual(rightsReadback, {
        artifactId, revision: assetRightsRevision(artifactId, 1), snapshot: granted.snapshot,
      })
      assert.equal(granted.replayed, false)
      assert.equal(rightsReadback.snapshot.id, rightsSnapshotId)
      assert.deepEqual(rightsReadback.snapshot.allowedUses, [allowedUse])
      assert.deepEqual(rightsReadback.snapshot.allowedWorkspaceIds, [workspaceId])
      assert.deepEqual(rightsReadback.snapshot.allowedLocales, ['pt-BR'])
      const rightsArtifact = await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: artifactId } })
      assert.equal(rightsArtifact.currentRightsSnapshotId, rightsSnapshotId)
      assert.equal(rightsArtifact.rightsRevision, 1)
      const rightsAudit = await client.v2AssetRightsChange.findUniqueOrThrow({
        where: { artifactId_sequence: { artifactId, sequence: 1 } },
      })
      assert.equal(rightsAudit.workspaceId, workspaceId)
      assert.equal(rightsAudit.snapshotId, rightsSnapshotId)
      assert.equal(rightsAudit.snapshotHash, granted.snapshot.snapshotHash)
      assert.equal(rightsAudit.baseRevision, baseRevision)
      assert.equal(rightsAudit.resultRevision, granted.revision)
      assert.equal(rightsAudit.actorKind, 'external')
      assert.equal(rightsAudit.actorType, 'api-client')
      assert.equal(rightsAudit.actorId, issued.client.id)
      assert.equal(rightsAudit.actorClientId, issued.client.id)
      assert.equal(rightsAudit.actorCredentialId, issued.credential.id)
      assert.equal(rightsAudit.actorContextHash, operationAuditContext.contextHash)
      assert.equal(rightsAudit.actorAuthenticationKind, 'bearer')
      assert.equal(rightsAudit.actorEnvironment, 'production')
      assert.equal(rightsAudit.changedAt.toISOString(), createdAt.toISOString())
      assert.equal(evaluateAssetUse(rightsReadback.snapshot, {
        workspaceId, locale: 'pt-BR', use: allowedUse,
      }, createdAt).outcome, 'allow')
      assert.equal(evaluateAssetUse(rightsReadback.snapshot, {
        workspaceId, locale: 'pt-BR',
        use: allowedUse === 'rendering' ? 'editorial-reuse' : 'rendering',
      }, createdAt).outcome, 'deny')
    }
    const { createMediaTranscript } = await import('../../src/v2/domain/media-transcript.ts')
    const currentTranscript = createMediaTranscript({
      language: 'pt-BR', text: 'Primeira frase Segunda', provider: 'groq', model: 'whisper-large-v3',
      words: [
        { word: 'Primeira', start: 0.2, end: 0.5 }, { word: 'frase', start: 1.2, end: 1.6 },
        { word: 'Segunda', start: 3.2, end: 3.6 },
      ],
      segments: [{ id: 0, start: 0.2, end: 3.6, text: 'Primeira frase Segunda' }],
    })
    const replacementTranscript = createMediaTranscript({
      language: 'pt-BR', text: 'Compre frase Segunda', provider: 'groq', model: 'whisper-large-v3',
      words: [
        { word: 'Compre', start: 0.2, end: 0.5 }, { word: 'frase', start: 1.2, end: 1.6 },
        { word: 'Segunda', start: 3.2, end: 3.6 },
      ],
      segments: [{ id: 0, start: 0.2, end: 3.6, text: 'Compre frase Segunda' }],
    })
    for (const [id, transcript, offset] of [
      [currentTranscriptId, currentTranscript, 0],
      [replacementTranscriptId, replacementTranscript, 1],
    ]) {
      await client.v2MediaTranscript.create({ data: {
        id, workspaceId, projectId, sourceArtifactId: sourceA, sourceManifestId: manifestA,
        schemaVersion: transcript.schemaVersion, language: transcript.language,
        provider: transcript.provider, model: transcript.model, providerVersion: 'test-v1',
        transcriptHash: transcript.transcriptHash, transcriptJson: stableSerialize(transcript),
        createdAt: new Date(createdAt.getTime() + offset * 1000),
      } })
    }
    // The plan's retimed transcript names the exact transcript it was derived from (an editorial cut later seals it).
    editPlan.retimedTranscript.sourceTranscriptHash = currentTranscript.transcriptHash
    // Its captions are the cue track aligned to that transcript (the words each cue shows), which an editorial cut needs to cut a cue.
    Object.assign(editPlan.subtitleTracks[0], { schemaVersion: 'source-transcript-cue-track/v1', sourceTranscriptId: currentTranscriptId,
      sourceTranscriptHash: currentTranscript.transcriptHash })
    editPlan.subtitleTracks[0].cues[0].sourceWordIndices = [0, 1]
    editPlan.subtitleTracks[0].cues[1].sourceWordIndices = [2]
    // The initial Version is a real child Command: it adopts the first recording's persisted ingest receipt (the only source
    // its clips play; the second is offered but not consumed) and carries the timeline above. Its sequence follows the creation
    // Command (1) and the output variant (2): every revision below is counted from it.
    const initialBundle = await commitSealedChild(client, { workspaceId, projectId, actor: authenticatedActor,
      suffix: `manual-${suffix}-initial`, versionId: initialVersionId, snapshotId: editPlanId,
      mutatePlan: () => editPlan, adopt: [sourceA, sourceB] })
    const initialBaseHash = initialBundle.version.baseHash
    const sequenceOffset = initialBundle.version.sequence - 1
    const rev = (sequence) => sequence + sequenceOffset
    const completedProxyManifestId = `manifest-${completedProxyArtifactId}`
    const completedProxyOperationId = `manual-proxy-operation-${suffix}`
    const completedProxyHash = calculateVersionHash({ completedProxyArtifactId })
    await client.v2MediaArtifact.create({ data: {
      id: completedProxyArtifactId, workspaceId,
      artifactKey: `manual/${completedProxyArtifactId}.mp4`,
      sha256: completedProxyHash, byteSize: 1n,
      mediaType: 'video', container: 'mp4', status: 'available', createdAt,
    } })


    // These explicit completions are metadata-only fixture preparation, not
    // worker execution, FFmpeg provenance, critic approval or rendered pixels.
    const proxyMaps = new PrismaRenderElementMapRepository(client)
    const prepareControlledProxyMetadata = async ({
      mode, operationId, projectVersionId, editPlanSnapshotId,
      outputArtifactId: newArtifactId, manifestId: newManifestId, expectedOperation,
    }) => {
      assert.ok(['new-controlled-base', 'complete-api-operation'].includes(mode))
      const existing = await client.v2PublicOperation.findUnique({ where: { id: operationId }, include: { projectProxyRender: true } })
      // The primary source of a proxy is the product's choice (the render sources of the Version decide it): an operation the API
      // allocated names it, and the fixture follows it instead of assuming the first recording.
      const primary = mode === 'complete-api-operation' && existing?.projectProxyRender
        ? { sourceArtifactId: existing.projectProxyRender.sourceArtifactId, sourceManifestId: existing.projectProxyRender.sourceManifestId }
        : { sourceArtifactId: sourceA, sourceManifestId: manifestA }
      const source = await new PrismaProjectProxyRenderRepository(client).readImmutableSource({
        workspaceId, projectId, projectVersionId, editPlanSnapshotId, ...primary,
      })
      const colorPipelineBindings = source.renderSources.filter((asset) => asset.mediaType === 'video').map((asset) => {
        const compilation = colorCompilations.get(asset.artifactId)
        assert.ok(compilation)
        return { sourceArtifactId: asset.artifactId, sourceManifestId: asset.manifestId,
          compilationId: compilation.id, compilationHash: compilation.compilationHash, pipelineHash: compilation.pipeline.pipelineHash }
      })
      const inputHash = projectProxyRenderInputHash({ source, colorPipelineBindings })
      const colorBindingsJson = stableSerialize(colorPipelineBindings)
      let outputArtifactId = newArtifactId, manifestId = newManifestId
      if (mode === 'complete-api-operation') {
        assert.ok(existing?.projectProxyRender, 'the API must have allocated this exact proxy operation')
        const detail = existing.projectProxyRender
        assert.deepEqual({ workspaceId: detail.workspaceId, projectId: detail.projectId,
          projectVersionId: detail.projectVersionId, editPlanSnapshotId: detail.editPlanSnapshotId,
          sourceArtifactId: detail.sourceArtifactId, sourceManifestId: detail.sourceManifestId,
          inputHash: detail.inputHash, colorBindingsJson: detail.colorPipelineBindingsJson },
        { workspaceId, projectId, projectVersionId, editPlanSnapshotId,
          ...primary, inputHash, colorBindingsJson })
        assert.equal(existing.workspaceId, workspaceId); assert.equal(existing.projectId, projectId)
        assert.equal(existing.type, 'project-proxy-render'); assert.equal(existing.clientId, issued.client.id)
        const auditInput = { workspaceId, clientId: existing.clientId, credentialId: existing.actorCredentialId,
          environment: existing.actorEnvironment, authenticationKind: existing.actorAuthenticationKind,
          ...(existing.delegatedUserId ? { delegatedUserId: existing.delegatedUserId } : {}),
          ...(existing.delegatedIdentityId ? { delegatedIdentityId: existing.delegatedIdentityId } : {}),
          ...(existing.workspaceRole ? { workspaceRole: existing.workspaceRole } : {}) }
        const persistedAudit = createApiAccessAuditContext(auditInput)
        assert.equal(persistedAudit.contextHash, existing.actorContextHash)
        assert.equal(persistedAudit.environment, 'production')
        if (persistedAudit.authenticationKind === 'bearer') {
          assert.equal(persistedAudit.credentialId, issued.credential.id)
          assert.equal(persistedAudit.contextHash, operationAuditContext.contextHash)
        } else {
          assert.match(persistedAudit.credentialId, /^ui-session:[a-f0-9]{64}$/)
          const member = await client.v2WorkspaceMember.findUniqueOrThrow({ where: { id: persistedAudit.delegatedUserId } })
          assert.equal(member.workspaceId, workspaceId); assert.equal(member.identityId, persistedAudit.delegatedIdentityId)
          assert.equal(member.role, persistedAudit.workspaceRole); assert.equal(member.status, 'active')
        }
        assert.equal(existing.targetType, 'media-artifact'); assert.equal(existing.targetId, detail.outputArtifactId)
        assert.equal(existing.leaseOwner, null)
        assert.equal(existing.leaseExpiresAt, null)
        assert.ok(['queued', 'succeeded'].includes(existing.status), 'fixture must never adopt a live, failed or canceled attempt')
        assert.equal(expectedOperation.id, existing.id)
        assert.equal(expectedOperation.target.id, detail.outputArtifactId)
        assert.equal(expectedOperation.target.manifestId, detail.outputManifestId)
        outputArtifactId = detail.outputArtifactId; manifestId = detail.outputManifestId
      } else {
        assert.equal(existing, null, 'a new controlled base cannot duplicate any allocated operation')
        assert.equal(await client.v2ProjectProxyRenderOperation.count({ where: { workspaceId, projectVersionId, inputHash } }), 0)
        assert.ok(outputArtifactId && manifestId)
      }
      const proxyHash = outputArtifactId === completedProxyArtifactId ? completedProxyHash
        : calculateVersionHash({ fixtureScope: 'metadata-only-manual-edit-mechanics', operationId, outputArtifactId })
      const artifactKey = `manual/${outputArtifactId}.mp4`
      const dimensions = {}
      for (const asset of source.renderSources.filter((asset) => asset.mediaType === 'video')) {
        const row = await client.v2MediaArtifactManifest.findUniqueOrThrow({ where: { id: asset.manifestId } })
        const body = JSON.parse(row.manifestJson); assertMediaArtifactManifest(body)
        assert.equal(body.manifestHash, row.manifestHash); assert.ok(body.probe)
        dimensions[asset.artifactId] = { width: body.probe.width, height: body.probe.height }
      }
      const map = buildRenderElementMap({ proxyHash, fps: source.editPlan.fps, durationFrames: source.editPlan.durationFrames,
        canvas: { width: 540, height: 960 }, source: dimensions[sourceA], sourceDimensions: dimensions,
        clips: source.editPlan.videoTracks.filter((track) => track.kind === 'base-video').flatMap((track) => track.clips),
        composition: source.editPlan.composition, subtitleCues: [], ctaOverlays: [] })
      const mapHash = renderElementMapHash(map)
      const digest = createHash('sha256').update(`apollo-v2-ffmpeg-editorial/${FFMPEG_EDITORIAL_RENDERER_VERSION}`).digest('hex')
      const manifest = createMediaArtifactManifestV2({ artifactKey, artifactSha256: proxyHash, byteSize: 1, mediaType: 'video', container: 'mp4',
        recipe: { id: 'editorial-proxy', version: EDITORIAL_PROXY_RECIPE_VERSION, parameters: {
          fixtureScope: 'metadata-only-manual-edit-mechanics', operationId, projectVersionId, editPlanSnapshotId,
          editPlanHash: source.editPlanHash, inputHash, renderElementMapHash: mapHash,
          captionPolicy: 'unknown-face-suppressed', colorPipelineBindings } },
        sources: source.renderSources.map((asset) => ({ artifactKey: asset.artifactKey, sha256: asset.sha256, role: asset.role,
          execution: { tool: { id: 'ffmpeg', version: 'static', digest } } })),
        probe: { width: 540, height: 960, duration: map.durationFrames / map.fps, fps: map.fps } })
      const now = new Date()
      const resultJson = stableSerialize({ resource: { type: 'media-artifact', id: outputArtifactId, manifestId } })
      await client.$transaction(async (transaction) => {
        const artifact = await transaction.v2MediaArtifact.findUnique({ where: { id: outputArtifactId } })
        if (artifact) assert.deepEqual({ workspaceId: artifact.workspaceId, artifactKey: artifact.artifactKey, sha256: artifact.sha256,
          byteSize: artifact.byteSize, mediaType: artifact.mediaType, container: artifact.container, status: artifact.status },
        { workspaceId, artifactKey, sha256: proxyHash, byteSize: 1n, mediaType: 'video', container: 'mp4', status: 'available' })
        else await transaction.v2MediaArtifact.create({ data: { id: outputArtifactId, workspaceId, artifactKey, sha256: proxyHash,
          byteSize: 1n, mediaType: 'video', container: 'mp4', status: 'available', createdAt: now } })
        const storedManifest = await transaction.v2MediaArtifactManifest.findUnique({ where: { id: manifestId } })
        const manifestData = { id: manifestId, workspaceId, artifactId: outputArtifactId, schemaVersion: manifest.schemaVersion,
          manifestHash: manifest.manifestHash, recipeId: manifest.recipe.id, recipeVersion: manifest.recipe.version,
          parametersHash: manifest.recipe.parametersHash, manifestJson: stableSerialize(manifest) }
        if (storedManifest) for (const [key, value] of Object.entries(manifestData)) assert.equal(storedManifest[key], value)
        else await transaction.v2MediaArtifactManifest.create({ data: { ...manifestData, createdAt: now } })
        const storedMap = await transaction.v2RenderElementMap.findFirst({ where: { workspaceId, projectVersionId, proxyArtifactId: outputArtifactId } })
        const mapData = { workspaceId, projectId, projectVersionId, proxyArtifactId: outputArtifactId, proxyHash, mapHash,
          schemaVersion: map.schemaVersion, fps: map.fps, durationFrames: map.durationFrames,
          canvasWidth: map.canvas.width, canvasHeight: map.canvas.height, elementsJson: JSON.stringify(map.elements) }
        if (storedMap) for (const [key, value] of Object.entries(mapData)) assert.equal(storedMap[key], value)
        else await transaction.v2RenderElementMap.create({ data: { id: randomUUID(), ...mapData, createdAt: now } })
        if (existing) {
          const current = await transaction.v2PublicOperation.findUniqueOrThrow({ where: { id: operationId }, include: { projectProxyRender: true } })
          assert.deepEqual(current.projectProxyRender, existing.projectProxyRender, 'reserved output/source/detail identity cannot change during fixture preparation')
          assert.equal(current.status, existing.status); assert.equal(current.leaseOwner, null)
          for (const key of ['clientId', 'actorCredentialId', 'actorEnvironment', 'actorAuthenticationKind', 'actorContextHash', 'delegatedUserId', 'delegatedIdentityId', 'workspaceRole']) assert.equal(current[key], existing[key])
          if (current.status === 'succeeded') {
            assert.equal(current.phase, 'completed'); assert.equal(current.resultJson, resultJson)
          } else {
            const changed = await transaction.v2PublicOperation.updateMany({ where: { id: operationId, workspaceId, projectId,
              status: 'queued', attempt: existing.attempt, leaseOwner: null, targetId: outputArtifactId },
            data: { status: 'succeeded', phase: 'completed', progressCompleted: 4, progressTotal: 4, progressUnit: 'render',
              cancelable: false, retryable: false, attempt: 1, resultJson, startedAt: now, completedAt: now, updatedAt: now } })
            assert.equal(changed.count, 1, 'metadata-only completion must own the unchanged queued identity')
          }
          // A completed proxy is bound to the stable output variant it was rendered for: an editorial cut or a restore refuses a
          // proxy without that authority, and the route's enqueue does not write it.
          await transaction.v2ProjectProxyRenderOperation.update({ where: { operationId }, data: { renderableVariantId: '9:16' } })
        } else {
          await transaction.v2PublicOperation.create({ data: { id: operationId, workspaceId, projectId, clientId: issued.client.id,
            ...operationActorAudit, type: 'project-proxy-render', status: 'succeeded', phase: 'completed',
            targetType: 'media-artifact', targetId: outputArtifactId, progressCompleted: 4, progressTotal: 4, progressUnit: 'render',
            cancelable: false, retryable: false, attempt: 1, maxAttempts: 3, resultJson, idempotencyKey: `controlled-${operationId}`,
            requestFingerprint: calculateVersionHash({ fixtureScope: 'metadata-only', operationId, inputHash }),
            createdAt: now, updatedAt: now, startedAt: now, completedAt: now } })
          await transaction.v2ProjectProxyRenderOperation.create({ data: { operationId, workspaceId, projectId, projectVersionId,
            editPlanSnapshotId, sourceArtifactId: sourceA, sourceManifestId: manifestA,
            colorPipelineBindingsJson: colorBindingsJson, inputHash, outputArtifactId, outputManifestId: manifestId,
            renderableVariantId: '9:16', originalFileName: `${outputArtifactId}.mp4`, createdAt: now } })
        }
      }, { isolationLevel: 'Serializable' })
      const record = await client.v2PublicOperation.findUniqueOrThrow({ where: { id: operationId }, include: { projectProxyRender: true } })
      assert.equal(record.status, 'succeeded'); assert.equal(record.phase, 'completed'); assert.equal(record.resultJson, resultJson)
      assert.equal(record.projectProxyRender.inputHash, inputHash)
      assert.equal(record.projectProxyRender.outputArtifactId, outputArtifactId)
      assert.equal(record.projectProxyRender.outputManifestId, manifestId)
      const artifactReadback = await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: outputArtifactId } })
      assert.equal(artifactReadback.workspaceId, workspaceId); assert.equal(artifactReadback.artifactKey, artifactKey)
      assert.equal(artifactReadback.sha256, proxyHash); assert.equal(artifactReadback.byteSize, 1n)
      const manifestReadback = await client.v2MediaArtifactManifest.findUniqueOrThrow({ where: { id: manifestId } })
      assert.equal(manifestReadback.workspaceId, workspaceId); assert.equal(manifestReadback.artifactId, outputArtifactId)
      assert.equal(manifestReadback.manifestHash, manifest.manifestHash)
      assert.deepEqual(JSON.parse(manifestReadback.manifestJson), manifest)
      assertMediaArtifactManifest(JSON.parse(manifestReadback.manifestJson))
      const readback = await proxyMaps.findExact({ workspaceId, projectId, projectVersionId, proxyArtifactId: outputArtifactId })
      assert.equal(readback.mapHash, mapHash); assert.deepEqual(readback.map, map)
      assert.equal(readback.map.elements.some((element) => element.type === 'subtitle'), false)
      console.log(JSON.stringify({ fixtureScope: 'metadata-only-manual-edit-mechanics', mode, operationId, projectVersionId,
        originalStatus: existing?.status ?? null, outputArtifactId, manifestId, inputHash, mapHash,
        physicalRenderObserved: false, approvalTransferred: false }))
      return { operationId, outputArtifactId, manifestId, inputHash, map: readback }
    }
    const initialProxyMetadata = await prepareControlledProxyMetadata({ mode: 'new-controlled-base', operationId: completedProxyOperationId,
      projectVersionId: initialVersionId, editPlanSnapshotId: editPlanId, outputArtifactId: completedProxyArtifactId, manifestId: completedProxyManifestId })

    assert.equal(initialProxyMetadata.outputArtifactId, completedProxyArtifactId)
    const initial = await readManualTimelineService({ repository })({ workspaceId, projectId })
    assert.equal(initial.timeline.clips.length, 2)
    assert.deepEqual(initial.timeline.snapPointsMs, [0, 3000, 6000])

    const split = await execute({
      baseVersionId: initialVersionId,
      baseHash: initialBaseHash,
      expectedRevision: rev(1),
      action: 'apply',
      variantId: '9:16',
      targetId: 'clip-1',
      operation: { kind: 'split', clipId: 'clip-1', atMs: 1505 },
      idempotencyKey: `manual-split-${suffix}`,
    })
    assert.equal(split.version.sequence, rev(2))
    assert.deepEqual(split.timeline.clips.map((clip) => clip.id), ['clip-1:a', 'clip-1:b', 'clip-2'])
    assert.equal(split.timeline.clips[0].endMs, 1500)
    const splitStoredCommand = await client.v2EditCommand.findUnique({ where: { id: split.command.id } })
    assert.equal(splitStoredCommand.type, 'manual-edit')
    assert.equal(splitStoredCommand.actorId, issued.client.id)
    assert.equal(splitStoredCommand.actorCredentialId, issued.credential.id)
    assert.equal(
      splitStoredCommand.actorContextHash,
      materializeActorAuditContext(authenticatedActor).contextHash,
    )
    const splitPayload = JSON.parse(splitStoredCommand.payloadJson)
    assert.equal(splitPayload.schemaVersion, 2)
    assert.equal(splitPayload.impact.schemaVersion, 'command-impact/v1')
    assert.equal(splitPayload.impact.commandId, split.command.id)
    assert.equal(splitPayload.impact.baseVersionId, initialVersionId)
    assert.equal(splitPayload.impact.resultVersionId, split.version.id)
    assert.deepEqual(splitPayload.impact.affectedRanges, [{ startFrame: 0, endFrame: 90 }])
    assert.equal(splitPayload.impact.impactHash.length, 64)
    assert.deepEqual(split.invalidations.map((item) => item.artifactId), [completedProxyArtifactId])
    const splitInvalidations = await client.v2CommandArtifactInvalidation.findMany({
      where: { commandId: split.command.id },
    })
    assert.equal(splitInvalidations.length, 1)
    assert.equal(splitInvalidations[0].artifactId, completedProxyArtifactId)
    assert.equal(splitInvalidations[0].status, 'stale')
    assert.equal(splitInvalidations[0].resultVersionId, split.version.id)
    assert.equal((await client.v2MediaArtifact.findUnique({
      where: { id: completedProxyArtifactId },
    })).status, 'available')

    await assert.rejects(() => execute({
      baseVersionId: initialVersionId,
      baseHash: initialBaseHash,
      expectedRevision: rev(1),
      action: 'apply',
      variantId: '9:16',
      targetId: 'clip-2',
      operation: { kind: 'replace', clipId: 'clip-2', sourceId: sourceB },
      idempotencyKey: `manual-stale-${suffix}`,
    }), (error) => error instanceof DomainError && error.code === 'VERSION_CONFLICT')

    const inspect = await execute({
      baseVersionId: split.version.id,
      baseHash: split.version.baseHash,
      expectedRevision: rev(2),
      action: 'apply',
      variantId: '9:16',
      targetId: 'clip-1:a',
      operation: { kind: 'inspect', clipId: 'clip-1:a', patch: {
        layout: 'close-up', text: 'Texto ajustado', subtitle: 'bold',
        color: 'warm-lut', motion: 'static', audioGain: 0.9,
      } },
      idempotencyKey: `manual-inspect-${suffix}`,
    })
    assert.equal(inspect.version.sequence, rev(3))
    assert.match(JSON.stringify(inspect.editPlan), /Texto ajustado/)
    assert.match(JSON.stringify(inspect.editPlan), /warm-lut/)

    const undo = await execute({
      baseVersionId: inspect.version.id,
      baseHash: inspect.version.baseHash,
      expectedRevision: rev(3),
      action: 'undo',
      variantId: '9:16',
      targetId: 'clip-1:a',
      targetVersionId: split.version.id,
      idempotencyKey: `manual-undo-${suffix}`,
    })
    assert.equal(undo.version.sequence, rev(4))
    assert.doesNotMatch(JSON.stringify(undo.editPlan), /Texto ajustado/)
    assert.equal(undo.command.payload.restoresVersionId, split.version.id)

    const redo = await execute({
      baseVersionId: undo.version.id,
      baseHash: undo.version.baseHash,
      expectedRevision: rev(4),
      action: 'redo',
      variantId: '9:16',
      targetId: 'clip-1:a',
      targetVersionId: inspect.version.id,
      idempotencyKey: `manual-redo-${suffix}`,
    })
    assert.equal(redo.version.sequence, rev(5))
    assert.match(JSON.stringify(redo.editPlan), /Texto ajustado/)
    const replay = await execute({
      baseVersionId: undo.version.id,
      baseHash: undo.version.baseHash,
      expectedRevision: rev(4),
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
        // This journey sends bursts of writes from one client within a minute: the request-spike anomaly is not what it proves.
        APOLLO_GOVERNANCE_ANOMALY_REQUEST_MINIMUM: '1000000',
        APOLLO_AUTH_MODE: 'bootstrap',
        APOLLO_ALLOW_BOOTSTRAP_AUTH: 'true',
        APOLLO_UI_BOOTSTRAP_ROLE: 'operator',
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
    assert.equal(timeline.data.timeline.revision, rev(5))
    assert.equal(timeline.data.history[0].action, 'redo')
    const invalidationsResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/artifact-invalidations?resultVersionId=${split.version.id}`,
      { headers: { authorization } },
    )
    const invalidationsView = await invalidationsResponse.json()
    assert.equal(invalidationsResponse.status, 200, JSON.stringify(invalidationsView))
    assert.equal(invalidationsView.data.resultVersionId, split.version.id)
    assert.deepEqual(
      invalidationsView.data.invalidations.map((item) => item.artifactId),
      [completedProxyArtifactId],
    )

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
    assert.equal(publicApplied.data.version.sequence, rev(6))
    assert.equal(publicApplied.data.operation.status, 'queued')
    assert.equal(publicApplied.data.command.payload.schemaVersion, 2)
    assert.equal(publicApplied.data.command.payload.impact.schemaVersion, 'command-impact/v1')
    assert.equal(publicApplied.data.timeline.clips.find((clip) => clip.id === 'clip-2').sourceId, sourceB)
    const { readProjectWorkspaceService } = await import('../../src/v2/application/read-project-workspace.ts')
    const { PrismaProjectWorkspaceQueryRepository } = await import('../../src/v2/infrastructure/prisma/project-workspace-query-repository.ts')
    const workspaceProjection = await readProjectWorkspaceService({
      projects: new PrismaProjectWorkspaceQueryRepository(client),
    })({ workspaceId, projectId })
    assert.equal(workspaceProjection.version.id, publicApplied.data.version.id)

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
    const loginCompleted = page.waitForResponse((response) =>
      response.url().endsWith('/v1/session') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Entrar no Apollo' }).click()
    const loginResponse = await loginCompleted
    const loginBody = await loginResponse.json()
    assert.equal(loginResponse.status(), 200, JSON.stringify(loginBody))
    await page.waitForURL(`**/projects/${projectId}`)
    const uiWorkspaceResponse = await page.request.get(
      `${baseUrl}/v1/projects/${projectId}/workspace`,
      { headers: { accept: 'application/json' } },
    )
    const uiWorkspace = await uiWorkspaceResponse.json()
    assert.equal(uiWorkspaceResponse.status(), 200, JSON.stringify(uiWorkspace))
    const uiTimelineResponse = await page.request.get(
      `${baseUrl}/v1/projects/${projectId}/timeline`,
      { headers: { accept: 'application/json' } },
    )
    const uiTimeline = await uiTimelineResponse.json()
    assert.equal(uiTimelineResponse.status(), 200, JSON.stringify(uiTimeline))
    assert.equal(uiTimeline.data.timeline.versionId, publicApplied.data.version.id)
    const manualEditor = page.getByTestId('manual-editor')
    await manualEditor.waitFor({ state: 'visible', timeout: 10_000 }).catch(async (error) => {
      throw new Error(`${error.message}\n${(await page.locator('body').innerText()).slice(-4_000)}`)
    })
    await page.getByTestId('manual-clip-clip-2').click()
    await assert.doesNotReject(async () => {
      await page.getByTestId('manual-selected-clip').waitFor({ state: 'visible' })
      assert.equal(await page.getByTestId('manual-selected-clip').textContent(), 'clip-2')
    })

    const clipBox = await page.getByTestId('manual-clip-clip-2').boundingBox()
    assert.ok(clipBox)
    const moved = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/v1/projects/${projectId}/manual-edits`)
        && response.request().method() === 'POST',
      { timeout: 90_000 },
    )
    await page.mouse.move(clipBox.x + clipBox.width / 2, clipBox.y + clipBox.height / 2)
    await page.mouse.down()
    await new Promise((resolve) => setTimeout(resolve, 100))
    await page.mouse.move(clipBox.x - 180, clipBox.y + clipBox.height / 2, { steps: 8 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    await page.mouse.up()
    assert.equal((await moved).status(), 201)
    await page.getByText(new RegExp(`Edição registrada na versão ${rev(7)}`)).waitFor({ state: 'visible' })

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
    await page.getByText(new RegExp(`Undo registrado como versão ${rev(8)}`)).waitFor({ state: 'visible' })
    assert.match(await manualEditor.textContent(), new RegExp(`V${rev(8)}`))

    const beforeTrimResponse = await fetch(`${baseUrl}/v1/projects/${projectId}/timeline`, {
      headers: { authorization },
    })
    const beforeTrim = await beforeTrimResponse.json()
    assert.equal(beforeTrimResponse.status, 200, JSON.stringify(beforeTrim))
    assert.equal(beforeTrim.data.timeline.revision, rev(8))
    const beforeCompareVersionId = beforeTrim.data.timeline.versionId
    // KNOWN PRODUCT DEFECT (manual-editing.ts, `trim`/`split` of a clip that `replace` gave audioSource* ranges): the trim moves the video
    // range and the timeline but not audioSourceOutFrame, so the sealed materialization refuses the clip with INVALID_RENDER_INPUT
    // 'Primary/secondary audio rate map invalid' (output-materialization.ts). Replacing a different clip than the one trimmed passes.
    const trimResponse = await fetch(`${baseUrl}/v1/projects/${projectId}/manual-edits`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': `manual-compare-trim-${suffix}`,
      },
      body: JSON.stringify({
        action: 'apply',
        baseVersionId: beforeTrim.data.timeline.versionId,
        baseHash: beforeTrim.data.baseHash,
        expectedRevision: beforeTrim.data.timeline.revision,
        variantId: '9:16',
        targetId: 'clip-2',
        operation: { kind: 'trim', clipId: 'clip-2', edge: 'end', atMs: 4000 },
      }),
    })
    const trimmed = await trimResponse.json()
    let trimDiagnostic = '' // Failure diagnostics: the route hides the domain error, so the same apply runs in-process.
    if (trimResponse.status !== 201) {
      try {
        await execute({ baseVersionId: beforeTrim.data.timeline.versionId, baseHash: beforeTrim.data.baseHash,
          expectedRevision: beforeTrim.data.timeline.revision, action: 'apply', variantId: '9:16', targetId: 'clip-2',
          operation: { kind: 'trim', clipId: 'clip-2', edge: 'end', atMs: 4000 }, idempotencyKey: `diag-trim-${suffix}` })
        trimDiagnostic = 'apply ok in-process'
      } catch (error) { trimDiagnostic = `${error?.code} ${error?.message} ${JSON.stringify(error?.details ?? null)}` }
    }
    assert.equal(trimResponse.status, 201, `${JSON.stringify(trimmed)}\n${trimDiagnostic}`)
    assert.equal(trimmed.data.version.sequence, rev(9))
    const afterCompareVersionId = trimmed.data.version.id
    const comparisonUrl = (mode) => {
      const query = new URLSearchParams({
        beforeVersionId: beforeCompareVersionId,
        afterVersionId: afterCompareVersionId,
        mode,
      })
      return `${baseUrl}/v1/projects/${projectId}/version-comparisons?${query}`
    }
    for (const mode of ['toggle', 'split', 'overlay']) {
      const response = await fetch(comparisonUrl(mode), { headers: { authorization } })
      const compared = await response.json()
      assert.equal(response.status, 200, JSON.stringify(compared))
      assert.equal(compared.data.comparison.mode, mode)
      assert.equal(compared.data.comparison.durationDeltaMs, -2000)
      assert.equal(compared.data.comparison.synchronized, false)
      assert.equal(compared.data.comparison.playheadMapping, 'independent')
      assert.equal(compared.data.comparison.versionsPreserved, true)
      assert.ok(compared.data.comparison.semanticChanges.some((change) => change.category === 'duration'))
    }

    const compareActionBody = (action) => ({
      action,
      beforeVersionId: beforeCompareVersionId,
      afterVersionId: afterCompareVersionId,
      mode: 'split',
      baseVersionId: afterCompareVersionId,
      baseHash: trimmed.data.version.baseHash,
      expectedRevision: rev(9),
      variantId: '9:16',
    })
    // A compare action is the only no-render Command: it moves the review state
    // and must leave versions, renders and artifact invalidations untouched.
    const compareBaseline = {
      versions: await client.v2ProjectVersion.count({ where: { projectId } }),
      invalidations: await client.v2CommandArtifactInvalidation.count({ where: { workspaceId } }),
      renderOperations: await client.v2ProjectProxyRenderOperation.count({ where: { workspaceId } }),
      commands: await client.v2EditCommand.count({ where: { projectId } }),
    }
    const compareAct = (action, key) => fetch(`${baseUrl}/v1/projects/${projectId}/version-comparisons`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(compareActionBody(action)),
    })
    const acceptKey = `manual-compare-accept-${suffix}`
    const accept = () => compareAct('accept', acceptKey)
    const acceptedResponse = await accept()
    const accepted = await acceptedResponse.json()
    assert.equal(acceptedResponse.status, 201, JSON.stringify(accepted))
    assert.equal(accepted.data.command.type, 'compare-action')
    assert.equal(accepted.data.projectStatus, 'reviewing-proxy')
    assert.equal(accepted.data.versionsPreserved, true)

    const acceptedImpact = accepted.data.impact
    assert.equal(acceptedImpact.schemaVersion, 'compare-action-impact/v1')
    assert.equal(acceptedImpact.commandType, 'compare-action')
    assert.equal(acceptedImpact.commandId, accepted.data.command.id)
    assert.equal(acceptedImpact.action, 'accept')
    assert.equal(acceptedImpact.baseVersionId, afterCompareVersionId)
    assert.equal(acceptedImpact.resultVersionId, afterCompareVersionId, 'accept preserves its version')
    assert.equal(acceptedImpact.renderSemanticsChanged, false)
    assert.deepEqual(acceptedImpact.changeKinds, ['review-state'])
    for (const field of [
      'dependencyTypes', 'affectedRanges', 'affectedVariantIds',
      'affectedArtifacts', 'minimalRenders',
    ]) {
      assert.deepEqual(acceptedImpact[field], [], `${field} must stay empty in persisted state`)
    }
    assert.match(acceptedImpact.impactHash, /^[a-f0-9]{64}$/)
    assert.equal(accepted.data.command.payload.schemaVersion, 2)
    assert.equal(accepted.data.command.payload.impact.impactHash, acceptedImpact.impactHash)

    // The impact really is in Postgres, byte for byte, and the parser accepts it.
    const storedAcceptCommand = await client.v2EditCommand.findUnique({
      where: { id: accepted.data.command.id },
    })
    const storedAcceptPayload = JSON.parse(storedAcceptCommand.payloadJson)
    assert.equal(storedAcceptPayload.schemaVersion, 2)
    assert.equal(storedAcceptPayload.impact.impactHash, acceptedImpact.impactHash)
    assert.equal(
      parseCompareActionImpact(storedAcceptPayload.impact).impactHash,
      acceptedImpact.impactHash,
    )
    assert.equal(storedAcceptCommand.baseVersionId, afterCompareVersionId)

    const acceptedEvent = await client.v2PublicEventOutbox.findFirst({
      where: { workspaceId, type: 'project.status.changed', resourceId: projectId },
      orderBy: { occurredAt: 'desc' },
    })
    const acceptedEventData = JSON.parse(acceptedEvent.dataJson)
    assert.equal(acceptedEventData.commandImpactHash, acceptedImpact.impactHash)
    assert.equal(acceptedEventData.artifactInvalidationCount, 0)
    assert.equal(acceptedEventData.versionsPreserved, true)
    assert.equal(acceptedEventData.compareAction, 'accept')

    const acceptedReplayResponse = await accept()
    const acceptedReplay = await acceptedReplayResponse.json()
    assert.equal(acceptedReplayResponse.status, 200)
    assert.equal(acceptedReplay.data.replayed, true)
    assert.equal(acceptedReplay.data.command.id, accepted.data.command.id)
    assert.equal(
      acceptedReplay.data.impact.impactHash,
      acceptedImpact.impactHash,
      'the replay rehydrates the stored impact instead of rebuilding it',
    )

    // A stale revision rolls the whole decision back: no Command, no status move.
    const staleResponse = await fetch(`${baseUrl}/v1/projects/${projectId}/version-comparisons`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': `manual-compare-stale-${suffix}`,
      },
      body: JSON.stringify({ ...compareActionBody('accept'), expectedRevision: rev(8) }),
    })
    const stale = await staleResponse.json()
    assert.equal(staleResponse.status, 409, JSON.stringify(stale))
    assert.equal(stale.error.code, 'VERSION_CONFLICT')
    assert.equal(
      await client.v2EditCommand.count({ where: { projectId, idempotencyKey: `manual-compare-stale-${suffix}` } }),
      0,
      'a conflicting compare action persists nothing',
    )
    assert.equal(
      (await client.v2Project.findUnique({ where: { id: projectId } })).status,
      'reviewing-proxy',
      'a conflicting compare action leaves the review state where accept put it',
    )

    const reopenedResponse = await compareAct('reopen', `manual-compare-reopen-${suffix}`)
    const reopened = await reopenedResponse.json()
    assert.equal(reopenedResponse.status, 201, JSON.stringify(reopened))
    assert.equal(reopened.data.projectStatus, 'revising')
    assert.equal(reopened.data.impact.action, 'reopen')
    assert.equal(reopened.data.impact.resultVersionId, afterCompareVersionId)
    assert.equal(reopened.data.impact.renderSemanticsChanged, false)
    assert.notEqual(
      reopened.data.impact.impactHash,
      acceptedImpact.impactHash,
      'accept and reopen are distinct content-addressed decisions',
    )
    assert.equal((await client.v2Project.findUnique({ where: { id: projectId } })).status, 'revising')

    assert.deepEqual({
      versions: await client.v2ProjectVersion.count({ where: { projectId } }),
      invalidations: await client.v2CommandArtifactInvalidation.count({ where: { workspaceId } }),
      renderOperations: await client.v2ProjectProxyRenderOperation.count({ where: { workspaceId } }),
      commands: await client.v2EditCommand.count({ where: { projectId } }),
    }, {
      ...compareBaseline,
      commands: compareBaseline.commands + 2,
    }, 'accept and reopen add two Commands and nothing else — no version, no render, no invalidation')

    await page.reload()
    await page.getByTestId('version-compare').waitFor({ state: 'visible' })
    await page.getByTestId('compare-before').selectOption(beforeCompareVersionId)
    await page.getByTestId('compare-after').selectOption(afterCompareVersionId)
    await page.getByTestId('compare-mode-overlay').click()
    const overlayLoaded = page.waitForResponse((response) =>
      response.url().includes(`/v1/projects/${projectId}/version-comparisons?`)
      && response.request().method() === 'GET',
    )
    await page.getByTestId('compare-load').click()
    assert.equal((await overlayLoaded).status(), 200)
    await page.getByTestId('compare-result').waitFor({ state: 'visible' })
    assert.match(await page.getByTestId('compare-sync-state').textContent(), /timelines independentes/)
    assert.match(await page.getByTestId('compare-result').textContent(), /-2\.00s/)
    assert.equal(await page.getByTestId('compare-overlay-preview').isVisible(), true)
    await page.getByTestId('compare-mode-split').click()
    const splitLoaded = page.waitForResponse((response) =>
      response.url().includes(`/v1/projects/${projectId}/version-comparisons?`)
      && response.request().method() === 'GET',
    )
    await page.getByTestId('compare-load').click()
    assert.equal((await splitLoaded).status(), 200)
    await page.getByTestId('compare-split-preview').waitFor({ state: 'visible' })
    const restoredResponse = page.waitForResponse((response) =>
      response.url().endsWith(`/v1/projects/${projectId}/version-comparisons`)
      && response.request().method() === 'POST',
    )
    await page.getByTestId('compare-restore').click()
    const restoredHttp = await restoredResponse
    const restoredPayload = await restoredHttp.json()
    assert.equal(restoredHttp.status(), 201, JSON.stringify(restoredPayload))
    assert.ok(restoredPayload.data.operation?.id)
    await page.getByText(new RegExp(`restaurada como V${rev(10)}`)).waitFor({ state: 'visible' })
    const persistedVersions = await client.v2ProjectVersion.findMany({
      where: { projectId },
      orderBy: { sequence: 'asc' },
    })
    assert.equal(persistedVersions.at(-1).sequence, rev(10))
    assert.equal(persistedVersions.at(-1).parentVersionId, afterCompareVersionId)
    assert.equal(persistedVersions.some((version) => version.id === beforeCompareVersionId), true)
    assert.equal(persistedVersions.some((version) => version.id === afterCompareVersionId), true)
    const restoredCommand = await client.v2EditCommand.findUnique({
      where: { id: persistedVersions.at(-1).commandId },
    })
    assert.match(restoredCommand.payloadJson, /"action":"restore"/)

    const selectionBaseVersion = persistedVersions.at(-1)
    const selectionBaseSnapshot = await client.v2ProjectSnapshot.findUniqueOrThrow({
      where: { id: selectionBaseVersion.editPlanSnapshotId },
    })
    const selectionBasePlan = JSON.parse(selectionBaseSnapshot.contentJson)
    const selectionClipId = selectionBasePlan.videoTracks[0].clips[0].id
    assert.equal(selectionClipId, 'clip-1:a')
    const selectionBaseOperationId = restoredPayload.data.operation.id
    const selectionProxyMetadata = await prepareControlledProxyMetadata({ mode: 'complete-api-operation',
      operationId: selectionBaseOperationId, projectVersionId: selectionBaseVersion.id,
      editPlanSnapshotId: selectionBaseVersion.editPlanSnapshotId, expectedOperation: restoredPayload.data.operation })
    const artifactCountBeforeSelection = await client.v2MediaArtifact.count({ where: { workspaceId } })
    const selectionKey = `manual-selection-reuse-${suffix}`
    const select = () => fetch(`${baseUrl}/v1/projects/${projectId}/manual-edits`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': selectionKey,
      },
      body: JSON.stringify({
        action: 'apply',
        baseVersionId: selectionBaseVersion.id,
        baseHash: selectionBaseVersion.baseHash,
        expectedRevision: rev(10),
        variantId: '9:16',
        targetId: selectionClipId,
        operation: { kind: 'select', clipId: selectionClipId },
      }),
    })
    const selectedResponse = await select()
    const selected = await selectedResponse.json()
    assert.equal(selectedResponse.status, 201, JSON.stringify(selected))
    assert.equal(selected.data.version.sequence, rev(11))
    assert.equal(selected.data.operation.status, 'succeeded')
    assert.equal(selected.data.operation.phase, 'completed')
    assert.equal(selected.data.operation.target.id, selectionProxyMetadata.outputArtifactId)
    const selectionOperation = await client.v2ProjectProxyRenderOperation.findUnique({
      where: { operationId: selected.data.operation.id },
    })
    assert.equal(selectionOperation.projectVersionId, selected.data.version.id)
    assert.equal(selectionOperation.reusedFromOperationId, selectionBaseOperationId)
    assert.equal(selectionOperation.reuseCommandId, selected.data.command.id)
    assert.equal(selectionOperation.reuseImpactHash, selected.data.command.payload.impact.impactHash)
    assert.equal(selectionOperation.reuseBaseVersionId, selectionBaseVersion.id)
    assert.equal(selectionOperation.outputArtifactId, selectionProxyMetadata.outputArtifactId)
    const selectedMap = await proxyMaps.findExact({ workspaceId, projectId,
      projectVersionId: selected.data.version.id, proxyArtifactId: selectionProxyMetadata.outputArtifactId })
    assert.ok(selectedMap, 'runtime must atomically preserve the map for the reused child')
    assert.notEqual(selectedMap.id, selectionProxyMetadata.map.id)
    assert.equal(selectedMap.mapHash, selectionProxyMetadata.map.mapHash)
    assert.deepEqual(selectedMap.map, selectionProxyMetadata.map.map)
    assert.equal(await client.v2MediaArtifact.count({ where: { workspaceId } }), artifactCountBeforeSelection)
    assert.equal(await client.v2CommandArtifactInvalidation.count({
      where: { commandId: selected.data.command.id },
    }), 0)
    const selectedReplayResponse = await select()
    const selectedReplay = await selectedReplayResponse.json()
    assert.equal(selectedReplayResponse.status, 200)
    assert.equal(selectedReplay.data.replayed, true)
    assert.equal(selectedReplay.data.operation.id, selected.data.operation.id)

    assert.equal(await client.v2RenderElementMap.count({ where: { workspaceId, projectVersionId: selected.data.version.id, proxyArtifactId: selectionProxyMetadata.outputArtifactId } }), 1, 'replay must not duplicate the runtime child map')

    const cropKey = `manual-crop-range-${suffix}`
    const cropResponse = await fetch(`${baseUrl}/v1/projects/${projectId}/manual-edits`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': cropKey,
      },
      body: JSON.stringify({
        action: 'apply',
        baseVersionId: selected.data.version.id,
        baseHash: selected.data.version.baseHash,
        expectedRevision: rev(11),
        variantId: '9:16',
        targetId: selectionClipId,
        operation: {
          kind: 'crop', clipId: selectionClipId,
          crop: { x: 0.2, y: 0, width: 0.6, height: 1 },
        },
        reason: 'Reenquadramento manual restrito ao clip e formato 9:16.',
      }),
    })
    const cropped = await cropResponse.json()
    assert.equal(cropResponse.status, 201, JSON.stringify(cropped))
    assert.equal(cropped.data.version.sequence, rev(12))
    assert.equal(cropped.data.command.payload.impact.changeKinds[0], 'crop')
    assert.deepEqual(cropped.data.command.payload.impact.dependencyTypes, ['visual'])
    assert.deepEqual(cropped.data.command.payload.impact.affectedVariantIds, ['9:16'])
    assert.equal(cropped.data.command.payload.impact.minimalRenders.length, 1)
    assert.equal(cropped.data.operation.status, 'queued')
    const cropVersion = await client.v2ProjectVersion.findUnique({
      where: { id: cropped.data.version.id },
      include: { editPlanSnapshot: true },
    })
    const cropPlan = JSON.parse(cropVersion.editPlanSnapshot.contentJson)
    assert.deepEqual(cropPlan.videoTracks[0].clips.find((clip) => clip.id === selectionClipId).crop, {
      x: 0.2, y: 0, width: 0.6, height: 1,
    })
    const cropInvalidations = await client.v2CommandArtifactInvalidation.findMany({
      where: { commandId: cropped.data.command.id },
    })
    assert.equal(cropInvalidations.length, 1)
    assert.deepEqual(JSON.parse(cropInvalidations[0].dependencyTypesJson), ['visual'])
    const cropOperation = await client.v2ProjectProxyRenderOperation.findUnique({
      where: { operationId: cropped.data.operation.id },
    })
    const cropSource = await new PrismaProjectProxyRenderRepository(client).readImmutableSource({
      workspaceId,
      projectId,
      projectVersionId: cropped.data.version.id,
      editPlanSnapshotId: cropOperation.editPlanSnapshotId,
      sourceArtifactId: cropOperation.sourceArtifactId,
      sourceManifestId: cropOperation.sourceManifestId,
    })
    assert.equal(cropSource.rangeReuse.commandId, cropped.data.command.id)
    assert.equal(cropSource.rangeReuse.impactHash, cropped.data.command.payload.impact.impactHash)
    assert.equal(cropSource.rangeReuse.baseVersionId, selected.data.version.id)
    assert.equal(cropSource.rangeReuse.artifactId, selectionProxyMetadata.outputArtifactId)
    assert.deepEqual(
      cropSource.rangeReuse.ranges,
      cropped.data.command.payload.impact.minimalRenders[0].ranges,
    )
    const transcriptProxyMetadata = await prepareControlledProxyMetadata({ mode: 'complete-api-operation',
      operationId: cropped.data.operation.id, projectVersionId: cropped.data.version.id,
      editPlanSnapshotId: cropVersion.editPlanSnapshotId, expectedOperation: cropped.data.operation })
    const editorialKey = `remove-spoken-content-${suffix}`
    const applyEditorialCut = () => fetch(`${baseUrl}/v1/projects/${projectId}/commands`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json', 'idempotency-key': editorialKey },
      body: JSON.stringify({
        type: 'remove-spoken-content',
        baseVersionId: cropped.data.version.id,
        baseHash: cropped.data.version.baseHash,
        sourceTranscriptId: currentTranscriptId,
        variantId: '9:16',
        rules: [{ id: 'remove-phrase', label: 'frase', alternatives: ['frase'] }],
        exclusionOverrides: [{
          sourceStartSeconds: 1.1, sourceEndSeconds: 1.7,
          ruleIds: ['remove-phrase'], reason: 'Reviewed boundary removes only the selected source word.',
        }],
        reason: 'Comprovar impacto editorial full-timeline e invalidação persistida.',
      }),
    })
    const editorialResponse = await applyEditorialCut()
    const editorialApplied = await editorialResponse.json()
    let editorialDiagnostic = '' // Failure diagnostics: the route hides the domain error, so the same Command is applied in-process.
    if (editorialResponse.status !== 201) {
      try {
        const { applyEditorialCutCommandService } = await import('../../src/v2/application/apply-editorial-cut-command.ts')
        const factory = await import('../../src/v2/infrastructure/repository-factory.ts')
        await applyEditorialCutCommandService({ repository: factory.createEditorialCommandRepository(), clock: () => new Date(),
          createId: (kind) => `${kind}-diag-${randomUUID()}`, createEventId: randomUUID })({
          workspaceId, projectId, baseVersionId: cropped.data.version.id, baseHash: cropped.data.version.baseHash,
          sourceTranscriptId: currentTranscriptId, variantId: '9:16', rules: [{ id: 'remove-phrase', label: 'frase', alternatives: ['frase'] }],
          exclusionOverrides: [{ sourceStartSeconds: 1.1, sourceEndSeconds: 1.7, ruleIds: ['remove-phrase'], reason: 'Reviewed boundary removes only the selected source word.' }],
          actor: authenticatedActor, idempotency: { clientId: authenticatedActor.clientId, key: `diag-editorial-${suffix}` } })
        editorialDiagnostic = 'applied in-process'
      } catch (error) { editorialDiagnostic = `${error?.code} ${error?.message} ${JSON.stringify(error?.details ?? null)}` }
    }
    assert.equal(editorialResponse.status, 201, `${JSON.stringify(editorialApplied)}
${editorialDiagnostic}`)
    assert.equal(editorialApplied.data.version.sequence, rev(13))
    assert.equal(editorialApplied.data.editorial.impact.schemaVersion, 'editorial-cut-impact/v2')
    assert.deepEqual(editorialApplied.data.editorial.impact.affectedRanges, [{ startFrame: 0, endFrame: cropPlan.durationFrames }])
    assert.equal(editorialApplied.data.editorial.impact.minimalRenders.length, 1)
    assert.equal(editorialApplied.data.editorial.impact.minimalRenders[0].ranges[0].endFrame, editorialApplied.data.editorial.outputDurationFrames)
    assert.equal(editorialApplied.data.editorial.invalidations.length, 1)
    assert.equal(editorialApplied.data.operation.type, 'project-proxy-render')
    const editorialInvalidations = await client.v2CommandArtifactInvalidation.findMany({
      where: { commandId: editorialApplied.data.command.id },
    })
    assert.equal(editorialInvalidations.length, 1)
    assert.equal(editorialInvalidations[0].artifactId, transcriptProxyMetadata.outputArtifactId)
    assert.deepEqual(JSON.parse(editorialInvalidations[0].dependencyTypesJson), ['audio', 'content', 'timing', 'visual'])
    const editorialReplayResponse = await applyEditorialCut()
    assert.equal(editorialReplayResponse.status, 200)
    assert.equal((await editorialReplayResponse.json()).data.replayed, true)
    const editorialProxyMetadata = await prepareControlledProxyMetadata({ mode: 'complete-api-operation',
      operationId: editorialApplied.data.operation.id, projectVersionId: editorialApplied.data.version.id,
      editPlanSnapshotId: (await client.v2ProjectVersion.findUniqueOrThrow({ where: { id: editorialApplied.data.version.id } })).editPlanSnapshotId,
      expectedOperation: editorialApplied.data.operation })
    const transcriptKey = `replace-source-transcript-${suffix}`
    const replaceTranscript = () => fetch(`${baseUrl}/v1/projects/${projectId}/commands`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json', 'idempotency-key': transcriptKey },
      body: JSON.stringify({
        type: 'replace-source-transcript',
        baseVersionId: editorialApplied.data.version.id,
        baseHash: editorialApplied.data.version.baseHash,
        sourceTranscriptId: replacementTranscriptId,
        expectedTranscriptHash: replacementTranscript.transcriptHash,
        reason: 'Selecionar a retranscrição corrigida antes de executar novamente o Diretor.',
      }),
    })
    const transcriptResponse = await replaceTranscript()
    const transcriptApplied = await transcriptResponse.json()
    assert.equal(transcriptResponse.status, 201, JSON.stringify(transcriptApplied))
    assert.equal(transcriptApplied.data.version.sequence, rev(14))
    assert.equal(transcriptApplied.data.command.type, 'replace-source-transcript')
    assert.equal(transcriptApplied.data.sourceTranscript.replacementTranscriptId, replacementTranscriptId)
    assert.equal(transcriptApplied.data.sourceTranscript.impact.renderBlockedUntilDirectorRun, true)
    assert.deepEqual(transcriptApplied.data.sourceTranscript.impact.affectedRanges, [{
      startFrame: 0,
      endFrame: editorialApplied.data.editorial.outputDurationFrames,
    }])
    assert.equal(transcriptApplied.data.sourceTranscript.invalidations.length, 1)
    assert.equal(transcriptApplied.data.sourceTranscript.nextRequiredCapability, 'apollo.projects.commands.apply:run-director')
    const replacementVersion = await client.v2ProjectVersion.findUnique({
      where: { id: transcriptApplied.data.version.id }, include: { editPlanSnapshot: true },
    })
    const replacementPlan = JSON.parse(replacementVersion.editPlanSnapshot.contentJson)
    assert.equal(replacementPlan.retimedTranscript.sourceTranscriptId, replacementTranscriptId)
    assert.equal(replacementPlan.retimedTranscript.sourceTranscriptHash, replacementTranscript.transcriptHash)
    assert.match(replacementPlan.retimedTranscript.words.map((word) => word.text).join(' '), /Compre/)
    assert.equal(await client.v2ProjectProxyRenderOperation.count({
      where: { projectVersionId: transcriptApplied.data.version.id },
    }), 0)
    const transcriptReplayResponse = await replaceTranscript()
    assert.equal(transcriptReplayResponse.status, 200)
    assert.equal((await transcriptReplayResponse.json()).data.replayed, true)
    const newestUnselectedTranscript = createMediaTranscript({
      language: 'pt-BR', text: 'transcrição posterior não selecionada', provider: 'groq', model: 'whisper-large-v3',
      words: [{ word: 'posterior', start: 0.2, end: 0.6 }],
      segments: [{ id: 0, start: 0.2, end: 0.6, text: 'posterior' }],
    })
    await client.v2MediaTranscript.create({ data: {
      id: `manual-transcript-unselected-${suffix}`, workspaceId, projectId,
      sourceArtifactId: sourceA, sourceManifestId: manifestA,
      schemaVersion: newestUnselectedTranscript.schemaVersion, language: newestUnselectedTranscript.language,
      provider: newestUnselectedTranscript.provider, model: newestUnselectedTranscript.model, providerVersion: 'test-v1',
      transcriptHash: newestUnselectedTranscript.transcriptHash,
      transcriptJson: stableSerialize(newestUnselectedTranscript),
      createdAt: new Date(createdAt.getTime() + 60_000),
    } })
    const { PrismaDirectorRunRepository } = await import('../../src/v2/infrastructure/prisma/director-run-repository.ts')
    const directorContext = await new PrismaDirectorRunRepository(client).readContext({ workspaceId, projectId })
    assert.equal(directorContext.transcript.id, replacementTranscriptId)
    assert.equal(directorContext.transcript.transcriptHash, replacementTranscript.transcriptHash)
    assert.equal(directorContext.currentDurationFrames, replacementPlan.durationFrames)
    assert.deepEqual(directorContext.variantIds, ['9:16'])
    assert.equal('proxyVariantId' in directorContext, false)
    assert.deepEqual(directorContext.outputReferences, [])
    const directorBaseProxyOperationId = `manual-director-base-proxy-${suffix}`
    const directorProxyMetadata = await prepareControlledProxyMetadata({ mode: 'new-controlled-base',
      operationId: directorBaseProxyOperationId, projectVersionId: transcriptApplied.data.version.id,
      editPlanSnapshotId: replacementVersion.editPlanSnapshotId, outputArtifactId: `manual-proxy-director-base-${suffix}`,
      manifestId: `manifest-${directorBaseProxyOperationId}` })
    const directorKey = `run-director-impact-${suffix}`
    const runDirector = () => fetch(`${baseUrl}/v1/projects/${projectId}/commands`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json', 'idempotency-key': directorKey },
      body: JSON.stringify({
        type: 'run-director',
        baseVersionId: transcriptApplied.data.version.id,
        baseHash: transcriptApplied.data.version.baseHash,
        objective: 'discovery',
        reason: 'Recalcular a direção e invalidar somente os outputs concluídos da versão-base.',
      }),
    })
    const directorResponse = await runDirector()
    const directorApplied = await directorResponse.json()
    assert.equal(directorResponse.status, 201, JSON.stringify(directorApplied) + ' --- server log tail --- ' + serverLogs.slice(-3000))
    assert.equal(directorApplied.data.version.sequence, rev(15))
    assert.equal(directorApplied.data.directorRun.impact.schemaVersion, 'director-run-impact/v1')
    assert.equal(directorApplied.data.directorRun.impact.sourceTranscriptId, replacementTranscriptId)
    assert.deepEqual(directorApplied.data.directorRun.impact.affectedArtifacts, [{
      artifactId: directorProxyMetadata.outputArtifactId, kind: 'proxy',
      sourceVersionId: transcriptApplied.data.version.id, variantId: '9:16',
    }])
    assert.equal(directorApplied.data.directorRun.invalidations.length, 1)
    assert.equal(directorApplied.data.directorRun.objective, 'discovery')
    assert.equal(directorApplied.data.directorRun.objectiveVersion, 1)
    assert.equal(directorApplied.data.directorRun.rubricRef, 'awareness-discovery/v1')
    assert.equal(directorApplied.data.directorRun.supersedesRunId, undefined)
    assert.equal(directorApplied.data.directorRun.invalidations[0].artifactId, directorProxyMetadata.outputArtifactId)
    assert.equal(directorApplied.data.operation.status, 'queued')
    const storedDirectorCommand = await client.v2EditCommand.findUniqueOrThrow({
      where: { id: directorApplied.data.command.id }, include: { artifactInvalidations: true },
    })
    assert.equal(JSON.parse(storedDirectorCommand.payloadJson).schemaVersion, 3)
    assert.equal(storedDirectorCommand.artifactInvalidations.length, 1)
    assert.deepEqual(JSON.parse(storedDirectorCommand.artifactInvalidations[0].dependencyTypesJson), ['audio', 'content', 'policy', 'timing', 'visual'])
    const directorReplayResponse = await runDirector()
    const directorReplay = await directorReplayResponse.json()
    assert.equal(directorReplayResponse.status, 200, JSON.stringify(directorReplay))
    assert.equal(directorReplay.data.replayed, true)
    assert.equal(directorReplay.data.operation.id, directorApplied.data.operation.id)
    const completedDirectorProxyMetadata = await prepareControlledProxyMetadata({ mode: 'complete-api-operation',
      operationId: directorApplied.data.operation.id, projectVersionId: directorApplied.data.version.id,
      editPlanSnapshotId: (await client.v2ProjectVersion.findUniqueOrThrow({ where: { id: directorApplied.data.version.id } })).editPlanSnapshotId,
      expectedOperation: directorApplied.data.operation })
    const lutSelectionKey = `set-project-lut-impact-${suffix}`
    const setProjectLut = () => fetch(`${baseUrl}/v1/projects/${projectId}/lut-selection`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json', 'idempotency-key': lutSelectionKey },
      body: JSON.stringify({
        baseVersionId: directorApplied.data.version.id,
        baseHash: directorApplied.data.version.baseHash,
        selection: { mode: 'none' },
        reason: 'Comprovar impacto visual full-timeline da selecao de LUT.',
      }),
    })
    const lutSelectionResponse = await setProjectLut()
    const lutSelectionApplied = await lutSelectionResponse.json()
    assert.equal(lutSelectionResponse.status, 201, JSON.stringify(lutSelectionApplied))
    assert.equal(lutSelectionApplied.data.version.sequence, rev(16))
    assert.equal(lutSelectionApplied.data.impact.schemaVersion, 'project-lut-selection-impact/v1')
    assert.equal(lutSelectionApplied.data.impact.renderDeferredUntilTimeline, false)
    assert.deepEqual(lutSelectionApplied.data.impact.dependencyTypes, ['visual'])
    assert.deepEqual(lutSelectionApplied.data.impact.affectedRanges, directorApplied.data.directorRun.impact.affectedRanges)
    assert.deepEqual(lutSelectionApplied.data.impact.affectedArtifacts, [{
      artifactId: completedDirectorProxyMetadata.outputArtifactId, kind: 'proxy',
      sourceVersionId: directorApplied.data.version.id, variantId: '9:16',
    }])
    assert.equal(lutSelectionApplied.data.impact.minimalRenders.length, 1)
    assert.equal(lutSelectionApplied.data.invalidations.length, 1)
    assert.equal(lutSelectionApplied.data.invalidations[0].artifactId, completedDirectorProxyMetadata.outputArtifactId)
    assert.equal(lutSelectionApplied.data.operation.status, 'queued')
    const storedLutSelectionCommand = await client.v2EditCommand.findUniqueOrThrow({
      where: { id: lutSelectionApplied.data.command.id }, include: { artifactInvalidations: true },
    })
    assert.equal(JSON.parse(storedLutSelectionCommand.payloadJson).schemaVersion, 2)
    assert.equal(JSON.parse(storedLutSelectionCommand.payloadJson).impact.impactHash, lutSelectionApplied.data.impact.impactHash)
    assert.equal(storedLutSelectionCommand.artifactInvalidations.length, 1)
    assert.deepEqual(JSON.parse(storedLutSelectionCommand.artifactInvalidations[0].dependencyTypesJson), ['visual'])
    const lutSelectionReplayResponse = await setProjectLut()
    const lutSelectionReplay = await lutSelectionReplayResponse.json()
    assert.equal(lutSelectionReplayResponse.status, 200, JSON.stringify(lutSelectionReplay))
    assert.equal(lutSelectionReplay.data.replayed, true)
    assert.equal(lutSelectionReplay.data.operation.id, lutSelectionApplied.data.operation.id)

    // An unapproved direction cannot be superseded. This negative must not
    // create an operation, Command, Version, snapshot or outbox event.
    const asyncDirectorContext = await new PrismaDirectorRunRepository(client).readContext({ workspaceId, projectId })
    assert.equal(asyncDirectorContext.currentVersion.id, lutSelectionApplied.data.version.id)
    assert.equal(asyncDirectorContext.currentVersion.baseHash, lutSelectionApplied.data.version.baseHash)
    assert.equal(asyncDirectorContext.project.objective, 'discovery')
    assert.equal(asyncDirectorContext.latestDirectorObjective.runId, directorApplied.data.directorRun.id)
    assert.equal(asyncDirectorContext.latestDirectorObjective.approved, false)
    const currentDesiredAction = parseDesiredAction(asyncDirectorContext.brief.desiredAction, 'discovery')
    assert.deepEqual(currentDesiredAction, brief.desiredAction)
    const currentDesiredActionInput = {
      ...(currentDesiredAction.destination ? { destination: currentDesiredAction.destination } : {}),
      ...(currentDesiredAction.verbalCta ? { verbalCta: currentDesiredAction.verbalCta } : {}),
      ...(currentDesiredAction.visualCta ? { visualCta: currentDesiredAction.visualCta } : {}),
      disclosures: [...currentDesiredAction.disclosures],
    }
    assert.deepEqual(createDesiredAction({
      objective: 'discovery', desiredAction: currentDesiredActionInput,
    }), currentDesiredAction)
    const readDirectionBoundary = async () => ({
      project: await client.v2Project.findUniqueOrThrow({ where: { id: projectId } }),
      previousRun: await client.v2DirectorRun.findUniqueOrThrow({
        where: { id: directorApplied.data.directorRun.id }, include: { qualitySnapshot: true },
      }),
      versions: await client.v2ProjectVersion.count({ where: { projectId } }),
      commands: await client.v2EditCommand.count({ where: { projectId } }),
      snapshots: await client.v2ProjectSnapshot.count({ where: { projectId } }),
      directorRuns: await client.v2DirectorRun.count({ where: { projectId } }),
      operations: await client.v2PublicOperation.count({ where: { workspaceId } }),
      directorOperations: await client.v2ProjectDirectorOperation.count({ where: { workspaceId } }),
      proxyOperations: await client.v2ProjectProxyRenderOperation.count({ where: { workspaceId } }),
      invalidations: await client.v2CommandArtifactInvalidation.count({ where: { workspaceId } }),
      maps: await client.v2RenderElementMap.findMany({ where: { workspaceId, projectId }, orderBy: { id: 'asc' } }),
      reviews: await client.v2ProxyReview.findMany({ where: { workspaceId, projectId }, orderBy: { id: 'asc' } }),
      outbox: await client.v2PublicEventOutbox.count({ where: { workspaceId } }),
    })
    const directionBoundaryBefore = await readDirectionBoundary()
    assert.equal(JSON.parse(directionBoundaryBefore.previousRun.qualitySnapshot.contentJson).status, 'review-required')
    const rejectedSaleResponse = await fetch(`${baseUrl}/v1/projects/${projectId}/director-runs`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json', 'idempotency-key': `unapproved-sale-${suffix}` },
      body: JSON.stringify({
        baseVersionId: lutSelectionApplied.data.version.id,
        baseHash: lutSelectionApplied.data.version.baseHash,
        objective: 'sale',
        desiredAction: {
          destination: { type: 'url', value: 'https://example.com/checkout' },
          visualCta: 'Garanta sua vaga',
          disclosures: ['Oferta sujeita a disponibilidade.'],
        },
        reason: 'Tentar alterar uma direção discovery ainda não aprovada.',
      }),
    })
    const rejectedSale = await rejectedSaleResponse.json()
    assert.equal(rejectedSaleResponse.status, 428, JSON.stringify(rejectedSale))
    assert.equal(rejectedSale.error.code, 'PRECONDITION_REQUIRED')
    assert.deepEqual(await readDirectionBoundary(), directionBoundaryBefore, 'unapproved objective change must preserve prior records, head, status and quality with zero new effects')

    // Exercise the real async worker in the existing direction. Approval and
    // an objective change remain outside this positive.
    const asyncDirectorKey = `async-director-${suffix}`
    const enqueueAsyncDirector = () => fetch(`${baseUrl}/v1/projects/${projectId}/director-runs`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json', 'idempotency-key': asyncDirectorKey },
      body: JSON.stringify({
        baseVersionId: lutSelectionApplied.data.version.id,
        baseHash: lutSelectionApplied.data.version.baseHash,
        objective: 'discovery',
        desiredAction: currentDesiredActionInput,
        reason: 'Comprovar enqueue, lease e commit transacional assíncrono na mesma direção discovery.',
      }),
    })
    const asyncDirectorResponse = await enqueueAsyncDirector()
    const asyncDirectorEnqueued = await asyncDirectorResponse.json()
    assert.equal(asyncDirectorResponse.status, 202, JSON.stringify(asyncDirectorEnqueued))
    assert.equal(asyncDirectorEnqueued.data.replayed, false)
    assert.equal(asyncDirectorEnqueued.data.operation.type, 'project-director-run')
    assert.equal(asyncDirectorEnqueued.data.operation.target.type, 'project-version')
    const allocatedResultVersionId = asyncDirectorEnqueued.data.operation.target.id

    const { runNextProjectDirectorOperationService } = await import('../../src/v2/application/run-project-director-operation-worker.ts')
    const { PrismaPublicOperationRepository } = await import('../../src/v2/infrastructure/prisma/public-operation-repository.ts')
    const { createEvidenceBoundBriefCompiler } = await import('../../src/v2/infrastructure/brief/evidence-bound-brief-compiler-model.ts')
    // Retrying operations clear error columns. Observe the real port call
    // before that transition, without changing its input, return or exception.
    const asyncDirectorDiagnostics = []
    const diagnosticCode = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value)
      ? value : null
    const diagnosticMessage = (value) => typeof value === 'string'
      ? { sha256: createHash('sha256').update(value, 'utf8').digest('hex'), bytes: Buffer.byteLength(value, 'utf8') }
      : null
    const diagnosticTargetFields = new Set([
      'id', 'workspaceId', 'projectId', 'kind', 'contentHash', 'sequence',
      'idempotencyKey', 'commandId', 'resultVersionId', 'operationId',
    ])
    const diagnosticTarget = (value) => {
      if (value === undefined || value === null) return null
      if (Array.isArray(value) && value.length <= 16 &&
        value.every((field) => typeof field === 'string' && diagnosticTargetFields.has(field))) {
        return { fields: [...value] }
      }
      if (typeof value === 'string') return { hash: diagnosticMessage(value) }
      if (Array.isArray(value) && value.every((field) => typeof field === 'string')) {
        return { hash: diagnosticMessage(JSON.stringify(value)) }
      }
      return { type: typeof value }
    }
    const diagnosticError = (error, depth = 0) => {
      if (depth >= 3) return { truncated: true }
      if (!error || typeof error !== 'object') return { type: typeof error, message: diagnosticMessage(error) }
      return {
        name: diagnosticCode(error.name),
        code: diagnosticCode(error.code),
        sqlState: diagnosticCode(error.meta?.code),
        modelName: diagnosticCode(error.meta?.modelName),
        target: diagnosticTarget(error.meta?.target),
        errno: Number.isSafeInteger(error.errno) ? error.errno : null,
        syscall: diagnosticCode(error.syscall),
        message: diagnosticMessage(error.message),
        ...(error.cause === undefined ? {} : { cause: diagnosticError(error.cause, depth + 1) }),
      }
    }
    const observeDirectorCall = async (phase, action, args) => {
      try {
        return await action(...args)
      } catch (error) {
        asyncDirectorDiagnostics.push({ phase, error: diagnosticError(error) })
        throw error
      }
    }
    const observeDirectorPort = (port, label) => new Proxy(port, {
      get(target, property) {
        const value = Reflect.get(target, property)
        if (typeof value !== 'function') return value
        return async (...args) => {
          if (label === 'operations' && property === 'failOrRetry') {
            const failure = args[0]
            asyncDirectorDiagnostics.push({
              phase: 'operations.failOrRetry',
              operationId: failure.operationId,
              attempt: failure.attempt,
              now: failure.now,
              nextAttemptAt: failure.nextAttemptAt ?? null,
              error: {
                code: diagnosticCode(failure.error.code),
                retryable: failure.error.retryable,
                message: diagnosticMessage(failure.error.message),
              },
            })
          }
          return observeDirectorCall(`${label}.${String(property)}`, value.bind(target), args)
        }
      },
    })
    // Keep the real transaction callback/options and transaction client
    // untouched. Observe a rejected Prisma transaction before the repository
    // converts P2002 to its domain conflict.
    const diagnosticDirectorClient = new Proxy(client, {
      get(target, property) {
        const value = Reflect.get(target, property, target)
        if (property !== '$transaction') return typeof value === 'function' ? value.bind(target) : value
        return async (...args) => observeDirectorCall(
          'directorClient.$transaction', value.bind(target), args,
        )
      },
    })
    const realBriefCompiler = createEvidenceBoundBriefCompiler()
    const runNextDirector = runNextProjectDirectorOperationService({
      operations: observeDirectorPort(new PrismaPublicOperationRepository(client), 'operations'),
      directorRuns: observeDirectorPort(new PrismaDirectorRunRepository(diagnosticDirectorClient), 'directorRuns'),
      createId: (kind) => `${kind}-async-${suffix}-${randomUUID()}`,
      createEventId: randomUUID,
      compileBrief: (...args) => observeDirectorCall('compileBrief', realBriefCompiler, args),
    })
    const asyncDirectorOutcome = await runNextDirector(`director-worker-${suffix}`)
    const asyncDirectorSettlement = await client.v2PublicOperation.findUniqueOrThrow({
      where: { id: asyncDirectorEnqueued.data.operation.id },
      select: {
        id: true, status: true, phase: true, attempt: true, maxAttempts: true,
        retryable: true, nextAttemptAt: true, startedAt: true, completedAt: true,
        leaseOwner: true, leaseExpiresAt: true, heartbeatAt: true,
        errorCode: true, errorMessage: true, errorRetryable: true,
      },
    })
    const asyncDirectorDiagnosticReceipt = {
      fixtureScope: 'real-director-worker-diagnostic',
      operation: {
        id: asyncDirectorSettlement.id,
        status: asyncDirectorSettlement.status,
        phase: asyncDirectorSettlement.phase,
        attempt: asyncDirectorSettlement.attempt,
        maxAttempts: asyncDirectorSettlement.maxAttempts,
        retryable: asyncDirectorSettlement.retryable,
        nextAttemptAt: asyncDirectorSettlement.nextAttemptAt,
        startedAt: asyncDirectorSettlement.startedAt,
        completedAt: asyncDirectorSettlement.completedAt,
        leaseOwner: asyncDirectorSettlement.leaseOwner,
        leaseExpiresAt: asyncDirectorSettlement.leaseExpiresAt,
        heartbeatAt: asyncDirectorSettlement.heartbeatAt,
        error: {
          code: diagnosticCode(asyncDirectorSettlement.errorCode),
          retryable: asyncDirectorSettlement.errorRetryable,
          message: diagnosticMessage(asyncDirectorSettlement.errorMessage),
        },
      },
      observedCalls: asyncDirectorDiagnostics,
    }
    console.log(JSON.stringify(asyncDirectorDiagnosticReceipt))
    assert.deepEqual(asyncDirectorOutcome, {
      operationId: asyncDirectorEnqueued.data.operation.id,
      status: 'succeeded',
    }, JSON.stringify(asyncDirectorDiagnosticReceipt))
    const storedAsyncOperation = await client.v2PublicOperation.findUniqueOrThrow({
      where: { id: asyncDirectorEnqueued.data.operation.id },
      include: { projectDirectorRun: { include: { directorRun: true } } },
    })
    assert.equal(storedAsyncOperation.status, 'succeeded')
    assert.equal(storedAsyncOperation.phase, 'completed')
    assert.equal(storedAsyncOperation.targetId, allocatedResultVersionId)
    assert.equal(storedAsyncOperation.projectDirectorRun.resultVersionId, allocatedResultVersionId)
    assert.equal(storedAsyncOperation.projectDirectorRun.directorRun.operationId, storedAsyncOperation.id)
    assert.equal(storedAsyncOperation.projectDirectorRun.directorRun.resultVersionId, allocatedResultVersionId)
    assert.equal(storedAsyncOperation.projectDirectorRun.directorRun.objective, 'discovery')
    assert.equal(storedAsyncOperation.projectDirectorRun.directorRun.objectiveVersion, 1)
    assert.equal(storedAsyncOperation.projectDirectorRun.directorRun.rubricRef, 'awareness-discovery/v1')
    assert.equal(storedAsyncOperation.projectDirectorRun.directorRun.supersedesRunId, null)
    assert.equal(storedAsyncOperation.projectDirectorRun.desiredActionJson, null, 'same-direction operation inherits its existing action instead of recording a replacement')
    const [storedStorySnapshot, storedEditPlanSnapshot] = await Promise.all([
      client.v2ProjectSnapshot.findUniqueOrThrow({
        where: { id: storedAsyncOperation.projectDirectorRun.directorRun.storySnapshotId },
      }),
      client.v2ProjectSnapshot.findUniqueOrThrow({
        where: { id: storedAsyncOperation.projectDirectorRun.directorRun.editPlanSnapshotId },
      }),
    ])
    const storedStoryPlan = JSON.parse(storedStorySnapshot.contentJson)
    const storedEditPlan = JSON.parse(storedEditPlanSnapshot.contentJson)
    const persistedDesiredAction = parseDesiredAction(storedStoryPlan.desiredActionRef.action, 'discovery')
    assert.deepEqual(persistedDesiredAction, currentDesiredAction)
    assert.deepEqual(storedStoryPlan.desiredActionRef.action, persistedDesiredAction)
    assert.equal(storedStoryPlan.desiredActionRef.actionHash.length, 64)
    assert.equal(storedEditPlan.desiredActionRef.id, storedStoryPlan.desiredActionRef.id)
    assert.equal(storedEditPlan.subtitleTracks[0].desiredActionRef.id, storedStoryPlan.desiredActionRef.id)
    // The project asked for no visual call to action (ADR-160: one is drawn only where a request or the speech places it), so none is drawn.
    assert.equal(storedEditPlan.overlayTracks.length, 0)
    assert.equal(currentDesiredAction.visualCta, undefined)
    const storedAsyncVersion = await client.v2ProjectVersion.findUniqueOrThrow({
      where: { id: allocatedResultVersionId },
      include: { briefSnapshot: true },
    })
    const compiledBriefSnapshot = JSON.parse(storedAsyncVersion.briefSnapshot.contentJson)
    assert.deepEqual(parseDesiredAction(compiledBriefSnapshot.desiredAction, 'discovery'), persistedDesiredAction)
    assert.equal(storedAsyncVersion.briefSnapshot.schemaVersion, 3)
    assert.equal(compiledBriefSnapshot.briefCompilation.audit.promptVersion, 'brief-compiler/v1')
    assert.equal(compiledBriefSnapshot.briefCompilation.audit.modelId, 'apollo-evidence-bound-brief-compiler')
    assert.equal(compiledBriefSnapshot.briefCompilation.audit.modelVersion, '1.0.0')
    assert.equal(compiledBriefSnapshot.briefCompilation.compiled.requiresReview, false)
    assert.deepEqual(compiledBriefSnapshot.briefCompilation.compiled.fields.audience, ['equipes criativas'])
    assert.deepEqual(compiledBriefSnapshot.briefCompilation.compiled.fields.offer, ['demonstra\u00e7\u00e3o'])
    assert.deepEqual(compiledBriefSnapshot.briefCompilation.compiled.fields.tone, ['direto'])
    assert.match(compiledBriefSnapshot.briefCompilation.audit.inputHash, /^[a-f0-9]{64}$/)
    assert.match(compiledBriefSnapshot.briefCompilation.audit.outputHash, /^[a-f0-9]{64}$/)
    const compiledWorkspaceResponse = await fetch(`${baseUrl}/v1/projects/${projectId}/workspace`, {
      headers: { authorization, accept: 'application/json' },
    })
    const compiledWorkspace = await compiledWorkspaceResponse.json()
    assert.equal(compiledWorkspaceResponse.status, 200, JSON.stringify(compiledWorkspace))
    assert.equal(compiledWorkspace.data.directorRuns.at(-1).qualityStatus, 'review-required')
    assert.equal(
      compiledWorkspace.data.brief.briefCompilation.audit.outputHash,
      compiledBriefSnapshot.briefCompilation.audit.outputHash,
    )
    const qualityResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/director-runs/${storedAsyncOperation.projectDirectorRun.directorRun.id}/quality-report`,
      { headers: { authorization } },
    )
    const qualityRead = await qualityResponse.json()
    assert.equal(qualityResponse.status, 200, JSON.stringify(qualityRead))
    assert.equal(qualityRead.data.qualityReport.directorRunId, storedAsyncOperation.projectDirectorRun.directorRun.id)
    assert.equal(qualityRead.data.qualityReport.projectId, projectId)
    assert.equal(qualityRead.data.qualityReport.objective, 'discovery')
    assert.equal(qualityRead.data.qualityReport.objectiveVersion, 1)
    assert.equal(qualityRead.data.qualityReport.rubricRef, 'awareness-discovery/v1')
    assert.equal(qualityRead.data.qualityReport.qualitySnapshot.contentSchemaVersion, 5)
    assert.match(qualityRead.data.qualityReport.qualitySnapshot.contentHash, /^[a-f0-9]{64}$/)
    assert.equal(qualityRead.data.qualityReport.report.schemaVersion, 'director-quality-report/v5')
    assert.equal(qualityRead.data.qualityReport.report.status, 'review-required')
    assert.equal(qualityRead.data.qualityReport.report.hardChecks.every((check) => check.passed), true)
    assert.equal(qualityRead.data.qualityReport.report.hardChecks.find((check) => check.id === 'subtitlesFaceSafe'), undefined, 'face safety is claimed by nobody: no check of the v5 list says it, the faceSafety object does')
    assert.deepEqual(qualityRead.data.qualityReport.report.faceSafety, {
      status: 'unknown', reasonCode: 'FACE_PERCEPTION_UNAVAILABLE', evidenceRefs: [],
    })
    const persistedQualitySnapshot = await client.v2ProjectSnapshot.findUniqueOrThrow({
      where: { id: storedAsyncOperation.projectDirectorRun.directorRun.qualitySnapshotId },
    })
    assert.equal(persistedQualitySnapshot.schemaVersion, 5)
    assert.equal(JSON.parse(persistedQualitySnapshot.contentJson).status, 'review-required')
    assert.equal(
      qualityRead.data.qualityReport.report.desiredActionRef.id,
      storedStoryPlan.desiredActionRef.id,
    )
    assert.equal(qualityRead.data.qualityReport.report.strategic.schemaVersion, 'strategic-quality-report/v1')
    assert.equal(qualityRead.data.qualityReport.report.strategic.rubric.objective, 'discovery')
    assert.equal(qualityRead.data.qualityReport.report.strategic.rubric.purpose, 'editorial-quality-proxy')
    assert.equal(qualityRead.data.qualityReport.report.strategic.passed, true)
    assert.deepEqual(qualityRead.data.qualityReport.report.strategic.gateFailures, [])
    assert.deepEqual(
      qualityRead.data.qualityReport.report.strategic.evidence.map((item) => ({
        criterionId: item.criterionId, weight: item.weight,
      })),
      // ADR-160 F5: the request asked for neither a hook nor a call to action, so those criteria are not scored and the rest keep their proportions.
      (await import('../../src/v2/domain/strategic-rubric.ts')).effectiveRubricCriteria(
        (await import('../../src/v2/domain/strategic-rubric.ts')).resolveStrategicRubric('discovery'), ['hook-clarity', 'cta-clarity', 'friction-reduction'])
        .map((criterion) => ({ criterionId: criterion.id, weight: criterion.weight })),
    )
    assert.equal(qualityRead.data.qualityReport.report.strategic.evidence.some((item) => item.criterionId === 'hook-clarity'), false)
    const projectAfterSameDirection = await client.v2Project.findUniqueOrThrow({ where: { id: projectId } })
    assert.equal(projectAfterSameDirection.currentVersionId, allocatedResultVersionId)
    assert.equal(projectAfterSameDirection.objective, 'discovery')
    const asyncDirectorReplayResponse = await enqueueAsyncDirector()
    const asyncDirectorReplay = await asyncDirectorReplayResponse.json()
    assert.equal(asyncDirectorReplayResponse.status, 202, JSON.stringify(asyncDirectorReplay))
    assert.equal(asyncDirectorReplay.data.replayed, true)
    assert.equal(asyncDirectorReplay.data.operation.id, storedAsyncOperation.id)

    const inheritedPolicySnapshot = await client.v2ProjectSnapshot.findUniqueOrThrow({
      where: { id: storedAsyncVersion.policiesSnapshotId },
      select: { id: true, contentJson: true, contentHash: true },
    })
    const policyRequest = {
      baseVersionId: storedAsyncVersion.id,
      baseHash: storedAsyncVersion.baseHash,
      overrides: {
        logo: { mode: 'none' },
        instagramHandle: { mode: 'none' },
        youtubeHandle: { mode: 'inherit' },
        professionalName: { mode: 'custom', value: 'Apollo Policy E2E' },
        subtitleStyle: { mode: 'custom', value: 'clean-color' },
      },
      reason: 'Comprovar override isolado no projeto.',
    }
    const setPolicy = () => fetch(`${baseUrl}/v1/projects/${projectId}/policy-overrides`, {
      method: 'POST',
      headers: {
        authorization,
        accept: 'application/json',
        'content-type': 'application/json',
        'idempotency-key': `f1010-policy-${suffix}`,
      },
      body: JSON.stringify(policyRequest),
    })
    const policyResponse = await setPolicy()
    const policyApplied = await policyResponse.json()
    assert.equal(policyResponse.status, 201, JSON.stringify(policyApplied))
    assert.equal(policyApplied.data.command.type, 'set-project-policy-overrides')
    assert.equal(policyApplied.data.version.parentVersionId, storedAsyncVersion.id)
    assert.equal(policyApplied.data.policySnapshot.contentSchemaVersion, 2)
    assert.deepEqual(policyApplied.data.resolved.logo, { value: null, origin: 'project-none' })
    assert.deepEqual(policyApplied.data.resolved.instagramHandle, { value: null, origin: 'project-none' })
    assert.deepEqual(policyApplied.data.resolved.professionalName, { value: 'Apollo Policy E2E', origin: 'project-custom' })
    assert.equal(policyApplied.data.nextRequiredCapability, 'apollo.projects.commands.apply:run-director')
    assert.equal(policyApplied.data.impact.renderBlockedUntilDirectorRun, true)
    assert.equal(await client.v2ProjectProxyRenderOperation.count({
      where: { workspaceId, projectId, projectVersionId: policyApplied.data.version.id },
    }), 0)
    assert.deepEqual(await client.v2ProjectSnapshot.findUniqueOrThrow({
      where: { id: inheritedPolicySnapshot.id },
      select: { id: true, contentJson: true, contentHash: true },
    }), inheritedPolicySnapshot, 'project override must not mutate the inherited policy snapshot')
    const policyReplayResponse = await setPolicy()
    const policyReplay = await policyReplayResponse.json()
    assert.equal(policyReplayResponse.status, 200, JSON.stringify(policyReplay))
    assert.equal(policyReplay.data.replayed, true)
    assert.equal(policyReplay.data.command.id, policyApplied.data.command.id)
    const currentPolicyResponse = await fetch(`${baseUrl}/v1/projects/${projectId}/policy-overrides`, {
      headers: { authorization, accept: 'application/json' },
    })
    const currentPolicy = await currentPolicyResponse.json()
    assert.equal(currentPolicyResponse.status, 200, JSON.stringify(currentPolicy))
    assert.equal(currentPolicy.data.version.id, policyApplied.data.version.id)
    assert.equal(currentPolicy.data.policySnapshot.id, policyApplied.data.policySnapshot.id)
    assert.equal(currentPolicy.data.resolved.logo.origin, 'project-none')

    await page.goto(`${baseUrl}/projects/${projectId}`)
    const policyStatus = page.getByTestId('project-policy-overrides')
    await policyStatus.waitFor({ state: 'visible', timeout: 10_000 })
    await policyStatus.locator('summary').click()
    const policyStatusText = await policyStatus.textContent()
    assert.match(policyStatusText, /Logo/u)
    assert.match(policyStatusText, /Desativado no projeto/u)
    assert.match(policyStatusText, /Apollo Policy E2E/u)
    assert.match(policyStatusText, /Personalizado no projeto/u)
    assert.equal(await policyStatus.locator('[data-origin="project-none"]').count() >= 2, true)
    assert.equal(await policyStatus.locator('[data-origin="project-custom"]').count() >= 2, true)

    async function createBriefingProject(label, briefing, key) {
      const response = await fetch(`${baseUrl}/v1/projects`, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: JSON.stringify({
          name: `F1.007 ${label}`,
          objective: 'discovery',
          locale: 'pt-BR',
          ...(briefing === undefined ? {} : { briefing }),
        }),
      })
      const payload = await response.json()
      assert.equal(response.status, 201, `${JSON.stringify(payload)}\n${serverLogs.slice(-4_000)}`)
      return payload.data.projectAtCreation.id
    }

    const briefingCases = [
      {
        label: 'completo',
        // Creation reads nothing: what a briefing covers is said after the interpreter has read it (revise-editorial-request).
        briefing: 'alpha beta gamma',
        coverage: { audience: false, offer: false, tone: false },
        assumptions: [],
        trustLabel: 'Owner autorizado',
      },
      {
        label: 'curto',
        briefing: 'alpha',
        coverage: { audience: false, offer: false, tone: false },
        assumptions: [],
        trustLabel: 'Owner autorizado',
      },
      {
        label: 'ausente',
        briefing: undefined,
        coverage: { audience: false, offer: false, tone: false },
        assumptions: [
          'briefing-absent',
          'audience-not-specified',
          'offer-not-specified',
          'tone-not-specified',
        ],
        trustLabel: 'Media-only',
      },
    ]

    for (const briefingCase of briefingCases) {
      const briefingProjectId = await createBriefingProject(
        briefingCase.label,
        briefingCase.briefing,
        `f1007-${briefingCase.label}-${suffix}`,
      )
      const workspaceResponse = await fetch(
        `${baseUrl}/v1/projects/${briefingProjectId}/workspace`,
        { headers: { authorization, accept: 'application/json' } },
      )
      const workspaceRead = await workspaceResponse.json()
      assert.equal(workspaceResponse.status, 200, JSON.stringify(workspaceRead))
      const productionBrief = workspaceRead.data.brief.productionBrief
      assert.deepEqual(productionBrief.summary.coverage, briefingCase.coverage)
      assert.deepEqual(productionBrief.assumptions, briefingCase.assumptions)
      assert.equal(productionBrief.readyForExpensiveGeneration, false)
      assert.equal(productionBrief.ownerInput?.trust, briefingCase.briefing === undefined
        ? undefined
        : 'owner-authorized')

      await page.goto(`${baseUrl}/projects/${briefingProjectId}`)
      const briefingState = page.getByTestId('production-brief-state')
      await briefingState.waitFor({ state: 'visible', timeout: 10_000 })
      assert.match(await briefingState.textContent(), new RegExp(briefingCase.trustLabel, 'u'))
      assert.equal(
        (await page.getByTestId('production-brief-assumptions').textContent())?.trim().length > 0,
        true,
      )
      assert.match(
        await briefingState.textContent(),
        /Nenhuma geração cara foi iniciada por esta leitura\./u,
      )
    }

    const forgedTrustBoundary = await fetch(`${baseUrl}/v1/projects`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': `f1007-forged-trust-${suffix}`,
      },
      body: JSON.stringify({
        name: 'F1.007 trust boundary forgery',
        objective: 'discovery',
        productionBrief: { ownerInput: { trust: 'owner-authorized' } },
      }),
    })
    const forgedTrustPayload = await forgedTrustBoundary.json()
    assert.equal(forgedTrustBoundary.status, 422, JSON.stringify(forgedTrustPayload))
    assert.equal(forgedTrustPayload.error.code, 'INVALID_ARGUMENT')
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
