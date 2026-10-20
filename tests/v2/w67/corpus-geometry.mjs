/**
 * W67 controlled corpus - the framing geometry, independent of the product.
 *
 * Pure arithmetic on a human-annotated face box (Open Images, normalized to the source image) and on the OutputSpec of a format. It decides,
 * BY CONSTRUCTION and before any render, where the face lands in the output for a given crop window. It never calls the product's reframe
 * solver, caption solver or any detector, and it is used for two things only: to choose the crop windows handed to the renderer, and to
 * write the expected labels (defect x format x interval). Whether the rendered pixels agree is what the critic is measured against.
 */
export const FRAMING_RULES = Object.freeze({
  id: 'w67-framing-rules/v1',
  /** Target height of the face in the output canvas, in output pixels (both formats). */
  faceHeightPixels: 170,
  /** Maximum upscale of the source pixels onto the canvas (a smaller face than this cannot be framed legibly). */
  maxUpscale: 2.5,
  /** Horizontal centre of the face in the output, normalized. */
  faceCentreX: 0.5,
  /** Vertical centre of the face in the output, normalized, per format. */
  faceCentreY: Object.freeze({ '9:16': 0.45, '16:9': 0.55 }),
  /** A framed face keeps this much canvas (normalized) between its box and every canvas edge. */
  edgeMargin: 0.04,
  /** Bottom caption band must stay free of the framed face by this much (normalized) so a clean control can caption there. */
  bottomBandClearance: 0.02,
  /** CTA block (an8 at 10% of the height, two lines) ends by this normalized y; the framed face starts below it plus the margin. */
  ctaBottom: Object.freeze({ '9:16': 0.19, '16:9': 0.27 }),
  ctaClearance: 0.02,
  /** Share of the face that stays inside the canvas in the lost-crop framing (the rest is cut by the canvas edge). */
  lostCropVisibleShare: 0.35,
  /** A caption band counts as covering the framed face when at least this share of the band's HEIGHT lies inside the face box. */
  bandCoverShare: 0.5,
  /** ... and the face is horizontally central enough for the centred caption text to cross it. */
  bandCoverFaceCentreXRange: Object.freeze([0.3, 0.7]),
})

export const FORMATS = Object.freeze({
  '9:16': Object.freeze({ width: 540, height: 960, safeArea: Object.freeze({ top: 0.08, right: 0.06, bottom: 0.06, left: 0.06 }) }),
  '16:9': Object.freeze({ width: 960, height: 540, safeArea: Object.freeze({ top: 0.055, right: 0.05, bottom: 0.06, left: 0.05 }) }),
})

/** Caption bands in canvas-normalized coordinates, copied from the preset-derived bands of subtitle-anchor-plan/v3 (checked by the generator). */
export const PREFERENCE = Object.freeze(['bottom', 'lower-third', 'upper-third', 'top', 'center'])

const rect = (x0, y0, x1, y1) => ({ x0, y0, x1, y1 })
const area = (box) => Math.max(0, box.x1 - box.x0) * Math.max(0, box.y1 - box.y0)
const inter = (a, b) => rect(Math.max(a.x0, b.x0), Math.max(a.y0, b.y0), Math.min(a.x1, b.x1), Math.min(a.y1, b.y1))

/** The face rect (source-normalized) from an Open Images row. */
export const faceRectOf = (row) => rect(Number(row.XMin), Number(row.YMin), Number(row.XMax), Number(row.YMax))

/** Where a source-normalized rect lands in the output for a crop window `{x, y, width, height}` (source-normalized). Not clipped. */
export function toOutput(face, window) {
  return rect((face.x0 - window.x) / window.width, (face.y0 - window.y) / window.height, (face.x1 - window.x) / window.width, (face.y1 - window.y) / window.height)
}

export function visibleShare(outputRect) {
  const total = area(outputRect)
  return total > 0 ? area(inter(outputRect, rect(0, 0, 1, 1))) / total : 0
}

const windowAspectRatio = (format, source) => (FORMATS[format].width / FORMATS[format].height) * (source.height / source.width)

