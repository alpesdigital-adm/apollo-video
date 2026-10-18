import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { planCaptionPlacement } from '../../src/v2/application/plan-caption-placement.ts'
import { clipForegroundOnCanvas, sourceRectCanvasSegments } from '../../src/v2/domain/caption-canvas-projection.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createColorPipelineCompilation } from '../../src/v2/domain/color-pipeline-compilation.ts'
import { createMediaColorProbe } from '../../src/v2/domain/color-and-export.ts'
import { readOutputFormatPreset } from '../../src/v2/domain/output-format-registry.ts'
import { createEditorialAudioTimelineHash } from '../../src/v2/domain/production-modes.ts'
import { subtitleAnchorDecisionFor } from '../../src/v2/domain/subtitle-anchor-plan.ts'
import { FfmpegCaptionPixelCritic } from '../../src/v2/infrastructure/media/ffmpeg-caption-pixel-critic.ts'
import { FfmpegEditorialProxyRenderer } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'
import { sealedSourceWindow } from './helpers/face-source-envelope-v3.mjs'

/**
 * W65 pixel proofs, on the real renderer and real FFmpeg, in both canvases.
 *
 * The master is a flat grey picture with a GREEN frame around it and a MAGENTA rectangle - the stand-in for a face - at a known
 * place. The face evidence the planner reads is fabricated (real V9 tensors from the shared helper) from that rectangle's source
 * coordinates. The pixel oracle is code of its own: it finds the picture by its green frame, the stand-in face by its colour
 * INSIDE that frame (the blurred copy that fills the rest of the canvas is not a face), and the caption by its near-white
 * glyphs, all on the delivered or the caption-free frame. So the projection, the band decision and the renderer are checked
 * against where things really ended up, independently of the clearance pipeline that decided them.
 */
const require = createRequire(import.meta.url)
const ffmpegPath = process.env.FFMPEG_BIN ?? require('ffmpeg-static')

const FPS = 30
const FRAMES = 90
const CUE = Object.freeze({ id: 'cue-1', startFrame: 20, endFrame: 60, text: 'LEGENDA DE TESTE', anchor: 'bottom' })
const PRESET_ID = 'kinetic'
const TOLERANCE_PX = 8
const FRAME = 40

