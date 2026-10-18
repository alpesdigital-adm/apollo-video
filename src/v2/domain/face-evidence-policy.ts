import { calculateCanonicalHash } from './canonical-hash.ts'

/**
 * Pinned, versioned operating point of the owner-accepted V9 face detector (W62).
 *
 * Every number is classified by where it comes from. Nothing here is a qualification: the analysis the
 * score floors rest on is post-hoc, on the adaptive development corpus, with wide intervals, and the real
 * video measurement is pending the W70 journey. The policy changes only by a new id and a new hash.
 */
export const FACE_V9_OWNER_ACCEPTANCE_DOCUMENT = 'docs/quality/w62-v9-owner-acceptance.md'
/** SHA-256 of the owner acceptance document the envelope binds. Editing the document breaks this constant. */
export const FACE_V9_OWNER_ACCEPTANCE_SHA256 = 'f9ca6ebca7ee2a8643955ebda6237b26c9a1949cac80b7473397887271910436'

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

export const FACE_EVIDENCE_POLICY = deepFreeze({
  schemaVersion: 'face-evidence-policy/v1' as const,
  id: 'w62-v9-foreground-evidence/v1' as const,
  /** The provider persists every detection at or above this score; the stricter evidence subset is derived on read. */
  detection: { collectionScoreFloor: 0.2 },
  /** Foreground faces and the speaker candidate: the subset the owner accepted (score >= 0.50, V9 literal). */
  evidence: {
    scoreMin: 0.5,
    /** A face is foreground when its box height is at least this fraction of the frame height. */
    foregroundMinHeightFraction: 0.1,
    aggregationWindowMs: 2000,
    /** A track is present when it is detected in at least `enter` of the analysed samples of the window, and stays
     * present until that share falls under `exit` (hysteresis). */
    persistence: { enter: 0.5, exit: 0.35 },
    minAnalysedSamplesInWindow: 3,
    track: { associationMinIou: 0.3, maxGapMs: 500 },
    speaker: {
      basis: 'largest-persistent-foreground-face' as const,
      /** A challenger replaces the incumbent only after holding this area ratio for this long. */
      switchAreaRatio: 1.25,
      switchHoldMs: 1000,
    },
  },
  /** Caption-area clearance: every detection from the floor up counts, foreground or not. */
  clearance: {
    scoreMin: 0.2,
    dilation: { largerSideFraction: 0.35, minFrameFraction: 0.015 },
    maxSampleGapMs: 500,
    /** Closed rectangles: a detection that merely touches the area occupies it. */
    boundaryTouchIsOverlap: true,
    states: ['free-certified', 'occupied', 'unknown'] as const,
    /** Unauthenticated or mismatched evidence is `unknown`; an overlap in authenticated evidence is `occupied`
     * even when other samples are missing; `free-certified` needs complete coverage and no overlap. */
    precedence: ['unauthenticated-evidence:unknown', 'overlap:occupied', 'incomplete-coverage:unknown', 'free-certified'] as const,
  },
  sampling: { targetHz: 6, maxSamplesPerWindow: 60, maxWindowFrames: 300 },
  parameterBasis: {
    'detection.collectionScoreFloor': 'development-analysis',
    'evidence.scoreMin': 'owner-accepted-v9-literal',
    'evidence.foregroundMinHeightFraction': 'development-analysis',
    'evidence.persistence.enter': 'coordinator-decision',
    'evidence.persistence.exit': 'design-prior-unmeasured',
    'evidence.aggregationWindowMs': 'design-prior-unmeasured',
    'evidence.minAnalysedSamplesInWindow': 'design-prior-unmeasured',
    'evidence.track': 'design-prior-unmeasured',
    'evidence.speaker.switch': 'design-prior-unmeasured',
    'clearance.scoreMin': 'development-analysis',
    'clearance.dilation': 'coordinator-decision',
    'clearance.maxSampleGapMs': 'coordinator-decision',
    'sampling': 'coordinator-decision',
  },
  developmentEvidence: {
    scope: 'post-hoc-adaptive-development-not-qualification' as const,
    analysis: {
      path: 'BASE/w62-v9-foreground-analysis-20261018/ (tables.md, results.json, analysis.py, faces.csv, grid.csv, SHA256SUMS)',
      tablesMdSha256: 'e5ed533dfcab5ae26d119bed4dbfacc865ee2bf3c7fba893a6d958f238499613',
      resultsJsonSha256: '4c7f07ffd3ff3feb22220adabaff2873fb5c54f47de5733ec8cd2110d598d2d3',
      analysisPySha256: '2166235aba507d1f845ab69e957e380a7ec6e43ae1580735eb58b2c75e9780b3',
    },
    developmentViewSha256: '7f2e232a0e063589dcc6eef487dd2d684dfc1ba063d55ef1fbc66cfc5697e8a6',
    v9ReceiptSha256: '390d3b28d172015f8ed2cb3d416e38625ce4d4efaca8e1eea52d7a8e58aaa817',
    v9RunId: 'w62-development-v9-v1-42ee2328',
    ownerAcceptanceSha256: FACE_V9_OWNER_ACCEPTANCE_SHA256,
    stillsNumbers: {
      allFacesAt050: '50/67',
      facesHeightAtLeast10PercentAt050: '34/43',
      largestFacePerImageAt050: '32/40',
      imagesWithOccupiedBandsFalseFree: { at050: '3/26', at030: '3/26', at020: '2/26', at010: '1/26' },
      bottomBandFalseOccupied: { at050: '2/49', at010: '8/49' },
      dilationEffectOnFalseFree: 'none between 0.10 and 0.20 of the larger side',
    },
  },
  claims: {
    qualification: false as const,
    independentConfirmation: 'not-performed' as const,
    faceSafety: 'unknown' as const,
    realVideoMeasurement: 'pending-w70-journey' as const,
    deploymentGate: 'linux-parity-run-on-60-development-images-pending' as const,
  },
})

export type FaceEvidencePolicy = typeof FACE_EVIDENCE_POLICY
export const FACE_EVIDENCE_POLICY_SHA256 = calculateCanonicalHash(FACE_EVIDENCE_POLICY)

/** Sampling stride that yields `targetHz` samples per second, never below one frame. */
export function faceSampleIntervalFrames(fps: Readonly<{ num: number; den: number }>): number {
  return Math.max(1, Math.ceil(fps.num / (FACE_EVIDENCE_POLICY.sampling.targetHz * fps.den)))
}

/** Window length (frames) for one operation: at most 300 frames and at most 60 samples at this stride. */
export function faceWindowFrames(intervalFrames: number): number {
  return Math.min(FACE_EVIDENCE_POLICY.sampling.maxWindowFrames,
    FACE_EVIDENCE_POLICY.sampling.maxSamplesPerWindow * intervalFrames)
}

/** Largest frame distance between consecutive analysed samples that clearance still accepts. */
export function maxSampleGapFrames(fps: Readonly<{ num: number; den: number }>): number {
  return Math.floor(FACE_EVIDENCE_POLICY.clearance.maxSampleGapMs * fps.num / (1000 * fps.den))
}
