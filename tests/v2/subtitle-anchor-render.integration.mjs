import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FfmpegEditorialProxyRenderer } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createColorPipelineCompilation } from '../../src/v2/domain/color-pipeline-compilation.ts'
import { createMediaColorProbe } from '../../src/v2/domain/color-and-export.ts'
import { critiqueOutputFormat } from '../../src/v2/domain/format-quality-critic.ts'
import { readOutputFormatPreset } from '../../src/v2/domain/output-format-registry.ts'
import { createEditorialAudioTimelineHash } from '../../src/v2/domain/production-modes.ts'
import { createRenderPlacementPlan } from '../../src/v2/domain/render-placement-plan.ts'
import { deriveSubtitleRegion } from '../../src/v2/domain/subtitle-region.ts'
import {
  deriveSubtitleAnchorBands,
  SUBTITLE_ANCHOR_PERCEPTION_FIXTURES,
  subtitleAnchorDecisionFor,
} from '../../src/v2/domain/subtitle-anchor-plan.ts'

/**
 * F1.036 / FR-173 visual goldens.
 *
 * Every assertion below is a measurement on the decoded pixels of an MP4 that the real
 * `FfmpegEditorialProxyRenderer` produced from a real `RenderPlacementPlanV1`. Nothing is asserted
 * about the plan alone: the point of this file is that the anchor the plan decided is the row band
 * where the white subtitle glyphs actually land, and that a cue with nowhere safe to go leaves the
 * frame empty instead of covering a face.
 */

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')

const FORMAT = '9:16'
const FPS = 30
const DURATION_FRAMES = 90
const SOURCE_WIDTH = 640
const SOURCE_HEIGHT = 360
const preset = readOutputFormatPreset(FORMAT)
const CANVAS = Object.freeze({ width: preset.exportDefaults.proxy.width, height: preset.exportDefaults.proxy.height })
const region = deriveSubtitleRegion({ spec: preset.spec, presetId: 'kinetic' })
const BANDS = deriveSubtitleAnchorBands({ region, safeArea: preset.spec.safeArea })

const colorMetadata = Object.freeze({
  colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709',
  range: 'limited', bitDepth: 8,
})

