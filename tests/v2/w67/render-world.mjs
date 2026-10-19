import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { FORMATS, framingOf, bandsOf, PREFERENCE } from './corpus-geometry.mjs'

// Under tsx a static named import of a TypeScript module is not visible to Node (the module runs as CommonJS), so these are dynamic.
const { planCaptionPlacement } = await import('../../../src/v2/application/plan-caption-placement.ts')
const { calculateCanonicalHash } = await import('../../../src/v2/domain/canonical-hash.ts')
const { createColorPipelineCompilation } = await import('../../../src/v2/domain/color-pipeline-compilation.ts')
const { createMediaColorProbe } = await import('../../../src/v2/domain/color-and-export.ts')
const { createEditorialAudioTimelineHash } = await import('../../../src/v2/domain/production-modes.ts')
const { createRenderReframePlan } = await import('../../../src/v2/domain/render-reframe-plan.ts')
const { FfmpegEditorialProxyRenderer } = await import('../../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts')
const { sealedSourceWindow } = await import('../helpers/face-source-envelope-v3.mjs')

/**
 * W67 controlled corpus - the world the generator renders in: a source video from one still, a two-clip timeline, a reframe plan, a
 * caption cue and a CTA overlay, rendered by the REAL product renderer (FfmpegEditorialProxyRenderer) in the proxy canvas of each format.
 *
 * Timeline: clip A (frames 0-44) carries the caption cue and the CTA, one after the other, under the good crop; clip B (45-89) carries no overlay
 * and, in the lost-crop variants, the bad crop. So each defect has its own clip or interval and none can explain another.
 *
 * What is seeded, and how (every mechanism is decided here, from human boxes and the preset's public geometry, never from the product's
 * solver output):
 *  - caption over a protected face: the face evidence handed to the planner reports small phantom boxes in every band BEFORE the target
 *    band and omits the real face, so the planner's ordinary rules place the cue in the target band, over the face;
 *  - subject lost by a bad crop: the second clip's reframe window is the good window shifted until only a third of the face is left;
 *  - CTA outside the safe area: the CTA text is long enough that its second line is wider than the canvas.
 * A clean control gives the planner the human face box, a good crop for both clips and a short CTA.
 */
export const TIMELINE = Object.freeze({
  fps: 30, durationFrames: 90,
  clips: Object.freeze([
    Object.freeze({ id: 'clip-a', sourceArtifactId: 'source-1', sourceInFrame: 0, sourceOutFrame: 45, timelineInFrame: 0, timelineOutFrame: 45, rate: 1 }),
    Object.freeze({ id: 'clip-b', sourceArtifactId: 'source-1', sourceInFrame: 45, sourceOutFrame: 90, timelineInFrame: 45, timelineOutFrame: 90, rate: 1 }),
  ]),
  cue: Object.freeze({ id: 'cue-1', startFrame: 8, endFrame: 28, text: 'Veja o que muda', anchor: 'bottom' }),
  cta: Object.freeze({ id: 'cta-1', startFrame: 31, endFrame: 44, text: 'Garanta sua vaga', longText: 'Garanta agora a sua vaga na mentoria com desconto exclusivo de lancamento e bonus especiais' }),
})

export const VARIANTS = Object.freeze(['clean', 'caption', 'crop', 'cta', 'combined'])
/** Which defects each variant seeds; the same table writes the labels. */
export const VARIANT_DEFECTS = Object.freeze({
  clean: [], caption: ['caption-over-face'], crop: ['crop-lost'], cta: ['cta-outside-safe-area'],
  combined: ['caption-over-face', 'crop-lost', 'cta-outside-safe-area'],
})
/** Defect -> the frame interval (half-open, timeline frames) in which it is seeded, and the critic codes that count as detecting it. */
export const DEFECT_TABLE = Object.freeze({
  'caption-over-face': { interval: [TIMELINE.cue.startFrame, TIMELINE.cue.endFrame], codes: ['SUBTITLE_FACE_OVERLAP_IN_PIXELS'] },
  'crop-lost': { interval: [45, TIMELINE.durationFrames], codes: ['SUBJECT_NOT_VISIBLE_IN_PIXELS', 'SUBJECT_CLIPPED_IN_PIXELS'] },
  'cta-outside-safe-area': { interval: [TIMELINE.cta.startFrame, TIMELINE.cta.endFrame], codes: ['INK_OUTSIDE_SAFE_AREA_IN_PIXELS', 'INK_CLIPPED_BY_CANVAS_IN_PIXELS'] },
})

