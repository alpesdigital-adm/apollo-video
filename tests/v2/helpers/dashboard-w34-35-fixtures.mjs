import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'

import { variantBodyFor } from './explicit-project-http.mjs'
import { commitSealedChild, persistReceiptForExistingVideo, testActor } from './pg-output-world.mjs'

/**
 * Fixtures and independent oracles shared by the W34 aggregate proof and the
 * W35 state proof.
 *
 * Provenance is part of the contract. Every relation a fixture writes is
 * labelled in the manifest as one of:
 *
 * - `real-api`: produced by the public V2 HTTP API as the journey API client
 *   (project creation, version advance through `output-variants`, archive).
 * - `real-service`: produced by the production application services over
 *   PostgreSQL without HTTP (the ingest receipt adoption, the project LUT
 *   selection and the Director run that give a project its observed timeline
 *   and its Director run). A sealed Version, snapshot or Command can only be
 *   born through those writers, never inserted by hand.
 * - `controlled-pg-seed`: rows written with Prisma, inside the foreign keys and
 *   CHECK constraints of PostgreSQL (operations, annotations, final-export
 *   chain, project status). A seed is controlled state, not an operation that
 *   ran. PostgreSQL is never corrupted and no foreign key is bypassed.
 *
 * No worker or provider executed any operation in these fixtures.
 */

// A `.mjs` that names a static `.ts` specifier dies at link time under tsx,
// so the domain arrives through `await import`.
const { createMediaArtifactManifest } = await import('../../../src/v2/domain/media-artifact.ts')
const { createMediaTranscript } = await import('../../../src/v2/domain/media-transcript.ts')
const { assetRightsRevision } = await import('../../../src/v2/domain/asset-rights.ts')
const { stableSerialize } = await import('../../../src/v2/application/version-hash.ts')
const { compileInitialSourceEditPlan } = await import('../../../src/v2/application/apply-editorial-cut-command.ts')
const { setAssetRightsService } = await import('../../../src/v2/application/set-asset-rights.ts')
const { setProjectLutSelectionService } = await import('../../../src/v2/application/project-lut-selections.ts')
const { runProjectDirectorService } = await import('../../../src/v2/application/run-project-director.ts')
const { PrismaMediaArtifactRepository } = await import('../../../src/v2/infrastructure/prisma/media-artifact-repository.ts')
const { PrismaAssetRightsRepository } = await import('../../../src/v2/infrastructure/prisma/asset-rights-repository.ts')
const { PrismaProjectLutSelectionRepository } = await import('../../../src/v2/infrastructure/prisma/project-lut-selection-repository.ts')
const { PrismaDirectorRunRepository } = await import('../../../src/v2/infrastructure/prisma/director-run-repository.ts')
const { createEvidenceBoundBriefCompiler } = await import('../../../src/v2/infrastructure/brief/evidence-bound-brief-compiler-model.ts')

export const sha = (character) => character.repeat(64)
export const hashOf = (text) => createHash('sha256').update(text).digest('hex')

export const W35_EMPTY_WORKSPACE_ID = 'w35-empty-workspace-v2'

export const RENDER_OPERATION_TYPES = new Set([
  'project-proxy-render', 'project-final-export',
])

// -- Real API fixtures ------------------------------------------------------

// 6.0.0: the project is born at its creation Version (sequence 1, no output); `format` is not part of the request.
export async function createRealProject({
  baseUrl, authorization, name, key, objective = 'discovery', locale = 'pt-BR',
}) {
  const response = await fetch(`${baseUrl}/v1/projects`, {
    method: 'POST',
    headers: {
      authorization, 'content-type': 'application/json', 'idempotency-key': key,
    },
    body: JSON.stringify({ name, objective, locale }),
  })
  const body = await response.json()
  assert.equal(response.status, 201, `create ${name}: ${JSON.stringify(body)}`)
  assert.equal(body.data.creationVersion.sequence, 1)
  return { project: body.data.projectAtCreation, version: body.data.creationVersion }
}