/** The crop window (source-normalized) that frames the face at the rules' size and position, clamped into the source. Null when it cannot be framed. */
export function goodWindow(face, format, source) {
  const canvas = FORMATS[format]
  const targetHeight = FRAMING_RULES.faceHeightPixels / canvas.height
  const faceHeight = face.y1 - face.y0
  const windowHeight = faceHeight / targetHeight
  const windowWidth = windowAspectRatio(format, source) * windowHeight
  if (windowWidth > 1 || windowHeight > 1) return { feasible: false, reason: 'FACE_TOO_LARGE_FOR_TARGET_SCALE' }
  const upscale = canvas.height / (windowHeight * source.height)
  if (upscale > FRAMING_RULES.maxUpscale) return { feasible: false, reason: 'UPSCALE_TOO_HIGH', upscale }
  const centreX = (face.x0 + face.x1) / 2, centreY = (face.y0 + face.y1) / 2
  const x = Math.min(1 - windowWidth, Math.max(0, centreX - FRAMING_RULES.faceCentreX * windowWidth))
  const y = Math.min(1 - windowHeight, Math.max(0, centreY - FRAMING_RULES.faceCentreY[format] * windowHeight))
  const window = { x, y, width: windowWidth, height: windowHeight }
  const placed = toOutput(face, window)
  const margin = FRAMING_RULES.edgeMargin
  if (placed.x0 < margin || placed.x1 > 1 - margin || placed.y0 < margin || placed.y1 > 1 - margin) return { feasible: false, reason: 'FACE_TOO_CLOSE_TO_EDGE_AFTER_CLAMP', window, placed }
  if (placed.y0 < FRAMING_RULES.ctaBottom[format] + FRAMING_RULES.ctaClearance) return { feasible: false, reason: 'FACE_UNDER_CTA_BLOCK', window, placed }
  return { feasible: true, window, placed, upscale }
}

/** The lost-crop window: the good window shifted along one axis, in a fixed order, until only `lostCropVisibleShare` of the face is left. */
export function lostWindow(face, good, format, source) {
  const share = FRAMING_RULES.lostCropVisibleShare
  const faceWidth = face.x1 - face.x0, faceHeight = face.y1 - face.y0
  const candidates = [
    { axis: 'x', direction: '+x', position: face.x0 + (1 - share) * faceWidth },
    { axis: 'x', direction: '-x', position: face.x0 + share * faceWidth - good.width },
    { axis: 'y', direction: '+y', position: face.y0 + (1 - share) * faceHeight },
    { axis: 'y', direction: '-y', position: face.y0 + share * faceHeight - good.height },
  ]
  for (const candidate of candidates) {
    const size = candidate.axis === 'x' ? good.width : good.height
    if (candidate.position < -1e-9 || candidate.position > 1 - size + 1e-9) continue
    const window = candidate.axis === 'x' ? { ...good, x: candidate.position } : { ...good, y: candidate.position }
    const placed = toOutput(face, window)
    const visible = visibleShare(placed)
    if (Math.abs(visible - share) <= 0.02) return { feasible: true, window, placed, direction: candidate.direction, visibleShare: visible }
  }
  return { feasible: false, reason: 'NO_AXIS_REACHES_THE_LOST_SHARE' }
}

/** The caption bands (canvas-normalized rects) of a format, as the preset derives them. */
export function bandsOf(format, derived) {
  return Object.fromEntries(Object.entries(derived).map(([name, band]) => [name, rect(band.x, band.y, band.x + band.width, band.y + band.height)]))
}

/** Whether a band covers the framed face under the rules, and the first band of the preference order that does. */
export function coveringBands(placed, bands) {
  const centreX = (placed.x0 + placed.x1) / 2
  const [low, high] = FRAMING_RULES.bandCoverFaceCentreXRange
  return PREFERENCE.filter((name) => {
    const band = bands[name]
    const overlap = Math.max(0, Math.min(band.y1, placed.y1) - Math.max(band.y0, placed.y0))
    return centreX >= low && centreX <= high && overlap / (band.y1 - band.y0) >= FRAMING_RULES.bandCoverShare
  })
}

/** Every band whose rect intersects the framed face rect at all: the bands a correct detector would make the solver avoid. */
export function intersectingBands(placed, bands) {
  return PREFERENCE.filter((name) => area(inter(bands[name], placed)) > 0)
}

/** Full framing plan of one image in one format, or the reason it cannot be framed. */
export function framingOf(face, format, source, bands) {
  const good = goodWindow(face, format, source)
  if (!good.feasible) return { feasible: false, stage: 'good', ...good }
  const lost = lostWindow(face, good.window, format, source)
  if (!lost.feasible) return { feasible: false, stage: 'lost', ...lost }
  const covering = coveringBands(good.placed, bands)
  if (covering.length === 0) return { feasible: false, stage: 'caption-defect', reason: 'NO_BAND_COVERS_THE_FACE' }
  const bottomRect = bands.bottom
  if (good.placed.y1 > bottomRect.y0 - FRAMING_RULES.bottomBandClearance) return { feasible: false, stage: 'clean-caption', reason: 'FACE_REACHES_THE_BOTTOM_BAND' }
  const target = covering[0]
  const blockers = PREFERENCE.slice(0, PREFERENCE.indexOf(target))
  return { feasible: true, good, lost, target, blockers, covering, intersecting: intersectingBands(good.placed, bands) }
}
