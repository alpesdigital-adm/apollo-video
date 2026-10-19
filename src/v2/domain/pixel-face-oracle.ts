import { createHash } from 'node:crypto'

import { calculateCanonicalHash } from './canonical-hash.ts'
import { decodeFace0204Output, FACE0204_OUTPUT_BYTES, FACE0204_OUTPUT_POLICY_ID, FACE0204_OUTPUT_POLICY_SHA256 } from './face-detector-output.ts'
import type { NormalizedBounds } from './output-spec.ts'

/**
 * W67. The face oracle of the MP4 critic: a UNION of two independent Open Model Zoo detectors read on the pixels of one frame.
 *
 * - `omz-face-detection-0204-v9` is the detector the product itself runs (owner-accepted V9, score floor 0.50);
 * - `omz-face-detection-retail-0004` is a second, architecturally different detector (SSD, 300x300), score floor 0.50 - the operating
 *   point preregistered in W61 V7 and never changed.
 *
 * Neither is a ground truth and neither is tuned here. The critic protects the union of what they find, and says `unknown` when
 * neither finds anything: the absence of a detection is never the absence of a face. Both decoders are TypeScript twins of the
 * literal V9 rules, applied to the raw tensors the bridge returns, so a bridge that disagrees with them cannot publish a box.
 */
export const PIXEL_ORACLE_PROTOCOL = 'apollo-pixel-oracle/v1' as const
export const PIXEL_ORACLE_SCORE_FLOOR = 0.5 as const
export const RETAIL0004_OUTPUT_BYTES = FACE0204_OUTPUT_BYTES

export const PIXEL_ORACLE_MODELS = Object.freeze({
  v9: Object.freeze({
    id: 'omz-face-detection-0204-v9' as const,
    role: 'product-detector' as const,
    family: 'OpenVINO Open Model Zoo face-detection-0204 FP32 (MobileNetV2 SSD)',
    xmlSha256: '33394c03a4c88cbcd2537c5d232c149b69f2a7ad406d85d2323d7303f17d7ee3',
    binSha256: '0bbc0e08b297ce385b67ad742fd7612947e855c8f50c625b94835f883a6e4102',
    xmlBytes: 185457,
    binBytes: 7269196,
    inputSize: 448,
    faceLabel: 0,
    scoreFloor: PIXEL_ORACLE_SCORE_FLOOR,
    outputPolicyId: FACE0204_OUTPUT_POLICY_ID,
    outputPolicySha256: FACE0204_OUTPUT_POLICY_SHA256,
    licence: 'Apache-2.0',
    licenceSha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
    sourceCommit: 'eda1863a6d60b09551df9d039cff2377d6ddd4d6',
  }),
  retail: Object.freeze({
    id: 'omz-face-detection-retail-0004' as const,
    role: 'independent-second-detector' as const,
    family: 'OpenVINO Open Model Zoo face-detection-retail-0004 FP32 (SqueezeNet SSD)',
    xmlSha256: '90922d199016d18128bdaba488bdb1628fce50efcc81155ede7949cbba3dd979',
    binSha256: '89349ce12dd21c5263fb302cd3ffd4b73c35ea12ed98aff863d03a2cf3a32464',
    xmlBytes: 105340,
    binBytes: 2352984,
    inputSize: 300,
    faceLabel: 1,
    scoreFloor: PIXEL_ORACLE_SCORE_FLOOR,
    outputPolicyId: 'w67-ssd-visible-intersection-continuous/v1',
    // The V9 rules, label 1 (documented below); the V7 evaluator treated a box outside [0,1] as a failed image, this decoder keeps the
    // visible intersection as the V9 policy does. The score floor, the model and the preprocessing are the V7 preregistration.
    outputPolicySha256: calculateCanonicalHash({
      id: 'w67-ssd-visible-intersection-continuous/v1', imageId: 0, label: 1, scoreFloor: PIXEL_ORACLE_SCORE_FLOOR,
      validation: 'score-on-every-slot, image-id-label-and-box-on-selected-slots', boxes: 'visible-intersection-with-frame', invalidSelectedSlot: 'frame-unknown',
    }),
    licence: 'Apache-2.0',
    licenceSha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
    sourceCommit: 'eda1863a6d60b09551df9d039cff2377d6ddd4d6',
    v7PreregistrationSha256: '1c813d9e044b7928e74f35a31040aba0f1d4513792faf33f438adaea2539614b',
  }),
})
export type PixelOracleModelKey = keyof typeof PIXEL_ORACLE_MODELS
export type PixelOracleModelId = (typeof PIXEL_ORACLE_MODELS)[PixelOracleModelKey]['id']