// A real second Version through the V2 API: the project's first explicit output variant, built on `version`.
export async function advanceVersionThroughApi({
  baseUrl, authorization, projectId, version, key, aspectRatio = '9:16',
}) {
  const response = await fetch(`${baseUrl}/v1/projects/${projectId}/output-variants`, {
    method: 'POST',
    headers: {
      authorization, 'content-type': 'application/json', 'idempotency-key': key,
    },
    body: JSON.stringify({
      ...variantBodyFor({ aspectRatio }), baseVersionId: version.id, baseHash: version.baseHash,
    }),
  })
  const body = await response.json()
  assert.equal(response.status, 201, `advance ${projectId}: ${JSON.stringify(body)}`)
  assert.equal(body.data.version.sequence, version.sequence + 1)
  return body.data.version
}

export async function archiveThroughApi({
  baseUrl, authorization, projectId, baseRevision, key,
}) {
  const response = await fetch(`${baseUrl}/v1/projects/${projectId}/archive`, {
    method: 'POST',
    headers: {
      authorization, 'content-type': 'application/json', 'idempotency-key': key,
    },
    body: JSON.stringify({ baseRevision, confirmed: true }),
  })
  const body = await response.json()
  assert.equal(response.status, 200, `archive ${projectId}: ${JSON.stringify(body)}`)
  assert.equal(body.data.project.status, 'archived')
  return body.data
}

// -- Controlled PostgreSQL seeds -------------------------------------------

export async function setProjectStatus(client, projectId, status) {
  await client.v2Project.update({ where: { id: projectId }, data: { status } })
}

/**
 * One public operation row that satisfies the canonical state, progress,
 * lease, retry and actor-audit CHECKs for the render types (total 4, unit
 * `render`). `completed` is the persisted progress counter.
 */

/** Raw PostgreSQL CHECK rejection, not an API/presenter synthetic success. */
export async function proveRejectedProgressWithoutTotal(client, { workspaceId, projectId, operationId }) {
  const before = await client.v2PublicOperation.findUnique({ where: { id: operationId } })
  assert.ok(before); assert.equal(before.workspaceId, workspaceId); assert.equal(before.projectId, projectId)
  assert.equal(before.progressCompleted, 1); assert.equal(before.progressTotal, 4); assert.equal(before.progressUnit, 'render')
  const countBefore = await client.v2PublicOperation.count({ where: { workspaceId } })
  let sqlstate, constraint
  await assert.rejects(() => client.$executeRawUnsafe(
    'UPDATE "public_operations" SET "progressCompleted" = 1, "progressTotal" = NULL, "progressUnit" = NULL WHERE "id" = $1 AND "workspaceId"::text = $2 AND "projectId"::text = $3',
    operationId, workspaceId, projectId,
  ), (error) => {
    sqlstate = error.meta?.code
    const message = error.meta?.message
    constraint = typeof message === 'string' && message.includes('public_operations_progress_check')
      ? 'public_operations_progress_check' : null
    return error.code === 'P2010' && sqlstate === '23514' && constraint === 'public_operations_progress_check'
  }, 'counter-without-total must be rejected by the exact PostgreSQL CHECK')
  const after = await client.v2PublicOperation.findUnique({ where: { id: operationId } })
  const countAfter = await client.v2PublicOperation.count({ where: { workspaceId } })
  assert.deepEqual(after, before, 'the rejected statement must leave every operation column unchanged')
  assert.equal(countAfter, countBefore, 'the rejected statement must have zero row-count effects')
  return { origin: 'raw-postgresql-check-rejection', operationId, workspaceId, projectId,
    sqlstate, constraint, attemptedProgress: { completed: 1, total: null, unit: null },
    persistedProgressBefore: { completed: before.progressCompleted, total: before.progressTotal, unit: before.progressUnit },
    persistedProgressAfter: { completed: after.progressCompleted, total: after.progressTotal, unit: after.progressUnit },
    rowUnchanged: true, countBefore, countAfter, statementRollbackReadback: true }
}

