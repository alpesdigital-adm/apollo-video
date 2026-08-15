import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FfmpegEditorialProxyRenderer } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createColorPipelineCompilation } from '../../src/v2/domain/color-pipeline-compilation.ts'
import { createMediaColorProbe } from '../../src/v2/domain/color-and-export.ts'
import { createEditorialAudioTimelineHash } from '../../src/v2/domain/production-modes.ts'
import { createRenderPlacementPlan } from '../../src/v2/domain/render-placement-plan.ts'
import { createRenderReframePlan } from '../../src/v2/domain/render-reframe-plan.ts'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const colorMetadata = Object.freeze({
  colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709',
  range: 'limited', bitDepth: 8,
})

const FPS = 30
const DURATION_FRAMES = 90
const SOURCE_WIDTH = 640
const SOURCE_HEIGHT = 360
const CANVAS = Object.freeze({ width: 540, height: 960 })
/** Widest 9:16 window a 640x360 source can offer, i.e. the pan viewport. */
const CROP_WIDTH = (9 / 16) / (SOURCE_WIDTH / SOURCE_HEIGHT)
/** Red stripe in the source, in source pixels. It is what the pan moves across. */
const STRIPE_X = 140
const STRIPE_WIDTH = 20

function colorCompilation(artifactId) {
  const manifestId = `manifest-${artifactId}`
  const probe = createMediaColorProbe({
    id: `probe-${artifactId}`, workspaceId: 'workspace-render-geometry', artifactId, manifestId,
    detection: { state: 'ready', metadata: colorMetadata, pixelFormat: 'yuv420p', hdrMode: 'sdr' },
    producer: { provider: 'ffprobe', version: 'json-v1', binaryDigest: '9'.repeat(64) },
    createdAt: '2026-08-14T08:00:00.000Z',
  })
  const implementation = (provider, parameters) => ({
    provider, version: 'v1', parameters, parametersHash: calculateCanonicalHash(parameters),
  })
  return createColorPipelineCompilation({
    id: `compilation-${artifactId}`, workspaceId: probe.workspaceId,
    projectId: 'project-render-geometry', sourceArtifactId: artifactId, sourceManifestId: manifestId,
    probe, outputMetadata: colorMetadata, createdByClientId: 'client-render-geometry',
    createdAt: '2026-08-14T08:01:00.000Z',
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

const pixelAt = (raw, x, y) => {
  const offset = (y * CANVAS.width + x) * 3
  return [raw[offset], raw[offset + 1], raw[offset + 2]]
}

const isRed = ([r, g, b]) => r > 110 && r > g * 1.8 && r > b * 1.8
const isGreen = ([r, g, b]) => g > 110 && g > r * 1.8 && g > b * 1.8

/** Mean column of the red-dominant pixels of a frame; NaN when the stripe is absent. */
const redCentroidColumn = (raw) => {
  let total = 0
  let weighted = 0
  for (let y = 0; y < CANVAS.height; y += 4) {
    for (let x = 0; x < CANVAS.width; x += 1) {
      if (isRed(pixelAt(raw, x, y))) { total += 1; weighted += x }
    }
  }
  return total === 0 ? Number.NaN : weighted / total
}

/** Near-white pixels in the bottom third — where the caption layer draws its text. */
const captionPixels = (raw) => {
  let count = 0
  for (let y = Math.floor(CANVAS.height * 0.66); y < CANVAS.height; y += 1) {
    for (let x = 0; x < CANVAS.width; x += 1) {
      const [r, g, b] = pixelAt(raw, x, y)
      if (r > 235 && g > 235 && b > 235) count += 1
    }
  }
  return count
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'apollo-render-geometry-'))
  const sourcePath = join(root, 'source.mp4')
  const logoPath = join(root, 'logo.png')
  execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=0x282828:s=${SOURCE_WIDTH}x${SOURCE_HEIGHT}:r=${FPS}:d=4`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
    '-vf', `drawbox=x=${STRIPE_X}:y=0:w=${STRIPE_WIDTH}:h=${SOURCE_HEIGHT}:color=red:t=fill`,
    '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000', sourcePath,
  ], { windowsHide: true, timeout: 180_000 })
  execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x00C853:s=128x128:d=1',
    '-frames:v', '1', logoPath,
  ], { windowsHide: true, timeout: 60_000 })
  const logoSha256 = createHash('sha256').update(await readFile(logoPath)).digest('hex')
  const clips = [Object.freeze({
    id: 'clip-geometry-1', sourceArtifactId: 'artifact-geometry-source',
    sourceInFrame: 0, sourceOutFrame: DURATION_FRAMES,
    timelineInFrame: 0, timelineOutFrame: DURATION_FRAMES, rate: 1,
  })]
  return {
    root, sourcePath, logoPath, logoSha256, clips,
    audioTimelineHash: createEditorialAudioTimelineHash({ fps: FPS, clips }),
    sources: [{
      artifactId: 'artifact-geometry-source', path: sourcePath, mediaType: 'video',
      colorPipelineCompilation: colorCompilation('artifact-geometry-source'),
    }],
    renderer: new FfmpegEditorialProxyRenderer({ workRoot: join(root, 'work'), ffmpegPath }),
  }
}

test('T-FR-163 the renderer paints planned placements at their exact pixel box', { timeout: 10 * 60_000 }, async () => {
  const context = await fixture()
  try {
    const plan = createRenderPlacementPlan({
      format: '9:16', canvas: CANVAS, durationFrames: DURATION_FRAMES, subtitlePresetId: 'kinetic',
      elements: [{
        id: 'logo-geometry-1', kind: 'logo', anchor: 'auto', priority: 90, readingOrder: 0,
        minWidth: 0.16, maxWidth: 0.3, minHeight: 0.06, maxHeight: 0.2,
        timeRange: { startFrame: 0, endFrame: 45 },
        assetArtifactId: 'artifact-geometry-logo', assetSha256: context.logoSha256,
      }],
    })
    const logo = plan.placements.find((placement) => placement.kind === 'logo')
    const rendered = await context.renderer.render({
      operationId: 'render-geometry-placement', renderKind: 'proxy',
      sources: context.sources, lutPaths: {}, clips: context.clips,
      audioTimelineHash: context.audioTimelineHash, fps: FPS, format: '9:16',
      composition: { foregroundScale: 1, verticalPosition: 0.5 },
      placementPlan: plan,
      placementAssets: [{ elementId: 'logo-geometry-1', path: context.logoPath, sha256: context.logoSha256 }],
    })

    const boxWidth = Math.max(2, Math.round(logo.bounds.width * CANVAS.width / 2) * 2)
    const boxHeight = Math.max(2, Math.round(logo.bounds.height * CANVAS.height / 2) * 2)
    const boxX = Math.round(logo.bounds.x * CANVAS.width)
    const boxY = Math.round(logo.bounds.y * CANVAS.height)
    const inside = frameBytes(rendered.outputPath, 10)
    console.log(`T-FR-163 placement box ${boxWidth}x${boxHeight} at (${boxX},${boxY}) on ${CANVAS.width}x${CANVAS.height}; planHash=${plan.placementPlanHash.slice(0, 12)}`)
    const center = pixelAt(inside, boxX + Math.floor(boxWidth / 2), boxY + Math.floor(boxHeight / 2))
    assert.ok(isGreen(center), `logo centre must be green, read ${center.join(',')}`)
    // Every corner of the planned box is inside the painted rectangle.
    for (const [dx, dy] of [[2, 2], [boxWidth - 3, 2], [2, boxHeight - 3], [boxWidth - 3, boxHeight - 3]]) {
      const corner = pixelAt(inside, boxX + dx, boxY + dy)
      assert.ok(isGreen(corner), `logo corner (${dx},${dy}) must be green, read ${corner.join(',')}`)
    }
    // One row above the box is untouched: the overlay does not bleed.
    if (boxY >= 4) {
      const above = pixelAt(inside, boxX + Math.floor(boxWidth / 2), boxY - 4)
      assert.ok(!isGreen(above), `pixel above the box must not be green, read ${above.join(',')}`)
    }
    // The half-open [0,45) window: painted at 44, gone at 45.
    const last = pixelAt(frameBytes(rendered.outputPath, 44), boxX + Math.floor(boxWidth / 2), boxY + Math.floor(boxHeight / 2))
    const after = pixelAt(frameBytes(rendered.outputPath, 45), boxX + Math.floor(boxWidth / 2), boxY + Math.floor(boxHeight / 2))
    assert.ok(isGreen(last), `frame 44 must still carry the logo, read ${last.join(',')}`)
    assert.ok(!isGreen(after), `frame 45 must no longer carry the logo, read ${after.join(',')}`)

    // A digest that does not match the bytes on disk never reaches FFmpeg.
    await assert.rejects(
      () => context.renderer.render({
        operationId: 'render-geometry-placement-tampered', renderKind: 'proxy',
        sources: context.sources, lutPaths: {}, clips: context.clips,
        audioTimelineHash: context.audioTimelineHash, fps: FPS, format: '9:16',
        placementPlan: plan,
        placementAssets: [{ elementId: 'logo-geometry-1', path: context.sourcePath, sha256: context.logoSha256 }],
      }),
      (error) => error.code === 'INVALID_RENDER_INPUT',
    )
  } finally {
    await rm(context.root, { recursive: true, force: true })
  }
})

test('T-FR-164 the renderer pans a reframe trajectory deterministically across real frames', { timeout: 10 * 60_000 }, async () => {
  const context = await fixture()
  try {
    const reframePlan = createRenderReframePlan({
      format: '9:16', variantId: '9:16', fps: FPS, durationFrames: DURATION_FRAMES,
      source: { width: SOURCE_WIDTH, height: SOURCE_HEIGHT },
      ranges: [{
        clipId: 'clip-geometry-1', startFrame: 0, endFrame: DURATION_FRAMES, interpolation: 'linear',
        keyframes: [
          { frame: 0, crop: { x: 0, y: 0, width: CROP_WIDTH, height: 1 } },
          { frame: 45, crop: { x: 0.075, y: 0, width: CROP_WIDTH, height: 1 } },
          { frame: 89, crop: { x: 0.15, y: 0, width: CROP_WIDTH, height: 1 } },
        ],
      }],
    })
    const render = (operationId) => context.renderer.render({
      operationId, renderKind: 'proxy',
      sources: context.sources, lutPaths: {}, clips: context.clips,
      audioTimelineHash: context.audioTimelineHash, fps: FPS, format: '9:16',
      composition: { foregroundScale: 1, verticalPosition: 0.5 },
      reframePlan,
    })
    const first = await render('render-geometry-reframe-a')
    const samples = [0, 44, 89].map((frame) => redCentroidColumn(frameBytes(first.outputPath, frame)))
    for (const [index, column] of samples.entries()) {
      assert.ok(Number.isFinite(column), `frame sample ${index} must still show the tracked stripe`)
    }
    console.log(`T-FR-164 stripe centre column at frames 0/44/89: ${samples.map((value) => value.toFixed(1)).join(' / ')}; planHash=${reframePlan.reframePlanHash.slice(0, 12)}`)
    // The crop window walks right across a static source, so the stripe walks left on screen.
    assert.ok(samples[0] - samples[1] > 60, `stripe must travel left between frames 0 and 44 (${samples[0]} -> ${samples[1]})`)
    assert.ok(samples[1] - samples[2] > 60, `stripe must keep travelling between frames 44 and 89 (${samples[1]} -> ${samples[2]})`)
    assert.ok(samples[0] - samples[2] > 180, `total travel must be large (${samples[0]} -> ${samples[2]})`)

    // Determinism: the same plan renders the same bytes.
    const second = await render('render-geometry-reframe-b')
    assert.equal(second.sha256, first.sha256)

    // A moving crop on a retimed clip cannot be reproduced frame-for-frame, so it fails closed.
    await assert.rejects(
      () => context.renderer.render({
        operationId: 'render-geometry-reframe-retimed', renderKind: 'proxy',
        sources: context.sources, lutPaths: {},
        clips: [{ ...context.clips[0], rate: 2, sourceOutFrame: DURATION_FRAMES * 2 }],
        fps: FPS, format: '9:16', reframePlan,
      }),
      (error) => error.code === 'INVALID_RENDER_INPUT',
    )
  } finally {
    await rm(context.root, { recursive: true, force: true })
  }
})

test('T-FR-171 subtitles resolved to none render zero caption pixels', { timeout: 10 * 60_000 }, async () => {
  const context = await fixture()
  try {
    const base = {
      renderKind: 'proxy', sources: context.sources, lutPaths: {}, clips: context.clips,
      audioTimelineHash: context.audioTimelineHash, fps: FPS, format: '9:16',
      composition: { foregroundScale: 1, verticalPosition: 0.5 },
    }
    const cues = [{ id: 'cue-1', startFrame: 0, endFrame: 90, text: 'A FALA CONTINUA AQUI', anchor: 'bottom' }]
    const withCaptions = await context.renderer.render({ ...base, operationId: 'render-geometry-subs-on', subtitleCues: cues })
    const withoutCaptions = await context.renderer.render({ ...base, operationId: 'render-geometry-subs-none', subtitleCues: [] })

    const drawn = captionPixels(frameBytes(withCaptions.outputPath, 30))
    const suppressed = captionPixels(frameBytes(withoutCaptions.outputPath, 30))
    console.log(`T-FR-171 caption pixels in the bottom third: enabled=${drawn} none=${suppressed}`)
    assert.ok(drawn > 400, `captions must actually draw pixels, counted ${drawn}`)
    assert.equal(suppressed, 0, `none must leave zero caption pixels, counted ${suppressed}`)
    // Only the caption layer changed: both renders keep the same timeline identity.
    assert.equal(withCaptions.renderElementMap.durationFrames, withoutCaptions.renderElementMap.durationFrames)
    assert.notEqual(withCaptions.sha256, withoutCaptions.sha256)
  } finally {
    await rm(context.root, { recursive: true, force: true })
  }
})
