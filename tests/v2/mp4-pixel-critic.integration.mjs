import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import sharp from 'sharp'

import { FORMATS, faceRectOf } from './w67/corpus-geometry.mjs'
import {
  criticRequest, DEFECT_TABLE, encodeSource, labelsOf, outputSpecOf, planOutput, presetBands, renderOutput, createRenderer, TIMELINE, VARIANT_DEFECTS,
} from './w67/render-world.mjs'

const { FfmpegMp4PixelCritic } = await import('../../src/v2/infrastructure/media/ffmpeg-mp4-pixel-critic.ts')
const { PIXEL_ORACLE_MODELS, decodeV9Output } = await import('../../src/v2/domain/pixel-face-oracle.ts')
const { sealMp4Evidence, verifyMp4QualityReport } = await import('../../src/v2/domain/mp4-pixel-quality.ts')
const { critiqueOutputFormat, selectExportableVariants } = await import('../../src/v2/domain/format-quality-critic.ts')
const { mp4ExportGate } = await import('../../src/v2/domain/mp4-export-gate.ts')

/**
 * W67 critic, plumbing proof on synthetic pixels and the REAL renderer, in both canvases.
 *
 * The source is a procedurally textured video (it has features to register) with a magenta rectangle standing in for the face; the human
 * box is that rectangle. The ORACLE here is a colour-key stand-in (and the registration of the source onto the output is the exact
 * transform of the crop window the test itself chose): this suite proves that the critic's decoding, control lockstep, ink, overlap,
 * safe-area, subject and sealing arithmetic land on the right frames of a real encode. It does not prove the detectors or the feature
 * registration: those are measured by the controlled corpus on real photographs (docs/quality/w67-mp4-critic-preregistration-v1.md).
 */
const require = createRequire(import.meta.url)
const ffmpegPath = process.env.FFMPEG_BIN ?? require('ffmpeg-static')
const SOURCE = Object.freeze({ width: 1024, height: 768 })
const MARKER = Object.freeze({ x: 0.46, y: 0.34, width: 0.1, height: 0.16 })
const FACE = Object.freeze(faceRectOf({ XMin: MARKER.x, YMin: MARKER.y, XMax: MARKER.x + MARKER.width, YMax: MARKER.y + MARKER.height }))
const isMarker = (r, g, b) => r > 170 && b > 170 && g < 100

let root, sourcePath, sourceSha256, renderer, bands
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'apollo-w67-'))
  const px = (value, total) => Math.round(value * total)
  const encoded = encodeSource({
    ffmpegPath, outPath: join(root, 'source.mp4'),
    lavfiVideo: `mandelbrot=size=${SOURCE.width}x${SOURCE.height}:rate=30:end_scale=3,drawbox=x=${px(MARKER.x, SOURCE.width)}:y=${px(MARKER.y, SOURCE.height)}:w=${px(MARKER.width, SOURCE.width)}:h=${px(MARKER.height, SOURCE.height)}:color=0xff00ff:t=fill`,
  })
  sourcePath = encoded.path; sourceSha256 = encoded.sha256
  renderer = createRenderer({ workRoot: join(root, 'work'), ffmpegPath })
  bands = {}
  for (const format of Object.keys(FORMATS)) bands[format] = await presetBands(format, SOURCE)
})
after(async () => { if (root) await rm(root, { recursive: true, force: true }) })

