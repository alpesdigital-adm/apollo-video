import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createProjectReviewAnnotationService,
  readProjectReviewService,
} from '../../src/v2/application/review-project.ts'

const screenshotRef = `data:image/jpeg;base64,${Buffer.from('project-review-frame').toString('base64')}`
const context = Object.freeze({
  currentProjectVersionId: 'project-version-review-1',
  projectVersionId: 'project-version-review-1',
  proxyArtifactId: 'artifact-review-proxy-1',
  proxyHash: 'a'.repeat(64),
  fps: 30,
  width: 1080,
  height: 1920,
  durationFrames: 2400,
  stale: false,
  formatId: '9:16',
  localeId: 'pt-BR',
  recipeIds: Object.freeze(['review-proxy']),
  availableScopeCounts: Object.freeze({ frame: 2400, region: 1, clip: 1, scene: 1, range: 1, project: 1, formats: 1, locales: 1, recipes: 1 }),
  versions: Object.freeze([{ id: 'project-version-review-1', sequence: 1, createdAt: '2026-07-19T14:00:00.000Z', current: true, previewAvailable: true }]),
  scenes: Object.freeze([{ id: 'scene:clip-1', label: 'Cena 1', startFrame: 0, endFrame: 900 }]),
})

function repositoryFixture(overrides = {}) {
  const annotations = []
  const idempotency = new Map()
  return {
    annotations,
    async readPreviewContext() { return context },
    async list() { return Object.freeze([...annotations].reverse()) },
    async findIdempotent({ idempotencyKey }) { return idempotency.get(idempotencyKey) ?? null },
    async create(input) {
      annotations.push(input.annotation)
      idempotency.set(input.idempotencyKey, { requestFingerprint: input.requestFingerprint, annotation: input.annotation })
      return input.annotation
    },
    ...overrides,
  }
}

test('F1-039 review session binds the exact active version, proxy identity, metadata and scenes', async () => {
  const repository = repositoryFixture()
  const result = await readProjectReviewService({ repository })({
    workspaceId: 'workspace-review-1',
    projectId: 'project-review-1',
  })
  assert.deepEqual(result.session, {
    currentProjectVersionId: context.currentProjectVersionId,
    projectVersionId: context.projectVersionId,
    proxyArtifactId: context.proxyArtifactId,
    proxyUrl: `/v1/artifacts/${context.proxyArtifactId}/content`,
    proxyHash: context.proxyHash,
    fps: 30,
    resolution: { width: 1080, height: 1920 },
    durationFrames: 2400,
    stale: false,
  })
  assert.deepEqual(result.versions, context.versions)
  assert.equal(result.scopeContext.options.length, 9)
  assert.deepEqual(result.scopeContext.recipeIds, ['review-proxy'])
  assert.deepEqual(result.scenes, context.scenes)
  assert.deepEqual(result.annotations, [])
})

test('F1-039 historic review forwards the selected immutable version and exposes it as stale', async () => {
  let query
  const historicContext = {
    ...context,
    projectVersionId: 'project-version-review-0',
    stale: true,
    versions: Object.freeze([
      ...context.versions,
      { id: 'project-version-review-0', sequence: 0, createdAt: '2026-07-19T13:00:00.000Z', current: false, previewAvailable: true },
    ]),
  }
  const repository = repositoryFixture({
    async readPreviewContext(input) { query = input; return historicContext },
  })
  const result = await readProjectReviewService({ repository })({
    workspaceId: 'workspace-review-1',
    projectId: 'project-review-1',
    projectVersionId: 'project-version-review-0',
  })
  assert.equal(query.projectVersionId, 'project-version-review-0')
  assert.equal(result.session.projectVersionId, 'project-version-review-0')
  assert.equal(result.session.currentProjectVersionId, context.currentProjectVersionId)
  assert.equal(result.session.stale, true)
})

