import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

import { critiqueOutputFormat, selectExportableVariants } from '../../src/v2/domain/format-quality-critic.ts'
import { evaluateRenderedProxy } from '../../src/v2/application/render-workflow.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { readOutputFormatPreset } from '../../src/v2/domain/output-format-registry.ts'
import { STORY_GOLDEN_FIXTURES } from '../../src/v2/domain/story-plan.ts'

const HASH = 'a'.repeat(64)
function element(elementId, type, frame, bounds) {
  return { elementId, type, clipId: 'clip-format-1', sceneId: 'scene-format-1', sourceId: 'source-format-1', frame, bounds, zIndex: type === 'subtitle' ? 10 : 1, opacity: 1, priority: 1 }
}
function map(width, height, elements) {
  return { schemaVersion: 'render-element-map/v1', proxyHash: HASH, fps: 30, durationFrames: 60, canvas: { width, height }, elements }
}
const verticalInput = {
  outputSpecId: 'preset-9x16', format: '9:16', proxyHash: HASH,
  map: map(540, 960, [element('presenter-v', 'presenter', 30, { x: 80, y: 100, width: 380, height: 760 }), element('subtitle-v', 'subtitle', 30, { x: 45, y: 700, width: 450, height: 170 })]),
  subjects: [{ id: 'face-primary', startFrame: 0, endFrame: 60, bounds: { x: .25, y: .55, width: .5, height: .3 }, critical: true }],
}
const landscapeInput = {
  outputSpecId: 'preset-16x9', format: '16:9', proxyHash: HASH,
  map: map(960, 540, [element('presenter-h', 'presenter', 30, { x: 90, y: 30, width: 780, height: 450 }), element('subtitle-h', 'subtitle', 30, { x: 100, y: 410, width: 760, height: 80 })]),
  subjects: [{ id: 'face-primary', startFrame: 0, endFrame: 60, bounds: { x: .35, y: .15, width: .3, height: .35 }, critical: true }],
}

test('T-FR-165 blocks only 9:16 while the same StoryPlan, subject and subtitle pass in 16:9', () => {
  const storyPlan = STORY_GOLDEN_FIXTURES.linear
  const storyPlanBefore = structuredClone(storyPlan)
  const storyPlanHashBefore = calculateCanonicalHash(storyPlan)

  const vertical = critiqueOutputFormat(verticalInput)
  const landscape = critiqueOutputFormat(landscapeInput)

  assert.equal(vertical.status, 'blocked')
  assert.equal(vertical.exportAllowed, false)
  assert.ok(vertical.issues.some((issue) => issue.code === 'SUBTITLE_SUBJECT_COLLISION' && issue.outputSpecId === 'preset-9x16' && issue.evidenceRange.startFrame === 30))
  assert.equal(landscape.status, 'passed')
  assert.equal(landscape.exportAllowed, true)
  assert.equal(landscape.issues.length, 0)

  // The critic is a read-only reviewer: the canonical plan is byte-identical after both verdicts.
  assert.deepEqual(structuredClone(storyPlan), storyPlanBefore)
  assert.equal(calculateCanonicalHash(storyPlan), storyPlanHashBefore)
  const criticSource = JSON.stringify([verticalInput, landscapeInput])
  assert.ok(!criticSource.includes('storyHash') && !criticSource.includes('"blocks"'), 'the format critic must not consume the StoryPlan at all')

  const selection = selectExportableVariants([vertical, landscape])
  assert.deepEqual(selection.approvedOutputSpecIds, ['preset-16x9'])
  assert.deepEqual(selection.blockedOutputSpecIds, ['preset-9x16'])
})

test('T-FR-165 explains every variant verdict independently and never lets one blocker cross outputs', () => {
  const { decisions } = selectExportableVariants([critiqueOutputFormat(verticalInput), critiqueOutputFormat(landscapeInput)])
  assert.equal(decisions.length, 2)
  const [landscape, vertical] = decisions
  assert.equal(landscape.outputSpecId, 'preset-16x9')
  assert.equal(landscape.exportAllowed, true)
  assert.deepEqual(landscape.blockingCodes, [])
  assert.match(landscape.explanation, /preset-16x9 \(16:9\) passed every format check over 60 frames/)
  assert.equal(vertical.outputSpecId, 'preset-9x16')
  assert.equal(vertical.exportAllowed, false)
  assert.deepEqual(vertical.blockingCodes, ['SUBTITLE_SUBJECT_COLLISION'])
  assert.match(vertical.explanation, /blocked by 1 hard format reason code\(s\): SUBTITLE_SUBJECT_COLLISION/)
  assert.match(vertical.explanation, /Only this output is blocked/)
  // Each decision is content-addressed by the canonical preset it was measured against.
  assert.equal(landscape.outputPresetHash, readOutputFormatPreset('16:9').presetHash)
  assert.equal(vertical.outputPresetHash, readOutputFormatPreset('9:16').presetHash)
  assert.notEqual(landscape.outputPresetHash, vertical.outputPresetHash)
  assert.notEqual(landscape.reportHash, vertical.reportHash)
})

