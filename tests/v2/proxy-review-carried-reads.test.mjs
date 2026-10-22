import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateRenderedProxy } from '../../src/v2/application/render-workflow.ts'
import { createApiAccessAuditContext } from '../../src/v2/domain/api-access-control.ts'
import { PrismaProxyReviewRepository } from '../../src/v2/infrastructure/prisma/proxy-review-repository.ts'

/**
 * W70 readiness follow-up. The stored row of a carried review names the AUTOMATIC CARRY as its acknowledger (never the person who
 * acknowledged the source review), the read path publishes it as stored, the person is read from the source review, and the replay of an
 * acknowledgement after a unique-key conflict goes through the same read as every other path (it carries `carriedFrom` too).
 */
const workspaceId = 'carried-workspace'
const projectId = 'carried-project'
const person = Object.freeze({ type: 'api-client', id: 'client-who-acknowledged', at: new Date('2026-10-20T10:00:00.000Z') })
const hash = 'a'.repeat(64)

function review() {
  return evaluateRenderedProxy({ projectVersionId: 'carried-version', proxyArtifactId: 'carried-artifact',
    proxyManifestId: 'carried-manifest', proxySha256: hash, inputHash: hash, format: '9:16', sourceSha256: hash,
    editPlanHash: hash, expectedDurationMs: 2000, uploadReceivedAt: '2026-10-05T10:00:00.000Z',
    renderCompletedAt: '2026-10-05T10:00:01.000Z', warningsAcknowledged: true,
    probe: { width: 540, height: 960, duration: 2, fps: 30, codec: 'h264', container: 'mp4' },
    map: { schemaVersion: 'render-element-map/v1', proxyHash: hash, fps: 30, durationFrames: 60,
      canvas: { width: 540, height: 960 }, elements: [{ elementId: 'carried-subtitle', type: 'subtitle',
        clipId: 'carried-clip', sceneId: 'carried-scene', sourceId: 'carried-source', frame: 30,
        bounds: { x: 100, y: 100, width: 300, height: 200 }, zIndex: 10, opacity: 1, priority: 1 }] },
    formatCritic: { outputSpecId: 'preset-9x16' },
  })
}
function reviewRow(id, ack, patch = {}) {
  const value = review()
  return { ...value, id, workspaceId, projectId, operationId: `operation-${id}`, specJson: JSON.stringify(value.spec),
    technicalIssuesJson: JSON.stringify(value.technicalIssues), criticIssuesJson: JSON.stringify(value.criticIssues),
    formatQualityJson: value.formatQuality ? JSON.stringify(value.formatQuality) : null, timeToFirstProxyMs: BigInt(value.timeToFirstProxyMs),
    uploadReceivedAt: new Date(value.uploadReceivedAt), renderCompletedAt: new Date(value.renderCompletedAt),
    createdAt: new Date(value.renderCompletedAt), updatedAt: new Date(value.renderCompletedAt), revision: 2,
    acknowledgedByType: ack.type, acknowledgedById: ack.id, acknowledgedAt: ack.at, ...patch }
}
const audit = createApiAccessAuditContext({ clientId: 'client-owner', credentialId: 'credential-owner', workspaceId, environment: 'sandbox', authenticationKind: 'bearer' })
const decisionRow = (id, proxyReviewId, action, createdAt, patch = {}) => ({
  id, workspaceId, projectId, proxyReviewId, action, actorType: 'api-client', actorId: audit.clientId, actorCredentialId: audit.credentialId,
  actorEnvironment: audit.environment, actorAuthenticationKind: audit.authenticationKind, actorContextHash: audit.contextHash,
  delegatedUserId: null, delegatedIdentityId: null, workspaceRole: null, baseReviewHash: hash, resultReviewHash: hash,
  idempotencyKey: `key-${id}`, requestFingerprint: 'f'.repeat(64), createdAt, ...patch,
})