export async function seedOperation(client, {
  workspaceId, clientId, projectId, id, type = 'project-proxy-render',
  status, phase, completed, createdAt, updatedAt, targetId,
  errorCode = 'render-failed', errorRetryable = true, audit,
}) {
  assert.ok(RENDER_OPERATION_TYPES.has(type), `unsupported seeded operation type ${type}`)
  assert.ok(updatedAt.getTime() - createdAt.getTime() >= 2000, 'operation spans at least two seconds')
  const startedAt = new Date(createdAt.getTime() + 1000)
  const data = {
    id, workspaceId, projectId, clientId, type, status, phase,
    targetType: 'media-artifact', targetId,
    progressCompleted: completed, progressTotal: 4, progressUnit: 'render',
    maxAttempts: 3, idempotencyKey: `${id}-key`,
    requestFingerprint: hashOf(`fingerprint:${id}`),
    createdAt, updatedAt,
    ...(audit ? {
      actorCredentialId: audit.credentialId, actorEnvironment: audit.environment,
      actorAuthenticationKind: 'bearer', actorContextHash: audit.contextHash,
    } : {}),
  }
  if (status === 'queued') {
    Object.assign(data, { attempt: 0, cancelable: true, retryable: false })
  } else if (status === 'running') {
    Object.assign(data, {
      attempt: 1, cancelable: true, retryable: false, startedAt,
      leaseOwner: 'w34-w35-controlled-seed',
      heartbeatAt: updatedAt,
      leaseExpiresAt: new Date(updatedAt.getTime() + 5 * 60_000),
    })
  } else if (status === 'succeeded') {
    Object.assign(data, {
      attempt: 1, cancelable: false, retryable: false, startedAt,
      completedAt: updatedAt, resultJson: JSON.stringify({ artifactId: targetId }),
    })
  } else if (status === 'failed') {
    Object.assign(data, {
      attempt: 1, cancelable: false, retryable: errorRetryable, startedAt,
      completedAt: updatedAt, errorCode, errorRetryable,
      errorMessage: 'Controlled fixture failure recorded for the dashboard proof.',
    })
  } else {
    throw new Error(`unsupported seeded operation status ${status}`)
  }
  await client.v2PublicOperation.create({ data })
  return data
}

export async function seedAnnotations(client, {
  workspaceId, projectId, versionId, proxyArtifactId, clientId, audit,
  status, count, suffix,
}) {
  const ids = []
  for (let index = 0; index < count; index += 1) {
    const id = randomUUID()
    const createdAt = new Date(Date.now() - 60_000)
    await client.v2ReviewAnnotation.create({
      data: {
        id, workspaceId, projectId, projectVersionId: versionId,
        proxyArtifactId, proxyHash: hashOf(`proxy:${proxyArtifactId}`),
        frame: 10 + index, timeStartMs: 333 + index, timeEndMs: 333 + index,
        scope: 'point', targetIdsJson: JSON.stringify([]),
        applicationScopeJson: JSON.stringify({
          kind: 'scene', targetIds: [], formatIds: ['9:16'], localeIds: ['pt-BR'],
          recipeIds: ['project-proxy-render'], global: false,
        }),
        affectedCount: 1, screenshotRef: 'data:image/jpeg;base64,/9j/2Q==',
        text: `w34-w35 ${suffix} ${status} annotation ${index + 1}`,
        authorType: 'api-client', authorId: clientId, authorName: clientId,
        actorClientId: clientId, actorCredentialId: audit.credentialId,
        actorEnvironment: audit.environment, actorAuthenticationKind: 'bearer',
        actorContextHash: audit.contextHash, status,
        idempotencyKey: `${suffix}-${status}-${index}`,
        requestFingerprint: hashOf(`annotation:${id}`), createdAt, updatedAt: createdAt,
      },
    })
    ids.push(id)
  }
  return ids
}

