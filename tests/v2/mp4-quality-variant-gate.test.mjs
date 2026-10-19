import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { critiqueOutputFormat, selectExportableVariants } from '../../src/v2/domain/format-quality-critic.ts'
import {
  createMp4QualityReport, MP4_PIXEL_CRITIC_POLICY, mp4EvidenceSealMismatches, sealMp4Evidence, verifyMp4QualityReport,
} from '../../src/v2/domain/mp4-pixel-quality.ts'
import { pixelOracleModelPins } from '../../src/v2/domain/pixel-face-oracle.ts'
import { STORY_GOLDEN_FIXTURES } from '../../src/v2/domain/story-plan.ts'

const sha = (character) => character.repeat(64)
const TALL = { sha: sha('a'), canvas: { width: 540, height: 960 }, safe: { top: 0.08, right: 0.06, bottom: 0.06, left: 0.06 }, spec: 'preset-9x16', format: '9:16' }
const WIDE = { sha: sha('b'), canvas: { width: 960, height: 540 }, safe: { top: 0.055, right: 0.05, bottom: 0.06, left: 0.05 }, spec: 'preset-16x9', format: '16:9' }
const element = (elementId, type, frame, bounds) => ({ elementId, type, clipId: 'clip-1', sceneId: 'scene-1', sourceId: 'source-1', frame, bounds, zIndex: 1, opacity: 1, priority: 1 })
const map = (variant) => ({ schemaVersion: 'render-element-map/v1', proxyHash: variant.sha, fps: 30, durationFrames: 60, canvas: variant.canvas, elements: [element('presenter', 'presenter', 30, { x: 50, y: 50, width: 200, height: 300 })] })
const ink = (x0, y0, x1, y1) => ({ pixels: 4000, bbox: { x0, y0, x1, y1 }, touchesCanvasEdge: false })

/** A sealed MP4 report of `variant`'s file; `overFace` frames have caption ink on a face. */
function mp4Report(variant, overFace) {
  const samples = Array.from({ length: 60 }, (_unused, frameIndex) => ({
    sampleId: `s-${variant.format}-${frameIndex}`, frameIndex, ptsTicks: frameIndex * 512, frameSha256: sha('f'),
    caption: frameIndex >= 10 && frameIndex < 30 ? ink(60, 300, 480, 340) : { pixels: 0, bbox: null, touchesCanvasEdge: false }, cta: { pixels: 0, bbox: null, touchesCanvasEdge: false },
    inkDensity: frameIndex >= 10 && frameIndex < 30 ? 0.05 : 0, oracle: { state: 'observed', outputFaceCount: 1, sourceFaceCount: 1 }, registration: null,
    protectedRegions: [{ origin: 'oracle-0204-v9', box: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 }, captionInkPixels: overFace && frameIndex >= 10 && frameIndex < 30 ? 90 : 0, ctaInkPixels: 0 }],
    subject: { state: 'measured', visibleFraction: 1, outputConfirmed: true, projected: { x0: 0.3, y0: 0.3, x1: 0.5, y1: 0.5 } },
  }))
  return createMp4QualityReport({
    identity: { workspaceId: 'workspace-w67', projectId: 'project-w67', projectVersionId: 'version-w67', variantId: `variant-${variant.format.replace(':', 'x')}`, outputSpecId: variant.spec, format: variant.format, operationId: `operation-${variant.format.replace(':', 'x')}`, renderInputHash: sha('c') },
    artifact: { sha256: variant.sha, byteSize: 4096, container: 'mp4', videoCodec: 'h264', pixelFormat: 'yuv420p', ...variant.canvas, frameRate: { num: 30, den: 1 }, timeBase: { num: 1, den: 15360 }, frameCount: 60, durationTicks: 30720 },
    decode: { status: 'complete', framesExpected: 60, framesDecoded: 60, frameListSha256: sha('e'), stderrSha256: sha('d'), ffmpegBinarySha256: null },
    outputSpec: { ...variant.canvas, safeArea: variant.safe }, controls: [], noiseProbe: null,
    oracle: { protocol: 'apollo-pixel-oracle/v1', models: pixelOracleModelPins(), bridgeSha256: sha('1'), pythonSha256: sha('2'), runtime: {}, registration: MP4_PIXEL_CRITIC_POLICY.registration, perSample: [] },
    samples,
  })
}
function variantReport(variant, overFace) {
  const report = mp4Report(variant, overFace)
  verifyMp4QualityReport(report)
  return { report, format: critiqueOutputFormat({ outputSpecId: variant.spec, format: variant.format, proxyHash: variant.sha, map: map(variant), mp4PixelIssues: report.issues, mp4Evidence: sealMp4Evidence(report) }) }
}

