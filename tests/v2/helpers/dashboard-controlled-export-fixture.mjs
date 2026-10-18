import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { writeEditingProxyFile } from './editing-proxy-file.mjs'
import { variantBodyFor } from './explicit-project-http.mjs'
import { commitSealedChild, persistReceiptForExistingVideo, seedSealedProject } from './pg-output-world.mjs'

// Same domain-to-row contract as project-media-repository.colorProbeData.
export function dashboardColorProbePersistenceData(probe, stableSerialize) {
  return { id: probe.id, workspaceId: probe.workspaceId, artifactId: probe.artifactId,
    manifestId: probe.manifestId, schemaVersion: probe.schemaVersion,
    state: probe.detection.state,
    metadataJson: stableSerialize(probe.detection.state === 'ready' ? probe.detection.metadata : null),
    pixelFormat: probe.detection.pixelFormat ?? null,
    hdrMode: probe.detection.state === 'ready' ? probe.detection.hdrMode : null,
    reasonsJson: stableSerialize(probe.detection.state === 'unavailable' ? probe.detection.reasons : []),
    producerProvider: probe.producer.provider, producerVersion: probe.producer.version,
    producerBinaryDigest: probe.producer.binaryDigest, probeHash: probe.probeHash,
    createdAt: new Date(probe.createdAt) }
}

/** Explicit test seed, not public project/Director/proxy acceptance. The project
 * is born through the real creation Command and one explicit 9:16 output variant (sealed Versions, never raw rows);
 * its status is then set to reviewing-proxy, the one write this helper makes to a project row besides the sealed writers.
 * Every copied media object has its own key/manifest and explicit copy lineage, and the base Version adopts the
 * source's ingest receipt (persisted by persistReceiptForExistingVideo) exactly as a child Command does.
 *
 * `editorialSource: true` seeds the other kind of project the journey needs: an ingest-compiled plan that an editorial cut can
 * descend from (a Director plan carries no source transcript hash, so a copy of a Director project can never take the cut). It stops
 * after the base child and the neutral LUT: no copied proxy, no Director run, no seeded review, no color compilation, and the project
 * keeps the status its sealed Versions gave it. It returns the head the project can be duplicated at and the transcript a cut names.
 */
