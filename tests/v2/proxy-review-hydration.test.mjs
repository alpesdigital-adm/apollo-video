import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateRenderedProxy } from '../../src/v2/application/render-workflow.ts'
import { hydrateProxyReview } from '../../src/v2/infrastructure/prisma/proxy-review-repository.ts'

function verdict(geometry = {}) {
  const hash = 'a'.repeat(64)
  return evaluateRenderedProxy({ projectVersionId: 'hydrate-version', proxyArtifactId: 'hydrate-artifact',
    proxyManifestId: 'hydrate-manifest', proxySha256: hash, inputHash: hash, format: '9:16', sourceSha256: hash,
    editPlanHash: hash, expectedDurationMs: 2000, uploadReceivedAt: '2026-10-05T10:00:00.000Z',
    renderCompletedAt: '2026-10-05T10:00:01.000Z',
    probe: { width: 540, height: 960, duration: 2, fps: 30, codec: 'h264', container: 'mp4' },
    map: { schemaVersion: 'render-element-map/v1', proxyHash: hash, fps: 30, durationFrames: 60,
      canvas: { width: 540, height: 960 }, elements: [{ elementId: 'hydrate-subtitle', type: 'subtitle',
        clipId: 'hydrate-clip', sceneId: 'hydrate-scene', sourceId: 'hydrate-source', frame: 30,
        bounds: { x: 100, y: 100, width: 300, height: 200 }, zIndex: 10, opacity: 1, priority: 1 }] },
    formatCritic: { outputSpecId: 'preset-9x16', ...geometry,
      subjects: [{ id: 'hydrate-face', startFrame: 0, endFrame: 60,
        bounds: { x: .2, y: .1, width: .5, height: .3 }, critical: true }] },
  })
}
function row(review) {
  return { ...review, id: 'hydrate-review', workspaceId: 'hydrate-workspace', projectId: 'hydrate-project',
    operationId: 'hydrate-operation', specJson: JSON.stringify(review.spec),
    technicalIssuesJson: JSON.stringify(review.technicalIssues), criticIssuesJson: JSON.stringify(review.criticIssues),
    formatQualityJson: JSON.stringify(review.formatQuality), timeToFirstProxyMs: BigInt(review.timeToFirstProxyMs),
    uploadReceivedAt: new Date(review.uploadReceivedAt), renderCompletedAt: new Date(review.renderCompletedAt),
    createdAt: new Date(review.renderCompletedAt), updatedAt: new Date(review.renderCompletedAt), revision: 1 }
}
test('format critic geometry and per-output hash round-trip through proxy review hydration', () => {
  for (const geometry of [{}, { placementPlanHash: 'b'.repeat(64), reframePlanHash: 'c'.repeat(64) }]) {
    const review = verdict(geometry)
    assert.ok(review.criticIssues.some((issue) => issue.outputPresetHash), 'actual format critic generated a bounded issue')
    const persisted = hydrateProxyReview(row(review))
    assert.equal(persisted.reviewHash, review.reviewHash)
    assert.deepEqual(persisted.criticIssues, JSON.parse(JSON.stringify(review.criticIssues)))
    assert.deepEqual(persisted.formatQuality, review.formatQuality)
  }
})
test('invalid or altered geometry hashes fail before returning a proxy review', () => {
  for (const key of ['outputPresetHash', 'placementPlanHash', 'reframePlanHash']) {
    const review = verdict({ placementPlanHash: 'b'.repeat(64), reframePlanHash: 'c'.repeat(64) })
    const corrupted = row(review)
    const issues = JSON.parse(corrupted.criticIssuesJson)
    for (const replacement of ['invalid', 'd'.repeat(64)]) {
      issues[0][key] = replacement
      corrupted.criticIssuesJson = JSON.stringify(issues)
      assert.throws(() => hydrateProxyReview(corrupted), (error) => error.code === 'PERSISTENCE_CONFLICT')
    }
  }
})
test('unsupported or altered format cannot replace the critic output identity', () => {
  const review = verdict()
  for (const format of ['3:7', '16:9']) {
    const corrupted = row(review)
    const issues = JSON.parse(corrupted.criticIssuesJson)
    issues[0].format = format
    corrupted.criticIssuesJson = JSON.stringify(issues)
    assert.throws(() => hydrateProxyReview(corrupted), (error) => error.code === 'PERSISTENCE_CONFLICT')
  }
})
