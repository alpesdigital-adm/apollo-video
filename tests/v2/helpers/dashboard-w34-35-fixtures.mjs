import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'

/**
 * Fixtures and independent oracles shared by the W34 aggregate proof and the
 * W35 state proof.
 *
 * Provenance is part of the contract. Every relation a fixture writes is
 * labelled in the manifest as one of:
 *
 * - `real-api`: produced by the public V2 HTTP API as the journey API client
 *   (project creation, version advance through `lut-selection`, archive).
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

export const sha = (character) => character.repeat(64)
export const hashOf = (text) => createHash('sha256').update(text).digest('hex')

export const W35_EMPTY_WORKSPACE_ID = 'w35-empty-workspace-v2'

export const RENDER_OPERATION_TYPES = new Set([
  'project-proxy-render', 'project-final-export',
])

// -- Real API fixtures ------------------------------------------------------

export async function createRealProject({
  baseUrl, authorization, name, key, objective = 'discovery',
  format = '9:16', locale = 'pt-BR',
}) {
  const response = await fetch(`${baseUrl}/v1/projects`, {
    method: 'POST',
    headers: {
      authorization, 'content-type': 'application/json', 'idempotency-key': key,
    },
    body: JSON.stringify({ name, objective, format, locale }),
  })
  const body = await response.json()
  assert.equal(response.status, 201, `create ${name}: ${JSON.stringify(body)}`)
  assert.equal(body.data.version.sequence, 1)
  return { project: body.data.project, version: body.data.version }
}

export async function advanceVersionThroughApi({
  baseUrl, authorization, projectId, version, key,
}) {
  const response = await fetch(`${baseUrl}/v1/projects/${projectId}/lut-selection`, {
    method: 'POST',
    headers: {
      authorization, 'content-type': 'application/json', 'idempotency-key': key,
    },
    body: JSON.stringify({
      baseVersionId: version.id, baseHash: version.baseHash,
      selection: { mode: 'none' },
      reason: 'W34/W35 fixture: a real second version through the V2 API.',
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

async function ensureDirectorSnapshots(client, { workspaceId, projectId, suffix }) {
  const ids = {}
  for (const kind of ['perception', 'treatment', 'story', 'quality-report']) {
    const id = `${suffix}-snapshot-${kind}`
    const existing = await client.v2ProjectSnapshot.findUnique({ where: { id } })
    if (!existing) {
      await client.v2ProjectSnapshot.create({
        data: {
          id, workspaceId, projectId, kind, schemaVersion: 1,
          contentJson: JSON.stringify({ kind, fixture: suffix }),
          contentHash: hashOf(`${projectId}:${kind}`),
          createdAt: new Date(Date.now() - 120_000),
        },
      })
    }
    ids[kind] = id
  }
  return ids
}

/**
 * The final-export chain the dashboard aggregate reads outputs from: edit
 * command, director run, proxy render (public operation, render row, review),
 * output artifacts, and one final export per requested status. Every row is
 * written inside the real foreign keys. `exports[].status` selects the final
 * public operation state; only `succeeded` becomes a completed output.
 */
export async function seedFinalExportChain(client, {
  workspaceId, clientId, projectId, versionId, sourceArtifactId,
  sourceManifestId, suffix, audit, aspectRatio, exports,
}) {
  const version = await client.v2ProjectVersion.findUniqueOrThrow({ where: { id: versionId } })
  const snapshots = await ensureDirectorSnapshots(client, { workspaceId, projectId, suffix: projectId })
  const commandId = `${suffix}-director-command`
  const directorRunId = `${suffix}-director-run`
  const proxyOperationId = `${suffix}-proxy-operation`
  const proxyReviewId = `${suffix}-proxy-review`
  const at = (offsetSeconds) => new Date(Date.now() - 300_000 + offsetSeconds * 1000)
  await client.v2EditCommand.create({
    data: {
      id: commandId, workspaceId, projectId, baseVersionId: versionId,
      baseHash: version.baseHash, type: 'run-director',
      scopeJson: JSON.stringify({ kind: 'project' }),
      payloadJson: JSON.stringify({ reason: 'dashboard fixture director run' }),
      reason: 'W34/W35 fixture needs a director run to hang the export off',
      actorType: 'api-client', actorId: clientId,
      idempotencyKey: `${suffix}-director-key`,
      requestFingerprint: hashOf(`command:${commandId}`), createdAt: at(1),
    },
  })
  await client.v2DirectorRun.create({
    data: {
      id: directorRunId, workspaceId, projectId, commandId,
      baseVersionId: versionId, resultVersionId: versionId, status: 'succeeded',
      plannerVersion: 'planner/1.0.0', criticVersion: 'critic/1.0.0',
      objective: 'discovery', objectiveVersion: 1, rubricRef: 'awareness-discovery/v1',
      perceptionSnapshotId: snapshots.perception,
      treatmentSnapshotId: snapshots.treatment,
      storySnapshotId: snapshots.story,
      editPlanSnapshotId: version.editPlanSnapshotId,
      qualitySnapshotId: snapshots['quality-report'],
      decisionsJson: JSON.stringify([]), assumptionsJson: JSON.stringify([]),
      initiatedByType: 'api-client', initiatedById: clientId,
      createdAt: at(2), updatedAt: at(2),
    },
  })
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
        qualitySnapshotId: snapshots['quality-report'], qualitySnapshotHash: sha('1'),
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
    await client.v2ReviewAnnotation.deleteMany({ where })
    await client.v2ProjectFinalExportAttempt.deleteMany({
      where: { workspaceId, operationId: { in: finals.map((row) => row.operationId) } },
    })
    await client.v2ProjectFinalExportOperation.deleteMany({ where })
    await client.v2ProxyReview.deleteMany({ where })
    await client.v2ProjectProxyRenderOperation.deleteMany({ where })
    await client.v2PublicOperation.deleteMany({ where })
    await client.v2DirectorRun.deleteMany({ where })
    await client.v2ProjectLutSelectionHead.deleteMany({ where })
    await client.v2ProjectLutSelection.deleteMany({ where })
    await client.v2ProjectAdministrationCommand.deleteMany({ where })
    await client.v2ProjectCreationCommand.deleteMany({ where })
  }
  if (emptyWorkspaceId) {
    await client.v2UiSession.deleteMany({ where: { workspaceId: emptyWorkspaceId } })
    await client.v2WorkspaceUiPrincipal.deleteMany({ where: { workspaceId: emptyWorkspaceId } })
    await client.v2WorkspaceMember.deleteMany({ where: { workspaceId: emptyWorkspaceId } })
    await client.v2ApiCredential.deleteMany({ where: { workspaceId: emptyWorkspaceId } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId: emptyWorkspaceId } })
    await client.v2Workspace.deleteMany({ where: { id: emptyWorkspaceId } })
  }
  return { projects: ids.length }
}