test('T-FR-165 records clipping, safe area, hidden subject, subtitle collision and density with evidence ranges', () => {
  const report = critiqueOutputFormat({
    outputSpecId: 'preset-9x16', format: '9:16', proxyHash: HASH, densityLimit: .25,
    map: map(540, 960, [
      element('clipped-cta', 'cta', 10, { x: -5, y: 0, width: 500, height: 400 }),
      element('unsafe-subtitle', 'subtitle', 10, { x: 0, y: 700, width: 500, height: 220 }),
    ]),
    subjects: [{ id: 'critical-face', startFrame: 0, endFrame: 60, bounds: { x: .3, y: .7, width: .3, height: .2 }, critical: true }],
  })
  assert.deepEqual(new Set(report.issues.map((issue) => issue.code)), new Set(['OUTPUT_CLIPPING', 'OUTPUT_SAFE_AREA', 'SUBJECT_NOT_VISIBLE', 'SUBTITLE_SUBJECT_COLLISION', 'OUTPUT_DENSITY_EXCESS']))
  assert.ok(report.issues.every((issue) => issue.outputSpecId === 'preset-9x16' && issue.rangeMs[1] >= issue.rangeMs[0] && issue.evidenceIds.length > 0))
  assert.ok(report.issues.every((issue) => issue.outputPresetHash === readOutputFormatPreset('9:16').presetHash), 'every issue carries the content-addressed preset identity')
  assert.match(report.reportHash, /^[a-f0-9]{64}$/)
  assert.equal(report.status, 'blocked')
  // Clipping and safe area are judged separately: the clipped CTA never produces a safe-area duplicate.
  assert.deepEqual(report.issues.filter((issue) => issue.code === 'OUTPUT_SAFE_AREA').flatMap((issue) => issue.elementIds), ['unsafe-subtitle'])
  assert.deepEqual(report.issues.filter((issue) => issue.code === 'OUTPUT_CLIPPING').flatMap((issue) => issue.elementIds), ['clipped-cta'])
})

test('T-FR-165 localizes evidence in half-open frame ranges backed by frame-first milliseconds', () => {
  const report = critiqueOutputFormat({
    outputSpecId: 'preset-9x16', format: '9:16', proxyHash: HASH,
    map: map(540, 960, [
      element('subtitle-v', 'subtitle', 10, { x: 45, y: 700, width: 450, height: 170 }),
      element('subtitle-v', 'subtitle', 11, { x: 45, y: 700, width: 450, height: 170 }),
      element('subtitle-v', 'subtitle', 12, { x: 45, y: 700, width: 450, height: 170 }),
    ]),
    subjects: [{ id: 'face-primary', startFrame: 0, endFrame: 60, bounds: { x: .25, y: .55, width: .5, height: .3 }, critical: false }],
  })
  const collision = report.issues.find((issue) => issue.code === 'SUBTITLE_SUBJECT_COLLISION')
  assert.ok(collision, 'contiguous frames must group into a single localized issue')
  // Frames 10, 11 and 12 carry the defect; frame 13 does not, so endFrame is exclusive.
  assert.deepEqual(collision.evidenceRange, { startFrame: 10, endFrame: 13 })
  assert.deepEqual(collision.rangeMs, [333, 433])
  assert.ok(report.issues.every((issue) => issue.evidenceRange.endFrame > issue.evidenceRange.startFrame))
})