test('W67: an MP4 critic failure on 9:16 blocks only 9:16; 16:9 passes only on its own report; the StoryPlan is untouched', () => {
  const storyPlan = STORY_GOLDEN_FIXTURES.linear
  const before = calculateCanonicalHash(storyPlan)
  const tall = variantReport(TALL, true), wide = variantReport(WIDE, false)
  assert.equal(tall.report.verdict, 'blocked')
  assert.equal(wide.report.verdict, 'passed')
  assert.equal(tall.format.status, 'blocked')
  assert.equal(tall.format.exportAllowed, false)
  assert.ok(tall.format.issues.some((issue) => issue.code === 'SUBTITLE_FACE_OVERLAP_IN_PIXELS' && issue.severity === 'hard' && issue.evidenceRange.startFrame === 10 && issue.evidenceRange.endFrame === 30))
  assert.ok(tall.format.issues.every((issue) => issue.evidenceIds.some((id) => id === `mp4-quality-report:${tall.report.reportHash}`)), 'every issue names the sealed report it came from')
  assert.equal(wide.format.status, 'passed')
  assert.equal(wide.format.schemaVersion, 'format-quality-report/v3')
  assert.equal(wide.format.mp4Evidence.reportHash, wide.report.reportHash)
  const selection = selectExportableVariants([tall.format, wide.format])
  assert.deepEqual(selection.approvedOutputSpecIds, ['preset-16x9'])
  assert.deepEqual(selection.blockedOutputSpecIds, ['preset-9x16'])
  assert.equal(calculateCanonicalHash(storyPlan), before, 'the critic never touches the canonical StoryPlan')
})

test('W67: the other variant\'s evidence does not authorize this file, and a hand-edited report cannot allow what its seal forbids', () => {
  const tall = variantReport(TALL, true), wide = variantReport(WIDE, false)
  // 16:9 evidence presented for the 9:16 file
  assert.throws(() => critiqueOutputFormat({ outputSpecId: TALL.spec, format: TALL.format, proxyHash: TALL.sha, map: map(TALL), mp4PixelIssues: [], mp4Evidence: wide.format.mp4Evidence }), /does not belong/)
  // issues without a seal
  assert.throws(() => critiqueOutputFormat({ outputSpecId: TALL.spec, format: TALL.format, proxyHash: TALL.sha, map: map(TALL), mp4PixelIssues: tall.report.issues }), /need the seal/)
  // a blocked seal under a report that allows the export
  const { reportHash: _hash, ...body } = tall.format
  const forged = { ...body, status: 'passed', exportAllowed: true, issues: [], explanation: 'forged' }
  assert.throws(() => selectExportableVariants([{ ...forged, reportHash: calculateCanonicalHash(forged) }]), /disagrees with its MP4 evidence/)
  // a v2 report (no evidence field) is not accepted
  const v2 = { ...body, schemaVersion: 'format-quality-report/v2' }
  delete v2.mp4Evidence
  assert.throws(() => selectExportableVariants([{ ...v2, reportHash: calculateCanonicalHash(v2) }]), /schema is unsupported/)
  assert.deepEqual(mp4EvidenceSealMismatches(tall.format.mp4Evidence, { artifactSha256: tall.report.artifact.sha256, outputSpecId: 'preset-9x16', variantId: 'variant-9x16', operationId: 'operation-9x16' }), [])
  assert.deepEqual(mp4EvidenceSealMismatches(tall.format.mp4Evidence, { artifactSha256: sha('0'), variantId: 'variant-16x9' }).toSorted(), ['ARTIFACT_SHA256', 'VARIANT'])
})

test('W67: a report with no MP4 evidence is still a v3 report, and the evidence seal binds file, input, policy and oracle digests', () => {
  const plain = critiqueOutputFormat({ outputSpecId: WIDE.spec, format: WIDE.format, proxyHash: WIDE.sha, map: map(WIDE) })
  assert.equal(plain.schemaVersion, 'format-quality-report/v3')
  assert.equal(plain.mp4Evidence, null)
  selectExportableVariants([plain])
  const seal = sealMp4Evidence(mp4Report(WIDE, false))
  assert.equal(seal.artifactSha256, WIDE.sha)
  assert.equal(seal.renderInputHash, sha('c'))
  assert.equal(seal.policySha256, calculateCanonicalHash(MP4_PIXEL_CRITIC_POLICY))
  assert.deepEqual(seal.oracleModelDigests.map((model) => [model.id, model.scoreFloor]), [['omz-face-detection-0204-v9', 0.5], ['omz-face-detection-retail-0004', 0.5]])
  assert.equal(seal.sampledFrames, 60)
})
