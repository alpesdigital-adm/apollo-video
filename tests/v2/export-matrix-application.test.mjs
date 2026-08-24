import assert from 'node:assert/strict'
import test from 'node:test'

import { createAssetRightsSnapshot } from '../../src/v2/domain/asset-rights.ts'
import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import {
  commitExportMatrixService,
  createExportMatrixPreflightService,
} from '../../src/v2/application/export-matrices.ts'
import { deriveExportMatrixRuntimeStatus } from '../../src/v2/domain/export-matrix.ts'
import { HmacPreflightCommitTokenIssuer } from '../../src/v2/infrastructure/security/preflight-commit-token.ts'

const workspaceId = 'workspace-export-matrix-app'
const formats = ['9:16', '16:9', '4:5', '1:1', '21:9']
const formatByProject = new Map(formats.map((format) => [`project-${format.replace(':', 'x')}`, format]))

function actor() {
  const auditContext = createExternalAuditContext({
    clientId: 'client-export-matrix-app',
    credentialId: 'credential-export-matrix-app',
    workspaceId,
    environment: 'production',
  })
  return Object.freeze({
    ...auditContext,
    scopes: new Set(['projects:write']),
    authenticationKind: 'bearer',
    clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active',
    workspaceAccessStatus: 'active',
    auditContext,
  })
}

function requests() {
  return formats.map((format, index) => ({
    recipeId: `recipe-${index + 1}`,
    projectId: `project-${format.replace(':', 'x')}`,
    projectVersionId: `version-${format.replace(':', 'x')}`,
    projectVersionHash: String(index + 1).repeat(64),
    format,
    locale: 'pt-BR',
  }))
}

function source(projectId) {
  const format = formatByProject.get(projectId)
  const sourceArtifactId = `source-${projectId}`
  return Object.freeze({
    projectId,
    projectVersionId: `version-${format.replace(':', 'x')}`,
    projectVersionHash: String(formats.indexOf(format) + 1).repeat(64),
    editPlanSnapshotId: `snapshot-${projectId}`,
    editPlanHash: 'a'.repeat(64),
    editPlan: Object.freeze({
      schemaVersion: 2,
      state: 'compiled',
      id: `plan-${projectId}`,
      projectVersionId: `version-${format.replace(':', 'x')}`,
      fps: 30,
      movementPolicy: Object.freeze({ automaticZoom: false, protectedOpeningFrames: 60 }),
      subtitleTracks: Object.freeze([]),
      transitions: Object.freeze([]),
      videoTracks: Object.freeze([{ kind: 'base-video', clips: Object.freeze([Object.freeze({
        id: `clip-${projectId}`,
        sourceArtifactId,
        sourceInFrame: 0,
        sourceOutFrame: 300,
        timelineInFrame: 0,
        timelineOutFrame: 300,
        rate: 1,
      })]) }]),
    }),
    format,
    locale: 'pt-BR',
    directorRunId: `director-${projectId}`,
    qualitySnapshotId: `quality-${projectId}`,
    qualitySnapshotHash: 'b'.repeat(64),
    qualityStatus: 'approved',
    qualityScore: 0.99,
    proxyReviewId: `review-${projectId}`,
    proxyReviewHash: 'c'.repeat(64),
    proxyArtifactId: `proxy-${projectId}`,
    sourceArtifactId,
    sourceManifestId: `manifest-${projectId}`,
    sourceArtifactKey: `workspaces/matrix/${projectId}/source.mp4`,
    sourceSha256: 'd'.repeat(64),
    renderSources: Object.freeze([Object.freeze({
      artifactId: sourceArtifactId,
      manifestId: `manifest-${projectId}`,
      artifactKey: `workspaces/matrix/${projectId}/source.mp4`,
      sha256: 'd'.repeat(64),
      byteSize: 1024,
      mediaType: 'video',
      container: 'mp4',
      role: 'source-master',
    })]),
    originalFileName: `${projectId}.mp4`,
  })
}

