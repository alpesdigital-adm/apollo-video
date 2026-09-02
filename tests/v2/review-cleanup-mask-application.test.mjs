import assert from 'node:assert/strict'
import test from 'node:test'

import { createReviewCleanupMaskService, refineReviewCleanupMaskService } from '../../src/v2/application/review-cleanup-masks.ts'
import { createTransformationBrief } from '../../src/v2/domain/transformation-brief.ts'
import { authenticatedActor } from './helpers/authentication-audit.mjs'

const HASH = (value) => value.repeat(64)
const workspaceId = 'workspace-audit-test'
const projectId = 'project-review-mask'

function brief() {
  return createTransformationBrief({
    workspaceId, projectId, projectVersionId: 'version-review-mask', storyPlanId: 'story-review-mask', storyPlanHash: HASH('1'),
    sourceArtifactId: 'artifact-source-review-mask', sourceArtifactHash: HASH('2'), sourceRange: { startFrame: 30, endFrame: 150 },
    intent: 'world-shift', editorialIntent: 'Remover marca sobre o fundo sem alterar a pessoa.', mode: 'object-environment-change',
    prompt: 'Reconstruir apenas pixels sob a máscara.', negativeConstraints: ['não alterar a pessoa'], preserve: ['identity', 'speech'],
    allowedChanges: ['background-pixels-under-mask'], target: { cleanup: 'inpaint' }, outputSpecIds: ['output-spec-vertical'],
    intensityBps: 1_000, noveltyBps: 500, safety: ['no-face-change'],
    safeZones: [{ x: 0.3, y: 0.05, width: 0.4, height: 0.55, purpose: 'subject' }], fallbackLadder: ['source-unchanged'],
    rightsSnapshotId: 'rights-review-mask', rightsSnapshotHash: HASH('3'), identitySnapshotId: 'identity-review-mask', identitySnapshotHash: HASH('4'),
    createdAt: '2026-09-01T20:00:00.000Z',
  })
}

function annotation() {
  return Object.freeze({
    id: '5e87ff95-9de3-4aef-9166-eae8739ed25b', projectVersionId: 'version-review-mask', proxyArtifactId: 'artifact-proxy-review-mask', proxyHash: HASH('5'),
    frame: 60, timeRangeMs: [2_000, 3_000], screenshotRef: 'data:image/png;base64,AA==', scope: 'region',
    region: { x: 0.12, y: 0.78, width: 0.76, height: 0.12 }, targetIds: [],
    applicationScope: { kind: 'region', targetIds: ['clip-review-mask'], formatIds: ['output-spec-vertical'], localeIds: ['pt-BR'], recipeIds: [], global: false },
    affectedCount: 1, text: 'Remover marca.', author: { id: 'client-audit-test', name: 'client-audit-test', type: 'api-client' }, status: 'open',
    createdAt: '2026-09-01T20:01:00.000Z', authenticationAudit: {},
  })
}

function fixture() {
  const rows = []
  const masks = {
    async findIdempotent(input) { return rows.find((row) => row.mask.createdByClientId === input.actorClientId && row.idempotencyKey === input.idempotencyKey) ?? null },
    async read(input) { return rows.find((row) => row.mask.id === input.maskId) ?? null },
    async readLatest(input) { return rows.filter((row) => row.mask.rootId === input.rootId).toSorted((a, b) => b.mask.revision - a.mask.revision)[0] ?? null },
    async list() { return rows },
    async persist(input) { const row = Object.freeze({ mask: input.mask, authenticationAudit: input.authenticationAudit, idempotencyKey: input.idempotencyKey, requestFingerprint: input.requestFingerprint }); rows.push(row); return row },
  }
  const sourceBrief = brief()
  let sequence = 0
  const create = createReviewCleanupMaskService({
    masks,
    annotations: {
      async readPreviewContext() { return { currentProjectVersionId: 'version-review-mask', projectVersionId: 'version-review-mask', proxyArtifactId: 'artifact-proxy-review-mask', proxyHash: HASH('5'), fps: 30, stale: false } },
      async list() { return [annotation()] },
    },
    registry: { async readBrief() { return sourceBrief } },
    artifacts: { async findById() { return { id: sourceBrief.sourceArtifactId, sha256: sourceBrief.sourceArtifactHash, status: 'available' } } },
    clock: () => new Date(`2026-09-01T20:0${2 + sequence}:00.000Z`),
    createMaskId: () => `review-mask-${++sequence}`,
  })
  const refine = refineReviewCleanupMaskService({ masks, clock: () => new Date('2026-09-01T20:04:00.000Z'), createMaskId: () => `review-mask-${++sequence}` })
  return { rows, create, refine }
}

const actor = authenticatedActor({ workspaceId, clientId: 'client-audit-test', credentialId: 'credential-audit-test', scopes: ['projects:read', 'projects:write'] })
const createRequest = { workspaceId, projectId, annotationId: annotation().id, transformationBriefId: brief().id, format: { outputSpecId: 'output-spec-vertical', width: 540, height: 960 }, trackingConfidenceBps: 9_000, actor, idempotencyKey: 'create-mask-0001' }

test('T-FR-218 application creates and replays the same immutable mask', async () => {
  const subject = fixture()
  const first = await subject.create(createRequest)
  const replay = await subject.create(createRequest)
  assert.equal(first.replayed, false)
  assert.equal(replay.replayed, true)
  assert.equal(replay.persisted.mask.maskHash, first.persisted.mask.maskHash)
  assert.equal(subject.rows.length, 1)
})

test('T-FR-218 application rejects idempotency payload drift', async () => {
  const subject = fixture()
  await subject.create(createRequest)
  await assert.rejects(() => subject.create({ ...createRequest, trackingConfidenceBps: 8_500 }), /idempotency payload changed/)
})

test('T-FR-218 refinement fences stale revisions and persists an append-only successor', async () => {
  const subject = fixture()
  const first = await subject.create(createRequest)
  const prior = first.persisted.mask
  const refined = await subject.refine({
    workspaceId, projectId, maskId: prior.id, expectedMaskHash: prior.maskHash,
    region: prior.region, range: prior.range,
    keyframes: [...prior.keyframes, { frame: 75, region: { x: 0.11, y: 0.77, width: 0.77, height: 0.13 } }],
    trackingStatus: 'tracked', trackingConfidenceBps: 8_500, actor, idempotencyKey: 'refine-mask-0001',
  })
  assert.equal(refined.persisted.mask.revision, 2)
  assert.equal(refined.persisted.mask.supersedesId, prior.id)
  await assert.rejects(() => subject.refine({
    workspaceId, projectId, maskId: prior.id, expectedMaskHash: prior.maskHash, region: prior.region, range: prior.range,
    keyframes: prior.keyframes, trackingStatus: 'tracked', trackingConfidenceBps: 8_000, actor, idempotencyKey: 'refine-mask-0002',
  }), /newer revision/)
})

test('T-FR-218 creation fails closed when review preview is stale', async () => {
  const subject = fixture()
  subject.create = createReviewCleanupMaskService({
    masks: { ...subject, findIdempotent: async () => null },
    annotations: { async readPreviewContext() { return { currentProjectVersionId: 'version-new', projectVersionId: 'version-old', stale: true } } },
    registry: {}, artifacts: {}, clock: () => new Date(), createMaskId: () => 'mask-never-created',
  })
  await assert.rejects(() => subject.create(createRequest), /current review preview/)
})
