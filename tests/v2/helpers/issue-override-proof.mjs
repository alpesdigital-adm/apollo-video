import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'

import sharp from 'sharp'

import { faceBox, H, W } from './reframe-gt-oracle.mjs'

const run = promisify(execFile)
const { readOutputFormatPreset } = await import('../../../src/v2/domain/output-format-registry.ts')
const { FACE_EVIDENCE_POLICY } = await import('../../../src/v2/domain/face-evidence-policy.ts')
const { CAPTION_BAND_TOLERANCE_PX } = await import('../../../src/v2/domain/caption-pixel-verdict.ts')
const { deriveSubtitleAnchorBands } = await import('../../../src/v2/domain/subtitle-anchor-plan.ts')
const { deriveSubtitleRegion } = await import('../../../src/v2/domain/subtitle-region.ts')

/**
 * W68 pixel oracle. It looks at DECODED FRAMES of the delivered proxy and at nothing the product decided: where the pixels of a frame differ
 * from the same frame of another render, and where the generator put the face. It does not read the placement plan, the anchor plan or the
 * critic's verdict, and its tolerances are named here before any render is measured (they are not tuned to an output).
 */
export const PIXEL_TOLERANCE = Object.freeze({
  /** A channel difference below this is encoder noise, not a drawn caption. */
  channelDelta: 40,
  /** A row belongs to a changed cluster when at least this many of its pixels changed. */
  rowPixels: 6,
  /** Clusters closer than this many canvas rows are one drawn caption (two lines of one cue). */
  clusterGapRows: 14,
  /**
   * Slack, in canvas rows, around a band for the glyph outline, the opaque box and the anti-aliasing. It is the product's PUBLISHED constant
   * (`CAPTION_BAND_TOLERANCE_PX`), not a number chosen for this proof: a caption is inside its band when it is inside the band the plan
   * decided plus that tolerance, which is what the critic says and what this oracle measures independently.
   */
  bandSlackRows: CAPTION_BAND_TOLERANCE_PX,
})

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Decodes frame `index` (0-based) of an mp4 into RGB24. */
export async function decodeFrame(ffmpegPath, path, index) {
  const { stdout } = await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', path, '-vf', `select=eq(n\\,${index})`, '-vsync', '0', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  const decoded = await sharp(stdout).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  return Object.freeze({ width: decoded.info.width, height: decoded.info.height, data: decoded.data, png: stdout, sha256: sha256Hex(decoded.data) })
}

/** Row clusters `[startRow, endRow]` (inclusive) in which two same-size frames differ. */
export function changedClusters(left, right, tolerance = PIXEL_TOLERANCE) {
  if (left.width !== right.width || left.height !== right.height) throw new Error('frames of different sizes cannot be compared')
  const rows = []
  for (let y = 0; y < left.height; y += 1) {
    let changed = 0
    for (let x = 0; x < left.width; x += 1) {
      const offset = (y * left.width + x) * 3
      if (Math.abs(left.data[offset] - right.data[offset]) > tolerance.channelDelta
        || Math.abs(left.data[offset + 1] - right.data[offset + 1]) > tolerance.channelDelta
        || Math.abs(left.data[offset + 2] - right.data[offset + 2]) > tolerance.channelDelta) changed += 1
    }
    if (changed >= tolerance.rowPixels) rows.push(y)
  }
  const clusters = []
  for (const y of rows) {
    const last = clusters.at(-1)
    if (last && y - last[1] <= tolerance.clusterGapRows) last[1] = y
    else clusters.push([y, y])
  }
  return clusters
}

function bandsOf(format, presetId = 'kinetic') {
  const preset = readOutputFormatPreset(format)
  const region = deriveSubtitleRegion({ spec: preset.spec, presetId })
  return { bands: deriveSubtitleAnchorBands({ region, safeArea: preset.spec.safeArea }), canvas: preset.exportDefaults.proxy }
}

/** The rows `[top, bottom]` of one band on the proxy canvas of an output, from the registered preset (geometry only). */
export function bandRows(format, anchor, presetId = 'kinetic') {
  const { bands, canvas } = bandsOf(format, presetId)
  const band = bands[anchor]
  return Object.freeze({ top: Math.floor(band.y * canvas.height), bottom: Math.ceil((band.y + band.height) * canvas.height), canvas: Object.freeze({ width: canvas.width, height: canvas.height }) })
}

export const ANCHORS = Object.freeze(['top', 'upper-third', 'center', 'lower-third', 'bottom'])

/**
 * The bands the GENERATOR's face occupies over a frame range, by the PUBLISHED caption-clearance rule and nothing the product decided for this
 * render: a detection is dilated by max(0.35 x its larger side, 0.015 x the frame side) on each axis (`FACE_EVIDENCE_POLICY.clearance.dilation`),
 * and a band is occupied when the dilated box and the band overlap as CLOSED rectangles (a box that merely touches occupies it). `window` is the
 * normalized x-range of the source the output shows (`{ x: 0, width: 1 }` for a whole-frame output, the crop for a reframed one); the picture fills
 * the canvas, so a source y is the canvas y and a source x maps through the window.
 */
export function occupiedBands({ scene, format, frames, window = { x: 0, width: 1 } }) {
  const { largerSideFraction, minFrameFraction } = FACE_EVIDENCE_POLICY.clearance.dilation
  const { bands } = bandsOf(format)
  const occupied = new Set()
  for (const frame of frames) {
    const subject = scene.subjectsAtSource(frame).find((candidate) => candidate.kind === 'face')
    if (!subject) continue
    const [x1, y1, x2, y2] = subject.box
    const largerSide = Math.max((x2 - x1) * W, (y2 - y1) * H)
    const marginX = Math.max(largerSideFraction * largerSide, minFrameFraction * W) / W
    const marginY = Math.max(largerSideFraction * largerSide, minFrameFraction * H) / H
    const left = (Math.max(0, x1 - marginX) - window.x) / window.width, right = (Math.min(1, x2 + marginX) - window.x) / window.width
    const top = Math.max(0, y1 - marginY), bottom = Math.min(1, y2 + marginY)
    if (right < 0 || left > 1) continue
    for (const anchor of ANCHORS) {
      const band = bands[anchor]
      if (!(right < band.x || left > band.x + band.width || bottom < band.y || top > band.y + band.height)) occupied.add(anchor)
    }
  }
  return Object.freeze([...occupied])
}

export const faceBoxFor = faceBox