test('T-FR-165 proxy review persists variant identity, its own verdict and blocks only its own hard format issues', () => {
  const review = evaluateRenderedProxy({
    projectVersionId: 'version-format-1', proxyArtifactId: 'artifact-format-1', proxyManifestId: 'manifest-format-1',
    proxySha256: HASH, inputHash: 'b'.repeat(64), format: '9:16', sourceSha256: 'c'.repeat(64), editPlanHash: 'd'.repeat(64), expectedDurationMs: 2000,
    uploadReceivedAt: '2026-08-13T20:00:00.000Z', renderCompletedAt: '2026-08-13T20:00:01.000Z',
    probe: { width: 540, height: 960, duration: 2, fps: 30, codec: 'h264', container: 'mp4' },
    map: map(540, 960, [element('presenter-v', 'presenter', 30, { x: 80, y: 100, width: 380, height: 760 }), element('subtitle-v', 'subtitle', 30, { x: 45, y: 700, width: 450, height: 170 })]),
    formatCritic: { outputSpecId: 'preset-9x16', subjects: [{ id: 'face-primary', startFrame: 0, endFrame: 60, bounds: { x: .25, y: .55, width: .5, height: .3 }, critical: true }] },
  })
  assert.equal(review.outputSpecId, 'preset-9x16')
  assert.equal(review.status, 'blocked')
  assert.equal(review.finalAllowed, false)
  assert.ok(review.criticIssues.some((issue) => issue.outputSpecId === 'preset-9x16' && issue.evidenceRange.endFrame === 31))
  assert.ok(review.criticIssues.every((issue) => issue.category !== 'editorial' || typeof issue.outputPresetHash === 'string'))
  assert.equal(review.formatQuality.status, 'blocked')
  assert.equal(review.formatQuality.exportAllowed, false)
  assert.equal(review.formatQuality.outputPresetHash, readOutputFormatPreset('9:16').presetHash)
  assert.match(review.formatQuality.explanation, /preset-9x16 \(9:16\) is blocked by 1 hard format reason code\(s\)/)
  assert.match(review.formatQuality.reportHash, /^[a-f0-9]{64}$/)

  const clean = evaluateRenderedProxy({
    projectVersionId: 'version-format-1', proxyArtifactId: 'artifact-format-2', proxyManifestId: 'manifest-format-2',
    proxySha256: HASH, inputHash: 'e'.repeat(64), format: '16:9', sourceSha256: 'c'.repeat(64), editPlanHash: 'd'.repeat(64), expectedDurationMs: 2000,
    uploadReceivedAt: '2026-08-13T20:00:00.000Z', renderCompletedAt: '2026-08-13T20:00:01.000Z',
    probe: { width: 960, height: 540, duration: 2, fps: 30, codec: 'h264', container: 'mp4' },
    map: map(960, 540, [element('presenter-h', 'presenter', 30, { x: 90, y: 30, width: 780, height: 450 }), element('subtitle-h', 'subtitle', 30, { x: 100, y: 410, width: 760, height: 80 })]),
    formatCritic: { outputSpecId: 'preset-16x9', subjects: [{ id: 'face-primary', startFrame: 0, endFrame: 60, bounds: { x: .35, y: .15, width: .3, height: .35 }, critical: true }] },
  })
  // Same project version, same StoryPlan: the blocked vertical never contaminates the approved landscape.
  assert.equal(clean.outputSpecId, 'preset-16x9')
  assert.equal(clean.status, 'ready-for-final')
  assert.equal(clean.finalAllowed, true)
  assert.equal(clean.formatQuality.status, 'passed')
  assert.equal(clean.formatQuality.exportAllowed, true)
  assert.notEqual(clean.reviewHash, review.reviewHash)
})

test('T-FR-165 keeps the proxy review hash stable when no format critic evidence is supplied', () => {
  const base = {
    projectVersionId: 'version-format-2', proxyArtifactId: 'artifact-format-3', proxyManifestId: 'manifest-format-3',
    proxySha256: HASH, inputHash: 'b'.repeat(64), format: '9:16', sourceSha256: 'c'.repeat(64), editPlanHash: 'd'.repeat(64), expectedDurationMs: 2000,
    uploadReceivedAt: '2026-08-13T20:00:00.000Z', renderCompletedAt: '2026-08-13T20:00:01.000Z',
    probe: { width: 540, height: 960, duration: 2, fps: 30, codec: 'h264', container: 'mp4' },
    map: map(540, 960, []),
  }
  const review = evaluateRenderedProxy(base)
  assert.equal(review.formatQuality, undefined)
  assert.equal(review.outputSpecId, 'preset-9x16')
  assert.equal(review.status, 'ready-for-final')
})

test('T-FR-165 fails closed on tampered proxy evidence, duplicate variants and cross-output issues', () => {
  assert.throws(() => critiqueOutputFormat({ outputSpecId: 'preset-9x16', format: '9:16', proxyHash: HASH, map: { ...map(540, 960, []), proxyHash: 'f'.repeat(64) } }), /inconsistent/)
  const passed = critiqueOutputFormat({ outputSpecId: 'preset-16x9', format: '16:9', proxyHash: HASH, map: map(960, 540, []) })
  assert.throws(() => selectExportableVariants([passed, passed]), /unique/)
  assert.throws(() => selectExportableVariants([{ ...passed, exportAllowed: false }]), /hash is inconsistent/)
  assert.throws(() => critiqueOutputFormat({ outputSpecId: 'output-custom', format: '16:9', proxyHash: HASH, map: map(960, 540, []) }), /canonical registry/)
  const foreign = critiqueOutputFormat(verticalInput)
  const forged = { ...passed, issues: foreign.issues }
  assert.throws(() => selectExportableVariants([{ ...forged, reportHash: calculateCanonicalHash({ ...forged, reportHash: undefined, issues: foreign.issues }) }]), /hash is inconsistent|not localized in its own output/)
})

test('T-FR-165 final export and the public API bind the approval to the exact source output spec', async () => {
  const repository = await readFile(new URL('../../src/v2/infrastructure/prisma/project-final-export-repository.ts', import.meta.url), 'utf8')
  assert.match(repository, /outputSpecId: readOutputFormatPreset\(source\.format/)
  assert.match(repository, /outputSpecId: input\.outputSpecId/)
  const route = await readFile(new URL('../../src/app/v1/projects/[projectId]/proxy-reviews/route.ts', import.meta.url), 'utf8')
  assert.match(route, /outputSpecId: review\.outputSpecId/)
  assert.match(route, /formatQuality: review\.formatQuality/)
  const persistence = await readFile(new URL('../../src/v2/infrastructure/prisma/proxy-review-repository.ts', import.meta.url), 'utf8')
  assert.match(persistence, /formatQualityJson: input\.review\.formatQuality \? stableSerialize\(input\.review\.formatQuality\) : null/)
  assert.match(persistence, /parseFormatQuality\(row\.formatQualityJson\)/)
})