const colorMetadata = Object.freeze({ colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709', range: 'limited', bitDepth: 8 })
function colorCompilation(artifactId) {
  const manifestId = `manifest-${artifactId}`
  const probe = createMediaColorProbe({ id: `probe-${artifactId}`, workspaceId: 'workspace-w65-pixels', artifactId, manifestId,
    detection: { state: 'ready', metadata: colorMetadata, pixelFormat: 'yuv420p', hdrMode: 'sdr' },
    producer: { provider: 'ffprobe', version: 'json-v1', binaryDigest: '9'.repeat(64) }, createdAt: '2026-08-21T08:00:00.000Z' })
  const implementation = (provider, parameters) => ({ provider, version: 'v1', parameters, parametersHash: calculateCanonicalHash(parameters) })
  return createColorPipelineCompilation({ id: `compilation-${artifactId}`, workspaceId: probe.workspaceId, projectId: 'project-w65-pixels',
    sourceArtifactId: artifactId, sourceManifestId: manifestId, probe, outputMetadata: colorMetadata, createdByClientId: 'client-w65-pixels',
    createdAt: '2026-08-21T08:01:00.000Z',
    stages: [
      { id: 'technical-rec709', kind: 'technical', version: 'v1', enabled: true, input: colorMetadata, output: colorMetadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
      { id: 'match-bypass', kind: 'match', version: 'v1', enabled: false, input: colorMetadata, output: colorMetadata, implementation: implementation('apollo-match', { mode: 'bypass' }) },
      { id: 'creative-none', kind: 'creative-lut', version: 'v1', enabled: false, input: colorMetadata, output: colorMetadata, implementation: implementation('apollo-lut', { mode: 'none' }) },
      { id: 'output-rec709', kind: 'output', version: 'v1', enabled: true, input: colorMetadata, output: colorMetadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
    ] })
}

// ---- the oracle: code of its own, no import from the critic ---------------------------------------------------------------
const rawFrame = (path, frame, width, height) => {
  const bytes = execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', path, '-vf', `select=eq(n\\,${frame})`, '-fps_mode', 'passthrough',
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  assert.equal(bytes.byteLength, width * height * 3, `frame ${frame} of ${path} decoded`)
  return bytes
}
function boxOf(raw, width, height, predicate, within = null) {
  const from = within ?? { left: 0, top: 0, right: width, bottom: height }
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0
  for (let y = Math.max(0, Math.floor(from.top)); y < Math.min(height, Math.ceil(from.bottom)); y += 1) {
    for (let x = Math.max(0, Math.floor(from.left)); x < Math.min(width, Math.ceil(from.right)); x += 1) {
      const o = (y * width + x) * 3
      if (!predicate(raw[o], raw[o + 1], raw[o + 2])) continue
      count += 1; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y
    }
  }
  return count < 40 ? null : { left: minX, top: minY, right: maxX + 1, bottom: maxY + 1, count }
}
const isGlyph = (r, g, b) => r > 215 && g > 215 && b > 215
const isMarker = (r, g, b) => r > 170 && b > 170 && g < 100
const isFrameGreen = (r, g, b) => g > 190 && r < 80 && b < 80
const isLogo = (r, g, b) => r > 220 && g > 170 && g < 230 && b < 80
const intersects = (a, b) => a !== null && b !== null && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
const px = (bounds, canvas) => ({ left: bounds.x * canvas.width, top: bounds.y * canvas.height, right: (bounds.x + bounds.width) * canvas.width, bottom: (bounds.y + bounds.height) * canvas.height })
const within = (inner, outer, slack) => inner.left >= outer.left - slack && inner.right <= outer.right + slack && inner.top >= outer.top - slack && inner.bottom <= outer.bottom + slack
const close = (a, b, slack) => Math.abs(a.left - b.left) <= slack && Math.abs(a.right - b.right) <= slack && Math.abs(a.top - b.top) <= slack && Math.abs(a.bottom - b.bottom) <= slack

/** The tests-only veto detector: it finds the stand-in face by colour on the caption-free frame, inside the picture's green frame. */
const markerVeto = {
  id: 'color-key-marker',
  async detect({ width, height, rgb }) {
    const picture = boxOf(rgb, width, height, isFrameGreen)
    const box = picture ? boxOf(rgb, width, height, isMarker, picture) : null
    return box ? [{ x: box.left / width, y: box.top / height, width: (box.right - box.left) / width, height: (box.bottom - box.top) / height }] : []
  },
}

async function world(name, { format, master, marker, composition, evidence, veto = true, logo = false }) {
  const root = await mkdtemp(join(tmpdir(), `apollo-w65-${name}-`))
  const preset = readOutputFormatPreset(format)
  const canvas = { width: preset.exportDefaults.proxy.width, height: preset.exportDefaults.proxy.height }
  const sourcePath = join(root, 'master.mp4')
  execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=0x303030:s=${master.width}x${master.height}:r=${FPS}:d=3`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
    '-vf', `drawbox=x=0:y=0:w=iw:h=ih:color=0x00ff00:t=6,drawbox=x=${marker.x}:y=${marker.y}:w=${marker.w}:h=${marker.h}:color=0xff00ff:t=fill`,
    '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', sourcePath], { windowsHide: true, timeout: 180_000 })
  const clip = Object.freeze({ id: 'clip-1', sourceArtifactId: 'source-1', sourceInFrame: 0, sourceOutFrame: FRAMES, timelineInFrame: 0, timelineOutFrame: FRAMES, rate: 1 })
  const faceRow = [0.9, marker.x / master.width, marker.y / master.height, (marker.x + marker.w) / master.width, (marker.y + marker.h) / master.height]
  const envelope = evidence === 'marker' || evidence === 'clean'
    ? sealedSourceWindow({ start: 0, end: FRAMES, rowsAt: () => [evidence === 'marker' ? faceRow : [0.9, 0, 0, 0.02, 0.02]] })
    : evidence === 'everywhere'
      ? sealedSourceWindow({ start: 0, end: FRAMES, rowsAt: () => [[0.9, 0, 0, 1, 1]] })
      : null
  const reader = { async listSourceWindows() { return envelope ? [{ envelope }] : [] } }
  let placementAssets, placementElements = []
  if (logo) {
    const logoPath = join(root, 'logo.png')
    execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xffcc00:s=160x100', '-frames:v', '1', logoPath], { windowsHide: true })
    const sha256 = createHash('sha256').update(await readFile(logoPath)).digest('hex')
    placementElements = [{ id: 'logo-1', kind: 'logo', anchor: 'top-right', priority: 90, readingOrder: 0, minWidth: 0.1, maxWidth: 0.14, minHeight: 0.08, maxHeight: 0.14,
      timeRange: { startFrame: 0, endFrame: FRAMES }, assetArtifactId: 'artifact-logo-1', assetSha256: sha256 }]
    placementAssets = [{ elementId: 'logo-1', path: logoPath, sha256 }]
  }
  const planned = await planCaptionPlacement({ faceEvidence: reader, clock: () => new Date('2026-10-18T12:00:00.000Z') }, {
    workspaceId: 'workspace-1', projectId: 'project-1', format, canvas,
    editPlan: { fps: FPS, durationFrames: FRAMES, videoTracks: [{ kind: 'base-video', clips: [clip] }] }, clips: [clip], ...(composition ? { composition } : {}),
    renderSources: [{ artifactId: 'source-1', sha256: 'b'.repeat(64), mediaType: 'video', probe: { width: master.width, height: master.height } }],
    subtitleCues: [{ id: CUE.id, startFrame: CUE.startFrame, endFrame: CUE.endFrame }], subtitlePresetId: PRESET_ID,
    placementElements, primarySourceArtifactId: 'source-1' })
  const renderer = new FfmpegEditorialProxyRenderer({ workRoot: join(root, 'work'), ffmpegPath })
  const base = {
    renderKind: 'proxy', sources: [{ artifactId: 'source-1', path: sourcePath, mediaType: 'video', colorPipelineCompilation: colorCompilation('source-1') }],
    lutPaths: {}, clips: [clip], audioTimelineHash: createEditorialAudioTimelineHash({ fps: FPS, clips: [clip] }), fps: FPS, format,
    ...(composition ? { composition } : {}), placementPlan: planned.placementPlan, ...(placementAssets ? { placementAssets } : {}),
  }
  const render = (suffix, cues) => renderer.render({ ...base, operationId: `${name}-${suffix}`, subtitleCues: cues })
  return { root, canvas, master, marker, planned, plan: planned.placementPlan, base, render,
    decision: subtitleAnchorDecisionFor(planned.placementPlan.subtitleAnchorPlan, CUE.id),
    critic: new FfmpegCaptionPixelCritic({ ffmpegPath, ...(veto ? { faceVeto: markerVeto } : {}) }) }
}

/** Renders the delivered MP4 and its caption-free control, runs the production critic, and measures with the oracle. */
async function run(w) {
  const delivered = await w.render('delivered', [{ ...CUE }])
  let control
  const verification = await w.critic.verify({ plan: w.plan, deliveredPath: delivered.outputPath,
    renderControl: async () => { control = await w.render('control', []); return { path: control.outputPath } } })
  const { width, height } = w.canvas
  const controlRaw = rawFrame(control.outputPath, FRAME, width, height)
  const picture = boxOf(controlRaw, width, height, isFrameGreen)
  const marker = picture ? boxOf(controlRaw, width, height, isMarker, picture) : null
  const glyphs = boxOf(rawFrame(delivered.outputPath, FRAME, width, height), width, height, isGlyph)
  const outside = boxOf(rawFrame(delivered.outputPath, 5, width, height), width, height, isGlyph)
  const logo = boxOf(rawFrame(delivered.outputPath, FRAME, width, height), width, height, isLogo)
  return { delivered, control, verification, picture, marker, glyphs, outside, logo }
}
const hard = (verification) => verification.issues.filter((issue) => issue.severity === 'hard')
const cleanup = (w) => rm(w.root, { recursive: true, force: true })

/** The projection against the pixels: the picture and the stand-in face are where the single projection says they are. */
function assertProjectionMatchesPixels(w, result) {
  const projected = px(clipForegroundOnCanvas(w.planned.projection, 'clip-1', FRAME), w.canvas)
  assert.ok(result.picture, 'the picture frame is in the caption-free frame')
  assert.ok(close(result.picture, projected, 3), `picture ${JSON.stringify(result.picture)} vs projected ${JSON.stringify(projected)}`)
  const face = { x: w.marker.x / w.master.width, y: w.marker.y / w.master.height, width: w.marker.w / w.master.width, height: w.marker.h / w.master.height }
  const [segment] = sourceRectCanvasSegments(w.planned.projection, face, 'source-1', { startFrame: FRAME, endFrame: FRAME + 1 })
  assert.ok(segment && result.marker, 'the stand-in face is predicted and measured')
  assert.ok(within(result.marker, px(segment.bounds, w.canvas), 1), `measured face ${JSON.stringify(result.marker)} inside the predicted ${JSON.stringify(px(segment.bounds, w.canvas))}`)
}

const WIDE = Object.freeze({ width: 1280, height: 720 })
const TALL = Object.freeze({ width: 720, height: 1280 })
const lowerCentre = (master) => ({ x: Math.round(master.width * 0.4), y: Math.round(master.height * 0.7), w: Math.round(master.width * 0.2), h: Math.round(master.height * 0.26) })

for (const [label, format, master] of [['16:9 canvas, 16:9 master', '16:9', WIDE], ['9:16 canvas, 9:16 master', '9:16', TALL]]) {
  test(`W65 pixels ${label}: a face low in the frame moves the caption off it, and the delivered pixels agree with the plan`, { timeout: 5 * 60_000 }, async () => {
    const w = await world(`low-${format.replace(':', 'x')}`, { format, master, marker: lowerCentre(master), evidence: 'marker' })
    try {
      assert.equal(w.decision.bandAssessments.bottom.face.state, 'occupied', 'the plan sees the face under the bottom band')
      assert.equal(w.decision.disposition, 'placed'); assert.notEqual(w.decision.anchor, 'bottom')
      const result = await run(w)
      assertProjectionMatchesPixels(w, result)
      assert.ok(result.glyphs, 'the caption is in the pixels')
      assert.equal(intersects(result.glyphs, result.marker), false, 'the caption does not cover the face in the pixels')
      assert.equal(result.outside, null, 'nothing is drawn outside the cue')
      assert.ok(within(result.glyphs, px(w.decision.bounds, w.canvas), TOLERANCE_PX), 'the glyphs sit inside the decided band')
      assert.deepEqual(hard(result.verification), [], JSON.stringify(result.verification.issues))
      assert.deepEqual(result.verification.issues, [], 'with a veto detector wired nothing is left unavailable')
    } finally { await cleanup(w) }
  })
}

test('W65 pixels: the critic is not vacuous - captions decided on wrong evidence land on the face and are caught in the pixels', { timeout: 5 * 60_000 }, async () => {
  // the evidence says the frame is clean (a miss), so the preferred band is chosen - right on top of the stand-in face
  const w = await world('mutation', { format: '16:9', master: WIDE, marker: lowerCentre(WIDE), evidence: 'clean' })
  try {
    assert.equal(w.decision.anchor, 'bottom')
    const result = await run(w)
    assert.equal(intersects(result.glyphs, result.marker), true, 'the oracle sees the caption over the face')
    assert.ok(hard(result.verification).some((issue) => issue.code === 'SUBTITLE_FACE_OVERLAP_IN_PIXELS'), JSON.stringify(result.verification.issues))
    // and without a veto detector the same render is only a warning: the unknown is never upgraded, never silently passed
    const w2 = await world('mutation-noveto', { format: '16:9', master: WIDE, marker: lowerCentre(WIDE), evidence: 'clean', veto: false })
    try {
      const result2 = await run(w2)
      assert.deepEqual(result2.verification.issues.map((issue) => [issue.code, issue.severity]), [['FACE_PIXEL_CHECK_UNAVAILABLE', 'warning']])
    } finally { await cleanup(w2) }
  } finally { await cleanup(w) }
})

test('W65 pixels: a 16:9 picture on the 9:16 canvas, lowered - the composition is projected into the band decision, not guessed', { timeout: 5 * 60_000 }, async () => {
  // verticalPosition 0.85 pushes the picture strip (canvas y 656..960) under the bottom band (y 770..845)
  const composition = { foregroundScale: 1, verticalPosition: 0.85 }
  const w = await world('lowered', { format: '9:16', master: WIDE, marker: { x: 560, y: 300, w: 160, h: 150 }, composition, evidence: 'marker' })
  try {
    assert.equal(w.decision.bandAssessments.bottom.face.evaluations[0].kind, 'face-clearance', 'the bottom band lies over the lowered picture')
    assert.equal(w.decision.bandAssessments.bottom.face.state, 'occupied', 'and the face is under it, in canvas terms')
    assert.notEqual(w.decision.anchor, 'bottom')
    const result = await run(w)
    assertProjectionMatchesPixels(w, result)
    assert.ok(result.glyphs)
    assert.equal(intersects(result.glyphs, result.marker), false)
    assert.deepEqual(hard(result.verification), [])
    // the renderer refuses a plan decided on a different composition
    const other = { ...w.base, composition: { foregroundScale: 1, verticalPosition: 0.5 }, operationId: 'lowered-wrong-composition', subtitleCues: [{ ...CUE }] }
    await assert.rejects(new FfmpegEditorialProxyRenderer({ workRoot: join(w.root, 'work2'), ffmpegPath }).render(other), /caption projection/)
  } finally { await cleanup(w) }
})

test('W65 pixels: a shrunk, lowered picture on the 16:9 canvas - scale and position are projected into the decision', { timeout: 5 * 60_000 }, async () => {
  // foregroundScale 0.6 at verticalPosition 0.75: the picture is canvas y 216..540, under the bottom band (y 436..491)
  const composition = { foregroundScale: 0.6, verticalPosition: 0.75 }
  const w = await world('shrunk', { format: '16:9', master: WIDE, marker: { x: 560, y: 480, w: 160, h: 150 }, composition, evidence: 'marker' })
  try {
    assert.equal(w.decision.bandAssessments.bottom.face.state, 'occupied')
    assert.notEqual(w.decision.anchor, 'bottom')
    const result = await run(w)
    assertProjectionMatchesPixels(w, result)
    assert.ok(result.glyphs && result.marker)
    assert.equal(intersects(result.glyphs, result.marker), false)
    assert.deepEqual(hard(result.verification), [])
  } finally { await cleanup(w) }
})

for (const [label, format, master] of [['16:9', '16:9', WIDE], ['9:16', '9:16', TALL]]) {
  test(`W65 pixels ${label}: faces that own the frame withhold the caption - zero caption pixels, the cue is blocked`, { timeout: 5 * 60_000 }, async () => {
    const w = await world(`blocked-${format.replace(':', 'x')}`, { format, master, marker: lowerCentre(master), evidence: 'everywhere' })
    try {
      assert.equal(w.decision.disposition, 'blocked'); assert.equal(w.decision.anchor, null)
      assert.deepEqual(w.decision.issues.map((issue) => [issue.code, issue.severity]), [['NO_SAFE_SUBTITLE_REGION', 'hard']])
      const result = await run(w)
      assert.equal(result.glyphs, null, 'no caption pixel in the cue')
      assert.deepEqual(result.verification.issues, [], 'the pixels agree with the plan: nothing drawn')
      assert.equal(result.delivered.renderElementMap.elements.some((element) => element.type === 'subtitle'), false)
    } finally { await cleanup(w) }
  })

  test(`W65 pixels ${label}: with no face window the caption is review-required - it is not burned, whatever band would have been free`, { timeout: 5 * 60_000 }, async () => {
    const w = await world(`unknown-${format.replace(':', 'x')}`, { format, master, marker: lowerCentre(master), evidence: null })
    try {
      // the picture fills the canvas in both cases, so every band is over it and none can be certified without evidence
      assert.equal(w.decision.disposition, 'review-required'); assert.equal(w.decision.suppressed, true)
      const result = await run(w)
      assert.equal(result.glyphs, null)
      assert.deepEqual(result.verification.issues, [])
      assert.deepEqual(w.decision.issues.map((issue) => [issue.code, issue.severity]), [['FACE_PERCEPTION_UNAVAILABLE', 'hard']])
    } finally { await cleanup(w) }
  })
}

test('W65 pixels: a 16:9 picture on the 9:16 canvas has the bottom band over the blurred copy - placed by geometry, the strip untouched', { timeout: 5 * 60_000 }, async () => {
  const w = await world('geometry', { format: '9:16', master: WIDE, marker: lowerCentre(WIDE), evidence: null })
  try {
    assert.equal(w.decision.disposition, 'placed'); assert.equal(w.decision.anchor, 'bottom')
    assert.equal(w.decision.bandAssessments.bottom.face.evaluations[0].kind, 'geometry-outside-foreground')
    const result = await run(w)
    assertProjectionMatchesPixels(w, result)
    assert.ok(result.glyphs && result.marker)
    assert.equal(intersects(result.glyphs, result.picture), false, 'the caption is entirely off the picture strip, as the geometry certificate says')
    assert.ok(result.glyphs.top > result.marker.bottom)
    assert.deepEqual(hard(result.verification), [])
    assert.equal(w.plan.subtitleAnchorPlan.faceClearance.faceSafety, 'unknown')
  } finally { await cleanup(w) }
})

test('W65 pixels: with a face and a drawn logo together the caption avoids both, in the delivered pixels', { timeout: 5 * 60_000 }, async () => {
  const w = await world('overlays', { format: '16:9', master: WIDE, marker: lowerCentre(WIDE), evidence: 'marker', logo: true })
  try {
    const placement = w.plan.placements.find((entry) => entry.elementId === 'logo-1')
    assert.ok(placement && placement.assetArtifactId === 'artifact-logo-1', 'the solver placed the drawable logo')
    const result = await run(w)
    assertProjectionMatchesPixels(w, result)
    assert.ok(result.glyphs && result.marker && result.logo, 'caption, face and logo are all in the pixels')
    assert.ok(close(result.logo, px(placement.bounds, w.canvas), 4), `the logo is drawn where the plan says: ${JSON.stringify(result.logo)}`)
    assert.equal(intersects(result.glyphs, result.marker), false)
    assert.equal(intersects(result.glyphs, result.logo), false)
    assert.deepEqual(hard(result.verification), [], JSON.stringify(result.verification.issues))
  } finally { await cleanup(w) }
})