const T1 = new Date('2026-10-21T10:00:00.000Z')
const T2 = new Date('2026-10-21T11:00:00.000Z')
function world(overrides = {}) {
  const reviews = new Map([
    // the review a person acknowledged on its own Version
    ['review-source', reviewRow('review-source', person)],
    // carried from it: the row names the automatic carry (its decision and the time of it), never the person
    ['review-carried-1', reviewRow('review-carried-1', { type: 'automatic-carry', id: 'decision-carry-1', at: T1 })],
    // and carried again from that one
    ['review-carried-2', reviewRow('review-carried-2', { type: 'automatic-carry', id: 'decision-carry-2', at: T2 })],
  ])
  for (const [id, patch] of Object.entries(overrides.reviews ?? {})) reviews.set(id, { ...reviews.get(id), ...patch })
  const operations = new Map([
    ['operation-review-source', { carriedFromReviewId: null, carriedFromReviewHash: null, reuseBaseVersionId: null, renderContentHash: null }],
    ['operation-review-carried-1', { carriedFromReviewId: 'review-source', carriedFromReviewHash: hash, reuseBaseVersionId: 'version-source', renderContentHash: 'd'.repeat(64) }],
    ['operation-review-carried-2', { carriedFromReviewId: 'review-carried-1', carriedFromReviewHash: hash, reuseBaseVersionId: 'version-carried-1', renderContentHash: 'd'.repeat(64) }],
  ])
  const decisions = [
    decisionRow('decision-carry-1', 'review-carried-1', 'carry-over-approval', T1),
    decisionRow('decision-carry-2', 'review-carried-2', 'carry-over-approval', T2),
    decisionRow('decision-replay', 'review-carried-1', 'acknowledge-warnings', T2, { idempotencyKey: 'replayed-key', requestFingerprint: 'e'.repeat(64) }),
    decisionRow('decision-replay-2', 'review-carried-2', 'acknowledge-warnings', T2, { idempotencyKey: 'replayed-key-2', requestFingerprint: 'e'.repeat(64) }),
  ]
  const client = {
    v2ProxyReview: {
      findFirst: async ({ where }) => reviews.get(where.id) ?? null,
      findUnique: async ({ where }) => reviews.get(where.id) ?? null,
    },
    v2ProjectProxyRenderOperation: { findFirst: async ({ where }) => operations.get(where.operationId) ?? null },
    v2ProxyReviewDecision: {
      findFirst: async ({ where }) => decisions.find((row) => row.proxyReviewId === where.proxyReviewId && row.action === where.action) ?? null,
      findUnique: async ({ where }) => decisions.find((row) => row.idempotencyKey === where.workspaceId_projectId_idempotencyKey.idempotencyKey) ?? null,
    },
  }
  return { client, reviews }
}

test('a carried review is read as stored: the automatic carry is its acknowledger and the person is read from the source review', async () => {
  const { client, reviews } = world()
  const repository = new PrismaProxyReviewRepository(client)
  // the stored rows do not name the person (the carried ones), and the read path does not rewrite them
  for (const id of ['review-carried-1', 'review-carried-2']) {
    assert.equal(reviews.get(id).acknowledgedByType, 'automatic-carry')
    assert.notEqual(reviews.get(id).acknowledgedById, person.id)
  }
  const replay = await repository.findDecisionReplay({ workspaceId, projectId, idempotencyKey: 'replayed-key', requestFingerprint: 'e'.repeat(64), authenticationAudit: audit })
  assert.equal(replay.replayed, true)
  assert.deepEqual(replay.review.acknowledgedBy, { type: 'automatic-carry', id: 'decision-carry-1', at: T1.toISOString() })
  assert.deepEqual(replay.review.carriedFrom, {
    versionId: 'version-source', reviewId: 'review-source', reviewHash: hash, decisionId: 'decision-carry-1', renderContentHash: 'd'.repeat(64),
    acknowledgedBy: { type: 'api-client', id: person.id, at: person.at.toISOString() },
  }, 'the replay of an acknowledgement says it was carried, like every other read of the review')
  // a review carried from a carried review still names the person who acknowledged the review the chain started from
  const chainedReplay = await repository.findDecisionReplay({ workspaceId, projectId, idempotencyKey: 'replayed-key-2', requestFingerprint: 'e'.repeat(64), authenticationAudit: audit })
  const chained = chainedReplay.review
  assert.deepEqual(chained.acknowledgedBy, { type: 'automatic-carry', id: 'decision-carry-2', at: T2.toISOString() })
  assert.equal(chained.carriedFrom.reviewId, 'review-carried-1')
  assert.deepEqual(chained.carriedFrom.acknowledgedBy, { type: 'api-client', id: person.id, at: person.at.toISOString() })
})

test('a carried review whose row does not name its automatic carry is refused, never rewritten', async () => {
  for (const patch of [
    { acknowledgedByType: 'api-client', acknowledgedById: person.id, acknowledgedAt: person.at },
    { acknowledgedById: 'decision-other' },
    { acknowledgedAt: person.at },
  ]) {
    const { client } = world({ reviews: { 'review-carried-1': patch } })
    const repository = new PrismaProxyReviewRepository(client)
    await assert.rejects(
      repository.findDecisionReplay({ workspaceId, projectId, idempotencyKey: 'replayed-key', requestFingerprint: 'e'.repeat(64), authenticationAudit: audit }),
      (error) => error.code === 'PERSISTENCE_CONFLICT' && /automatic carry/.test(error.message),
    )
  }
})