async function storeArtifact(client, { workspaceId, artifactId, role, seed }) {
  const key = `workspaces/${workspaceId}/${role}/${artifactId}.mp4`
  const digest = hashOf(`${seed}:${artifactId}`)
  const manifest = createMediaArtifactManifest({
    artifactKey: key, artifactSha256: digest, byteSize: 8_192, mediaType: 'video',
    container: 'mp4', recipe: { id: role, version: '1.0.0', parameters: {} },
    sources: [], probe: { width: 1_920, height: 1_080, fps: 30, duration: 20 },
  })
  await client.v2MediaArtifact.create({
    data: {
      id: artifactId, workspaceId, artifactKey: key, sha256: digest,
      byteSize: BigInt(8_192), mediaType: 'video', container: 'mp4',
      status: 'available', createdAt: new Date(Date.now() - 120_000),
    },
  })
  await client.v2MediaArtifactManifest.create({
    data: {
      id: `manifest-${artifactId}`, workspaceId, artifactId,
      schemaVersion: manifest.schemaVersion, manifestHash: manifest.manifestHash,
      recipeId: manifest.recipe.id, recipeVersion: manifest.recipe.version,
      parametersHash: manifest.recipe.parametersHash,
      manifestJson: JSON.stringify(manifest), createdAt: new Date(Date.now() - 120_000),
    },
  })
  return { artifactId, manifestId: `manifest-${artifactId}` }
}

// One observed source for every project of these proofs that needs a real Director run. It is a rights-granted ingest source of
// its own (the journey's shared source keeps the rights history other proofs assert), with probe facts the ingest receipt reads.
const DIRECTOR_SOURCE = Object.freeze({
  artifactId: 'w34-w35-director-source-artifact', manifestId: 'w34-w35-director-source-manifest',
  key: 'workspaces/w34-w35/raw/director-source.mov', durationSeconds: 20, fps: 30,
})

async function ensureDirectorSource(client, { workspaceId, clientId, createdAt }) {
  if (!(await client.v2MediaArtifact.findUnique({ where: { id: DIRECTOR_SOURCE.artifactId } }))) {
    await new PrismaMediaArtifactRepository(client).persistOrReplay({
      workspaceId, artifactId: DIRECTOR_SOURCE.artifactId, manifestId: DIRECTOR_SOURCE.manifestId, lineageIds: [],
      manifest: createMediaArtifactManifest({
        artifactKey: DIRECTOR_SOURCE.key, artifactSha256: hashOf('w34-w35-director-source'), byteSize: 4_096,
        mediaType: 'video', container: 'mov', recipe: { id: 'ingest-source', version: 'v1', parameters: {} },
        probe: { width: 1_920, height: 1_080, duration: DIRECTOR_SOURCE.durationSeconds, fps: DIRECTOR_SOURCE.fps },
      }),
      createdAt: createdAt.toISOString(),
    })
    // Rights current and sufficient before any Version adopts the source: editing, editorial reuse and rendering.
    await setAssetRightsService({
      repository: new PrismaAssetRightsRepository(client), clock: () => createdAt,
      createId: () => 'w34-w35-director-source-rights',
    })({
      workspaceId, artifactId: DIRECTOR_SOURCE.artifactId, baseRevision: assetRightsRevision(DIRECTOR_SOURCE.artifactId, 0),
      draft: {
        status: 'approved', allowedUses: ['editing', 'editorial-reuse', 'rendering'], prohibitedUses: [],
        allowedLocales: ['pt-BR'], consent: { status: 'not-required', allowedUses: [] },
      },
      actor: { type: 'api-client', id: clientId },
    })
  }
  return { artifactId: DIRECTOR_SOURCE.artifactId, manifestId: DIRECTOR_SOURCE.manifestId }
}

