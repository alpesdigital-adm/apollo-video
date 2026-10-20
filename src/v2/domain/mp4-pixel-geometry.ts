import { MP4_PIXEL_CRITIC_POLICY, type InkFacts, type RegistrationFacts, type SubjectFacts } from './mp4-pixel-quality.ts'
import type { NormalizedBounds } from './output-spec.ts'

/**
 * W67. The pixel arithmetic of the MP4 critic, free of any file or process so each rule can be tested on its own.
 *
 * Ink is the set of pixels that differ between the delivered frame and the control encode of the same input without the overlay.
 * Registration relates a SOURCE frame to the OUTPUT frame by a similarity transform measured on their pixels; it is how the critic
 * knows where the source's faces are in the output without trusting the crop the renderer was given.
 */
export type RegistrationMeasurement = Readonly<{
  status: 'ok' | 'failed'
  reason: string | null
  matches: number
  inliers: number
  matrix: readonly [readonly [number, number, number], readonly [number, number, number]] | null
  medianResidualPixels: number | null
  scale: number | null
  rotationDegrees: number | null
}>
export type Box4 = Readonly<{ x0: number; y0: number; x1: number; y1: number }>

const luma = (rgb: Uint8Array, offset: number): number => (299 * rgb[offset]! + 587 * rgb[offset + 1]! + 114 * rgb[offset + 2]!) / 1000

/** Pixels whose luma moved by more than the threshold, before any neighbour rule: the codec noise floor shows up here. */
export function rawLumaChangedPixels(delivered: Uint8Array, control: Uint8Array, width: number, height: number, threshold: number): number {
  let count = 0
  for (let index = 0; index < width * height; index += 1) {
    if (Math.abs(luma(delivered, index * 3) - luma(control, index * 3)) > threshold) count += 1
  }
  return count
}

/**
 * The ink of one overlay on one frame: pixels that moved by more than `lumaThresholdLevels` AND have at least
 * `minChangedNeighboursOfFour` of their four neighbours moved too. Fewer survivors than `minInkPixels` means the overlay is absent.
 */
export function measureInk(delivered: Uint8Array, control: Uint8Array, width: number, height: number, policy = MP4_PIXEL_CRITIC_POLICY.ink): Readonly<{
  facts: InkFacts
  mask: Uint8Array | null
}> {
  const changed = new Uint8Array(width * height)
  for (let index = 0; index < width * height; index += 1) {
    if (Math.abs(luma(delivered, index * 3) - luma(control, index * 3)) > policy.lumaThresholdLevels) changed[index] = 1
  }
  const mask = new Uint8Array(width * height)
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0, edge = false
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      if (!changed[index]) continue
      const neighbours = (x > 0 ? changed[index - 1]! : 0) + (x < width - 1 ? changed[index + 1]! : 0) +
        (y > 0 ? changed[index - width]! : 0) + (y < height - 1 ? changed[index + width]! : 0)
      if (neighbours < policy.minChangedNeighboursOfFour) continue
      mask[index] = 1
      count += 1
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) edge = true
    }
  }
  if (count < policy.minInkPixels) return Object.freeze({ facts: Object.freeze({ pixels: 0, bbox: null, touchesCanvasEdge: false }), mask: null })
  return Object.freeze({
    facts: Object.freeze({ pixels: count, bbox: Object.freeze({ x0: minX, y0: minY, x1: maxX, y1: maxY }), touchesCanvasEdge: edge }),
    mask,
  })
}

/** A normalized box as an integer pixel rectangle `[x0, x1) x [y0, y1)` on the canvas, grown by `marginPixels` and clipped to it. */
export function pixelRectOf(box: Readonly<NormalizedBounds>, width: number, height: number, marginPixels: number): Readonly<{ x0: number; y0: number; x1: number; y1: number }> {
  return Object.freeze({
    x0: Math.max(0, Math.floor(box.x * width - marginPixels)),
    y0: Math.max(0, Math.floor(box.y * height - marginPixels)),
    x1: Math.min(width, Math.ceil((box.x + box.width) * width + marginPixels)),
    y1: Math.min(height, Math.ceil((box.y + box.height) * height + marginPixels)),
  })
}

/** Bit-packs a 0/1 mask (row-major) so a few hundred sampled frames stay in memory. */
export function packMask(mask: Uint8Array): Uint8Array {
  const packed = new Uint8Array(Math.ceil(mask.length / 8))
  for (let index = 0; index < mask.length; index += 1) if (mask[index]) packed[index >> 3]! |= 1 << (index & 7)
  return packed
}