export async function seedDashboardControlledExportFixture(input) {
  const { client, workspaceId, actor, artifactRoot, suffix, transcript, sourcePath,
    sourceArtifactId: originalSourceId, sourceManifestId: originalSourceManifestId, sourceManifest,
    proxyArtifact: originalProxy, proxyManifestId: originalProxyManifestId,
    signal, compileColorPipeline, editorialSource = false, projectName = 'Controlled export mechanics fixture' } = input
  assert.equal(signal?.aborted ?? false, false)
  if (!editorialSource) assert.equal(typeof compileColorPipeline, 'function', 'Seed must compile its actual color pipeline before inserting operation details')
  const { calculateVersionHash, stableSerialize } = await import('../../../src/v2/application/version-hash.ts')
  const { compileInitialSourceEditPlan } = await import('../../../src/v2/application/apply-editorial-cut-command.ts')
  const { createMediaArtifactManifestV2 } = await import('../../../src/v2/domain/media-artifact.ts')
  const { createMediaColorProbe } = await import('../../../src/v2/domain/color-and-export.ts')
  const { assetRightsRevision } = await import('../../../src/v2/domain/asset-rights.ts')
  const { setAssetRightsService } = await import('../../../src/v2/application/set-asset-rights.ts')
  const { PrismaAssetRightsRepository } = await import('../../../src/v2/infrastructure/prisma/asset-rights-repository.ts')
  const { PrismaColorPipelineCompilationRepository } = await import('../../../src/v2/infrastructure/prisma/color-pipeline-compilation-repository.ts')
  const { setProjectLutSelectionService } = await import('../../../src/v2/application/project-lut-selections.ts')
  const { PrismaProjectLutSelectionRepository } = await import('../../../src/v2/infrastructure/prisma/project-lut-selection-repository.ts')
  const { runProjectDirectorService } = await import('../../../src/v2/application/run-project-director.ts')
  const { PrismaDirectorRunRepository } = await import('../../../src/v2/infrastructure/prisma/director-run-repository.ts')
  const { createEvidenceBoundBriefCompiler } = await import('../../../src/v2/infrastructure/brief/evidence-bound-brief-compiler-model.ts')
  const { materializeActorAuditContext } = await import('../../../src/v2/application/authenticate-api-client.ts')
  const { calculateProxyReviewHash } = await import('../../../src/v2/application/render-workflow.ts')
  const { probeVideo } = await import('../../../src/v2/infrastructure/media/video-probe.ts')
  const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const toolDigest = hashBytes(await readFile(new URL(import.meta.url)))
  const id = (kind) => `runtime-mechanical-${kind}-${suffix}`
  const projectId = id('project'), baseVersionId = id('base-version'), transcriptId = id('transcript')
  const sourceArtifactId = id('source'), sourceManifestId = id('source-manifest')
  const proxyArtifactId = id('proxy'), proxyManifestId = id('proxy-manifest')
  const proxyOperationId = id('proxy-operation'), proxyReviewId = id('proxy-review')
  const createdAt = new Date(input.createdAt)
  assert.equal(Number.isFinite(createdAt.getTime()), true)
  const authenticationAudit = materializeActorAuditContext(actor)
  assert.equal(authenticationAudit.workspaceId, workspaceId)
  const sourceArtifactKey = `workspaces/final-export-e2e-${suffix}/mechanical/master.mp4`
  const proxyArtifactKey = `workspaces/final-export-e2e-${suffix}/mechanical/proxy.mp4`
  const ownSourcePath = join(artifactRoot, ...sourceArtifactKey.split('/'))
  const ownProxyPath = join(artifactRoot, ...proxyArtifactKey.split('/'))
  await mkdir(dirname(ownSourcePath), { recursive: true })
  const originalSource = await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: originalSourceId } })
  assert.equal(originalSource.workspaceId, workspaceId)
  const sourceBytes = await readFile(sourcePath)
  assert.equal(hashBytes(sourceBytes), originalSource.sha256)
  assert.equal(BigInt(sourceBytes.length), originalSource.byteSize)
  assert.equal(sourceManifest.artifact.sha256, originalSource.sha256)
  const previousSourceManifest = await client.v2MediaArtifactManifest.findUniqueOrThrow({ where: { id: originalSourceManifestId } })
  assert.equal(previousSourceManifest.workspaceId, workspaceId)
  assert.equal(previousSourceManifest.artifactId, originalSourceId)
  assert.equal(previousSourceManifest.manifestHash, sourceManifest.manifestHash)
  assert.equal(previousSourceManifest.manifestJson, stableSerialize(sourceManifest))
  await copyFile(sourcePath, ownSourcePath)
  assert.equal(hashBytes(await readFile(ownSourcePath)), originalSource.sha256)
  let proxyBytes = null, previousProxyManifest = null
  if (!editorialSource) {
    const originalProxyPath = join(artifactRoot, ...originalProxy.artifactKey.split('/'))
    proxyBytes = await readFile(originalProxyPath)
    assert.equal(hashBytes(proxyBytes), originalProxy.sha256)
    assert.equal(BigInt(proxyBytes.length), originalProxy.byteSize)
    previousProxyManifest = await client.v2MediaArtifactManifest.findUniqueOrThrow({ where: { id: originalProxyManifestId } })
    assert.equal(previousProxyManifest.workspaceId, workspaceId)
    assert.equal(previousProxyManifest.artifactId, originalProxy.id)
    await copyFile(originalProxyPath, ownProxyPath)
    assert.equal(hashBytes(await readFile(ownProxyPath)), originalProxy.sha256)
  }
  const sourceProbe = await probeVideo(ownSourcePath, { signal })
  assert.equal(Number.isInteger(sourceProbe.fps), true, 'Fixture uses the observed source fps without coercion')
  const proxyProbe = editorialSource ? null : await probeVideo(ownProxyPath, { signal })
  const copyExecution = { tool: { id: 'controlled-fixture-copy', version: '1.0.0', digest: toolDigest } }
  const sourceManifestOwn = createMediaArtifactManifestV2({ artifactKey: sourceArtifactKey,
    artifactSha256: originalSource.sha256, byteSize: sourceBytes.length, mediaType: 'video', container: 'mp4',
    recipe: { id: 'controlled-dashboard-master-copy', version: '1.0.0', parameters: {
      projectId, originalArtifactId: originalSourceId, originalManifestId: originalSourceManifestId, originalManifestHash: sourceManifest.manifestHash,
      proofScope: 'controlled-mechanics' } },
    sources: [{ artifactKey: originalSource.artifactKey, sha256: originalSource.sha256,
      role: 'test-fixture-master-copy', execution: copyExecution }],
    probe: { width: sourceProbe.width, height: sourceProbe.height, duration: sourceProbe.duration, fps: sourceProbe.fps } })
  const proxyManifestOwn = editorialSource ? null : createMediaArtifactManifestV2({ artifactKey: proxyArtifactKey,
    artifactSha256: originalProxy.sha256, byteSize: proxyBytes.length, mediaType: 'video', container: 'mp4',
    recipe: { id: 'controlled-dashboard-proxy-copy', version: '1.0.0', parameters: {
      projectId, originalArtifactId: originalProxy.id, originalManifestId: originalProxyManifestId,
      originalManifestHash: previousProxyManifest.manifestHash, proofScope: 'controlled-mechanics', renderedForSeededVersion: false } },
    sources: [{ artifactKey: originalProxy.artifactKey, sha256: originalProxy.sha256,
      role: 'test-fixture-proxy-copy', execution: copyExecution }],
    probe: { width: proxyProbe.width, height: proxyProbe.height, duration: proxyProbe.duration, fps: proxyProbe.fps } })

  const world = await seedSealedProject(client, { workspaceId, actor, prefix: 'runtime-mechanical', ids: { project: projectId },
    name: projectName, objective: 'discovery', variant: variantBodyFor({ aspectRatio: '9:16' }) })
  if (!editorialSource) await client.v2Project.update({ where: { id: projectId }, data: { status: 'reviewing-proxy' } })
  const outputSpecId = world.head.state.document.entries.find((entry) => entry.variantId === world.variantId).spec.output.id
  for (const [artifactId, manifestId, key, bytes, manifest, originalId, role] of [
    [sourceArtifactId, sourceManifestId, sourceArtifactKey, sourceBytes, sourceManifestOwn, originalSourceId, 'test-fixture-master-copy'],
    ...(editorialSource ? [] : [[proxyArtifactId, proxyManifestId, proxyArtifactKey, proxyBytes, proxyManifestOwn, originalProxy.id, 'test-fixture-proxy-copy']]),
  ]) {
    await client.v2MediaArtifact.create({ data: { id: artifactId, workspaceId, artifactKey: key,
      sha256: hashBytes(bytes), byteSize: BigInt(bytes.length), mediaType: 'video', container: 'mp4', status: 'available', createdAt } })
    await client.v2MediaArtifactManifest.create({ data: { id: manifestId, workspaceId, artifactId,
      schemaVersion: manifest.schemaVersion, manifestHash: manifest.manifestHash, recipeId: manifest.recipe.id,
      recipeVersion: manifest.recipe.version, parametersHash: manifest.recipe.parametersHash,
      manifestJson: stableSerialize(manifest), createdAt } })
    await client.v2MediaArtifactLineage.create({ data: { id: id(`lineage-${role}`), workspaceId, manifestId,
      sourceArtifactId: originalId, role, ordinal: 0, toolId: copyExecution.tool.id,
      toolVersion: copyExecution.tool.version, toolDigest, createdAt } })
    await client.v2ProjectMediaAsset.create({ data: { id: randomUUID(), workspaceId, projectId,
      artifactId, role: artifactId === sourceArtifactId ? 'source-master' : 'editorial-proxy',
      originalFileName: artifactId === sourceArtifactId ? 'mechanical-master.mp4' : 'mechanical-proxy.mp4', createdAt } })
  }
  await setAssetRightsService({ repository: new PrismaAssetRightsRepository(client), clock: () => createdAt,
    createId: () => id('source-rights') })({ workspaceId, artifactId: sourceArtifactId,
    baseRevision: assetRightsRevision(sourceArtifactId, 0),
    draft: { status: 'approved', allowedUses: ['editing', 'rendering', 'editorial-reuse'], prohibitedUses: [],
      allowedLocales: ['pt-BR'], consent: { status: 'approved', allowedUses: ['editing', 'rendering', 'editorial-reuse'], allowedLocales: ['pt-BR'] } },
    actor: { type: 'api-client', id: actor.clientId } })
  assert.equal(sourceProbe.color.state, 'ready', 'Mechanical source color must come from the actual copied bytes')
  const color = createMediaColorProbe({ id: id('color-probe'), workspaceId, artifactId: sourceArtifactId,
    manifestId: sourceManifestId, detection: sourceProbe.color,
    producer: sourceProbe.producer, createdAt: createdAt.toISOString() })
  await client.v2MediaColorProbe.create({ data: dashboardColorProbePersistenceData(color, stableSerialize) })
  await client.v2MediaTranscript.create({ data: { id: transcriptId, workspaceId, projectId, sourceArtifactId, sourceManifestId,
    schemaVersion: transcript.schemaVersion, language: transcript.language, provider: transcript.provider, model: transcript.model,
    providerVersion: 'controlled-v1', transcriptHash: transcript.transcriptHash, transcriptJson: stableSerialize(transcript), createdAt } })
  const initialPlan = compileInitialSourceEditPlan({ id: id('initial-plan'), projectVersionId: baseVersionId,
    transcriptId, transcript, sourceArtifactId, sourceDurationSeconds: sourceProbe.duration,
    fps: sourceProbe.fps, createdAt: createdAt.toISOString() })
  // The base Version is a real child Command: it adopts the source's persisted ingest receipt and plays it whole.
  const { resolveFfmpegBinary } = await import('../../../src/v2/infrastructure/media/ffmpeg-binary.ts')
  const editingProxy = await writeEditingProxyFile({ ffmpeg: resolveFfmpegBinary(), sourcePath: ownSourcePath, artifactRoot,
    key: `workspaces/final-export-e2e-${suffix}/mechanical/editing-proxy.mp4` })
  await persistReceiptForExistingVideo(client, { workspaceId, projectId, actor, artifactId: sourceArtifactId,
    createdAt: new Date(createdAt.getTime() - 60_000).toISOString(), derivative: editingProxy })
  const baseBundle = await commitSealedChild(client, { workspaceId, projectId, actor, suffix: id('base'), versionId: baseVersionId,
    mutatePlan: () => initialPlan, adopt: [sourceArtifactId] })
  const baseVersion = baseBundle.version
  const noLut = await setProjectLutSelectionService({ repository: new PrismaProjectLutSelectionRepository(client),
    createId: (kind) => id(`lut-${kind}`), createEventId: randomUUID, clock: () => createdAt })({ workspaceId, projectId,
    baseVersionId: baseVersion.id, baseHash: baseVersion.baseHash, selection: { mode: 'none' }, actor,
    idempotencyKey: id('lut-none'), reason: 'Explicit controlled mechanics fixture; no editorial approval.' })
  if (editorialSource) {
    // The head a copy is taken at. The plan is the ingest-compiled one, so its retimed transcript names the source transcript hash.
    assert.equal((await client.v2Project.findUniqueOrThrow({ where: { id: projectId } })).currentVersionId, noLut.version.id)
    return { projectId, projectVersionId: noLut.version.id, projectVersionHash: noLut.version.baseHash, baseVersionId,
      variantId: world.variantId, transcriptId, transcriptHash: transcript.transcriptHash, sourceArtifactId, sourceManifestId,
      sourceSha256: originalSource.sha256, sourceByteSize: sourceBytes.length, sourceManifest: sourceManifestOwn, sourcePath: ownSourcePath,
      receipt: { proofScope: 'controlled-editorial-source', seeded: true, projectId, baseVersionId, projectVersionId: noLut.version.id,
        projectVersionHash: noLut.version.baseHash, transcriptId, transcriptHash: transcript.transcriptHash,
        copies: [{ sourceArtifactId: originalSourceId, sourceManifestId: originalSourceManifestId,
          artifactId: sourceArtifactId, manifestId: sourceManifestId, manifestHash: sourceManifestOwn.manifestHash, sha256: originalSource.sha256 }],
        controlled: ['owned copied master bytes', 'aligned transcript', 'rights', 'ingest-compiled initial plan'],
        notProven: ['Director run', 'face safety', 'proxy render for this project'] } }
  }
  let bundle
  const realRepository = new PrismaDirectorRunRepository(client)
  // The real repository persists the run through the sealed writer (PG admission); this wrapper only keeps the proposed
  // bundle so the receipt can name its Command fingerprint and decision log.
  const observedRepository = { findIdempotentResult: (request) => realRepository.findIdempotentResult(request),
    readContext: (request) => realRepository.readContext(request),
    commitWithCanonicalSnapshots: (scope, prepare) => realRepository.commitWithCanonicalSnapshots(scope, async (resolve) => {
      const proposed = await prepare(resolve)
      bundle = proposed
      return proposed
    }) }
  let snapshotSequence = 0
  const directed = await runProjectDirectorService({ repository: observedRepository, clock: () => createdAt,
    createEventId: randomUUID, compileBrief: createEvidenceBoundBriefCompiler(),
    createId: (kind) => kind === 'project-snapshot' ? id(`director-snapshot-${++snapshotSequence}`) : id(kind) })({
    workspaceId, projectId, baseVersionId: noLut.version.id, baseHash: noLut.version.baseHash,
    actor, idempotency: { key: id('director-request') }, reason: 'Seed independent controlled export mechanics; face evidence remains unknown.' })
  assert.ok(bundle)
  assert.equal(directed.run.perception.inputVersionId, noLut.version.id)
  assert.equal(directed.run.qualityReport.status, 'review-required')
  assert.equal(directed.run.qualityReport.faceSafety.status, 'unknown')
  assert.equal(directed.run.status, 'planned')
  const projectVersionId = directed.version.id, projectVersionHash = directed.version.baseHash
  // This callback uses the public compilation API and the actual copied source
  // probe. Read it through the same integrity hydrator as runtime before INSERT.
  await compileColorPipeline({ projectId, sourceArtifactId, sourceManifestId })
  const compilationRows = await client.v2ColorPipelineCompilation.findMany({
    where: { workspaceId, projectId, sourceArtifactId, sourceManifestId }, select: { id: true },
  })
  assert.equal(compilationRows.length, 1, 'The owned seed must have exactly one source color compilation')
  const persistedCompilation = await new PrismaColorPipelineCompilationRepository(client).read({
    workspaceId, projectId, compilationId: compilationRows[0].id,
  })
  assert.ok(persistedCompilation)
  const compilation = persistedCompilation.compilation
  assert.equal(compilation.workspaceId, workspaceId)
  assert.equal(compilation.projectId, projectId)
  assert.equal(compilation.sourceArtifactId, sourceArtifactId)
  assert.equal(compilation.sourceManifestId, sourceManifestId)
  assert.equal(compilation.colorProbeId, color.id)
  assert.equal(compilation.colorProbeHash, color.probeHash)
  const colorPipelineBindings = [{ sourceArtifactId, sourceManifestId,
    compilationId: compilation.id, compilationHash: compilation.compilationHash,
    pipelineHash: compilation.pipeline.pipelineHash }]
  const inputHash = calculateVersionHash({ schemaVersion: 'controlled-dashboard-proxy-seed/v2', workspaceId, projectId,
    projectVersionId, projectVersionHash, editPlanHash: calculateVersionHash(directed.run.editPlan),
    sourceManifestHash: sourceManifestOwn.manifestHash, proxyManifestHash: proxyManifestOwn.manifestHash,
    colorPipelineBindings })
  await client.v2PublicOperation.create({ data: { id: proxyOperationId, workspaceId, projectId, clientId: actor.clientId,
    type: 'project-proxy-render', status: 'succeeded', phase: 'completed', targetType: 'media-artifact', targetId: proxyArtifactId,
    progressCompleted: 4, progressTotal: 4, progressUnit: 'render', cancelable: false, retryable: false, attempt: 1, maxAttempts: 3,
    actorCredentialId: authenticationAudit.credentialId, actorEnvironment: authenticationAudit.environment,
    actorAuthenticationKind: authenticationAudit.authenticationKind, actorContextHash: authenticationAudit.contextHash,
    resultJson: stableSerialize({ resource: { type: 'media-artifact', id: proxyArtifactId, manifestId: proxyManifestId } }),
    idempotencyKey: id('proxy-seed-request'), requestFingerprint: inputHash, createdAt, updatedAt: createdAt, startedAt: createdAt, completedAt: createdAt } })
  await client.v2ProjectProxyRenderOperation.create({ data: { operationId: proxyOperationId, workspaceId, projectId, projectVersionId,
    editPlanSnapshotId: directed.version.snapshotRefs.editPlan, sourceArtifactId, sourceManifestId, inputHash,
    colorPipelineBindingsJson: stableSerialize(colorPipelineBindings), outputArtifactId: proxyArtifactId, outputManifestId: proxyManifestId,
    originalFileName: 'mechanical-proxy.mp4', createdAt } })
  const reviewDocument = { schemaVersion: 'proxy-review/v1', projectVersionId, proxyArtifactId, proxyManifestId,
    inputHash, outputSpecId, rangeCacheKey: calculateVersionHash({ inputHash, seeded: true }),
    spec: { width: proxyProbe.width, height: proxyProbe.height, codec: 'h264', container: 'mp4', quality: 'review', reusableRanges: true },
    status: 'blocked', technicalIssues: [{ code: 'CONTROLLED_PROXY_FIXTURE_REQUIRES_REVIEW', severity: 'hard', category: 'integrity',
      message: 'Copied fixture bytes were not rendered for this seeded version.', correctable: false }],
    criticIssues: [{ code: 'FACE_PERCEPTION_UNAVAILABLE', severity: 'hard', category: 'editorial',
      message: 'No detector evidence is present in this controlled fixture.', correctable: true }], warningsAcknowledged: false,
    finalAllowed: false, uploadReceivedAt: createdAt.toISOString(), renderCompletedAt: createdAt.toISOString(), timeToFirstProxyMs: 0 }
  const reviewHash = calculateProxyReviewHash(reviewDocument)
  await client.v2ProxyReview.create({ data: { id: proxyReviewId, workspaceId, projectId, projectVersionId, operationId: proxyOperationId,
    proxyArtifactId, proxyManifestId, inputHash, outputSpecId: reviewDocument.outputSpecId, rangeCacheKey: reviewDocument.rangeCacheKey,
    specJson: stableSerialize(reviewDocument.spec), status: 'blocked', technicalIssuesJson: stableSerialize(reviewDocument.technicalIssues),
    criticIssuesJson: stableSerialize(reviewDocument.criticIssues), warningsAcknowledged: false, finalAllowed: false,
    reviewHash, revision: 1, uploadReceivedAt: createdAt, renderCompletedAt: createdAt, timeToFirstProxyMs: 0n, createdAt, updatedAt: createdAt } })
  assert.equal((await client.v2Project.findUniqueOrThrow({ where: { id: projectId } })).status, 'reviewing-proxy')
  return { projectId, projectVersionId, projectVersionHash, directed, sourceArtifactId, sourceManifestId,
    sourceSha256: originalSource.sha256, sourceByteSize: sourceBytes.length, sourceManifest: sourceManifestOwn,
    sourcePath: ownSourcePath, proxyArtifact: await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: proxyArtifactId } }),
    review: await client.v2ProxyReview.findUniqueOrThrow({ where: { id: proxyReviewId } }),
    receipt: { proofScope: 'controlled-mechanics', initialStatus: 'reviewing-proxy', seeded: true,
      projectId, baseVersionId, directorInputVersionId: noLut.version.id, projectVersionId, projectVersionHash,
      directorRunId: directed.run.id, directorRunStatus: directed.run.status, commandId: directed.command.id,
      requestFingerprint: bundle.requestFingerprint, decisionLogHash: bundle.decisionLog.logHash,
      snapshots: bundle.snapshots.map((snapshot) => ({ id: snapshot.id, kind: snapshot.kind, hash: snapshot.contentHash })),
      persistedQuality: { status: 'review-required', faceSafety: 'unknown' }, persistedProxyReview: { status: 'blocked', finalAllowed: false, reviewHash },
      copies: [{ sourceArtifactId: originalSourceId, sourceManifestId: originalSourceManifestId,
        artifactId: sourceArtifactId, manifestId: sourceManifestId, manifestHash: sourceManifestOwn.manifestHash, sha256: originalSource.sha256 },
        { sourceArtifactId: originalProxy.id, sourceManifestId: originalProxyManifestId,
          artifactId: proxyArtifactId, manifestId: proxyManifestId, manifestHash: proxyManifestOwn.manifestHash, sha256: originalProxy.sha256 }],
      observedColorProbe: { id: color.id, hash: color.probeHash, producer: color.producer },
      observedColorCompilation: { id: compilation.id, hash: compilation.compilationHash,
        probeId: compilation.colorProbeId, probeHash: compilation.colorProbeHash, pipelineHash: compilation.pipeline.pipelineHash,
        colorPipelineBindings, origin: 'public-api+postgres-integrity-hydrator-before-operation-insert' },
      controlled: ['initial project status', 'owned copied master/proxy bytes', 'aligned transcript', 'rights',
        'Director commit port and proxy operation/review seed'], notProven: ['public editorial approval', 'face safety', 'proxy render for seeded version'] } }
}