/**
 * Gives an API-created project a REAL Director run. The project is born through the public API (its creation Version and, via
 * `advanceVersionThroughApi`, its explicit output variant, which must already be the head). From there the same writers the product
 * uses: the project's own ingest receipt of the observed source (`persistReceiptForExistingVideo`), a child Command that adopts it
 * and plays it whole (`commitSealedChild`), the neutral project LUT selection (`setProjectLutSelectionService`) and
 * `runProjectDirectorService` with the evidence-bound brief compiler and the PostgreSQL Director repository. No snapshot, Command or
 * Director row is invented: a snapshot can only be born with its Version.
 *
 * Returns the Versions of that chain (`base`, `lut`, `directed`; `directed` is the new head) and the Director run, which
 * `seedFinalExportChain` hangs its proxy and final-export rows off.
 */
export async function seedDirectedProject(client, {
  workspaceId, clientId, credentialId, environment = 'production', projectId, suffix, words,
}) {
  const actor = testActor({ workspaceId, clientId, credentialId, environment })
  const now = Date.now()
  const source = await ensureDirectorSource(client, { workspaceId, clientId, createdAt: new Date(now - 900_000) })
  const ingestedAt = new Date(now - 600_000)
  const id = (kind) => `${suffix}-${kind}`
  const baseVersionId = id('base-version'), transcriptId = id('transcript')
  // `words` (observed, increasing, inside the 20 s source) replace the two-word default: a test that cuts inside a caption needs more.
  const observedWords = words ?? [{ word: 'Fonte', start: 0.1, end: 0.5 }, { word: `${suffix}.`, start: 0.5, end: 0.9 }]
  const observedText = words ? words.map((item) => item.word).join(' ') : `Fonte do painel ${suffix}.`
  const transcript = createMediaTranscript({
    language: 'pt-BR', text: observedText,
    words: observedWords,
    segments: [{ id: 0, start: observedWords[0].start, end: observedWords.at(-1).end, text: observedText }],
    provider: 'controlled', model: 'dashboard-fixture-v1',
  })
  await client.v2ProjectMediaAsset.create({ data: {
    id: randomUUID(), workspaceId, projectId, artifactId: source.artifactId, role: 'source-master',
    originalFileName: 'director-source.mov', createdAt: ingestedAt,
  } })
  await client.v2MediaTranscript.create({ data: {
    id: transcriptId, workspaceId, projectId, sourceArtifactId: source.artifactId, sourceManifestId: source.manifestId,
    schemaVersion: transcript.schemaVersion, language: transcript.language, provider: transcript.provider, model: transcript.model,
    providerVersion: 'controlled-v1', transcriptHash: transcript.transcriptHash, transcriptJson: stableSerialize(transcript),
    createdAt: ingestedAt,
  } })
  await persistReceiptForExistingVideo(client, {
    workspaceId, projectId, actor, artifactId: source.artifactId, createdAt: ingestedAt.toISOString(), slug: id('ingest'),
  })
  const basePlan = compileInitialSourceEditPlan({
    id: id('plan'), projectVersionId: baseVersionId, transcriptId, transcript, sourceArtifactId: source.artifactId,
    sourceDurationSeconds: DIRECTOR_SOURCE.durationSeconds, fps: DIRECTOR_SOURCE.fps, createdAt: ingestedAt.toISOString(),
  })
  const base = await commitSealedChild(client, {
    workspaceId, projectId, actor, suffix: id('base'), versionId: baseVersionId,
    mutatePlan: () => basePlan, adopt: [source.artifactId],
  })
  const noLut = await setProjectLutSelectionService({
    repository: new PrismaProjectLutSelectionRepository(client), createId: (kind) => id(`lut-${kind}`),
    createEventId: randomUUID, clock: () => new Date(),
  })({
    workspaceId, projectId, baseVersionId: base.version.id, baseHash: base.version.baseHash,
    selection: { mode: 'none' }, actor: { type: 'system', id: 'w34-w35-dashboard-fixture' },
    idempotencyKey: id('lut-none'), reason: 'Keep the dashboard fixture colorimetrically neutral.',
  })
  const directed = await runProjectDirectorService({
    repository: new PrismaDirectorRunRepository(client), clock: () => new Date(), createEventId: randomUUID,
    compileBrief: createEvidenceBoundBriefCompiler(),
    createId: (kind) => `${id(kind)}-${randomUUID().slice(0, 8)}`,
  })({
    workspaceId, projectId, baseVersionId: noLut.version.id, baseHash: noLut.version.baseHash, actor,
    idempotency: { key: id('director-request') }, reason: 'Dashboard fixture: a real Director run over an observed source.',
  })
  const qualitySnapshotId = directed.command.payload.snapshotRefs.quality
  const qualityRow = await client.v2ProjectSnapshot.findUniqueOrThrow({ where: { id: qualitySnapshotId } })
  const run = await client.v2DirectorRun.findUniqueOrThrow({ where: { id: directed.run.id } })
  assert.equal(run.projectId, projectId)
  assert.equal(run.resultVersionId, directed.version.id)
  assert.equal(run.qualitySnapshotId, qualitySnapshotId)
  assert.equal((await client.v2Project.findUniqueOrThrow({ where: { id: projectId } })).currentVersionId, directed.version.id,
    'the Director Version is the head of the project')
  return Object.freeze({
    projectId, source, versions: Object.freeze({
      base: base.version.id, lut: noLut.version.id, directed: directed.version.id,
      directedSequence: directed.version.sequence,
    }),
    director: Object.freeze({
      runId: run.id, status: run.status, qualitySnapshotId, qualitySnapshotHash: qualityRow.contentHash,
      qualityStatus: directed.run.qualityReport.status, commandId: run.commandId,
    }),
  })
}