export function countPackedMaskInRect(packed: Uint8Array | null, width: number, rect: Readonly<{ x0: number; y0: number; x1: number; y1: number }>): number {
  if (packed === null) return 0
  let count = 0
  for (let y = rect.y0; y < rect.y1; y += 1) {
    const row = y * width
    for (let x = rect.x0; x < rect.x1; x += 1) {
      const index = row + x
      count += (packed[index >> 3]! >> (index & 7)) & 1
    }
  }
  return count
}

export function countMaskInRect(mask: Uint8Array | null, width: number, rect: Readonly<{ x0: number; y0: number; x1: number; y1: number }>): number {
  if (mask === null) return 0
  let count = 0
  for (let y = rect.y0; y < rect.y1; y += 1) {
    const row = y * width
    for (let x = rect.x0; x < rect.x1; x += 1) count += mask[row + x]!
  }
  return count
}

/** Whether a registration is trustworthy under the policy's gates; the reason names the first gate it fails. */
export function registrationFacts(measurement: RegistrationMeasurement, policy = MP4_PIXEL_CRITIC_POLICY.registration): Readonly<{ facts: RegistrationFacts; usable: boolean }> {
  const ratio = measurement.matches > 0 ? measurement.inliers / measurement.matches : 0
  let reason: string | null = measurement.status === 'ok' ? null : (measurement.reason ?? 'REGISTRATION_FAILED')
  if (reason === null) {
    if (measurement.inliers < policy.minInliers) reason = 'TOO_FEW_INLIERS'
    else if (ratio < policy.minInlierRatio) reason = 'INLIER_RATIO_TOO_LOW'
    else if (measurement.medianResidualPixels === null || measurement.medianResidualPixels > policy.maxMedianResidualPixels) reason = 'RESIDUAL_TOO_HIGH'
    else if (measurement.scale === null || measurement.scale < policy.minScale || measurement.scale > policy.maxScale) reason = 'SCALE_OUT_OF_RANGE'
    else if (measurement.rotationDegrees === null || Math.abs(measurement.rotationDegrees) > policy.maxRotationDegrees) reason = 'ROTATION_OUT_OF_RANGE'
  }
  return Object.freeze({
    usable: reason === null,
    facts: Object.freeze({
      status: reason === null ? 'ok' as const : 'failed' as const, reason, matches: measurement.matches, inliers: measurement.inliers, inlierRatio: ratio,
      medianResidualPixels: measurement.medianResidualPixels, scale: measurement.scale, rotationDegrees: measurement.rotationDegrees,
    }),
  })
}

/** Maps a source-normalized box through the registration into output-normalized coordinates (unclipped bounding box of its four corners). */
export function projectSourceBox(
  matrix: NonNullable<RegistrationMeasurement['matrix']>,
  source: Readonly<{ width: number; height: number }>,
  output: Readonly<{ width: number; height: number }>,
  box: Readonly<NormalizedBounds>,
): Box4 {
  const corners = [[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]] as const
  const mapped = corners.map(([nx, ny]) => {
    const px = nx * source.width, py = ny * source.height
    return [(matrix[0][0] * px + matrix[0][1] * py + matrix[0][2]) / output.width, (matrix[1][0] * px + matrix[1][1] * py + matrix[1][2]) / output.height] as const
  })
  return Object.freeze({
    x0: Math.min(...mapped.map(([x]) => x)), y0: Math.min(...mapped.map(([, y]) => y)),
    x1: Math.max(...mapped.map(([x]) => x)), y1: Math.max(...mapped.map(([, y]) => y)),
  })
}

export const clipToCanvas = (box: Box4): Box4 => Object.freeze({ x0: Math.max(0, box.x0), y0: Math.max(0, box.y0), x1: Math.min(1, box.x1), y1: Math.min(1, box.y1) })
const area = (box: Box4) => Math.max(0, box.x1 - box.x0) * Math.max(0, box.y1 - box.y0)

/** Fraction of a box's area that lies inside the canvas [0,1]x[0,1]. */
export function visibleFractionOf(box: Box4): number {
  const total = area(box)
  return total > 0 ? area(clipToCanvas(box)) / total : 0
}

export function iou(left: Box4, right: Box4): number {
  const intersection = area({ x0: Math.max(left.x0, right.x0), y0: Math.max(left.y0, right.y0), x1: Math.min(left.x1, right.x1), y1: Math.min(left.y1, right.y1) })
  const union = area(left) + area(right) - intersection
  return union > 0 ? intersection / union : 0
}