function colorCompilation(artifactId) {
  const manifestId = `manifest-${artifactId}`
  const probe = createMediaColorProbe({
    id: `probe-${artifactId}`, workspaceId: 'workspace-subtitle-anchor', artifactId, manifestId,
    detection: { state: 'ready', metadata: colorMetadata, pixelFormat: 'yuv420p', hdrMode: 'sdr' },
    producer: { provider: 'ffprobe', version: 'json-v1', binaryDigest: '9'.repeat(64) },
    createdAt: '2026-08-21T08:00:00.000Z',
  })
  const implementation = (provider, parameters) => ({
    provider, version: 'v1', parameters, parametersHash: calculateCanonicalHash(parameters),
  })
  return createColorPipelineCompilation({
    id: `compilation-${artifactId}`, workspaceId: probe.workspaceId,
    projectId: 'project-subtitle-anchor', sourceArtifactId: artifactId, sourceManifestId: manifestId,
    probe, outputMetadata: colorMetadata, createdByClientId: 'client-subtitle-anchor',
    createdAt: '2026-08-21T08:01:00.000Z',
    stages: [
      { id: 'technical-rec709', kind: 'technical', version: 'v1', enabled: true, input: colorMetadata, output: colorMetadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
      { id: 'match-bypass', kind: 'match', version: 'v1', enabled: false, input: colorMetadata, output: colorMetadata, implementation: implementation('apollo-match', { mode: 'bypass' }) },
      { id: 'creative-none', kind: 'creative-lut', version: 'v1', enabled: false, input: colorMetadata, output: colorMetadata, implementation: implementation('apollo-lut', { mode: 'none' }) },
      { id: 'output-rec709', kind: 'output', version: 'v1', enabled: true, input: colorMetadata, output: colorMetadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
    ],
  })
}

/** Raw RGB24 bytes of one exact frame index — no seeking, no interpolation. */
const frameBytes = (path, frame) => execFileSync(ffmpegPath, [
  '-hide_banner', '-loglevel', 'error', '-i', path,
  '-vf', `select=eq(n\\,${frame})`, '-vsync', '0', '-frames:v', '1',
  '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 })

/** The subtitle glyphs are the only near-white pixels: the source is a flat dark grey. */
const isGlyph = (r, g, b) => r > 200 && g > 200 && b > 200

/** Rows that carry subtitle glyphs, plus how many glyph pixels each row has. */
function glyphRows(raw) {
  const rows = []
  for (let y = 0; y < CANVAS.height; y += 1) {
    let count = 0
    for (let x = 0; x < CANVAS.width; x += 1) {
      const offset = (y * CANVAS.width + x) * 3
      if (isGlyph(raw[offset], raw[offset + 1], raw[offset + 2])) count += 1
    }
    if (count > 0) rows.push({ y, count })
  }
  return rows
}

/** Weighted centre row of the glyphs, or NaN when nothing was drawn. */
function glyphCentreRow(raw) {
  const rows = glyphRows(raw)
  if (rows.length === 0) return Number.NaN
  const total = rows.reduce((sum, row) => sum + row.count, 0)
  return rows.reduce((sum, row) => sum + row.y * row.count, 0) / total
}

const bandPixels = (band) => Object.freeze({
  top: Math.round(band.y * CANVAS.height),
  bottom: Math.round((band.y + band.height) * CANVAS.height),
  centre: Math.round((band.y + band.height / 2) * CANVAS.height),
})

async function fixture(name) {
  const root = await mkdtemp(join(tmpdir(), `apollo-subtitle-anchor-${name}-`))
  const sourcePath = join(root, 'source.mp4')
  execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=0x141414:s=${SOURCE_WIDTH}x${SOURCE_HEIGHT}:r=${FPS}:d=4`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
    '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000', sourcePath,
  ], { windowsHide: true, timeout: 180_000 })
  const clips = [Object.freeze({
    id: 'clip-anchor-1', sourceArtifactId: 'artifact-anchor-source',
    sourceInFrame: 0, sourceOutFrame: DURATION_FRAMES,
    timelineInFrame: 0, timelineOutFrame: DURATION_FRAMES, rate: 1,
  })]
  return {
    root, sourcePath, clips,
    audioTimelineHash: createEditorialAudioTimelineHash({ fps: FPS, clips }),
    sources: [{
      artifactId: 'artifact-anchor-source', path: sourcePath, mediaType: 'video',
      colorPipelineCompilation: colorCompilation('artifact-anchor-source'),
    }],
    renderer: new FfmpegEditorialProxyRenderer({ workRoot: join(root, 'work'), ffmpegPath }),
  }
}

const cue = (id, startFrame, endFrame, text) => ({ id, startFrame, endFrame, text, anchor: 'bottom' })

function planWith(perceptionTimeline, cues, elements = []) {
  return createRenderPlacementPlan({
    format: FORMAT, canvas: CANVAS, durationFrames: DURATION_FRAMES,
    subtitlePresetId: 'kinetic', elements,
    subtitleAnchor: {
      fps: FPS,
      cues: cues.map((item) => ({ id: item.id, startFrame: item.startFrame, endFrame: item.endFrame })),
      perceptionTimeline,
    },
  })
}

async function renderWith(context, plan, cues) {
  return context.renderer.render({
    operationId: `render-anchor-${plan.subtitleAnchorPlan.anchorPlanHash.slice(0, 12)}`,
    renderKind: 'proxy', sources: context.sources, lutPaths: {}, clips: context.clips,
    audioTimelineHash: context.audioTimelineHash, fps: FPS, format: FORMAT,
    subtitleCues: cues, placementPlan: plan,
  })
}

/** The map the renderer produced must describe the same rectangle the plan decided. */
function assertMapMatchesBand(map, cueId, band) {
  const element = map.elements.find((item) => item.elementId === `subtitle:${cueId}`)
  if (band === null) {
    assert.equal(element, undefined, `suppressed cue ${cueId} must not appear in the RenderElementMap`)
    return
  }
  assert.ok(element, `cue ${cueId} must appear in the RenderElementMap`)
  assert.equal(element.bounds.y, Math.round(band.y * CANVAS.height))
  assert.equal(element.bounds.height, Math.round(band.height * CANVAS.height))
}

test('T-FR-173 golden 1: a low face pushes the burned subtitle out of the bottom bands', { timeout: 10 * 60_000 }, async () => {
  const context = await fixture('lower-face')
  try {
    const cues = [cue('cue-1', 6, 60, 'Legenda acima do rosto')]
    const plan = planWith(SUBTITLE_ANCHOR_PERCEPTION_FIXTURES.lowerFace, cues)
    const decision = subtitleAnchorDecisionFor(plan.subtitleAnchorPlan, 'cue-1')
    assert.equal(decision.anchor, 'upper-third')
    const rendered = await renderWith(context, plan, cues)

    const band = bandPixels(BANDS['upper-third'])
    const face = SUBTITLE_ANCHOR_PERCEPTION_FIXTURES.lowerFace.observations[0].value.bounds
    const faceTopPx = Math.round(face.y * CANVAS.height)
    const raw = frameBytes(rendered.outputPath, 20)
    const rows = glyphRows(raw)
    const centre = glyphCentreRow(raw)
    console.log(`T-FR-173/1 glyph rows ${rows[0].y}..${rows.at(-1).y}, centre ${centre.toFixed(1)}; band ${band.top}..${band.bottom} (centre ${band.centre}); face starts at y=${faceTopPx}`)
    assert.ok(rows.length > 0, 'the cue must be burned into the frame')
    // Measured glyphs sit inside the decided band, and the band is not where the face is.
    assert.ok(Math.abs(centre - band.centre) <= 12, `glyph centre ${centre.toFixed(1)} must track band centre ${band.centre}`)
    assert.ok(rows[0].y >= band.top - 8 && rows.at(-1).y <= band.bottom + 8, 'every glyph row must lie inside the decided band')
    assert.ok(rows.at(-1).y < faceTopPx, 'no glyph may reach the face region')
    assertMapMatchesBand(rendered.renderElementMap, 'cue-1', BANDS['upper-third'])
  } finally {
    await rm(context.root, { recursive: true, force: true })
  }
})

test('T-FR-173 golden 2: a full-screen OCR surface leaves no free band and is recorded, not hidden', { timeout: 10 * 60_000 }, async () => {
  const context = await fixture('full-screen')
  try {
    const cues = [cue('cue-1', 6, 60, 'Tela cheia de texto')]
    const plan = planWith(SUBTITLE_ANCHOR_PERCEPTION_FIXTURES.fullScreenOcr, cues)
    const decision = subtitleAnchorDecisionFor(plan.subtitleAnchorPlan, 'cue-1')
    assert.deepEqual(decision.eligibleAnchors, [])
    assert.equal(decision.anchor, 'bottom')
    const rendered = await renderWith(context, plan, cues)

    const band = bandPixels(BANDS.bottom)
    const centre = glyphCentreRow(frameBytes(rendered.outputPath, 20))
    console.log(`T-FR-173/2 glyph centre ${centre.toFixed(1)}; fallback band centre ${band.centre}; issues ${plan.subtitleAnchorPlan.issues.map((issue) => issue.code).join(',')}`)
    assert.ok(Math.abs(centre - band.centre) <= 12, 'the fallback band is where the pixels are')
    assertMapMatchesBand(rendered.renderElementMap, 'cue-1', BANDS.bottom)

    // The variant report carries the reason code, so the operator does not have to spot it by eye.
    const report = critiqueOutputFormat({
      outputSpecId: preset.spec.id, format: FORMAT, proxyHash: rendered.sha256,
      map: rendered.renderElementMap, placementPlanHash: plan.placementPlanHash,
      subtitleAnchorPlan: plan.subtitleAnchorPlan,
    })
    assert.equal(report.status, 'warning')
    assert.equal(report.exportAllowed, true)
    assert.ok(report.issues.some((issue) => issue.code === 'SUBTITLE_ANCHOR_FALLBACK' && issue.elementIds.includes('subtitle:cue-1')))
  } finally {
    await rm(context.root, { recursive: true, force: true })
  }
})

test('T-FR-173 golden 3: face, insert and the solved CTA together move the subtitle off all three', { timeout: 10 * 60_000 }, async () => {
  const context = await fixture('multiple-overlays')
  try {
    const cues = [cue('cue-1', 6, 60, 'Entre os overlays')]
    const plan = planWith(SUBTITLE_ANCHOR_PERCEPTION_FIXTURES.multipleOverlays, cues, [{
      id: 'cta-hero', kind: 'cta', anchor: 'auto', priority: 80, readingOrder: 0,
      minWidth: 0.5, maxWidth: 0.9, minHeight: 0.2, maxHeight: 0.5,
      timeRange: { startFrame: 0, endFrame: DURATION_FRAMES },
    }])
    const decision = subtitleAnchorDecisionFor(plan.subtitleAnchorPlan, 'cue-1')
    const cta = plan.placements.find((placement) => placement.elementId === 'cta-hero')
    assert.ok(decision.blockerIds.includes('face-upper') && decision.blockerIds.includes('insert-middle') && decision.blockerIds.includes('cta-hero'))
    // Exactly one band survives all three, so the golden below measures a genuine choice.
    assert.deepEqual(decision.eligibleAnchors, ['lower-third'])
    assert.equal(decision.anchor, 'lower-third')
    const rendered = await renderWith(context, plan, cues)

    const band = bandPixels(decision.bounds)
    const raw = frameBytes(rendered.outputPath, 20)
    const rows = glyphRows(raw)
    const centre = glyphCentreRow(raw)
    const blockers = [
      ['face-upper', SUBTITLE_ANCHOR_PERCEPTION_FIXTURES.multipleOverlays.observations.find((item) => item.id === 'face-upper').value.bounds],
      ['insert-middle', SUBTITLE_ANCHOR_PERCEPTION_FIXTURES.multipleOverlays.observations.find((item) => item.id === 'insert-middle').value.bounds],
      ['cta-hero', cta.bounds],
    ]
    console.log(`T-FR-173/3 anchor=${decision.anchor} glyph rows ${rows[0].y}..${rows.at(-1).y} (centre ${centre.toFixed(1)}); band ${band.top}..${band.bottom}`)
    assert.ok(Math.abs(centre - band.centre) <= 12, 'glyphs sit on the decided band')
    for (const [id, bounds] of blockers) {
      const blockerTop = Math.round(bounds.y * CANVAS.height)
      const blockerBottom = Math.round((bounds.y + bounds.height) * CANVAS.height)
      for (const row of rows) {
        assert.ok(row.y < blockerTop || row.y >= blockerBottom, `glyph row ${row.y} must stay off ${id} (${blockerTop}..${blockerBottom})`)
      }
    }
    assertMapMatchesBand(rendered.renderElementMap, 'cue-1', decision.bounds)
  } finally {
    await rm(context.root, { recursive: true, force: true })
  }
})

test('T-FR-173 golden 4: adjacent cues hold one band across a flicker in the evidence', { timeout: 10 * 60_000 }, async () => {
  const context = await fixture('stability')
  try {
    const cues = [
      cue('cue-1', 6, 30, 'Primeira fala'),
      cue('cue-2', 30, 36, 'Segunda fala'),
      cue('cue-3', 36, 84, 'Terceira fala'),
    ]
    const plan = planWith(SUBTITLE_ANCHOR_PERCEPTION_FIXTURES.flickeringFace, cues)
    assert.deepEqual(plan.subtitleAnchorPlan.decisions.map((item) => item.anchor), ['upper-third', 'upper-third', 'upper-third'])
    const rendered = await renderWith(context, plan, cues)

    // One frame inside each cue. If the solver had chased the flicker, the middle sample would
    // have jumped hundreds of rows down into the bottom band and back.
    const centres = [12, 32, 60].map((frame) => glyphCentreRow(frameBytes(rendered.outputPath, frame)))
    const band = bandPixels(BANDS['upper-third'])
    console.log(`T-FR-173/4 glyph centres ${centres.map((value) => value.toFixed(1)).join(' / ')}; band centre ${band.centre}; bottom band centre ${bandPixels(BANDS.bottom).centre}`)
    for (const centre of centres) {
      assert.ok(Number.isFinite(centre), 'each cue must be burned in')
      assert.ok(Math.abs(centre - band.centre) <= 12, `glyph centre ${centre.toFixed(1)} must stay on the held band`)
    }
    const spread = Math.max(...centres) - Math.min(...centres)
    assert.ok(spread <= 12, `the subtitle must not jump between adjacent cues, measured spread ${spread.toFixed(1)}px`)
    for (const item of cues) assertMapMatchesBand(rendered.renderElementMap, item.id, BANDS['upper-third'])
  } finally {
    await rm(context.root, { recursive: true, force: true })
  }
})

test('T-FR-173 golden 5: with no safe region the cue is absent from the pixels and blocks the variant', { timeout: 10 * 60_000 }, async () => {
  const context = await fixture('no-safe-region')
  try {
    const cues = [cue('cue-1', 6, 60, 'Nunca sobre o rosto')]
    const plan = planWith(SUBTITLE_ANCHOR_PERCEPTION_FIXTURES.noSafeRegion, cues)
    const decision = subtitleAnchorDecisionFor(plan.subtitleAnchorPlan, 'cue-1')
    assert.equal(decision.suppressed, true)
    const rendered = await renderWith(context, plan, cues)

    // The decisive measurement: the frame carries no glyph at all, anywhere.
    const rows = glyphRows(frameBytes(rendered.outputPath, 20))
    console.log(`T-FR-173/5 glyph rows in frame 20: ${rows.length}; issues ${plan.subtitleAnchorPlan.issues.map((issue) => issue.code).join(',')}`)
    assert.equal(rows.length, 0, 'a suppressed cue must not be painted over the face')
    assertMapMatchesBand(rendered.renderElementMap, 'cue-1', null)

    const report = critiqueOutputFormat({
      outputSpecId: preset.spec.id, format: FORMAT, proxyHash: rendered.sha256,
      map: rendered.renderElementMap, placementPlanHash: plan.placementPlanHash,
      subtitleAnchorPlan: plan.subtitleAnchorPlan,
    })
    assert.equal(report.status, 'blocked')
    assert.equal(report.exportAllowed, false)
    const issue = report.issues.find((item) => item.code === 'NO_SAFE_SUBTITLE_REGION')
    assert.ok(issue, 'the variant report must carry the localized reason code')
    assert.deepEqual(issue.evidenceRange, { startFrame: 6, endFrame: 60 })
    assert.ok(issue.evidenceIds.includes('face-fullscreen'))
    assert.ok(issue.evidenceIds.includes(`subtitle-anchor-plan:${plan.subtitleAnchorPlan.anchorPlanHash}`))
  } finally {
    await rm(context.root, { recursive: true, force: true })
  }
})
