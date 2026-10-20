import assert from 'node:assert/strict'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'
import { evaluateRenderedProxy } from '../../src/v2/application/render-workflow.ts'
import { hydrateProxyReview } from '../../src/v2/infrastructure/prisma/proxy-review-repository.ts'

test('current public issue contract accepts real critic identity and rejects corrupt identity while V1 stays frozen', () => {
  const issueSchema = (version) => getPublicSchema(`apollo://schemas/project-proxy-review-response/v${version}`)
    .schema.properties.data.properties.review.properties.criticIssues.items
  const validate = new Ajv2020({ strict: false, allErrors: true }).compile(issueSchema(2))
  const issues = JSON.parse(JSON.stringify(verdict({ placementPlanHash: 'b'.repeat(64), reframePlanHash: 'c'.repeat(64) }).criticIssues))
  assert.ok(issues.length)
  for (const issue of issues) {
    assert.equal(validate(issue), true, JSON.stringify(validate.errors))
    for (const field of ['placementPlanHash', 'reframePlanHash']) {
      assert.equal(validate({ ...issue, [field]: null }), true)
      assert.equal(validate({ ...issue, [field]: 'invalid' }), false)
    }
    assert.equal(validate({ ...issue, format: '3:7' }), false)
  }
  for (const field of ['outputSpecId', 'outputPresetHash', 'placementPlanHash', 'reframePlanHash', 'format', 'evidenceRange', 'elementIds', 'evidenceIds']) {
    assert.equal(Object.hasOwn(issueSchema(1).properties, field), false)
  }
})

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

// ---- W67: the seal of the MP4 critic's report travels with the format verdict ----
const { createMp4QualityReport: createHydrationMp4Report, MP4_PIXEL_CRITIC_POLICY: HYDRATION_POLICY, sealMp4Evidence: sealHydrationEvidence } = await import('../../src/v2/domain/mp4-pixel-quality.ts')
const { pixelOracleModelPins: hydrationPins } = await import('../../src/v2/domain/pixel-face-oracle.ts')

function sealedVerdict(overFace) {
  const hash = 'a'.repeat(64)
  const samples = Array.from({ length: 60 }, (_unused, frameIndex) => ({
    sampleId: `hydrate-${frameIndex}`, frameIndex, ptsTicks: frameIndex * 512, frameSha256: 'f'.repeat(64),
    caption: overFace && frameIndex < 4 ? { pixels: 900, bbox: { x0: 60, y0: 300, x1: 480, y1: 340 }, touchesCanvasEdge: false } : { pixels: 0, bbox: null, touchesCanvasEdge: false },
    cta: { pixels: 0, bbox: null, touchesCanvasEdge: false }, inkDensity: 0, oracle: { state: 'observed', outputFaceCount: 1, sourceFaceCount: 1 }, registration: null,
    protectedRegions: [{ origin: 'oracle-0204-v9', box: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 }, captionInkPixels: overFace && frameIndex < 4 ? 40 : 0, ctaInkPixels: 0 }],
    subject: { state: 'measured', visibleFraction: 1, outputConfirmed: true, projected: { x0: 0.3, y0: 0.3, x1: 0.5, y1: 0.5 } },
  }))
  const report = createHydrationMp4Report({
    identity: { workspaceId: 'hydrate-workspace', projectId: 'hydrate-project', projectVersionId: 'hydrate-version', variantId: 'hydrate-variant', outputSpecId: 'preset-9x16', format: '9:16', operationId: 'hydrate-operation', renderInputHash: hash },
    artifact: { sha256: hash, byteSize: 4096, container: 'mp4', videoCodec: 'h264', pixelFormat: 'yuv420p', width: 540, height: 960, frameRate: { num: 30, den: 1 }, timeBase: { num: 1, den: 15360 }, frameCount: 60, durationTicks: 30720 },
    decode: { status: 'complete', framesExpected: 60, framesDecoded: 60, frameListSha256: 'e'.repeat(64), stderrSha256: 'd'.repeat(64), ffmpegBinarySha256: null },
    outputSpec: { width: 540, height: 960, safeArea: { top: 0.08, right: 0.06, bottom: 0.06, left: 0.06 } }, controls: [], noiseProbe: null,
    oracle: { protocol: 'apollo-pixel-oracle/v1', models: hydrationPins(), bridgeSha256: '1'.repeat(64), pythonSha256: '2'.repeat(64), runtime: {}, registration: HYDRATION_POLICY.registration, failures: [], perSample: [] },
    samples,
  })
  const review = evaluateRenderedProxy({ projectVersionId: 'hydrate-version', proxyArtifactId: 'hydrate-artifact', proxyManifestId: 'hydrate-manifest', proxySha256: hash, inputHash: hash,
    format: '9:16', sourceSha256: hash, editPlanHash: hash, expectedDurationMs: 2000, uploadReceivedAt: '2026-10-05T10:00:00.000Z', renderCompletedAt: '2026-10-05T10:00:01.000Z',
    probe: { width: 540, height: 960, duration: 2, fps: 30, codec: 'h264', container: 'mp4' },
    map: { schemaVersion: 'render-element-map/v1', proxyHash: hash, fps: 30, durationFrames: 60, canvas: { width: 540, height: 960 }, elements: [] },
    formatCritic: { outputSpecId: 'preset-9x16', mp4PixelIssues: report.issues, mp4Evidence: sealHydrationEvidence(report) } })
  return { report, review }
}

