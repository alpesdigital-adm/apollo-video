import { calculateCanonicalHash } from './canonical-hash.ts'
import { FACE_EVIDENCE_POLICY, FACE_EVIDENCE_POLICY_SHA256 } from './face-evidence-policy.ts'

/**
 * `reframe-policy/v1` (W66r): every number the automatic reframe trajectory is allowed to use, in one frozen object whose
 * SHA-256 is sealed into the plan it produced. A plan carries the hash, never a loose copy of a limit, so a reader can
 * tell exactly which rules produced a crop and a change of any limit is a new policy with a new hash.
 *
 * Where each value comes from:
 * - `tracking.*` are the limits `createReframePlan` already shipped with (0.35 per second, 0.8 per second squared, 0.02
 *   margin, 0.6 confidence). They are NOT loosened here; they only moved into the sealed object.
 * - `roi.face.*` are read from the pinned face evidence policy (owner-accepted V9 operating point), so a change of that
 *   policy changes this policy's hash.
 * - Everything else is a W66r design decision and is classified as such below. None of it is a qualification: the
 *   numbers were chosen to be conservative, not measured on real video.
 */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

export const REFRAME_ISSUE_CODES = ['PERCEPTION_UNCERTAIN', 'SUBJECTS_DO_NOT_FIT', 'NO_SUBJECT_OBSERVATION', 'TRACKING_LIMIT_EXCEEDED'] as const
export type ReframeIssueCode = (typeof REFRAME_ISSUE_CODES)[number]
/** What an issue does to its variant: `blocked` keeps export closed until resolved, `review-required` asks a person to look. */
export type ReframeIssueDisposition = 'blocked' | 'review-required'
export type ReframeVariantDisposition = 'ready' | ReframeIssueDisposition

export const REFRAME_POLICY = deepFreeze({
  schemaVersion: 'reframe-policy/v1' as const,
  id: 'w66r-reframe-trajectory/v1' as const,
  tracking: {
    maxVelocityPerSecond: 0.35,
    maxAccelerationPerSecondSquared: 0.8,
    /** Normalized source units kept free around every subject on every side. */
    safetyMargin: 0.02,
    /** An observation under this confidence is reported as uncertain. */
    minObservationConfidence: 0.6,
    /** Velocity and acceleration are bounded for the automatic trajectory; the frame edge and a manual range are hard stops. */
    boundedBy: 'automatic-trajectory-only' as const,
  },
  roi: {
    face: {
      evidencePolicySha256: FACE_EVIDENCE_POLICY_SHA256,
      evidencePolicyId: FACE_EVIDENCE_POLICY.id,
      /** A box from this score up is an observation; under it the detection is not even a candidate. */
      includeScoreMin: FACE_EVIDENCE_POLICY.detection.collectionScoreFloor,
      /** Owner-accepted V9 literal: only a box from this score up must stay visible. */
      criticalScoreMin: FACE_EVIDENCE_POLICY.evidence.scoreMin,
      foregroundMinHeightFraction: FACE_EVIDENCE_POLICY.evidence.foregroundMinHeightFraction,
      priority: 100,
      /** Two boxes of consecutive samples are one subject when their IoU reaches this... */
      pairingMinIou: FACE_EVIDENCE_POLICY.evidence.track.associationMinIou,
      /** ...or their centres are no further apart than this many heights of the taller box. No identity is claimed. */
      pairingMaxCenterDistanceBoxHeights: 1,
    },
    /** No verified detector exists for objects. An absent ROI is reported as such and never guessed. */
    object: { status: 'absent' as const, reasonCode: 'NO_VERIFIED_DETECTOR' as const },
    /** No verified producer exists for screens. A screen-only clip has no ROI and falls back to the whole frame. */
    screen: { status: 'absent' as const, reasonCode: 'NO_VERIFIED_PRODUCER' as const },
    interpolation: {
      /** The stride is the face sample interval of the timeline's frame rate; a gap is measured in strides. */
      strideBasis: 'face-sample-interval-frames' as const,
      maxGapStrides: 1,
      acrossCuts: false as const,
      acrossUnknownSamples: false as const,
      acrossWindowGaps: false as const,
      acrossUntrustedEvidence: false as const,
      /** A sample is held at most `stride - 1` frames beyond itself, and only inside its own clip. */
      holdAfterSampleFrames: 'stride-1' as const,
    },
  },
  render: {
    /** The renderer encodes one contiguous keyframed range per clip, at most this many keyframes. */
    maxKeyframesPerRange: 600,
    /** Tolerance, in normalized source units, a simplified trajectory may differ from the exact one (verified, never assumed). */
    keyframeSimplificationTolerance: 0.004,
    /** A part of a clip the plan cannot track is bridged by the trajectory; a clip with no tracked part is shown whole. */
    untrackedClip: 'contain-whole-clip' as const,
  },
  issueDisposition: {
    SUBJECTS_DO_NOT_FIT: 'blocked',
    TRACKING_LIMIT_EXCEEDED: 'blocked',
    PERCEPTION_UNCERTAIN: 'review-required',
    NO_SUBJECT_OBSERVATION: 'review-required',
  } satisfies Record<ReframeIssueCode, ReframeIssueDisposition>,
  parameterBasis: {
    'tracking.maxVelocityPerSecond': 'inherited-from-createReframePlan-v1',
    'tracking.maxAccelerationPerSecondSquared': 'inherited-from-createReframePlan-v1',
    'tracking.safetyMargin': 'inherited-from-createReframePlan-v1',
    'tracking.minObservationConfidence': 'inherited-from-createReframePlan-v1',
    'roi.face': 'pinned-face-evidence-policy',
    'roi.interpolation': 'w66r-design-decision-unmeasured',
    'render.maxKeyframesPerRange': 'renderer-limit',
    'render.keyframeSimplificationTolerance': 'w66r-design-decision-unmeasured',
    'issueDisposition': 'w66r-design-decision',
  },
  claims: {
    qualification: false as const,
    faceSafety: 'unknown' as const,
    realVideoMeasurement: 'not-performed' as const,
  },
})

export type ReframePolicyV1 = typeof REFRAME_POLICY
export const REFRAME_POLICY_SHA256 = calculateCanonicalHash(REFRAME_POLICY)

/** True when `value` is exactly the pinned policy: an object with its id and hash is not enough, the content is compared. */
export function isPinnedReframePolicy(value: unknown): value is ReframePolicyV1 {
  try { return calculateCanonicalHash(value) === REFRAME_POLICY_SHA256 } catch { return false }
}

export function reframeIssueDisposition(code: ReframeIssueCode): ReframeIssueDisposition {
  return REFRAME_POLICY.issueDisposition[code]
}

/** The state of a variant given the codes of the issues that remain on it. */
export function reframeVariantDisposition(codes: readonly ReframeIssueCode[]): ReframeVariantDisposition {
  if (codes.some((code) => reframeIssueDisposition(code) === 'blocked')) return 'blocked'
  return codes.length > 0 ? 'review-required' : 'ready'
}