export type OracleFaceBox = Readonly<{ box: Readonly<NormalizedBounds>; confidence: number; clipped: boolean }>
export type OracleModelReading = Readonly<
  | { modelId: PixelOracleModelId; status: 'observed'; boxes: readonly OracleFaceBox[]; rawOutputSha256: string }
  | { modelId: PixelOracleModelId; status: 'unknown'; reason: string; boxes: readonly []; rawOutputSha256: string | null }
>

export function tensorSha256(raw: Uint8Array): string {
  return createHash('sha256').update(raw).digest('hex')
}

/**
 * Decodes the `[1,1,200,7]` float32 tensor of face-detection-retail-0004 with the V7 evaluator's validation and the V9 box rule: padding
 * slots (image id -1) are skipped, every other slot needs a finite score in [0,1]; a slot at or above the floor needs image id 0, label 1 and
 * four finite coordinates with xmin < xmax and ymin < ymax and a positive intersection with the frame, which replaces the box. One invalid
 * selected slot makes the frame unknown, never empty.
 */
export function decodeRetail0004Output(raw: Uint8Array, scoreFloor: number = PIXEL_ORACLE_SCORE_FLOOR): OracleModelReading {
  const unknown = (reason: string): OracleModelReading => Object.freeze({
    modelId: PIXEL_ORACLE_MODELS.retail.id, status: 'unknown' as const, reason, boxes: Object.freeze([]) as readonly [],
    rawOutputSha256: raw instanceof Uint8Array ? tensorSha256(raw) : null,
  })
  if (!(raw instanceof Uint8Array) || raw.byteLength !== RETAIL0004_OUTPUT_BYTES) return unknown('DETECTOR_OUTPUT_SIZE_INVALID')
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const boxes: OracleFaceBox[] = []
  for (let slot = 0; slot < 200; slot += 1) {
    const row: number[] = []
    for (let index = 0; index < 7; index += 1) row.push(view.getFloat32((slot * 7 + index) * 4, true))
    const [imageId, label, score, ...coordinates] = row as [number, number, number, number, number, number, number]
    if (!Number.isFinite(imageId)) return unknown('DETECTOR_IMAGE_ID_INVALID')
    if (imageId === -1) continue
    // As the preregistered V7 evaluator does: every slot needs a finite score in [0,1]; the image id and the label are checked on the
    // slots at or above the floor, which are the ones that become boxes.
    if (!Number.isFinite(score) || score < 0 || score > 1) return unknown('DETECTOR_SCORE_INVALID')
    if (score < scoreFloor) continue
    if (imageId !== 0) return unknown('DETECTOR_IMAGE_ID_INVALID')
    if (!Number.isFinite(label) || label !== PIXEL_ORACLE_MODELS.retail.faceLabel) return unknown('DETECTOR_LABEL_INVALID')
    if (!coordinates.every(Number.isFinite)) return unknown('DETECTOR_FACE_BOX_NONFINITE_OR_SHAPE')
    const [xmin, ymin, xmax, ymax] = coordinates as [number, number, number, number]
    if (!(xmin < xmax && ymin < ymax)) return unknown('DETECTOR_FACE_BOX_REVERSED_OR_ZERO_AREA')
    const visible = [Math.max(0, xmin), Math.max(0, ymin), Math.min(1, xmax), Math.min(1, ymax)] as const
    if (!(visible[0] < visible[2] && visible[1] < visible[3])) return unknown('DETECTOR_FACE_BOX_EMPTY_INTERSECTION')
    boxes.push(Object.freeze({
      box: Object.freeze({ x: visible[0], y: visible[1], width: visible[2] - visible[0], height: visible[3] - visible[1] }),
      confidence: score, clipped: visible[0] !== xmin || visible[1] !== ymin || visible[2] !== xmax || visible[3] !== ymax,
    }))
  }
  return Object.freeze({ modelId: PIXEL_ORACLE_MODELS.retail.id, status: 'observed' as const, boxes: Object.freeze(boxes), rawOutputSha256: tensorSha256(raw) })
}