function rights(artifactId) {
  return createAssetRightsSnapshot({
    id: `rights-${artifactId}`,
    workspaceId,
    artifactId,
    sequence: 1,
    draft: {
      status: 'approved',
      allowedUses: ['rendering'],
      prohibitedUses: [],
      allowedLocales: ['pt-BR'],
      consent: { status: 'not-required', allowedUses: [] },
    },
    createdBy: { type: 'api-client', id: 'client-export-matrix-app' },
    createdAt: '2026-08-24T18:00:00.000Z',
  })
}

function matrixRepository() {
  let preflight
  let matrix
  const cells = new Map()
  return {
    repository: {
      async findPreflightReplay() { return preflight ?? null },
      async createPreflight(input) {
        preflight = Object.freeze({
          id: input.id,
          preflight: input.preflight,
          createdByClientId: input.authenticationAudit.clientId,
          actorContextHash: input.authenticationAudit.contextHash,
          requestFingerprint: input.requestFingerprint,
          idempotencyKey: input.idempotencyKey,
        })
        return preflight
      },
      async readPreflight() { return preflight ?? null },
      async findMatrixByPreflight() { return matrix ? this.readMatrix() : null },
      async createMatrix(input) {
        matrix = {
          id: input.id,
          workspaceId,
          preflightId: input.preflight.id,
          definitionHash: input.preflight.preflight.definition.definitionHash,
          preflightHash: input.preflight.preflight.preflightHash,
          createdByClientId: input.authenticationAudit.clientId,
          createdAt: input.createdAt,
        }
        for (const cell of input.preflight.preflight.definition.cells) cells.set(cell.id, { ...cell, status: 'awaiting-dispatch', attempt: 0 })
        return this.readMatrix()
      },
      async attachCellOperation(input) {
        cells.set(input.cellId, { ...cells.get(input.cellId), status: 'queued', operationId: input.operationId })
      },
      async recordCellDispatchFailure(input) {
        cells.set(input.cellId, { ...cells.get(input.cellId), status: 'failed', error: input.error })
      },
      async readMatrix() {
        if (!matrix) return null
        const values = [...cells.values()].sort((left, right) => left.sequence - right.sequence)
        return Object.freeze({ ...matrix, status: deriveExportMatrixRuntimeStatus(values.map((cell) => cell.status)), cells: Object.freeze(values.map(Object.freeze)) })
      },
    },
    get preflight() { return preflight },
  }
}

test('T-FR-235 preflights five trusted approved outputs then commits independent operations with one contained dispatch failure', async () => {
  const matrices = matrixRepository()
  const tokenIssuer = new HmacPreflightCommitTokenIssuer('export-matrix-test-secret-that-is-long-enough')
  const projects = { async readApprovedCurrentSource(input) { return source(input.projectId) } }
  const rightsRepository = { async findCurrent(_workspaceId, artifactId) { return { snapshot: rights(artifactId), revision: 'revision-1' } } }
  const colorPipelines = {
    async listForSource(input) {
      return [{ compilation: {
        id: `color-${input.sourceArtifactId}`,
        sourceArtifactId: input.sourceArtifactId,
        sourceManifestId: input.sourceManifestId,
        compilationHash: 'e'.repeat(64),
        pipeline: { pipelineHash: 'f'.repeat(64) },
      } }]
    },
  }
  const preflightResult = await createExportMatrixPreflightService({
    matrices: matrices.repository,
    projects,
    rights: rightsRepository,
    colorPipelines,
    capacity: { async read() { return { operatorMaximumCostMinorUnits: 1_000_000, operatorAvailableStorageBytes: 1_000_000_000 } } },
    tokenIssuer,
    clock: () => new Date('2026-08-24T18:00:00.000Z'),
    createPreflightId: () => 'preflight-export-matrix-app',
  })({
    workspaceId,
    cells: requests(),
    requestedMaximumCostMinorUnits: 1_000_000,
    requestedMaximumStorageBytes: 1_000_000_000,
    actor: actor(),
    idempotencyKey: 'export-matrix-preflight-1',
  })

  assert.equal(preflightResult.record.preflight.allowed, true)
  assert.equal(preflightResult.record.preflight.quantity, 5)
  assert.equal(typeof preflightResult.commitToken, 'string')

  const operationIds = []
  let sequence = 0
  const operations = {
    async findReplay() { return null },
    async createOrReplay(input) {
      sequence += 1
      if (input.context.outputSpec.aspectRatio === '4:5') throw new Error('simulated queue outage')
      operationIds.push(input.operation.id)
      return { operation: input.operation, context: input.context, authenticationAudit: input.authenticationAudit, replayed: false }
    },
  }
  const counters = { matrix: 0, operation: 0, artifact: 0, manifest: 0 }
  const committed = await commitExportMatrixService({
    matrices: matrices.repository,
    projects,
    rights: rightsRepository,
    operations,
    colorPipelines,
    tokenIssuer,
    clock: () => new Date('2026-08-24T18:01:00.000Z'),
    createId(kind) { counters[kind] += 1; return `${kind}-export-matrix-${counters[kind]}` },
  })({
    workspaceId,
    preflightId: 'preflight-export-matrix-app',
    commitToken: preflightResult.commitToken,
    approval: { approved: true, note: 'Approved matrix.' },
    actor: actor(),
  })

  assert.equal(committed.matrix.status, 'partially-failed')
  assert.equal(committed.matrix.cells.filter((cell) => cell.status === 'queued').length, 4)
  assert.equal(committed.matrix.cells.filter((cell) => cell.status === 'failed').length, 1)
  assert.equal(new Set(operationIds).size, 4)
  assert.equal(new Set(committed.matrix.cells.map((cell) => cell.outputFileName)).size, 5)
})