/** The colour-key oracle: the marker is the face; the registration is the crop window's own transform (a stand-in for feature matching). */
function stubOracle(spec) {
  const canvas = FORMATS[spec.format]
  return {
    models: [{ id: PIXEL_ORACLE_MODELS.v9.id }, { id: PIXEL_ORACLE_MODELS.retail.id }],
    async analyze({ framesDirectory, frames, pairs }) {
      const results = []
      for (const frame of frames) {
        const { data, info } = await sharp(join(framesDirectory, frame.file)).raw().toBuffer({ resolveWithObject: true })
        let minX = info.width, minY = info.height, maxX = -1, maxY = -1, count = 0
        for (let y = 0; y < info.height; y += 1) for (let x = 0; x < info.width; x += 1) {
          const o = (y * info.width + x) * info.channels
          if (!isMarker(data[o], data[o + 1], data[o + 2])) continue
          count += 1; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y
        }
        const boxes = count >= 30 ? [{ box: { x: minX / info.width, y: minY / info.height, width: (maxX - minX + 1) / info.width, height: (maxY - minY + 1) / info.height }, confidence: 0.99, clipped: false }] : []
        results.push({ id: frame.id, sha256: 'f'.repeat(64), status: 'ok', reason: null, width: info.width, height: info.height, readings: [
          { modelId: PIXEL_ORACLE_MODELS.v9.id, status: 'observed', boxes, rawOutputSha256: '1'.repeat(64) },
          { modelId: PIXEL_ORACLE_MODELS.retail.id, status: 'observed', boxes: [], rawOutputSha256: '2'.repeat(64) },
        ] })
      }
      const registrations = pairs.map((pair) => {
        const frame = Number(pair.outputId.slice(2))
        const window = frame < 45 ? spec.windowA : spec.windowB
        const scale = canvas.width / (window.width * SOURCE.width)
        return { id: pair.id, sourceId: pair.sourceId, outputId: pair.outputId, status: 'ok', reason: null, matches: 200, inliers: 160,
          matrix: [[scale, 0, -window.x * SOURCE.width * scale], [0, scale, -window.y * SOURCE.height * scale]], medianResidualPixels: 0.4, scale, rotationDegrees: 0 }
      })
      return { receipt: { protocol: 'apollo-pixel-oracle/v1', bridgeSha256: 'b'.repeat(64), pythonSha256: 'c'.repeat(64), runtime: { stub: 'colour-key' } }, frames: results, registrations }
    },
  }
}

async function runOutput(format, variant) {
  const spec = outputSpecOf({ imageId: 'synthetic', format, variant, face: FACE, source: SOURCE, bands: bands[format] })
  const planned = await planOutput(spec, bands[format])
  const render = (kind) => renderOutput({ renderer, spec, planned, sourcePath, kind })
  const delivered = await render('delivered')
  const critic = new FfmpegMp4PixelCritic({ oracle: stubOracle(spec), workRoot: join(root, 'critic'), ffmpegPath })
  const verification = await critic.verify(criticRequest({
    spec, deliveredPath: delivered.outputPath, sourcePath, sourceSha256, renderInputHash: 'd'.repeat(64),
    renderControl: async (kind) => ({ path: (await render(kind)).outputPath }),
  }))
  return { spec, planned, delivered, verification }
}

const hardRanges = (verification, codes) => [...new Set(verification.issues.filter((issue) => issue.severity === 'hard' && codes.includes(issue.code))
  .map((issue) => `${issue.evidenceRange.startFrame}-${issue.evidenceRange.endFrame}`))].map((text) => text.split('-').map(Number))