const colorMetadata = Object.freeze({ colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709', range: 'limited', bitDepth: 8 })
export function colorCompilation(artifactId) {
  const manifestId = `manifest-${artifactId}`
  const probe = createMediaColorProbe({ id: `probe-${artifactId}`, workspaceId: 'workspace-w67-corpus', artifactId, manifestId,
    detection: { state: 'ready', metadata: colorMetadata, pixelFormat: 'yuv420p', hdrMode: 'sdr' },
    producer: { provider: 'ffprobe', version: 'json-v1', binaryDigest: '9'.repeat(64) }, createdAt: '2026-10-19T08:00:00.000Z' })
  const implementation = (provider, parameters) => ({ provider, version: 'v1', parameters, parametersHash: calculateCanonicalHash(parameters) })
  return createColorPipelineCompilation({ id: `compilation-${artifactId}`, workspaceId: probe.workspaceId, projectId: 'project-w67-corpus',
    sourceArtifactId: artifactId, sourceManifestId: manifestId, probe, outputMetadata: colorMetadata, createdByClientId: 'client-w67-corpus',
    createdAt: '2026-10-19T08:01:00.000Z',
    stages: [
      { id: 'technical-rec709', kind: 'technical', version: 'v1', enabled: true, input: colorMetadata, output: colorMetadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
      { id: 'match-bypass', kind: 'match', version: 'v1', enabled: false, input: colorMetadata, output: colorMetadata, implementation: implementation('apollo-match', { mode: 'bypass' }) },
      { id: 'creative-none', kind: 'creative-lut', version: 'v1', enabled: false, input: colorMetadata, output: colorMetadata, implementation: implementation('apollo-lut', { mode: 'none' }) },
      { id: 'output-rec709', kind: 'output', version: 'v1', enabled: true, input: colorMetadata, output: colorMetadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
    ] })
}

export const sha256Of = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** A 3 s, 30 fps source video: the still, held, with a sine track (the renderer requires an audio stream). `lavfiVideo` replaces the still. */
export function encodeSource({ ffmpegPath, imagePath, lavfiVideo, outPath }) {
  const video = lavfiVideo ? ['-f', 'lavfi', '-i', lavfiVideo] : ['-loop', '1', '-framerate', String(TIMELINE.fps), '-i', imagePath]
  execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...video, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
    '-t', '3', '-r', String(TIMELINE.fps), '-c:v', 'libx264', '-preset', 'medium', '-crf', '10', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-shortest', outPath],
  { windowsHide: true, timeout: 180_000 })
  return { path: outPath, sha256: sha256Of(outPath) }
}

/** Canvas rect (normalized) -> source rect (normalized) through a crop window. */
export const canvasToSource = (rect, window) => [window.x + rect.x0 * window.width, window.y + rect.y0 * window.height, window.x + rect.x1 * window.width, window.y + rect.y1 * window.height]

/** The band rects of a format as the preset derives them (public geometry, read once through a plan with no evidence). */
export async function presetBands(format, source) {
  const canvas = FORMATS[format]
  const probe = await planCaptionPlacement({ clock: () => new Date('2026-10-19T12:00:00.000Z') }, {
    workspaceId: 'workspace-1', projectId: 'project-1', format, canvas: { width: canvas.width, height: canvas.height },
    editPlan: { fps: TIMELINE.fps, durationFrames: TIMELINE.durationFrames }, clips: TIMELINE.clips,
    renderSources: [{ artifactId: 'source-1', sha256: 'b'.repeat(64), mediaType: 'video', probe: { width: source.width, height: source.height } }],
    subtitleCues: [{ id: TIMELINE.cue.id, startFrame: TIMELINE.cue.startFrame, endFrame: TIMELINE.cue.endFrame }], subtitlePresetId: 'kinetic', placementElements: [], primarySourceArtifactId: 'source-1' })
  return bandsOf(format, probe.placementPlan.subtitleAnchorPlan.bands)
}

/** Phantom box centred in a band, small enough that its dilation (35% of the larger side, 1.5% of the frame at least) stays inside the band's neighbourhood. */
export function phantomRect(band, format) {
  const centreX = (band.x0 + band.x1) / 2, centreY = (band.y0 + band.y1) / 2
  const width = 0.06, height = 0.02 * (FORMATS[format].width / FORMATS[format].height)
  return { x0: centreX - width / 2, y0: centreY - height / 2, x1: centreX + width / 2, y1: centreY + height / 2 }
}

/** Everything one output is made of, decided from the framing (never from a solver output). */
export function outputSpecOf({ imageId, format, variant, face, source, bands }) {
  const framing = framingOf(face, format, source, bands)
  if (!framing.feasible) throw new Error(`image ${imageId} cannot be framed in ${format}: ${framing.stage}:${framing.reason}`)
  const defects = VARIANT_DEFECTS[variant]
  return Object.freeze({
    id: `${imageId}-${format.replace(':', 'x')}-${variant}`, imageId, format, variant, face, source, framing,
    defects, windowA: framing.good.window, windowB: defects.includes('crop-lost') ? framing.lost.window : framing.good.window,
    evidence: defects.includes('caption-over-face') ? 'phantoms' : 'human-box', blockers: defects.includes('caption-over-face') ? framing.blockers : [],
    ctaText: defects.includes('cta-outside-safe-area') ? TIMELINE.cta.longText : TIMELINE.cta.text,
  })
}

/** The labels, as data written by the generator: defect x format x interval, plus which codes count as detecting it. */
export function labelsOf(spec) {
  return spec.defects.map((defect) => ({
    outputId: spec.id, defect, format: spec.format, startFrame: DEFECT_TABLE[defect].interval[0], endFrame: DEFECT_TABLE[defect].interval[1], codes: DEFECT_TABLE[defect].codes,
  }))
}

function reframePlanOf(spec) {
  const range = (clip, window) => ({ clipId: clip.id, startFrame: clip.timelineInFrame, endFrame: clip.timelineOutFrame, interpolation: 'hold', keyframes: [{ frame: clip.timelineInFrame, crop: window }] })
  return createRenderReframePlan({
    format: spec.format, variantId: `variant-${spec.format.replace(':', 'x')}`, fps: TIMELINE.fps, durationFrames: TIMELINE.durationFrames,
    source: { width: spec.source.width, height: spec.source.height },
    ranges: [range(TIMELINE.clips[0], spec.windowA), range(TIMELINE.clips[1], spec.windowB)],
  })
}

/** The planner's input for one output, with the face evidence the spec calls for. */
export async function planOutput(spec, bands) {
  const canvas = { width: FORMATS[spec.format].width, height: FORMATS[spec.format].height }
  const reframePlan = reframePlanOf(spec)
  const rowsAt = (sourceFrame) => {
    if (spec.evidence === 'human-box') return [[0.9, spec.face.x0, spec.face.y0, spec.face.x1, spec.face.y1]]
    const window = sourceFrame < 45 ? spec.windowA : spec.windowB
    return spec.blockers.map((name) => [0.9, ...canvasToSource(phantomRect(bands[name], spec.format), window)])
  }
  const envelope = sealedSourceWindow({ start: 0, end: TIMELINE.durationFrames, rowsAt })
  const reader = { async listSourceWindows() { return [{ envelope }] } }
  const planned = await planCaptionPlacement({ faceEvidence: reader, clock: () => new Date('2026-10-19T12:00:00.000Z') }, {
    workspaceId: 'workspace-1', projectId: 'project-1', format: spec.format, canvas,
    editPlan: { fps: TIMELINE.fps, durationFrames: TIMELINE.durationFrames }, clips: TIMELINE.clips, reframePlan,
    renderSources: [{ artifactId: 'source-1', sha256: 'b'.repeat(64), mediaType: 'video', probe: { width: spec.source.width, height: spec.source.height } }],
    subtitleCues: [{ id: TIMELINE.cue.id, startFrame: TIMELINE.cue.startFrame, endFrame: TIMELINE.cue.endFrame }], subtitlePresetId: 'kinetic',
    placementElements: [], primarySourceArtifactId: 'source-1' })
  return { placementPlan: planned.placementPlan, reframePlan, decision: planned.placementPlan.subtitleAnchorPlan.decisions[0] }
}

/** Renders `kind` of one output through the product renderer: 'delivered', or one of the three controls the critic asks for. */
export async function renderOutput({ renderer, spec, planned, sourcePath, kind }) {
  const cue = { ...TIMELINE.cue }
  const cta = { id: TIMELINE.cta.id, kind: 'cta', desiredActionRef: { schemaVersion: 'desired-action-ref/v1', id: 'action-w67', actionHash: 'a'.repeat(64), action: {} },
    startFrame: TIMELINE.cta.startFrame, endFrame: TIMELINE.cta.endFrame, text: spec.ctaText }
  const withCaptions = kind === 'delivered' || kind === 'cta-off'
  const withCta = kind === 'delivered' || kind === 'captions-off'
  return renderer.render({
    operationId: `${spec.id}-${kind}`, renderKind: 'proxy',
    sources: [{ artifactId: 'source-1', path: sourcePath, mediaType: 'video', colorPipelineCompilation: colorCompilation('source-1') }],
    lutPaths: {}, clips: TIMELINE.clips, audioTimelineHash: createEditorialAudioTimelineHash({ fps: TIMELINE.fps, clips: TIMELINE.clips }),
    fps: TIMELINE.fps, format: spec.format, subtitleCues: withCaptions ? [cue] : [], ...(withCta ? { ctaOverlays: [cta] } : {}),
    placementPlan: planned.placementPlan, reframePlan: planned.reframePlan,
  })
}

export function createRenderer({ workRoot, ffmpegPath }) {
  return new FfmpegEditorialProxyRenderer({ workRoot, ffmpegPath })
}

/** The critic's request for one output: the clips, the source and the control renders, with the identity the report seals. */
export function criticRequest({ spec, deliveredPath, sourcePath, sourceSha256, renderControl, renderInputHash }) {
  const canvas = FORMATS[spec.format]
  return {
    identity: {
      workspaceId: 'workspace-w67-corpus', projectId: 'project-w67-corpus', projectVersionId: 'version-w67-corpus-1',
      variantId: `variant-${spec.format.replace(':', 'x')}-${spec.variant}`, outputSpecId: spec.format === '9:16' ? 'preset-9x16' : 'preset-16x9',
      format: spec.format, operationId: `operation-${spec.id}`, renderInputHash,
    },
    deliveredPath, outputSpec: { width: canvas.width, height: canvas.height, safeArea: canvas.safeArea },
    sources: { 'source-1': { path: sourcePath, sha256: sourceSha256 } }, clips: TIMELINE.clips, renderControl,
  }
}

export async function ensureDirectory(path) { await mkdir(path, { recursive: true }); return path }
export { join, PREFERENCE }