test('T-FR-235 refuses commit when readiness or rights blocked preflight issuance', async () => {
  const matrices = matrixRepository()
  const tokenIssuer = new HmacPreflightCommitTokenIssuer('export-matrix-test-secret-that-is-long-enough')
  const result = await createExportMatrixPreflightService({
    matrices: matrices.repository,
    projects: { async readApprovedCurrentSource() { return null } },
    rights: { async findCurrent() { throw new Error('must not read rights without a ready source') } },
    colorPipelines: { async listForSource() { throw new Error('must not read color pipeline without a ready source') } },
    capacity: { async read() { return { operatorMaximumCostMinorUnits: 1_000_000, operatorAvailableStorageBytes: 1_000_000_000 } } },
    tokenIssuer,
    clock: () => new Date('2026-08-24T18:00:00.000Z'),
    createPreflightId: () => 'preflight-export-matrix-blocked',
  })({
    workspaceId,
    cells: [requests()[0]],
    requestedMaximumCostMinorUnits: 1_000_000,
    requestedMaximumStorageBytes: 1_000_000_000,
    actor: actor(),
    idempotencyKey: 'export-matrix-preflight-blocked',
  })

  assert.equal(result.record.preflight.allowed, false)
  assert.equal(result.commitToken, undefined)
  assert.equal(result.record.preflight.blockers[0].code, 'CELL_NOT_READY')
})

test('T-FR-235 treats a missing trusted color compilation as not ready', async () => {
  const matrices = matrixRepository()
  const result = await createExportMatrixPreflightService({
    matrices: matrices.repository,
    projects: { async readApprovedCurrentSource(input) { return source(input.projectId) } },
    rights: { async findCurrent(_workspaceId, artifactId) { return { snapshot: rights(artifactId), revision: 'revision-1' } } },
    colorPipelines: { async listForSource() { return [] } },
    capacity: { async read() { return { operatorMaximumCostMinorUnits: 1_000_000, operatorAvailableStorageBytes: 1_000_000_000 } } },
    tokenIssuer: new HmacPreflightCommitTokenIssuer('export-matrix-test-secret-that-is-long-enough'),
    clock: () => new Date('2026-08-24T18:00:00.000Z'),
    createPreflightId: () => 'preflight-export-matrix-color-blocked',
  })({
    workspaceId,
    cells: [requests()[0]],
    requestedMaximumCostMinorUnits: 1_000_000,
    requestedMaximumStorageBytes: 1_000_000_000,
    actor: actor(),
    idempotencyKey: 'export-matrix-preflight-color-blocked',
  })

  assert.equal(result.record.preflight.allowed, false)
  assert.equal(result.commitToken, undefined)
  assert.deepEqual(result.record.preflight.blockers, [{ code: 'CELL_NOT_READY', cellId: result.record.preflight.definition.cells[0].id }])
})