for (const [format, variants] of [['9:16', ['clean', 'caption', 'crop', 'cta', 'combined']], ['16:9', ['clean', 'combined']]]) {
  for (const variant of variants) {
    test(`W67 critic ${format} ${variant}: the delivered MP4 is read frame by frame and agrees with the seeded labels`, { timeout: 10 * 60_000 }, async () => {
      const { spec, planned, delivered, verification } = await runOutput(format, variant)
      const { report } = verification
      verifyMp4QualityReport(report)
      assert.equal(report.decode.status, 'complete')
      assert.equal(report.artifact.frameCount, TIMELINE.durationFrames)
      assert.equal(report.artifact.sha256, delivered.sha256)
      assert.equal(report.sampling.strategy, 'all-frames')
      assert.equal(report.samples.length, TIMELINE.durationFrames)
      assert.deepEqual(report.controls.map((control) => control.kind), ['captions-off', 'cta-off', 'overlays-off'])
      assert.ok(report.samples.every((sample) => /^[a-f0-9]{16}:f\d+:t\d+:[a-f0-9]{16}$/.test(sample.sampleId)))
      // the planner put the caption where the spec said it would (the label of the seeded defect rests on it)
      assert.equal(planned.decision.disposition, 'placed')
      if (spec.defects.includes('caption-over-face')) assert.equal(planned.decision.anchor, spec.framing.target, 'phantom evidence sends the cue to the target band')
      else assert.ok(!spec.framing.intersecting.includes(planned.decision.anchor), `with the face reported the cue avoids the bands the face touches (${planned.decision.anchor})`)
      // every seeded defect is found on exactly its interval; nothing else is a hard issue
      const labelled = labelsOf(spec)
      for (const label of labelled) {
        assert.deepEqual(hardRanges(verification, label.codes), [[label.startFrame, label.endFrame]], `${label.defect} found on ${label.startFrame}-${label.endFrame}`)
      }
      const allLabelledCodes = new Set(labelled.flatMap((label) => label.codes))
      assert.deepEqual(verification.issues.filter((issue) => issue.severity === 'hard' && !allLabelledCodes.has(issue.code)), [], 'no unlabelled hard issue')
      assert.equal(report.verdict, labelled.length === 0 ? 'passed' : 'blocked', JSON.stringify(verification.issues.map((issue) => [issue.code, issue.severity, issue.evidenceRange])))
      assert.equal(report.exportAllowed, labelled.length === 0)
      assert.ok(report.noiseProbe, 'the noise floor between a delivered encode and its control is measured')
      // W67 fail-closed gate: this stand-in oracle read every frame, so the final gate has nothing to block on (no false block)
      assert.deepEqual(mp4ExportGate({ report }).blockers, [], 'the final gate does not block a report whose oracle ran on every frame')
      // every projected region says which detector produced the source face it projects (the stand-in's only reader is the V9 slot)
      const projected = report.samples.flatMap((sample) => sample.facts.protectedRegions).filter((region) => region.origin === 'source-projection')
      assert.ok(projected.length > 0, 'the registered projection of the source face protects some frames')
      for (const region of projected) assert.deepEqual(region.sourceModels, ['oracle-0204-v9'])
    })
  }
}

test('W67 critic: a blocked 9:16 never blocks 16:9, and a blocked variant is not exportable', { timeout: 10 * 60_000 }, async () => {
  const wide = await runOutput('16:9', 'clean')
  const tall = await runOutput('9:16', 'combined')
  assert.equal(wide.verification.report.verdict, 'passed')
  assert.equal(tall.verification.report.verdict, 'blocked')
  const formatReport = (run) => critiqueOutputFormat({
    outputSpecId: run.verification.report.identity.outputSpecId, format: run.spec.format, proxyHash: run.delivered.sha256, map: run.delivered.renderElementMap,
    placementPlanHash: run.planned.placementPlan.placementPlanHash, reframePlanHash: run.planned.reframePlan.reframePlanHash,
    mp4PixelIssues: run.verification.issues, mp4Evidence: sealMp4Evidence(run.verification.report),
  })
  const selection = selectExportableVariants([formatReport(wide), formatReport(tall)])
  assert.deepEqual(selection.approvedOutputSpecIds, ['preset-16x9'])
  assert.deepEqual(selection.blockedOutputSpecIds, ['preset-9x16'])
  const blockingCodes = selection.decisions.find((decision) => decision.outputSpecId === 'preset-9x16').blockingCodes
  for (const code of ['SUBTITLE_FACE_OVERLAP_IN_PIXELS', 'SUBJECT_CLIPPED_IN_PIXELS', 'INK_OUTSIDE_SAFE_AREA_IN_PIXELS']) assert.ok(blockingCodes.includes(code), code)
})