test('F1-040 persists a bounded regional annotation independently and replays idempotently', async () => {
  const repository = repositoryFixture()
  let id = 0
  const create = createProjectReviewAnnotationService({
    repository,
    clock: () => new Date('2026-07-19T14:10:00.000Z'),
    createId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
  })
  const request = {
    workspaceId: 'workspace-review-1',
    projectId: 'project-review-1',
    projectVersionId: context.projectVersionId,
    proxyArtifactId: context.proxyArtifactId,
    proxyHash: context.proxyHash,
    frame: 315,
    timeRangeMs: [10500, 10500],
    scope: 'region',
    region: { x: 0.1, y: 0.2, width: 0.3, height: 0.25 },
    targetIds: [],
    screenshotRef,
    text: '  Mover a legenda para baixo.  ',
    author: { id: 'client-review-1', name: 'Editor', type: 'api-client' },
    idempotencyKey: 'review-region-request-1',
  }
  const first = await create(request)
  const replay = await create(request)
  assert.equal(first.replayed, false)
  assert.equal(replay.replayed, true)
  assert.equal(first.annotation.text, 'Mover a legenda para baixo.')
  assert.deepEqual(first.annotation.region, request.region)
  assert.equal(first.annotation.applicationScope.kind, 'scene')
  assert.deepEqual(first.annotation.applicationScope.formatIds, ['9:16'])
  assert.deepEqual(first.annotation.applicationScope.localeIds, ['pt-BR'])
  assert.equal(first.annotation.affectedCount, 1)
  assert.equal(repository.annotations.length, 1)
  assert.equal(first.annotation.projectVersionId, context.projectVersionId)
})

test('F1-040 rejects stale preview identity and validates an exact scene range', async () => {
  const staleRepository = repositoryFixture({ async readPreviewContext() { return { ...context, stale: true } } })
  const createStale = createProjectReviewAnnotationService({
    repository: staleRepository,
    clock: () => new Date('2026-07-19T14:10:00.000Z'),
    createId: () => '00000000-0000-4000-8000-000000000001',
  })
  const base = {
    workspaceId: 'workspace-review-1', projectId: 'project-review-1',
    projectVersionId: context.projectVersionId, proxyArtifactId: context.proxyArtifactId,
    proxyHash: context.proxyHash, frame: 315, timeRangeMs: [10500, 10500],
    scope: 'point', targetIds: [], screenshotRef, text: 'Ajustar este frame.',
    author: { id: 'client-review-1', name: 'Editor', type: 'api-client' },
    idempotencyKey: 'review-stale-request-1',
  }
  await assert.rejects(() => createStale(base), (error) => error?.code === 'VERSION_CONFLICT')

  const repository = repositoryFixture()
  const create = createProjectReviewAnnotationService({
    repository,
    clock: () => new Date('2026-07-19T14:10:00.000Z'),
    createId: () => '00000000-0000-4000-8000-000000000002',
  })
  const scene = await create({
    ...base,
    frame: 300,
    timeRangeMs: [0, 30000],
    scope: 'scene',
    targetIds: ['scene:clip-1'],
    text: 'Rever o ritmo desta cena inteira.',
    idempotencyKey: 'review-scene-request-1',
  })
  assert.equal(scene.annotation.scope, 'scene')
  assert.deepEqual(scene.annotation.timeRangeMs, [0, 30000])
})

test('F1-041 rejects unconfirmed global scope and persists its deterministic affected count after confirmation', async () => {
  const repository = repositoryFixture({
    async readPreviewContext() {
      return { ...context, availableScopeCounts: { ...context.availableScopeCounts, formats: 5 } }
    },
  })
  const create = createProjectReviewAnnotationService({
    repository,
    clock: () => new Date('2026-07-19T14:10:00.000Z'),
    createId: () => '00000000-0000-4000-8000-000000000003',
  })
  const request = {
    workspaceId: 'workspace-review-1', projectId: 'project-review-1',
    projectVersionId: context.projectVersionId, proxyArtifactId: context.proxyArtifactId,
    proxyHash: context.proxyHash, frame: 315, timeRangeMs: [10500, 10500],
    scope: 'point', targetIds: [], applicationScope: { kind: 'formats', global: true },
    screenshotRef, text: 'Aplicar a identidade visual em todos os formatos.',
    author: { id: 'client-review-1', name: 'Editor', type: 'api-client' },
    idempotencyKey: 'review-global-request-1',
  }
  await assert.rejects(() => create(request), (error) => error?.code === 'PRECONDITION_REQUIRED')
  const result = await create({ ...request, confirmedGlobal: true })
  assert.equal(result.annotation.applicationScope.kind, 'formats')
  assert.equal(result.annotation.applicationScope.global, true)
  assert.equal(result.annotation.affectedCount, 5)
  assert.equal(repository.annotations.length, 1)
})
