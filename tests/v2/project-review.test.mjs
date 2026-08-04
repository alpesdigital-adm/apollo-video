import assert from 'node:assert/strict'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import {
  createProjectReviewAnnotationService,
  readProjectReviewService,
} from '../../src/v2/application/review-project.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'
import { authenticatedActor } from './helpers/authentication-audit.mjs'

const screenshotRef = `data:image/jpeg;base64,${Buffer.from('project-review-frame').toString('base64')}`
const reviewActor = authenticatedActor({
  clientId: 'client-review-1',
  credentialId: 'credential-review-1',
  workspaceId: 'workspace-review-1',
})
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
  assert.equal(result.versions[0].visibleState.label, 'current')
  assert.equal(result.versions[0].visibleState.primaryAction, 'open-result')
  assert.equal(result.versions[0].visibleState.terminal, false)
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
  assert.equal(result.versions[1].visibleState.label, 'superseded')
  assert.equal(result.versions[1].visibleState.primaryAction, 'open-historical-output')
  assert.equal(result.versions[1].visibleState.terminal, true)
})

test('T-FR-236 version state is derived from current identity and preview availability', async () => {
  const reviewContext = {
    ...context,
    versions: Object.freeze([
      context.versions[0],
      { id: 'project-version-review-0', sequence: 1, createdAt: '2026-07-19T13:00:00.000Z', current: false, previewAvailable: false },
    ]),
  }
  const result = await readProjectReviewService({
    repository: repositoryFixture({ async readPreviewContext() { return reviewContext } }),
  })({ workspaceId: 'workspace-review-1', projectId: 'project-review-1' })
  assert.equal(result.versions[1].visibleState.primaryAction, 'inspect-history')
  assert.throws(() => result.versions[1].visibleState.availableActions.push('open-result'))

  const capability = FOUNDATION_CAPABILITIES.find((item) => item.id === 'apollo.projects.annotations.list')
  assert.equal(capability.version, '3.0.0')
  assert.equal(capability.outputSchemaRef, 'apollo://schemas/project-review/v3')
  assert.equal(getPublicSchema('apollo://schemas/project-review/v2').ref, 'apollo://schemas/project-review/v2')
  const validate = addFormats(new Ajv2020({ strict: false, allErrors: true }))
    .compile(getPublicSchema(capability.outputSchemaRef).schema)
  const body = { data: result, meta: { apiVersion: 'v1' } }
  assert.equal(validate(body), true, JSON.stringify(validate.errors))
  const mismatch = structuredClone(body)
  mismatch.data.versions[1].visibleState.label = 'current'
  assert.equal(validate(mismatch), false)
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
    actor: reviewActor,
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
  assert.match(first.annotation.authenticationAudit.contextHash, /^[a-f0-9]{64}$/)
  assert.equal(first.annotation.authenticationAudit.clientId, reviewActor.clientId)
  assert.deepEqual(first.annotation.author, {
    id: reviewActor.clientId,
    name: reviewActor.clientId,
    type: 'api-client',
  })
  await assert.rejects(
    () => create({
      ...request,
      actor: authenticatedActor({
        clientId: reviewActor.clientId,
        credentialId: 'credential-review-other',
        workspaceId: reviewActor.workspaceId,
      }),
    }),
    (error) => error?.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )

  const delegated = await create({
    ...request,
    actor: authenticatedActor({
      clientId: 'client-review-ui',
      credentialId: 'session-review-ui',
      workspaceId: reviewActor.workspaceId,
      authenticationKind: 'ui-session',
      delegatedUserId: 'member-review-ui',
      delegatedIdentityId: 'identity-review-ui',
      workspaceRole: 'reviewer',
    }),
    idempotencyKey: 'review-region-delegated-request',
  })
  assert.deepEqual(delegated.annotation.author, {
    id: 'member-review-ui',
    name: 'member-review-ui',
    type: 'user',
  })
  assert.equal(
    delegated.annotation.authenticationAudit.delegatedIdentityId,
    'identity-review-ui',
  )
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
    actor: reviewActor,
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
    actor: reviewActor,
    idempotencyKey: 'review-global-request-1',
  }
  await assert.rejects(() => create(request), (error) => error?.code === 'PRECONDITION_REQUIRED')
  const result = await create({ ...request, confirmedGlobal: true })
  assert.equal(result.annotation.applicationScope.kind, 'formats')
  assert.equal(result.annotation.applicationScope.global, true)
  assert.equal(result.annotation.affectedCount, 5)
  assert.equal(repository.annotations.length, 1)
})
