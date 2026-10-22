import { calculateCanonicalHash } from './canonical-hash.ts'
import { CAPTION_TEXT_DOES_NOT_FIT, type CaptionLayoutOverflowV1 } from './caption-burn-layout.ts'
import type { CaptionPixelIssueV1 } from './caption-pixel-verdict.ts'
import { CAPTION_TEXT_LAYOUT_ID } from './caption-text-layout.ts'
import type { DirectorQualityReport } from './director-run.ts'
import { FACE_EVIDENCE_POLICY_SHA256 } from './face-evidence-policy.ts'
import type { RenderPlacementPlan } from './render-placement-plan.ts'
import type { SubtitleAnchorPlanV3 } from './subtitle-anchor-plan-v3.ts'
import type { SubtitleAnchor } from './subtitle-system.ts'

/**
 * The rule under which a final export is admissible (W65b), pinned and versioned.
 *
 * Nothing in Apollo grants a GLOBAL facial safety: `faceSafety` stays `unknown`, in the Director's report and in every
 * placement plan. A final is therefore not admitted because "the faces are safe", but because of what is actually BURNED:
 *
 *  (a) the Director run and its QualityReport hold as they always did - the strategic gates pass, every hard check but the
 *      face one holds, nothing is a hard issue. The only reservation a report may still carry is the unknown face claim;
 *  (b) EVERY cue the final burns is placed in a band the placement plan certified `free-certified` on the final canvas -
 *      by trusted face evidence, or by geometry (the band touches no pixel of the picture) - and the C1 pixel critic
 *      measured the delivered MP4 and found each caption where the plan put it;
 *  (c) a cue that cannot be certified is OMITTED (never burned) and LISTED as a review item.
 *
 * `free-certified` keeps its W62 meaning: no trusted detection overlaps the band in the sampled evidence. It is never a
 * statement that no face is present, and this module never says otherwise.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

/** The anchor policy the final (and the proxy it is approved from) plans under: an uncertifiable cue is omitted and listed. */
export const FINAL_CAPTION_ANCHOR_POLICY = Object.freeze({ onNoSafeRegion: 'omit-and-list' as const })

export const FINAL_CAPTION_CERTIFICATION_POLICY = deepFreeze({
  id: 'final-caption-certification/v1',
  meaning: 'A final is admissible when every burned caption is certified in its band and confirmed in pixels; uncertified captions are omitted and listed. It does not claim that no face is under any caption.',
  directorAdmission: {
    verifiedFaceSafety: { status: ['approved', 'approved-with-warnings'], faceSafety: 'verified' },
    perCueCaptionCertification: {
      status: 'review-required',
      faceSafety: 'unknown',
      requires: ['strategic.passed', 'every-hard-check-except-subtitlesFaceSafe', 'no-hard-issue'],
    },
  },
  burnedCue: {
    band: 'free-certified',
    certifiedBy: ['face-clearance', 'geometry-outside-foreground'],
    pixelCritic: 'required',
    pixelHardCodes: ['CAPTION_PLACEMENT_MISMATCH', 'SUBTITLE_FACE_OVERLAP_IN_PIXELS'],
  },
  uncertifiedCue: {
    action: 'omit',
    listedAs: 'review-item',
    codes: ['FACE_PERCEPTION_UNAVAILABLE', 'NO_SAFE_SUBTITLE_REGION'],
  },
  // W70 readiness (R3). A cue whose text does not fit the band it would be burned in (`caption-burn-layout.ts`, decided by the layout before
  // the encode) is omitted and listed the same way; the pixel critic's tolerance is never what admits it.
  overflowingCue: {
    action: 'omit',
    listedAs: 'review-item',
    code: CAPTION_TEXT_DOES_NOT_FIT,
    layout: CAPTION_TEXT_LAYOUT_ID,
  },
  anchorPolicy: FINAL_CAPTION_ANCHOR_POLICY,
  claims: { faceSafety: 'unknown' },
  faceEvidencePolicySha256: FACE_EVIDENCE_POLICY_SHA256,
})
export const FINAL_CAPTION_CERTIFICATION_POLICY_SHA256: string = calculateCanonicalHash(FINAL_CAPTION_CERTIFICATION_POLICY)