test('W67 critic: the stand-in oracle is the only thing between this suite and a vacuous pass - a blind oracle leaves the face checks unknown, not safe', { timeout: 10 * 60_000 }, async () => {
  const spec = outputSpecOf({ imageId: 'synthetic', format: '9:16', variant: 'caption', face: FACE, source: SOURCE, bands: bands['9:16'] })
  const planned = await planOutput(spec, bands['9:16'])
  const render = (kind) => renderOutput({ renderer, spec, planned, sourcePath, kind })
  const delivered = await render('delivered')
  const blind = { models: [], async analyze({ frames }) {
    return { receipt: { protocol: 'apollo-pixel-oracle/v1', bridgeSha256: 'b'.repeat(64), pythonSha256: 'c'.repeat(64), runtime: {} },
      frames: frames.map((frame) => ({ id: frame.id, sha256: 'f'.repeat(64), status: 'error', reason: 'BLIND', width: null, height: null, readings: [] })), registrations: [] }
  } }
  const critic = new FfmpegMp4PixelCritic({ oracle: blind, workRoot: join(root, 'critic-blind'), ffmpegPath })
  const verification = await critic.verify(criticRequest({ spec, deliveredPath: delivered.outputPath, sourcePath, sourceSha256, renderInputHash: 'd'.repeat(64),
    renderControl: async (kind) => ({ path: (await render(kind)).outputPath }) }))
  assert.equal(verification.report.verdict, 'warning', 'unknown is a warning, never a pass')
  assert.equal(hardRanges(verification, DEFECT_TABLE['caption-over-face'].codes).length, 0, 'it cannot see the face, so it cannot fail it either')
  assert.ok(verification.report.unknowns.length > 0)
  assert.ok(verification.report.checks.captionFaceOverlap.unknown > 0 && verification.report.checks.captionFaceOverlap.pass === 0)
  assert.ok(VARIANT_DEFECTS.caption.length === 1)
})

test('W67 critic: a long output is sampled by stride plus the edges that matter, and the gaps are named - the defect is still found on its edges', { timeout: 10 * 60_000 }, async () => {
  const spec = outputSpecOf({ imageId: 'synthetic', format: '9:16', variant: 'caption', face: FACE, source: SOURCE, bands: bands['9:16'] })
  const planned = await planOutput(spec, bands['9:16'])
  const render = (kind) => renderOutput({ renderer, spec, planned, sourcePath, kind })
  const delivered = await render('delivered')
  const critic = new FfmpegMp4PixelCritic({ oracle: stubOracle(spec), workRoot: join(root, 'critic-stride'), ffmpegPath, sampling: { allFramesUpTo: 20, strideFrames: 7 } })
  const verification = await critic.verify(criticRequest({ spec, deliveredPath: delivered.outputPath, sourcePath, sourceSha256, renderInputHash: 'd'.repeat(64),
    renderControl: async (kind) => ({ path: (await render(kind)).outputPath }) }))
  const { report } = verification
  verifyMp4QualityReport(report)
  assert.equal(report.sampling.strategy, 'stride-with-edges')
  assert.deepEqual(report.sampling.policy, { allFramesUpTo: 20, strideFrames: 7 })
  const frames = report.samples.map((sample) => sample.frameIndex)
  for (const expected of [0, 7, 14, 21, 28, 44, 45, 89, 8, 27]) assert.ok(frames.includes(expected), `frame ${expected} is measured`)
  assert.ok(!frames.includes(9) && !frames.includes(20), 'frames between the stride samples and the edges are not')
  assert.ok(report.sampling.gaps.length > 0)
  assert.ok(verification.issues.some((issue) => issue.code === 'MP4_PIXEL_COVERAGE_PARTIAL' && issue.severity === 'warning'), 'the unmeasured stretches are reported, never interpolated into a pass')
  const flagged = new Set(verification.issues.filter((issue) => issue.severity === 'hard' && issue.code === 'SUBTITLE_FACE_OVERLAP_IN_PIXELS')
    .flatMap((issue) => Array.from({ length: issue.evidenceRange.endFrame - issue.evidenceRange.startFrame }, (_unused, index) => issue.evidenceRange.startFrame + index)))
  assert.deepEqual([...flagged].toSorted((a, b) => a - b), [8, 14, 21, 27], 'the first and last frame of the cue are checked, and nothing outside the cue is flagged')
  assert.equal(report.verdict, 'blocked')
})