/**
 * The final-export chain the dashboard aggregate reads outputs from: proxy
 * render (public operation, render row, review), output artifacts, and one
 * final export per requested status, all hung off the REAL Director run of
 * `directed` (`seedDirectedProject`) and the source it observed. Every row is
 * written inside the real foreign keys. `versionId` is the Version the rows are
 * about (the head, or an earlier Version of the same project, which is then
 * superseded); its own EditPlan snapshot is the one the rows reference.
 * `exports[].status` selects the final public operation state; only
 * `succeeded` becomes a completed output.
 */
export async function seedFinalExportChain(client, {
  workspaceId, clientId, projectId, versionId, directed, suffix, audit, aspectRatio, exports,
}) {
  assert.equal(directed.projectId, projectId, 'the Director run belongs to the project the chain is seeded for')
  const version = await client.v2ProjectVersion.findUniqueOrThrow({ where: { id: versionId } })
  assert.equal(version.projectId, projectId)
  const { artifactId: sourceArtifactId, manifestId: sourceManifestId } = directed.source
  const directorRunId = directed.director.runId
  const proxyOperationId = `${suffix}-proxy-operation`
  const proxyReviewId = `${suffix}-proxy-review`
  const at = (offsetSeconds) => new Date(Date.now() - 300_000 + offsetSeconds * 1000)
  const proxy = await storeArtifact(client, {
    workspaceId, artifactId: `${suffix}-proxy-artifact`, role: 'editorial-proxy', seed: 'proxy',
  })
  await seedOperation(client, {
    workspaceId, clientId, projectId, id: proxyOperationId,
    type: 'project-proxy-render', status: 'succeeded', phase: 'completed',
    completed: 4, createdAt: at(3), updatedAt: at(10), targetId: proxy.artifactId, audit,
  })
  await client.v2ProjectProxyRenderOperation.create({
    data: {
      operationId: proxyOperationId, workspaceId, projectId,
      projectVersionId: versionId, editPlanSnapshotId: version.editPlanSnapshotId,
      sourceArtifactId, sourceManifestId,
      colorPipelineBindingsJson: JSON.stringify([]),
      inputHash: hashOf(`proxy-input:${suffix}`),
      outputArtifactId: proxy.artifactId, outputManifestId: proxy.manifestId,
      originalFileName: 'master.mp4', createdAt: at(4),
    },
  })
  await client.v2ProxyReview.create({
    data: {
      id: proxyReviewId, workspaceId, projectId, projectVersionId: versionId,
      operationId: proxyOperationId, proxyArtifactId: proxy.artifactId,
      proxyManifestId: proxy.manifestId, inputHash: hashOf(`proxy-input:${suffix}`),
      outputSpecId: 'proxy-16x9', rangeCacheKey: sha('a'),
      specJson: JSON.stringify({ id: 'proxy-16x9' }), status: 'ready-for-final',
      technicalIssuesJson: JSON.stringify([]), criticIssuesJson: JSON.stringify([]),
      warningsAcknowledged: true, acknowledgedByType: 'api-client',
      acknowledgedById: clientId, acknowledgedAt: at(11), finalAllowed: true,
      reviewHash: hashOf(`review:${suffix}`), revision: 1,
      uploadReceivedAt: at(5), renderCompletedAt: at(10),
      timeToFirstProxyMs: BigInt(1_000), createdAt: at(11), updatedAt: at(11),
    },
  })
  const outputs = []
  let offset = 20
  for (const [index, item] of exports.entries()) {
    const finalId = `${suffix}-final-operation-${index + 1}`
    const output = await storeArtifact(client, {
      workspaceId, artifactId: `${suffix}-output-artifact-${index + 1}`,
      role: 'final-export', seed: `final-${item.status}`,
    })
    await seedOperation(client, {
      workspaceId, clientId, projectId, id: finalId, type: 'project-final-export',
      status: item.status, phase: item.status === 'succeeded' ? 'completed' : 'failed',
      completed: item.status === 'succeeded' ? 4 : 2,
      createdAt: at(offset), updatedAt: at(offset + 10), targetId: output.artifactId,
      errorCode: 'export-failed', errorRetryable: true, audit,
    })
    await client.v2ProjectFinalExportOperation.create({
      data: {
        operationId: finalId, workspaceId, projectId, projectVersionId: versionId,
        projectVersionHash: version.baseHash,
        editPlanSnapshotId: version.editPlanSnapshotId, directorRunId,
        qualitySnapshotId: directed.director.qualitySnapshotId, qualitySnapshotHash: directed.director.qualitySnapshotHash,
        proxyReviewId, proxyReviewHash: hashOf(`review:${suffix}`),
        proxyArtifactId: proxy.artifactId, sourceArtifactId, sourceManifestId,
        colorPipelineBindingsJson: JSON.stringify([]),
        inputHash: hashOf(`final-input:${finalId}`),
        outputArtifactId: output.artifactId, outputManifestId: output.manifestId,
        outputAspectRatio: item.aspectRatio ?? aspectRatio, outputWidth: 1_920, outputHeight: 1_080,
        outputFps: 30, outputCodec: 'h264', outputAudioCodec: 'aac',
        outputContainer: 'mp4', outputQuality: 'final',
        approvedByType: 'api-client', approvedById: clientId,
        approvalNote: 'approved by the W34/W35 fixture', approvedAt: at(offset - 1),
        originalFileName: 'master.mp4', createdAt: at(offset),
      },
    })
    if (item.status === 'succeeded') {
      await client.v2ProjectFinalExportAttempt.create({
        data: {
          operationId: finalId, workspaceId, attempt: 1, status: 'promoted',
          validatorsJson: JSON.stringify([]), outputArtifactId: output.artifactId,
          outputManifestId: output.manifestId, outputSha256: hashOf(`output:${finalId}`),
          outputByteSize: BigInt(8_192), startedAt: at(offset + 1),
          completedAt: at(offset + 9),
        },
      })
    }
    outputs.push({
      operationId: finalId, artifactId: output.artifactId, status: item.status,
      aspectRatio: item.aspectRatio ?? aspectRatio,
    })
    offset += 20
  }
  return { proxyOperationId, proxyReviewId, directorRunId, outputs }
}