export type FinalQualityAdmission =
  | Readonly<{ admitted: true; basis: 'verified-face-safety' | 'per-cue-caption-certification' }>
  | Readonly<{ admitted: false; reason: string }>

const REQUIRED_HARD_CHECKS = Object.freeze([
  'openingMotionProtected', 'automaticZoomDisabled', 'subtitlesBounded', 'forbiddenSpeechAbsent', 'timelineContinuous',
] as const)

const refuse = (reason: string): FinalQualityAdmission => Object.freeze({ admitted: false as const, reason })

/**
 * (a) of the policy. The legacy basis (a Director that really verified face safety) is unchanged; the new one admits the
 * report the Director actually produces - `review-required` with an unknown face claim - when that claim is its only
 * reservation. Everything else (blocked, a failed gate or hard check, a hard issue, an inconsistent claim) is refused.
 */
export function admitDirectorQualityForFinal(report: Readonly<Pick<DirectorQualityReport, 'status' | 'faceSafety' | 'strategic' | 'hardChecks' | 'issues'>>): FinalQualityAdmission {
  const { status, faceSafety, hardChecks } = report
  if (status === 'blocked') return refuse('Director quality status is blocked')
  if (status === 'approved' || status === 'approved-with-warnings') {
    return faceSafety?.status === 'verified' && faceSafety.evidenceRefs.length > 0 && hardChecks?.subtitlesFaceSafe === true
      ? Object.freeze({ admitted: true as const, basis: 'verified-face-safety' as const })
      : refuse(`Director quality status ${status} is inconsistent with an unverified face safety claim`)
  }
  if (status !== 'review-required') return refuse(`Director quality status ${String(status)} is not recognised`)
  if (faceSafety?.status !== 'unknown' || faceSafety.evidenceRefs.length !== 0 || hardChecks?.subtitlesFaceSafe !== false) {
    return refuse('Director face safety claim is not the plain unknown claim (no evidence, subtitles not claimed face safe)')
  }
  if (report.strategic?.passed !== true) return refuse('Director strategic quality gate did not pass')
  const failedCheck = REQUIRED_HARD_CHECKS.find((check) => hardChecks[check] !== true)
  if (failedCheck) return refuse(`Director hard check ${failedCheck} did not hold`)
  const hardIssues = (report.issues ?? []).filter((issue) => issue.severity === 'hard')
  if (hardIssues.length > 0) return refuse(`Director report carries ${hardIssues.length} hard issue(s): ${[...new Set(hardIssues.map((issue) => issue.code))].join(', ')}`)
  return Object.freeze({ admitted: true as const, basis: 'per-cue-caption-certification' as const })
}

export type FinalPixelCheck = Readonly<{
  /** `failed`: the critic could not take its measurement (as opposed to measuring and finding a disagreement). */
  measurement: 'completed' | 'failed'
  issues: readonly Readonly<CaptionPixelIssueV1>[]
}>

export type FinalBurnedCueV1 = Readonly<{
  cueId: string
  startFrame: number
  endFrame: number
  anchor: SubtitleAnchor
  certification: 'face-clearance' | 'geometry-outside-foreground' | 'mixed'
  evaluationKinds: readonly string[]
  /** Seals of the W62 clearances the band was certified by (empty when certified by geometry alone). */
  clearanceHashes: readonly string[]
  sourceArtifactIds: readonly string[]
  /** The half-open window the band was assessed over. */
  window: Readonly<{ startFrame: number; endFrame: number }>
}>

export type FinalOmittedCueV1 = Readonly<{
  cueId: string
  startFrame: number
  endFrame: number
  code: 'FACE_PERCEPTION_UNAVAILABLE' | 'NO_SAFE_SUBTITLE_REGION' | typeof CAPTION_TEXT_DOES_NOT_FIT
  disposition: 'review-required' | 'blocked'
  reasons: readonly string[]
}>

