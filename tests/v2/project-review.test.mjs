import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createProjectReviewAnnotationService,
  readProjectReviewService,
} from '../../src/v2/application/review-project.ts'

const screenshotRef = `data:image/jpeg;base64,${Buffer.from('project-review-frame').toString('base64')}`
const context = Object.freeze({
  projectVersionId: 'project-version-review-1',
  proxyArtifactId: 'artifact-review-proxy-1',
  proxyHash: 'a'.repeat(64),
  fps: 30,
  width: 1080,
  height: 1920,
  durationFrames: 2400,
  stale: false,
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
    projectVersionId: context.projectVersionId,
    proxyArtifactId: context.proxyArtifactId,
    proxyUrl: `/v1/artifacts/${context.proxyArtifactId}/content`,
    proxyHash: context.proxyHash,
    fps: 30,
    resolution: { width: 1080, height: 1920 },
    durationFrames: 2400,
    stale: false,
  })
  assert.deepEqual(result.scenes, context.scenes)
  assert.deepEqual(result.annotations, [])
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