// -- Independent oracle -----------------------------------------------------

/**
 * Reads the persisted relations straight from PostgreSQL and derives the
 * dashboard aggregate the API must project. It deliberately does not import
 * the repository, the presenter or the component under test.
 */
export async function readAggregateOracle(client, { workspaceId, projectId }) {
  const project = await client.v2Project.findUniqueOrThrow({ where: { id: projectId } })
  assert.equal(project.workspaceId, workspaceId)
  const version = project.currentVersionId
    ? await client.v2ProjectVersion.findUniqueOrThrow({ where: { id: project.currentVersionId } })
    : null
  const operation = await client.v2PublicOperation.findFirst({
    where: { workspaceId, projectId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  const openReviewIssueCount = version
    ? await client.v2ReviewAnnotation.count({
        where: { workspaceId, projectId, projectVersionId: version.id, status: 'open' },
      })
    : 0
  const outputRows = version
    ? await client.v2ProjectFinalExportOperation.findMany({
        where: {
          workspaceId, projectId, projectVersionId: version.id,
          operation: { status: 'succeeded' },
        },
        orderBy: [{ createdAt: 'asc' }, { operationId: 'asc' }],
        select: { operationId: true, outputArtifactId: true, outputAspectRatio: true },
      })
    : []
  const outputs = outputRows.map((row) => ({
    artifactId: row.outputArtifactId, aspectRatio: row.outputAspectRatio,
  }))
  const lastActivity = Math.max(project.updatedAt.getTime(), operation?.updatedAt.getTime() ?? 0)
  const expected = {
    schemaVersion: 'project-dashboard-summary/v2',
    currentVersion: version
      ? { id: version.id, sequence: version.sequence, createdAt: version.createdAt.toISOString() }
      : null,
    latestOperation: operation
      ? {
          id: operation.id, type: operation.type, status: operation.status,
          phase: operation.phase,
          ...(operation.progressCompleted === null ? {} : {
            progress: {
              completed: operation.progressCompleted,
              ...(operation.progressTotal === null ? {} : { total: operation.progressTotal }),
              ...(operation.progressUnit === null ? {} : { unit: operation.progressUnit }),
            },
          }),
          ...(operation.status === 'failed'
            ? { error: { code: operation.errorCode, retryable: operation.errorRetryable } }
            : {}),
          updatedAt: operation.updatedAt.toISOString(),
        }
      : null,
    openReviewIssueCount,
    outputs,
    outputCount: outputs.length,
    lastActivityAt: new Date(lastActivity).toISOString(),
    administrationRevision: project.administrationRevision,
    archivedFromStatus: project.archivedFromStatus,
  }
  return {
    project: {
      id: project.id, name: project.name, status: project.status,
      currentVersionId: project.currentVersionId, locale: project.locale,
      format: project.format, objective: project.objective,
    },
    expected,
    outputOperationIds: outputRows.map((row) => row.operationId),
  }
}

// -- Cleanup ---------------------------------------------------------------

/**
 * Removes only what the W34/W35 fixtures wrote, in an order that respects
 * every RESTRICT foreign key, so the shared journey cleanup can then delete
 * the projects. Idempotent: a database without these fixtures is a no-op.
 */
export async function cleanupDashboardFixtures(client, {
  workspaceId, prefixes = ['w34-', 'w35-'], emptyWorkspaceId = W35_EMPTY_WORKSPACE_ID,
}) {
  const projects = await client.v2Project.findMany({
    where: { workspaceId, OR: prefixes.map((prefix) => ({ name: { startsWith: prefix } })) },
    select: { id: true },
  })
  const ids = projects.map((project) => project.id)
  if (ids.length) {
    const where = { workspaceId, projectId: { in: ids } }
    const finals = await client.v2ProjectFinalExportOperation.findMany({
      where, select: { operationId: true },
    })
  }
  return { projects: ids.length }
}