export type FinalCaptionCertificationReceiptV1 = Readonly<{
  schemaVersion: 'final-caption-certification-receipt/v1'
  policyId: string
  policySha256: string
  faceSafety: 'unknown'
  placementPlanHash: string
  anchorPlanHash: string | null
  burned: readonly FinalBurnedCueV1[]
  omitted: readonly FinalOmittedCueV1[]
  pixelCritic: 'ran' | 'not-run' | 'measurement-failed' | 'not-needed'
  pixelWarnings: readonly Readonly<{ code: string; cueId: string | null; startFrame: number; endFrame: number }>[]
  receiptHash: string
}>

export type FinalCaptionCertification = Readonly<{
  admissible: boolean
  failures: readonly string[]
  receipt: FinalCaptionCertificationReceiptV1
}>

const sortedUnique = <T extends string>(values: readonly T[]): readonly T[] => Object.freeze([...new Set(values)].toSorted())

/**
 * (b) and (c) of the policy, as a pure function of the placement plan the encode was decided with and of what the pixel critic
 * measured on the delivered bytes. It re-reads every burned cue's band from the plan's own assessments (the plan is validated
 * and re-derived elsewhere; this is the last, independent look), and returns the receipt that is recorded with the final.
 */
export function certifyFinalCaptions(input: Readonly<{
  plan: Readonly<RenderPlacementPlan>
  /** What the pixel critic returned for the delivered MP4; `null`/absent when it did not run. */
  pixelCheck?: FinalPixelCheck | null
  /**
   * W70 readiness (R3). The cues left out of the plan (and of the encode) because their text does not fit the band (`captionTextOverflow:
   * 'omit-and-list'`). They are listed as review items; one the plan still places would be burned, so that is a failure, never a listing.
   */
  layoutOmitted?: readonly Readonly<CaptionLayoutOverflowV1>[]
}>): FinalCaptionCertification {
  const { plan } = input
  const anchorPlan = plan.subtitleAnchorPlan
  const failures: string[] = []
  const burned: FinalBurnedCueV1[] = []
  const omitted: FinalOmittedCueV1[] = []
  for (const overflow of input.layoutOmitted ?? []) {
    if (anchorPlan?.decisions.some((decision) => decision.cueId === overflow.cueId)) {
      failures.push(`Cue ${overflow.cueId} does not fit its band (${overflow.code}) and is still in the caption plan`)
      continue
    }
    omitted.push(Object.freeze({
      cueId: overflow.cueId, startFrame: overflow.startFrame, endFrame: overflow.endFrame,
      code: CAPTION_TEXT_DOES_NOT_FIT, disposition: 'review-required' as const,
      reasons: Object.freeze([`${overflow.lines}/${overflow.maxLines} lines`, `${overflow.widthPx}/${overflow.maxWidthPx} px`]),
    }))
  }
  if (anchorPlan) {
    if (anchorPlan.schemaVersion !== 'subtitle-anchor-plan/v3') {
      failures.push(`The caption plan is ${anchorPlan.schemaVersion}, which was not decided by a face clearance of the final canvas`)
    }
    if (anchorPlan.policy.onNoSafeRegion !== FINAL_CAPTION_ANCHOR_POLICY.onNoSafeRegion) {
      failures.push(`The caption plan was decided under the ${anchorPlan.policy.onNoSafeRegion} policy, not ${FINAL_CAPTION_ANCHOR_POLICY.onNoSafeRegion}`)
    }
    if (anchorPlan.schemaVersion === 'subtitle-anchor-plan/v3') {
      for (const decision of (anchorPlan as Readonly<SubtitleAnchorPlanV3>).decisions) {
        if (decision.anchor === null || decision.bounds === null) {
          const blocked = decision.disposition === 'blocked'
          omitted.push(Object.freeze({
            cueId: decision.cueId, startFrame: decision.startFrame, endFrame: decision.endFrame,
            code: blocked ? 'NO_SAFE_SUBTITLE_REGION' as const : 'FACE_PERCEPTION_UNAVAILABLE' as const,
            disposition: blocked ? 'blocked' as const : 'review-required' as const,
            reasons: sortedUnique(Object.values(decision.bandAssessments).flatMap((assessment) =>
              assessment.face.state === 'free-certified' ? [] : assessment.face.reasons)),
          }))
          continue
        }
        const assessment = decision.bandAssessments?.[decision.anchor]
        const evaluations = assessment?.face.evaluations ?? []
        const certified = assessment?.face.state === 'free-certified' && evaluations.length > 0 && evaluations.every((evaluation) =>
          evaluation.state === 'free-certified' && FINAL_CAPTION_CERTIFICATION_POLICY.burnedCue.certifiedBy.includes(evaluation.kind))
        if (!certified) {
          failures.push(`Cue ${decision.cueId} is placed on the ${decision.anchor} band, which is not free-certified on the final canvas`)
          continue
        }
        const kinds = sortedUnique(evaluations.map((evaluation) => evaluation.kind))
        burned.push(Object.freeze({
          cueId: decision.cueId, startFrame: decision.startFrame, endFrame: decision.endFrame, anchor: decision.anchor,
          certification: kinds.length === 1 ? kinds[0] as 'face-clearance' | 'geometry-outside-foreground' : 'mixed' as const,
          evaluationKinds: kinds,
          clearanceHashes: sortedUnique(evaluations.flatMap((evaluation) => evaluation.clearanceHash ? [evaluation.clearanceHash] : [])),
          sourceArtifactIds: sortedUnique(evaluations.flatMap((evaluation) => evaluation.sourceArtifactId ? [evaluation.sourceArtifactId] : [])),
          window: Object.freeze({ startFrame: decision.stabilityWindow.startFrame, endFrame: decision.stabilityWindow.endFrame }),
        }))
      }
    }
  }
  let pixelCritic: FinalCaptionCertificationReceiptV1['pixelCritic']
  const pixelWarnings: { code: string; cueId: string | null; startFrame: number; endFrame: number }[] = []
  const check = input.pixelCheck ?? null
  if (check === null) {
    pixelCritic = burned.length > 0 ? 'not-run' : 'not-needed'
    if (burned.length > 0) failures.push('The caption pixel critic did not run, so the burned captions are not confirmed in the delivered pixels')
  } else if (check.measurement === 'failed') {
    pixelCritic = 'measurement-failed'
    if (burned.length > 0) failures.push('The caption pixel critic could not measure the delivered pixels, so the burned captions are not confirmed')
  } else {
    pixelCritic = 'ran'
    for (const issue of check.issues) {
      if (issue.severity === 'hard') failures.push(`Cue ${issue.cueId ?? 'none'}: ${issue.code} - ${issue.message}`)
      else pixelWarnings.push({ code: issue.code, cueId: issue.cueId, startFrame: issue.evidenceRange.startFrame, endFrame: issue.evidenceRange.endFrame })
    }
  }
  const body = Object.freeze({
    schemaVersion: 'final-caption-certification-receipt/v1' as const,
    policyId: FINAL_CAPTION_CERTIFICATION_POLICY.id,
    policySha256: FINAL_CAPTION_CERTIFICATION_POLICY_SHA256,
    faceSafety: 'unknown' as const,
    placementPlanHash: plan.placementPlanHash,
    anchorPlanHash: anchorPlan?.anchorPlanHash ?? null,
    burned: Object.freeze(burned),
    omitted: Object.freeze(omitted),
    pixelCritic,
    pixelWarnings: Object.freeze(pixelWarnings.map((warning) => Object.freeze(warning))),
  })
  const receipt: FinalCaptionCertificationReceiptV1 = Object.freeze({ ...body, receiptHash: calculateCanonicalHash(body) })
  return Object.freeze({ admissible: failures.length === 0, failures: Object.freeze(failures), receipt })
}

/** One line for the attempt record: what was burned and what was left out for review. */
export function describeFinalCaptionCertification(receipt: Readonly<FinalCaptionCertificationReceiptV1>): string {
  const listed = receipt.omitted.slice(0, 8).map((entry) => `${entry.cueId} (${entry.code})`).join(', ')
  const more = receipt.omitted.length > 8 ? ` and ${receipt.omitted.length - 8} more` : ''
  return (`${receipt.burned.length} caption(s) burned in certified bands, confirmed by the pixel critic (${receipt.pixelCritic}); ` +
    `${receipt.omitted.length} omitted and listed for review${receipt.omitted.length ? `: ${listed}${more}` : ''}. Face safety stays unknown.`).slice(0, 500)
}
