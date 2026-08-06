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
  const { createColorPipelineCompilationService } = await import('../../src/v2/application/color-pipeline-compilations.ts')
  const { calculateVersionHash, stableSerialize } = await import('../../src/v2/application/version-hash.ts')
  const { calculateCanonicalHash } = await import('../../src/v2/domain/canonical-hash.ts')
  const { createMediaColorProbe } = await import('../../src/v2/domain/color-and-export.ts')
  const { parseCompareActionImpact } = await import('../../src/v2/domain/compare-action-impact.ts')
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { createExternalAuditContext, materializeActorAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
  const { DomainError } = await import('../../src/v2/domain/errors.ts')
  const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
  const { PrismaManualEditRepository } = await import('../../src/v2/infrastructure/prisma/manual-edit-repository.ts')
  const { PrismaColorPipelineCompilationRepository } = await import('../../src/v2/infrastructure/prisma/color-pipeline-compilation-repository.ts')
  const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
  const {
    createUiPasswordHash,
    uiLoginThrottleKey,
    uiSessionSubjectHash,
  } = await import('../../src/v2/infrastructure/security/ui-session.ts')

  const client = new PrismaClient()
  const repository = new PrismaManualEditRepository(client)
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `manual-workspace-${suffix}`
  const projectId = `manual-project-${suffix}`
  const sourceA = `manual-artifact-a-${suffix}`
  const sourceB = `manual-artifact-b-${suffix}`
  const currentTranscriptId = `manual-transcript-current-${suffix}`
  const replacementTranscriptId = `manual-transcript-replacement-${suffix}`
  const completedProxyArtifactId = `manual-proxy-initial-${suffix}`
  const initialVersionId = `manual-version-${suffix}`
  const createdAt = new Date('2026-07-26T17:30:00.000Z')
  const uiUsername = `manual-user-${suffix}`
  const uiPassword = `Manual-E2E-${suffix}-secure`
  const uiSessionSecret = `manual-session-secret-${suffix}-at-least-32-characters`
  let clockTick = 0
  let server
  let browser
  let authenticatedActor
  const colorCompilations = new Map()

  const cleanup = async () => {
    const identityIds = (await client.v2WorkspaceMember.findMany({
      where: { workspaceId }, select: { identityId: true },
    })).map((member) => member.identityId)
    const sessionEnvironment = { APOLLO_UI_SESSION_SECRET: uiSessionSecret }
    const loginKeyHash = uiLoginThrottleKey('direct', uiUsername, sessionEnvironment)
    const loginSubjectHash = uiSessionSubjectHash(uiUsername, sessionEnvironment)
    await client.v2PublicEventOutbox.deleteMany({ where: { workspaceId } })
    await client.v2ProjectProxyRenderOperation.deleteMany({
      where: { workspaceId, reusedFromOperationId: { not: null } },
    })
    await client.v2ProjectProxyRenderOperation.deleteMany({ where: { workspaceId } })
    await client.v2DirectorRun.updateMany({
      where: { workspaceId },
      data: { operationId: null, supersedesRunId: null },
    })
    await client.v2ProjectDirectorOperation.updateMany({
      where: { workspaceId },
      data: { supersedesRunId: null },
    })
    await client.v2ProjectDirectorOperation.deleteMany({ where: { workspaceId } })
    const directorRunIds = (await client.v2DirectorRun.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    })).map((run) => run.id)
    for (const id of directorRunIds) {
      await client.v2DirectorRun.delete({ where: { id } })
    }
    await client.v2PublicOperation.deleteMany({ where: { workspaceId } })
    await client.v2CommandArtifactInvalidation.deleteMany({ where: { workspaceId } })
    await client.v2MediaTranscript.deleteMany({ where: { workspaceId } })
    await client.v2ColorPipelineCompilation.deleteMany({ where: { workspaceId } })
    await client.v2MediaColorProbe.deleteMany({ where: { workspaceId } })
    await client.v2ProjectMediaAsset.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifactManifest.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifact.deleteMany({ where: { workspaceId } })
    await client.v2ProjectCreationCommand.deleteMany({ where: { workspaceId } })
    await client.v2Project.deleteMany({ where: { workspaceId } })
    await client.v2UiSession.deleteMany({ where: { workspaceId } })
    await client.v2UiLoginAttempt.deleteMany({ where: { subjectHash: loginSubjectHash } })
    await client.v2UiLoginThrottle.deleteMany({ where: { keyHash: loginKeyHash } })
    await client.v2WorkspaceUiPrincipal.deleteMany({ where: { workspaceId } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId } })
    await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
    if (identityIds.length > 0) {
      await client.v2HumanIdentity.deleteMany({ where: { id: { in: identityIds } } })
    }
  }

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
    await cleanup()
    const brief = {
      schemaVersion: 1,
      objective: 'discovery',
      desiredAction: { schemaVersion: 1, kind: 'continue-viewing', disclosures: [] },
      createdAt: createdAt.toISOString(),
    }
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
    const auditContext = createExternalAuditContext({
      clientId: issued.client.id,
      credentialId: issued.credential.id,
      workspaceId,
      environment: 'production',
    })
    authenticatedActor = Object.freeze({
      ...auditContext,
      scopes: new Set(['projects:read', 'projects:write']),
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
        role: artifactId === sourceA ? 'source-master' : 'selected-insert',
        originalFileName: `${artifactId}.mp4`, createdAt,
      } })
      const sourceMetadata = Object.freeze({
        colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709',
        matrix: 'bt709', range: 'limited', bitDepth: 8,
      })
      const colorProbe = createMediaColorProbe({
        id: `manual-color-probe-${artifactId}`,
        workspaceId,
        artifactId,
        manifestId: `manifest-${artifactId}`,
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
      if (artifactId === sourceA) {
        const rightsSnapshotId = `rights-${sourceA}`
        await client.v2AssetRightsSnapshot.create({ data: {
          id: rightsSnapshotId, workspaceId, artifactId, sequence: 1,
          schemaVersion: 'asset-rights/v1',
          snapshotHash: calculateVersionHash({ artifactId, rights: 'approved' }),
          owner: 'Apollo E2E', license: 'test-owned', status: 'approved',
          allowedUsesJson: stableSerialize(['rendering']), prohibitedUsesJson: '[]',
          allowedWorkspaceIdsJson: stableSerialize([workspaceId]),
          consentStatus: 'not-required', consentAllowedUsesJson: '[]',
          createdByType: 'api-client', createdById: issued.client.id, createdAt,
        } })
        await client.v2MediaArtifact.update({
          where: { id: artifactId },
          data: { currentRightsSnapshotId: rightsSnapshotId, rightsRevision: 1 },
        })
      }
    }
    const renderColorBindings = (...artifactIds) => stableSerialize(artifactIds.map((artifactId) => {
      const compilation = colorCompilations.get(artifactId)
      assert.ok(compilation)
      return {
        sourceArtifactId: artifactId,
        sourceManifestId: `manifest-${artifactId}`,
        compilationId: compilation.id,
        compilationHash: compilation.compilationHash,
        pipelineHash: compilation.pipeline.pipelineHash,
      }
    }))
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
        id, workspaceId, projectId, sourceArtifactId: sourceA, sourceManifestId: `manifest-${sourceA}`,
        schemaVersion: transcript.schemaVersion, language: transcript.language,
        provider: transcript.provider, model: transcript.model, providerVersion: 'test-v1',
        transcriptHash: transcript.transcriptHash, transcriptJson: stableSerialize(transcript),
        createdAt: new Date(createdAt.getTime() + offset * 1000),
      } })
    }
    const completedProxyManifestId = `manifest-${completedProxyArtifactId}`
    const completedProxyOperationId = `manual-proxy-operation-${suffix}`
    const completedProxyHash = calculateVersionHash({ completedProxyArtifactId })
    await client.v2MediaArtifact.create({ data: {
      id: completedProxyArtifactId, workspaceId,
      artifactKey: `manual/${completedProxyArtifactId}.mp4`,
      sha256: completedProxyHash, byteSize: 1n,
      mediaType: 'video', container: 'mp4', status: 'available', createdAt,
    } })
    await client.v2MediaArtifactManifest.create({ data: {
      id: completedProxyManifestId, workspaceId, artifactId: completedProxyArtifactId,
      schemaVersion: 'media-artifact-manifest/v2',
      manifestHash: calculateVersionHash({ completedProxyArtifactId, manifest: true }),
      recipeId: 'manual-proxy', recipeVersion: '1.0.0',
      parametersHash: calculateVersionHash({ completedProxyArtifactId, parameters: true }),
      manifestJson: stableSerialize({ artifact: { artifactKey: `manual/${completedProxyArtifactId}.mp4` } }),
      createdAt,
    } })
    await client.v2PublicOperation.create({ data: {
      id: completedProxyOperationId, workspaceId, projectId, clientId: issued.client.id,
      ...operationActorAudit,
      type: 'project-proxy-render', status: 'succeeded', phase: 'completed',
      targetType: 'media-artifact', targetId: completedProxyArtifactId,
      progressCompleted: 4, progressTotal: 4, progressUnit: 'render',
      cancelable: false, retryable: false, attempt: 1, maxAttempts: 3,
      resultJson: stableSerialize({ resource: {
        type: 'media-artifact', id: completedProxyArtifactId,
        manifestId: completedProxyManifestId,
      } }),
      idempotencyKey: `manual-proxy-initial-${suffix}`,
      requestFingerprint: completedProxyHash,
      createdAt, updatedAt: createdAt, startedAt: createdAt, completedAt: createdAt,
    } })
    await client.v2ProjectProxyRenderOperation.create({ data: {
      operationId: completedProxyOperationId, workspaceId, projectId,
      projectVersionId: initialVersionId, editPlanSnapshotId: editPlanId,
      sourceArtifactId: sourceA, sourceManifestId: `manifest-${sourceA}`,
      colorPipelineBindingsJson: renderColorBindings(sourceA), inputHash: calculateVersionHash({ completedProxyOperationId }),
      outputArtifactId: completedProxyArtifactId,
      outputManifestId: completedProxyManifestId,
      originalFileName: `${completedProxyArtifactId}.mp4`, createdAt,
    } })

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
    assert.equal(timeline.data.timeline.revision, 5)
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
    assert.equal(publicApplied.data.version.sequence, 6)
    assert.equal(publicApplied.data.operation.status, 'queued')
    assert.equal(publicApplied.data.command.payload.schemaVersion, 2)
    assert.equal(publicApplied.data.command.payload.impact.schemaVersion, 'command-impact/v1')
    assert.equal(publicApplied.data.timeline.clips.find((clip) => clip.id === 'clip-2').sourceId, sourceB)
    const { readProjectWorkspaceService } = await import('../../src/v2/application/read-project-workspace.ts')
    const { PrismaProjectWorkspaceQueryRepository } = await import('../../src/v2/infrastructure/prisma/project-workspace-query-repository.ts')
    const { PrismaPublicOperationRepository: PrismaWorkspacePublicOperationRepository } = await import('../../src/v2/infrastructure/prisma/public-operation-repository.ts')
    const workspaceProjection = await readProjectWorkspaceService({
      projects: new PrismaProjectWorkspaceQueryRepository(client),
      operations: new PrismaWorkspacePublicOperationRepository(client),
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

    const beforeTrimResponse = await fetch(`${baseUrl}/v1/projects/${projectId}/timeline`, {
      headers: { authorization },
    })
    const beforeTrim = await beforeTrimResponse.json()
    assert.equal(beforeTrimResponse.status, 200, JSON.stringify(beforeTrim))
    assert.equal(beforeTrim.data.timeline.revision, 8)
    const beforeCompareVersionId = beforeTrim.data.timeline.versionId
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
    assert.equal(trimResponse.status, 201, JSON.stringify(trimmed))
    assert.equal(trimmed.data.version.sequence, 9)
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
      expectedRevision: 9,
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
      body: JSON.stringify({ ...compareActionBody('accept'), expectedRevision: 8 }),
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
    assert.equal((await restoredResponse).status(), 201)
    await page.getByText(/restaurada como V10/).waitFor({ state: 'visible' })
    const persistedVersions = await client.v2ProjectVersion.findMany({
      where: { projectId },
      orderBy: { sequence: 'asc' },
    })
    assert.equal(persistedVersions.at(-1).sequence, 10)
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
    const selectionBaseOperationId = `manual-selection-base-proxy-${suffix}`
    const selectionBaseFingerprint = calculateVersionHash({ selectionBaseOperationId })
    const selectionColorBindings = renderColorBindings(sourceA, sourceB)
    await client.v2PublicOperation.create({ data: {
      id: selectionBaseOperationId, workspaceId, projectId, clientId: issued.client.id,
      ...operationActorAudit,
      type: 'project-proxy-render', status: 'succeeded', phase: 'completed',
      targetType: 'media-artifact', targetId: completedProxyArtifactId,
      progressCompleted: 4, progressTotal: 4, progressUnit: 'render',
      cancelable: false, retryable: false, attempt: 1, maxAttempts: 3,
      resultJson: stableSerialize({ resource: {
        type: 'media-artifact', id: completedProxyArtifactId,
        manifestId: completedProxyManifestId,
      } }),
      idempotencyKey: `manual-selection-base-proxy-${suffix}`,
      requestFingerprint: selectionBaseFingerprint,
      createdAt, updatedAt: createdAt, startedAt: createdAt, completedAt: createdAt,
    } })
    await client.v2ProjectProxyRenderOperation.create({ data: {
      operationId: selectionBaseOperationId, workspaceId, projectId,
      projectVersionId: selectionBaseVersion.id,
      editPlanSnapshotId: selectionBaseVersion.editPlanSnapshotId,
      sourceArtifactId: sourceA, sourceManifestId: `manifest-${sourceA}`,
      colorPipelineBindingsJson: selectionColorBindings,
      inputHash: selectionBaseFingerprint,
      outputArtifactId: completedProxyArtifactId,
      outputManifestId: completedProxyManifestId,
      originalFileName: `${completedProxyArtifactId}.mp4`, createdAt,
    } })
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
        expectedRevision: 10,
        variantId: '9:16',
        targetId: selectionClipId,
        operation: { kind: 'select', clipId: selectionClipId },
      }),
    })
    const selectedResponse = await select()
    const selected = await selectedResponse.json()
    assert.equal(selectedResponse.status, 201, JSON.stringify(selected))
    assert.equal(selected.data.version.sequence, 11)
    assert.equal(selected.data.operation.status, 'succeeded')
    assert.equal(selected.data.operation.phase, 'completed')
    assert.equal(selected.data.operation.target.id, completedProxyArtifactId)
    const selectionOperation = await client.v2ProjectProxyRenderOperation.findUnique({
      where: { operationId: selected.data.operation.id },
    })
    assert.equal(selectionOperation.projectVersionId, selected.data.version.id)
    assert.equal(selectionOperation.reusedFromOperationId, selectionBaseOperationId)
    assert.equal(selectionOperation.reuseCommandId, selected.data.command.id)
    assert.equal(selectionOperation.reuseImpactHash, selected.data.command.payload.impact.impactHash)
    assert.equal(selectionOperation.reuseBaseVersionId, selectionBaseVersion.id)
    assert.equal(selectionOperation.outputArtifactId, completedProxyArtifactId)
    assert.equal(await client.v2MediaArtifact.count({ where: { workspaceId } }), artifactCountBeforeSelection)
    assert.equal(await client.v2CommandArtifactInvalidation.count({
      where: { commandId: selected.data.command.id },
    }), 0)
    const selectedReplayResponse = await select()
    const selectedReplay = await selectedReplayResponse.json()
    assert.equal(selectedReplayResponse.status, 200)
    assert.equal(selectedReplay.data.replayed, true)
    assert.equal(selectedReplay.data.operation.id, selected.data.operation.id)

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
        expectedRevision: 11,
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
    assert.equal(cropped.data.version.sequence, 12)
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
    const { PrismaProjectProxyRenderRepository } = await import(
      '../../src/v2/infrastructure/prisma/project-proxy-render-repository.ts'
    )
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
    assert.equal(cropSource.rangeReuse.artifactId, completedProxyArtifactId)
    assert.deepEqual(
      cropSource.rangeReuse.ranges,
      cropped.data.command.payload.impact.minimalRenders[0].ranges,
    )
    const transcriptBaseProxyOperationId = `manual-transcript-base-proxy-${suffix}`
    await client.v2PublicOperation.create({ data: {
      id: transcriptBaseProxyOperationId, workspaceId, projectId, clientId: issued.client.id,
      ...operationActorAudit,
      type: 'project-proxy-render', status: 'succeeded', phase: 'completed',
      targetType: 'media-artifact', targetId: completedProxyArtifactId,
      progressCompleted: 4, progressTotal: 4, progressUnit: 'render',
      cancelable: false, retryable: false, attempt: 1, maxAttempts: 3,
      resultJson: stableSerialize({ resource: { type: 'media-artifact', id: completedProxyArtifactId, manifestId: completedProxyManifestId } }),
      idempotencyKey: `manual-transcript-base-proxy-${suffix}`,
      requestFingerprint: calculateVersionHash({ transcriptBaseProxyOperationId }),
      createdAt, updatedAt: createdAt, startedAt: createdAt, completedAt: createdAt,
    } })
    await client.v2ProjectProxyRenderOperation.create({ data: {
      operationId: transcriptBaseProxyOperationId, workspaceId, projectId,
      projectVersionId: cropped.data.version.id, editPlanSnapshotId: cropVersion.editPlanSnapshotId,
      sourceArtifactId: sourceA, sourceManifestId: `manifest-${sourceA}`,
      colorPipelineBindingsJson: renderColorBindings(sourceA, sourceB), inputHash: calculateVersionHash({ transcriptBaseProxyOperationId, input: true }),
      outputArtifactId: completedProxyArtifactId, outputManifestId: completedProxyManifestId,
      originalFileName: `${completedProxyArtifactId}.mp4`, createdAt,
    } })
    const editorialKey = `remove-spoken-content-${suffix}`
    const applyEditorialCut = () => fetch(`${baseUrl}/v1/projects/${projectId}/commands`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json', 'idempotency-key': editorialKey },
      body: JSON.stringify({
        type: 'remove-spoken-content',
        baseVersionId: cropped.data.version.id,
        baseHash: cropped.data.version.baseHash,
        sourceTranscriptId: currentTranscriptId,
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
    assert.equal(editorialResponse.status, 201, JSON.stringify(editorialApplied))
    assert.equal(editorialApplied.data.version.sequence, 13)
    assert.equal(editorialApplied.data.editorial.impact.schemaVersion, 'editorial-cut-impact/v1')
    assert.deepEqual(editorialApplied.data.editorial.impact.affectedRanges, [{ startFrame: 0, endFrame: cropPlan.durationFrames }])
    assert.equal(editorialApplied.data.editorial.impact.minimalRenders.length, 1)
    assert.equal(editorialApplied.data.editorial.impact.minimalRenders[0].ranges[0].endFrame, editorialApplied.data.editorial.outputDurationFrames)
    assert.equal(editorialApplied.data.editorial.invalidations.length, 1)
    assert.equal(editorialApplied.data.operation.type, 'project-proxy-render')
    const editorialInvalidations = await client.v2CommandArtifactInvalidation.findMany({
      where: { commandId: editorialApplied.data.command.id },
    })
    assert.equal(editorialInvalidations.length, 1)
    assert.equal(editorialInvalidations[0].artifactId, completedProxyArtifactId)
    assert.deepEqual(JSON.parse(editorialInvalidations[0].dependencyTypesJson), ['audio', 'content', 'timing', 'visual'])
    const editorialReplayResponse = await applyEditorialCut()
    assert.equal(editorialReplayResponse.status, 200)
    assert.equal((await editorialReplayResponse.json()).data.replayed, true)
    const editorialOperationCreatedAt = (await client.v2PublicOperation.findUniqueOrThrow({
      where: { id: editorialApplied.data.operation.id }, select: { createdAt: true },
    })).createdAt
    await client.v2PublicOperation.update({
      where: { id: editorialApplied.data.operation.id },
      data: {
        status: 'succeeded', phase: 'completed', targetType: 'media-artifact', targetId: completedProxyArtifactId,
        progressCompleted: 4, progressTotal: 4, progressUnit: 'render',
        cancelable: false, retryable: false, attempt: 1,
        resultJson: stableSerialize({ resource: { type: 'media-artifact', id: completedProxyArtifactId, manifestId: completedProxyManifestId } }),
        startedAt: editorialOperationCreatedAt,
        completedAt: editorialOperationCreatedAt,
        updatedAt: editorialOperationCreatedAt,
      },
    })
    await client.v2ProjectProxyRenderOperation.update({
      where: { operationId: editorialApplied.data.operation.id },
      data: { outputArtifactId: completedProxyArtifactId, outputManifestId: completedProxyManifestId },
    })
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
    assert.equal(transcriptApplied.data.version.sequence, 14)
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
      sourceArtifactId: sourceA, sourceManifestId: `manifest-${sourceA}`,
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
    assert.equal(directorContext.proxyVariantId, '9:16')
    assert.deepEqual(directorContext.outputReferences, [])
    const directorBaseProxyOperationId = `manual-director-base-proxy-${suffix}`
    await client.v2PublicOperation.create({ data: {
      id: directorBaseProxyOperationId, workspaceId, projectId, clientId: issued.client.id,
      ...operationActorAudit,
      type: 'project-proxy-render', status: 'succeeded', phase: 'completed',
      targetType: 'media-artifact', targetId: completedProxyArtifactId,
      progressCompleted: 4, progressTotal: 4, progressUnit: 'render',
      cancelable: false, retryable: false, attempt: 1, maxAttempts: 3,
      resultJson: stableSerialize({ resource: { type: 'media-artifact', id: completedProxyArtifactId, manifestId: completedProxyManifestId } }),
      idempotencyKey: `manual-director-base-proxy-${suffix}`,
      requestFingerprint: calculateVersionHash({ directorBaseProxyOperationId }),
      createdAt, updatedAt: createdAt, startedAt: createdAt, completedAt: createdAt,
    } })
    await client.v2ProjectProxyRenderOperation.create({ data: {
      operationId: directorBaseProxyOperationId, workspaceId, projectId,
      projectVersionId: transcriptApplied.data.version.id,
      editPlanSnapshotId: replacementVersion.editPlanSnapshotId,
      sourceArtifactId: sourceA, sourceManifestId: `manifest-${sourceA}`,
      colorPipelineBindingsJson: renderColorBindings(sourceA, sourceB), inputHash: calculateVersionHash({ directorBaseProxyOperationId, input: true }),
      outputArtifactId: completedProxyArtifactId, outputManifestId: completedProxyManifestId,
      originalFileName: `${completedProxyArtifactId}.mp4`, createdAt,
    } })
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
    assert.equal(directorResponse.status, 201, JSON.stringify(directorApplied))
    assert.equal(directorApplied.data.version.sequence, 15)
    assert.equal(directorApplied.data.directorRun.impact.schemaVersion, 'director-run-impact/v1')
    assert.equal(directorApplied.data.directorRun.impact.sourceTranscriptId, replacementTranscriptId)
    assert.deepEqual(directorApplied.data.directorRun.impact.affectedArtifacts, [{
      artifactId: completedProxyArtifactId, kind: 'proxy',
      sourceVersionId: transcriptApplied.data.version.id, variantId: '9:16',
    }])
    assert.equal(directorApplied.data.directorRun.invalidations.length, 1)
    assert.equal(directorApplied.data.directorRun.objective, 'discovery')
    assert.equal(directorApplied.data.directorRun.objectiveVersion, 1)
    assert.equal(directorApplied.data.directorRun.rubricRef, 'awareness-discovery/v1')
    assert.equal(directorApplied.data.directorRun.supersedesRunId, undefined)
    assert.equal(directorApplied.data.directorRun.invalidations[0].artifactId, completedProxyArtifactId)
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
    const directorOperationCreatedAt = (await client.v2PublicOperation.findUniqueOrThrow({
      where: { id: directorApplied.data.operation.id }, select: { createdAt: true },
    })).createdAt
    await client.v2PublicOperation.update({
      where: { id: directorApplied.data.operation.id },
      data: {
        status: 'succeeded', phase: 'completed', targetType: 'media-artifact', targetId: completedProxyArtifactId,
        progressCompleted: 4, progressTotal: 4, progressUnit: 'render',
        cancelable: false, retryable: false, attempt: 1,
        resultJson: stableSerialize({ resource: { type: 'media-artifact', id: completedProxyArtifactId, manifestId: completedProxyManifestId } }),
        startedAt: directorOperationCreatedAt,
        completedAt: directorOperationCreatedAt,
        updatedAt: directorOperationCreatedAt,
      },
    })
    await client.v2ProjectProxyRenderOperation.update({
      where: { operationId: directorApplied.data.operation.id },
      data: { outputArtifactId: completedProxyArtifactId, outputManifestId: completedProxyManifestId },
    })
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
    assert.equal(lutSelectionApplied.data.version.sequence, 16)
    assert.equal(lutSelectionApplied.data.impact.schemaVersion, 'project-lut-selection-impact/v1')
    assert.equal(lutSelectionApplied.data.impact.renderDeferredUntilTimeline, false)
    assert.deepEqual(lutSelectionApplied.data.impact.dependencyTypes, ['visual'])
    assert.deepEqual(lutSelectionApplied.data.impact.affectedRanges, directorApplied.data.directorRun.impact.affectedRanges)
    assert.deepEqual(lutSelectionApplied.data.impact.affectedArtifacts, [{
      artifactId: completedProxyArtifactId, kind: 'proxy',
      sourceVersionId: directorApplied.data.version.id, variantId: '9:16',
    }])
    assert.equal(lutSelectionApplied.data.impact.minimalRenders.length, 1)
    assert.equal(lutSelectionApplied.data.invalidations.length, 1)
    assert.equal(lutSelectionApplied.data.invalidations[0].artifactId, completedProxyArtifactId)
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

    const asyncDirectorKey = `async-director-${suffix}`
    const enqueueAsyncDirector = () => fetch(`${baseUrl}/v1/projects/${projectId}/director-runs`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json', 'idempotency-key': asyncDirectorKey },
      body: JSON.stringify({
        baseVersionId: lutSelectionApplied.data.version.id,
        baseHash: lutSelectionApplied.data.version.baseHash,
        objective: 'sale',
        desiredAction: {
          destination: { type: 'url', value: 'https://example.com/checkout' },
        },
        reason: 'Comprovar enqueue, lease e commit transacional do Diretor assíncrono.',
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
    const runNextDirector = runNextProjectDirectorOperationService({
      operations: new PrismaPublicOperationRepository(client),
      directorRuns: new PrismaDirectorRunRepository(client),
      createId: (kind) => `${kind}-async-${suffix}-${randomUUID()}`,
      createEventId: randomUUID,
    })
    const asyncDirectorOutcome = await runNextDirector(`director-worker-${suffix}`)
    const asyncDirectorSettlement = await client.v2PublicOperation.findUniqueOrThrow({
      where: { id: asyncDirectorEnqueued.data.operation.id },
      select: {
        status: true, phase: true, errorCode: true,
        errorMessage: true, errorRetryable: true,
      },
    })
    assert.deepEqual(asyncDirectorOutcome, {
      operationId: asyncDirectorEnqueued.data.operation.id,
      status: 'succeeded',
    }, JSON.stringify(asyncDirectorSettlement))
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
    assert.equal(storedAsyncOperation.projectDirectorRun.directorRun.objective, 'sale')
    assert.equal(storedAsyncOperation.projectDirectorRun.directorRun.objectiveVersion, 2)
    assert.equal(storedAsyncOperation.projectDirectorRun.directorRun.rubricRef, 'conversion-sale/v1')
    assert.equal(storedAsyncOperation.projectDirectorRun.directorRun.supersedesRunId, directorApplied.data.directorRun.id)
    const qualityResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/director-runs/${storedAsyncOperation.projectDirectorRun.directorRun.id}/quality-report`,
      { headers: { authorization } },
    )
    const qualityRead = await qualityResponse.json()
    assert.equal(qualityResponse.status, 200, JSON.stringify(qualityRead))
    assert.equal(qualityRead.data.qualityReport.directorRunId, storedAsyncOperation.projectDirectorRun.directorRun.id)
    assert.equal(qualityRead.data.qualityReport.projectId, projectId)
    assert.equal(qualityRead.data.qualityReport.objective, 'sale')
    assert.equal(qualityRead.data.qualityReport.objectiveVersion, 2)
    assert.equal(qualityRead.data.qualityReport.rubricRef, 'conversion-sale/v1')
    assert.equal(qualityRead.data.qualityReport.qualitySnapshot.contentSchemaVersion, 2)
    assert.match(qualityRead.data.qualityReport.qualitySnapshot.contentHash, /^[a-f0-9]{64}$/)
    assert.equal(qualityRead.data.qualityReport.report.schemaVersion, 'director-quality-report/v2')
    assert.equal(qualityRead.data.qualityReport.report.strategic.schemaVersion, 'strategic-quality-report/v1')
    assert.equal(qualityRead.data.qualityReport.report.strategic.rubric.objective, 'sale')
    assert.equal(qualityRead.data.qualityReport.report.strategic.rubric.purpose, 'editorial-quality-proxy')
    assert.equal(qualityRead.data.qualityReport.report.strategic.passed, true)
    assert.deepEqual(qualityRead.data.qualityReport.report.strategic.gateFailures, [])
    assert.equal(qualityRead.data.qualityReport.report.strategic.evidence.length, 8)
    assert.equal(qualityRead.data.qualityReport.report.strategic.evidence.some((item) => item.criterionId === 'cta-clarity'), true)
    assert.equal(qualityRead.data.qualityReport.report.strategic.evidence.some((item) => item.criterionId === 'rights-compliance'), true)
    const projectAfterObjectiveChange = await client.v2Project.findUniqueOrThrow({ where: { id: projectId } })
    assert.equal(projectAfterObjectiveChange.currentVersionId, allocatedResultVersionId)
    assert.equal(projectAfterObjectiveChange.objective, 'sale')
    const asyncDirectorReplayResponse = await enqueueAsyncDirector()
    const asyncDirectorReplay = await asyncDirectorReplayResponse.json()
    assert.equal(asyncDirectorReplayResponse.status, 202, JSON.stringify(asyncDirectorReplay))
    assert.equal(asyncDirectorReplay.data.replayed, true)
    assert.equal(asyncDirectorReplay.data.operation.id, storedAsyncOperation.id)
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