test('W67 the MP4 evidence seal round-trips through the stored review and a corrupt or foreign seal is refused before it is returned', () => {
  for (const overFace of [false, true]) {
    const { report, review } = sealedVerdict(overFace)
    assert.equal(review.formatQuality.mp4Evidence.reportHash, report.reportHash)
    assert.equal(review.status, overFace ? 'blocked' : 'ready-for-final')
    const persisted = hydrateProxyReview(row(review))
    assert.equal(persisted.reviewHash, review.reviewHash)
    assert.deepEqual(persisted.formatQuality, review.formatQuality)
  }
  const { review } = sealedVerdict(true)
  const corrupt = (mutate) => {
    const stored = row(review)
    const verdict = JSON.parse(stored.formatQualityJson)
    mutate(verdict.mp4Evidence)
    stored.formatQualityJson = JSON.stringify(verdict)
    return stored
  }
  for (const [label, mutate] of [
    ['reportHash not a digest', (seal) => { seal.reportHash = 'invalid' }],
    ['unknown field', (seal) => { seal.extra = true }],
    ['missing field', (seal) => { delete seal.policySha256 }],
    ['oracle digest not a digest', (seal) => { seal.oracleModelDigests[0].xmlSha256 = 'x' }],
    ['no oracle model', (seal) => { seal.oracleModelDigests = [] }],
    ['verdict outside the enum', (seal) => { seal.verdict = 'fine' }],
    ['byte size not an integer', (seal) => { seal.artifactByteSize = 1.5 }],
  ]) assert.throws(() => hydrateProxyReview(corrupt(mutate)), (error) => error.code === 'PERSISTENCE_CONFLICT', label)
  // an altered seal that still parses is another review than the one the row's hash seals
  assert.throws(() => hydrateProxyReview(corrupt((seal) => { seal.sampledFrames = 59 })), (error) => error.code === 'PERSISTENCE_CONFLICT', 'altered but well-formed seal')
})

test('W67 the public review schema v3 publishes the seal, v2 keeps its published shape and refuses it', () => {
  const formatQuality = (version) => getPublicSchema(`apollo://schemas/project-proxy-review-response/v${version}`).schema.properties.data.properties.review.properties.formatQuality
  assert.ok(formatQuality(3).properties.mp4Evidence)
  assert.equal(Object.hasOwn(formatQuality(2).properties, 'mp4Evidence'), false)
  const { review } = sealedVerdict(false)
  const sealed = JSON.parse(JSON.stringify(review.formatQuality))
  const validate = (version) => new Ajv2020({ strict: false, allErrors: true }).compile(formatQuality(version))
  assert.equal(validate(3)(sealed), true, JSON.stringify(validate(3).errors))
  assert.equal(validate(2)(sealed), false, 'v2 consumers never receive a field they did not publish')
  const { mp4Evidence: _seal, placementPlanHash: _placement, reframePlanHash: _reframe, ...without } = sealed
  assert.equal(validate(2)(without), true, 'the five fields v2 always published')
  assert.equal(validate(3)(without), true, 'the seal is optional: a review made without the critic still validates')
  assert.equal(validate(3)(sealed), true, 'and v3 lists the geometry hashes the stored verdict carries')
  assert.equal(validate(3)({ ...sealed, mp4Evidence: { ...sealed.mp4Evidence, verdict: 'fine' } }), false)
})
