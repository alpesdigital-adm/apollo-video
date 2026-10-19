import { createHash } from 'node:crypto'

/**
 * Literal TypeScript twin of the owner-accepted V9 output policy `w62-v9-visible-intersection-continuous/v1`
 * (provider `w62-evaluate-openvino0204-v9.py`, policy SHA-256 a3c641fd…cad03), applied to the raw
 * `[1,1,200,7]` float32 tensor of OMZ face-detection-0204.
 *
 * All 200 slots are walked without a break. A slot with image_id -1 is padding. Every other slot must carry
 * image_id 0, label 0 and a finite score in [0,1] before the threshold applies. A slot at or above the floor
 * must hold four finite coordinates with xmin < xmax and ymin < ymax and a strictly positive intersection with
 * the frame; the box is replaced by that intersection (no epsilon, no rounding). `clipped` is true iff a
 * coordinate changed numerically. One invalid selected slot invalidates the whole frame: it is never an
 * absence of faces and never repaired.
 *
 * The product persists every detection from `collectionScoreFloor` (0.20); the V9 subset (score >= 0.50) is
 * a filter of that list. Raising the floor to 0.50 reproduces V9 exactly.
 */
export const FACE0204_OUTPUT_POLICY_ID = 'w62-v9-visible-intersection-continuous/v1' as const
export const FACE0204_OUTPUT_POLICY_SHA256 = 'a3c641fd9f17c07873ce33a6d655001bddbdbed5c4f72351ce9718ee9cacad03' as const
export const FACE0204_OUTPUT_BYTES = 5600
export const FACE0204_OUTPUT_SLOTS = 200
const ROW_FLOATS = 7
const EDGES = ['left', 'top', 'right', 'bottom'] as const

export type Face0204Failure = Readonly<{
  status: 'failed'
  reason: 'DETECTOR_OUTPUT_SIZE_INVALID' | 'DETECTOR_IMAGE_ID_INVALID' | 'DETECTOR_LABEL_INVALID' |
    'DETECTOR_SCORE_INVALID' | 'DETECTOR_FACE_BOX_NONFINITE_OR_SHAPE' |
    'DETECTOR_FACE_BOX_REVERSED_OR_ZERO_AREA' | 'DETECTOR_FACE_BOX_EMPTY_INTERSECTION'
  slot: number | null
}>
export type Face0204Detection = Readonly<{
  slotIndex: number
  confidence: number
  rawXYXY: readonly [number, number, number, number]
  /** Continuous intersection with the frame, normalized [left, top, right, bottom]. */
  boxXYXY: readonly [number, number, number, number]
  clipped: boolean
  boundaryChanges: readonly (typeof EDGES[number])[]
}>
export type Face0204Decoded = Readonly<{ status: 'decoded'; detections: readonly Face0204Detection[] }>

export function face0204OutputSha256(raw: Uint8Array): string {
  return createHash('sha256').update(raw).digest('hex')
}

export function decodeFace0204Output(raw: Uint8Array, scoreFloor: number): Face0204Decoded | Face0204Failure {
  if (!(raw instanceof Uint8Array) || raw.byteLength !== FACE0204_OUTPUT_BYTES ||
      !Number.isFinite(scoreFloor) || scoreFloor < 0 || scoreFloor > 1) {
    return Object.freeze({ status: 'failed', reason: 'DETECTOR_OUTPUT_SIZE_INVALID', slot: null })
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const detections: Face0204Detection[] = []
  const fail = (reason: Face0204Failure['reason'], slot: number): Face0204Failure =>
    Object.freeze({ status: 'failed', reason, slot })
  for (let slot = 0; slot < FACE0204_OUTPUT_SLOTS; slot += 1) {
    const row: number[] = []
    for (let index = 0; index < ROW_FLOATS; index += 1) row.push(view.getFloat32((slot * ROW_FLOATS + index) * 4, true))
    const [imageId, label, score, ...box] = row as [number, number, number, number, number, number, number]
    if (!Number.isFinite(imageId)) return fail('DETECTOR_IMAGE_ID_INVALID', slot)
    if (imageId === -1) continue // Padding of this slot only; never a stop at the first padding.
    if (imageId !== 0) return fail('DETECTOR_IMAGE_ID_INVALID', slot)
    if (!Number.isFinite(label) || label !== 0) return fail('DETECTOR_LABEL_INVALID', slot)
    if (!Number.isFinite(score) || score < 0 || score > 1) return fail('DETECTOR_SCORE_INVALID', slot)
    if (score < scoreFloor) continue
    if (!box.every(Number.isFinite)) return fail('DETECTOR_FACE_BOX_NONFINITE_OR_SHAPE', slot)
    const [xmin, ymin, xmax, ymax] = box as [number, number, number, number]
    if (!(xmin < xmax && ymin < ymax)) return fail('DETECTOR_FACE_BOX_REVERSED_OR_ZERO_AREA', slot)
    const visible: [number, number, number, number] = [Math.max(0, xmin), Math.max(0, ymin), Math.min(1, xmax), Math.min(1, ymax)]
    if (!(visible[0] < visible[2] && visible[2] <= 1 && visible[1] < visible[3] && visible[3] <= 1 && visible[0] >= 0 && visible[1] >= 0)) {
      return fail('DETECTOR_FACE_BOX_EMPTY_INTERSECTION', slot)
    }
    const raws: [number, number, number, number] = [xmin, ymin, xmax, ymax]
    const boundaryChanges = EDGES.filter((_edge, index) => raws[index] !== visible[index])
    detections.push(Object.freeze({
      slotIndex: slot, confidence: score, rawXYXY: Object.freeze(raws), boxXYXY: Object.freeze(visible),
      clipped: boundaryChanges.length > 0, boundaryChanges: Object.freeze(boundaryChanges),
    }))
  }
  return Object.freeze({ status: 'decoded', detections: Object.freeze(detections) })
}