export const boxOf = (bounds: Readonly<NormalizedBounds>): Box4 => Object.freeze({ x0: bounds.x, y0: bounds.y, x1: bounds.x + bounds.width, y1: bounds.y + bounds.height })
export const boundsOf = (box: Box4): Readonly<NormalizedBounds> => Object.freeze({ x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 })

/** The subject facts of one sample, from the source detections, the registration and the output detections. */
export function measureSubject(input: Readonly<{
  sourceFrameAvailable: boolean
  sourceOracle: 'observed' | 'unknown' | 'absent'
  sourceFaces: readonly Readonly<NormalizedBounds>[]
  registration: RegistrationMeasurement | null
  sourceDimensions: Readonly<{ width: number; height: number }> | null
  outputDimensions: Readonly<{ width: number; height: number }>
  outputFaces: readonly Readonly<NormalizedBounds>[]
  policy?: typeof MP4_PIXEL_CRITIC_POLICY
}>): Readonly<{ subject: SubjectFacts; registration: RegistrationFacts | null; projectedSourceFaces: readonly Readonly<NormalizedBounds>[]; projectedSourceFaceIndices: readonly number[]; mappedSourceFaces: number }> {
  const policy = input.policy ?? MP4_PIXEL_CRITIC_POLICY
  if (!input.sourceFrameAvailable) return Object.freeze({ subject: Object.freeze({ state: 'not-applicable' as const, reason: 'NO_SOURCE_FRAME' as const }), registration: null, projectedSourceFaces: Object.freeze([]), projectedSourceFaceIndices: Object.freeze([]), mappedSourceFaces: 0 })
  if (input.sourceOracle === 'unknown') return Object.freeze({ subject: Object.freeze({ state: 'unknown' as const, reason: 'SOURCE_FACE_ORACLE_UNREADABLE' }), registration: null, projectedSourceFaces: Object.freeze([]), projectedSourceFaceIndices: Object.freeze([]), mappedSourceFaces: 0 })
  if (input.sourceFaces.length === 0) return Object.freeze({ subject: Object.freeze({ state: 'not-applicable' as const, reason: 'NO_SOURCE_FACE' as const }), registration: null, projectedSourceFaces: Object.freeze([]), projectedSourceFaceIndices: Object.freeze([]), mappedSourceFaces: 0 })
  if (!input.registration || !input.sourceDimensions) {
    return Object.freeze({ subject: Object.freeze({ state: 'unknown' as const, reason: 'REGISTRATION_NOT_ATTEMPTED' }), registration: null, projectedSourceFaces: Object.freeze([]), projectedSourceFaceIndices: Object.freeze([]), mappedSourceFaces: 0 })
  }
  const registration = registrationFacts(input.registration, policy.registration)
  if (!registration.usable || !input.registration.matrix) {
    return Object.freeze({ subject: Object.freeze({ state: 'unknown' as const, reason: `REGISTRATION_${registration.facts.reason ?? 'FAILED'}` }), registration: registration.facts, projectedSourceFaces: Object.freeze([]), projectedSourceFaceIndices: Object.freeze([]), mappedSourceFaces: 0 })
  }
  const projected = input.sourceFaces.map((face) => projectSourceBox(input.registration!.matrix!, input.sourceDimensions!, input.outputDimensions, face))
  const primaryIndex = input.sourceFaces.reduce((best, face, index) => (face.width * face.height > input.sourceFaces[best]!.width * input.sourceFaces[best]!.height ? index : best), 0)
  const primary = projected[primaryIndex]!
  const kept = projected.map((box, index) => ({ index, bounds: boundsOf(clipToCanvas(box)) })).filter((entry) => entry.bounds.width > 0 && entry.bounds.height > 0)
  const visible = visibleFractionOf(primary)
  const inside = clipToCanvas(primary)
  const confirmed = input.outputFaces.some((face) => iou(inside, boxOf(face)) >= policy.subject.outputConfirmationMinIou)
  return Object.freeze({
    subject: Object.freeze({ state: 'measured' as const, visibleFraction: visible, outputConfirmed: confirmed, projected: primary }),
    registration: registration.facts,
    projectedSourceFaces: Object.freeze(kept.map((entry) => entry.bounds)),
    /** For each kept projected face, the index of the source face it came from (so a report can say which detector produced it). */
    projectedSourceFaceIndices: Object.freeze(kept.map((entry) => entry.index)),
    /** Every source face the registration projected (also those that fall outside the canvas): the faces the output frame can account for. */
    mappedSourceFaces: projected.length,
  })
}