/** The V9 policy at the oracle's operating point, as an oracle reading. */
export function decodeV9Output(raw: Uint8Array, scoreFloor: number = PIXEL_ORACLE_SCORE_FLOOR): OracleModelReading {
  const decoded = decodeFace0204Output(raw, scoreFloor)
  const rawOutputSha256 = raw instanceof Uint8Array ? tensorSha256(raw) : null
  if (decoded.status === 'failed') {
    return Object.freeze({ modelId: PIXEL_ORACLE_MODELS.v9.id, status: 'unknown' as const, reason: decoded.reason, boxes: Object.freeze([]) as readonly [], rawOutputSha256 })
  }
  return Object.freeze({
    modelId: PIXEL_ORACLE_MODELS.v9.id, status: 'observed' as const, rawOutputSha256: rawOutputSha256!,
    boxes: Object.freeze(decoded.detections.map((detection) => Object.freeze({
      box: Object.freeze({
        x: detection.boxXYXY[0], y: detection.boxXYXY[1],
        width: detection.boxXYXY[2] - detection.boxXYXY[0], height: detection.boxXYXY[3] - detection.boxXYXY[1],
      }),
      confidence: detection.confidence, clipped: detection.clipped,
    }))),
  })
}

export type UnionFace = Readonly<{ box: Readonly<NormalizedBounds>; models: readonly PixelOracleModelId[]; confidence: number; clipped: boolean }>
export type UnionReading = Readonly<{
  /** `observed`: at least one model read the frame; `unknown`: no model could read it (every reading failed). */
  status: 'observed' | 'unknown'
  /** Every box either model reports, the protected region of the frame. Boxes are not merged: each protects what its detector saw. */
  faces: readonly UnionFace[]
  readings: readonly OracleModelReading[]
}>

/** Union of the model readings of one frame. A model that failed contributes no box and is listed as unknown, never as empty. */
export function unionOracleReadings(readings: readonly OracleModelReading[]): UnionReading {
  const faces: UnionFace[] = []
  for (const reading of readings) {
    if (reading.status !== 'observed') continue
    for (const detection of reading.boxes) {
      faces.push(Object.freeze({ box: detection.box, models: Object.freeze([reading.modelId]), confidence: detection.confidence, clipped: detection.clipped }))
    }
  }
  const observed = readings.some((reading) => reading.status === 'observed')
  return Object.freeze({ status: observed ? 'observed' as const : 'unknown' as const, faces: Object.freeze(faces), readings: Object.freeze([...readings]) })
}

export const pixelOracleModelPins = () => Object.freeze(Object.values(PIXEL_ORACLE_MODELS).map((model) => Object.freeze({
  id: model.id, role: model.role, xmlSha256: model.xmlSha256, binSha256: model.binSha256, xmlBytes: model.xmlBytes, binBytes: model.binBytes,
  inputSize: model.inputSize, faceLabel: model.faceLabel, scoreFloor: model.scoreFloor, outputPolicyId: model.outputPolicyId,
  outputPolicySha256: model.outputPolicySha256, licence: model.licence, licenceSha256: model.licenceSha256, sourceCommit: model.sourceCommit,
})))
