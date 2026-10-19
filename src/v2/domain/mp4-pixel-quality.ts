import { createHash } from 'node:crypto'

import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import type { NormalizedBounds, NormalizedInsets } from './output-spec.ts'
import { pixelOracleModelPins } from './pixel-face-oracle.ts'

/**
 * W67. The verdict on the MP4 that was actually delivered, taken from its decoded pixels and sealed.
 *
 * The object under test is the file, by SHA-256 and size, after a full decode. The RenderElementMap, the reframe plan and the placement
 * plan are things to confront, never the ground truth: ink is the difference between the delivered frame and a control encode of the same
 * RenderInput without the overlay, faces are what two independent detectors find on the overlay-free frame, and the position of the
 * subject in the output is measured by registering the output frame against the SOURCE frame on its own pixels (feature matching), not
 * by applying the crop the renderer was told to use.
 *
 * This module is pure: infrastructure measures `Mp4SampleFacts`, this module judges them, localizes the issues, and seals the report.
 */
export const MP4_PIXEL_CRITIC_POLICY_ID = 'w67-mp4-pixel-critic/v1' as const

/** Every tolerance carries its unit. They were fixed before the first controlled render of the W67 corpus and are not tuned on it. */
export const MP4_PIXEL_CRITIC_POLICY = Object.freeze({
  id: MP4_PIXEL_CRITIC_POLICY_ID,
  ink: Object.freeze({
    /** Rec.601 luma (299/587/114 over 1000) on 8-bit RGB. A pixel is ink when |delivered - control| exceeds this many luma levels. */
    lumaThresholdLevels: 40,
    /** ... and at least this many of its four neighbours do too: an isolated difference is codec noise, not a glyph. */
    minChangedNeighboursOfFour: 2,
    /** Fewer surviving pixels than this in a frame means that overlay is absent from it. */
    minInkPixels: 40,
  }),
  faceMarginPixels: 0,
  safeArea: Object.freeze({
    /** Bounds are inclusive and come from the frozen OutputSpec; ink up to this many pixels past a bound is `unknown`, beyond it is a failure. */
    segmentationTolerancePixels: 2,
  }),
  density: Object.freeze({ limitFractionOfCanvasPixels: 0.2 }),
  subject: Object.freeze({
    primary: 'largest-source-detection-by-area' as const,
    /** A projected source face with less than this fraction of its area inside the canvas is lost; less than the second, clipped. */
    lostBelowVisibleFraction: 0.1,
    clippedBelowVisibleFraction: 0.9,
    /** The output oracle confirms a visible subject when one of its boxes has at least this IoU with the projected source face. */
    outputConfirmationMinIou: 0.2,
  }),
  registration: Object.freeze({
    algorithm: 'orb-2000-ratio0.75-similarity-ransac3px/v1' as const,
    minInliers: 25,
    minInlierRatio: 0.3,
    maxMedianResidualPixels: 2.5,
    minScale: 0.25,
    maxScale: 6,
    maxRotationDegrees: 2,
  }),
  sampling: Object.freeze({
    /** Up to this many frames every frame is sampled; beyond it the stride plus the edges below. */
    allFramesUpTo: 600,
    strideFrames: 5,
    includeInkRunEdges: true,
    includeCutBoundaries: true,
  }),
})
export const MP4_PIXEL_CRITIC_POLICY_SHA256 = calculateCanonicalHash(MP4_PIXEL_CRITIC_POLICY)

export const MP4_PIXEL_CODES = Object.freeze([
  'SUBTITLE_FACE_OVERLAP_IN_PIXELS', 'CTA_FACE_OVERLAP_IN_PIXELS', 'INK_OUTSIDE_SAFE_AREA_IN_PIXELS', 'INK_CLIPPED_BY_CANVAS_IN_PIXELS',
  'SUBJECT_NOT_VISIBLE_IN_PIXELS', 'SUBJECT_CLIPPED_IN_PIXELS', 'INK_DENSITY_EXCESS_IN_PIXELS',
  'MP4_PIXEL_EVIDENCE_UNKNOWN', 'MP4_PIXEL_COVERAGE_PARTIAL', 'MP4_DECODE_FAILED',
] as const)
export type Mp4PixelCode = (typeof MP4_PIXEL_CODES)[number]

export type Mp4PixelIssueV1 = Readonly<{
  code: Mp4PixelCode
  severity: 'hard' | 'warning'
  evidenceRange: Readonly<{ startFrame: number; endFrame: number }>
  elementIds: readonly string[]
  evidenceIds: readonly string[]
  message: string
  /** The samples the range was built from, in order. */
  sampleIds: readonly string[]
}>

export type InkKind = 'caption' | 'cta'
export type PixelBox = Readonly<{ x0: number; y0: number; x1: number; y1: number }>
export type InkFacts = Readonly<{
  /** Surviving ink pixels (0 when fewer than the policy minimum: the overlay is absent from the frame). */
  pixels: number
  /** Inclusive pixel extents of the ink, or null when absent. */
  bbox: PixelBox | null
  /** Any ink pixel in the outermost row or column of the canvas. */
  touchesCanvasEdge: boolean
}>
export type RegistrationFacts = Readonly<{
  status: 'ok' | 'failed'
  reason: string | null
  matches: number
  inliers: number
  inlierRatio: number
  /** Median distance, in output pixels, between each inlier's mapped source keypoint and its output keypoint. */
  medianResidualPixels: number | null
  scale: number | null
  rotationDegrees: number | null
}>
export type ProtectedRegionFacts = Readonly<{
  origin: 'oracle-0204-v9' | 'oracle-retail-0004' | 'source-projection'
  /** Normalized to the canvas and clipped to it. */
  box: Readonly<NormalizedBounds>
  /** Ink pixels inside the box, expanded by the policy's face margin. */
  captionInkPixels: number
  ctaInkPixels: number
}>
export type SubjectFacts = Readonly<
  | { state: 'not-applicable'; reason: 'NO_SOURCE_FACE' | 'NO_SOURCE_FRAME' }
  | { state: 'unknown'; reason: string }
  | {
      state: 'measured'
      /** Fraction of the projected source face that lies inside the canvas. */
      visibleFraction: number
      /** An output-oracle box overlaps the projected source face with at least the policy's IoU. */
      outputConfirmed: boolean
      /** Normalized projected box before clipping (may extend past the canvas). */
      projected: Readonly<{ x0: number; y0: number; x1: number; y1: number }>
    }
>
export type Mp4SampleFacts = Readonly<{
  sampleId: string
  frameIndex: number
  ptsTicks: number
  frameSha256: string
  caption: InkFacts
  cta: InkFacts
  /** (caption + cta ink pixels) / canvas pixels. */
  inkDensity: number
  oracle: Readonly<{ state: 'observed' | 'unknown'; outputFaceCount: number; sourceFaceCount: number }>
  registration: RegistrationFacts | null
  protectedRegions: readonly ProtectedRegionFacts[]
  subject: SubjectFacts
}>

export const MP4_CHECKS = Object.freeze(['captionFaceOverlap', 'ctaFaceOverlap', 'safeArea', 'canvasClipping', 'subjectVisibility', 'density'] as const)
export type Mp4CheckId = (typeof MP4_CHECKS)[number]
export type Mp4CheckVerdict = 'pass' | 'fail' | 'unknown' | 'not-applicable'
export type Mp4SampleCheck = Readonly<{ verdict: Mp4CheckVerdict; code: Mp4PixelCode | null; reason: string | null; elementIds: readonly string[] }>
export type Mp4SampleVerdict = Readonly<{ sampleId: string; frameIndex: number; checks: Readonly<Record<Mp4CheckId, Mp4SampleCheck>> }>

const check = (verdict: Mp4CheckVerdict, code: Mp4PixelCode | null = null, reason: string | null = null, elementIds: readonly string[] = []): Mp4SampleCheck =>
  Object.freeze({ verdict, code, reason, elementIds: Object.freeze([...elementIds]) })

/**
 * Overshoot, in pixels, of an ink extent past the safe rectangle of the canvas (0 when inside, bounds inclusive). A pixel is measured by
 * its centre: pixel `i` lies at `i + 0.5`, so an ink pixel is inside when its centre is on or within the (possibly fractional) safe edge.
 */
export function safeAreaOvershootPixels(
  bbox: PixelBox, canvas: Readonly<{ width: number; height: number }>, safeArea: Readonly<NormalizedInsets>,
): number {
  const left = safeArea.left * canvas.width, right = canvas.width - safeArea.right * canvas.width
  const top = safeArea.top * canvas.height, bottom = canvas.height - safeArea.bottom * canvas.height
  return Math.max(0, left - (bbox.x0 + 0.5), bbox.x1 + 0.5 - right, top - (bbox.y0 + 0.5), bbox.y1 + 0.5 - bottom)
}

export function evaluateMp4Sample(input: Readonly<{
  facts: Readonly<Mp4SampleFacts>
  canvas: Readonly<{ width: number; height: number }>
  safeArea: Readonly<NormalizedInsets>
  policy?: typeof MP4_PIXEL_CRITIC_POLICY
}>): Mp4SampleVerdict {
  const policy = input.policy ?? MP4_PIXEL_CRITIC_POLICY
  const { facts } = input
  const subjectFacts = facts.subject
  // Is there a face to protect in this frame? Detections on the overlay-free output frame and the registered projection of the source
  // detections both protect. Without either, a subject that left the canvas has nothing visible to cover; anything else is unknown.
  const evidence: 'present' | 'cut-away' | 'none' = facts.protectedRegions.length > 0
    ? 'present'
    : subjectFacts.state === 'measured' && subjectFacts.visibleFraction < policy.subject.lostBelowVisibleFraction ? 'cut-away' : 'none'
  const overlap = (kind: InkKind): Mp4SampleCheck => {
    const ink = facts[kind]
    const code: Mp4PixelCode = kind === 'caption' ? 'SUBTITLE_FACE_OVERLAP_IN_PIXELS' : 'CTA_FACE_OVERLAP_IN_PIXELS'
    if (ink.pixels === 0) return check('not-applicable', null, 'NO_INK_IN_FRAME')
    if (evidence === 'present') {
      const hit = facts.protectedRegions.some((region) => (kind === 'caption' ? region.captionInkPixels : region.ctaInkPixels) > 0)
      return hit ? check('fail', code, null, [kind]) : check('pass')
    }
    if (evidence === 'cut-away') return check('pass', null, 'PROTECTED_FACE_OUTSIDE_CANVAS')
    return check('unknown', 'MP4_PIXEL_EVIDENCE_UNKNOWN', facts.oracle.state === 'unknown' ? 'FACE_ORACLE_UNREADABLE' : 'NO_FACE_EVIDENCE', [kind])
  }
  const safeFor = (kind: InkKind): { verdict: Mp4CheckVerdict; overshoot: number } | null => {
    const ink = facts[kind]
    if (ink.pixels === 0 || !ink.bbox) return null
    const overshoot = safeAreaOvershootPixels(ink.bbox, input.canvas, input.safeArea)
    if (overshoot <= 0) return { verdict: 'pass', overshoot }
    return { verdict: overshoot <= policy.safeArea.segmentationTolerancePixels ? 'unknown' : 'fail', overshoot }
  }
  const safeResults = (['caption', 'cta'] as const).map((kind) => [kind, safeFor(kind)] as const).filter(([, result]) => result !== null)
  const safeFailed = safeResults.filter(([, result]) => result!.verdict === 'fail').map(([kind]) => kind)
  const safeUnknown = safeResults.filter(([, result]) => result!.verdict === 'unknown').map(([kind]) => kind)
  const safeArea: Mp4SampleCheck = safeResults.length === 0 ? check('not-applicable', null, 'NO_INK_IN_FRAME')
    : safeFailed.length > 0 ? check('fail', 'INK_OUTSIDE_SAFE_AREA_IN_PIXELS', null, safeFailed)
      : safeUnknown.length > 0 ? check('unknown', 'MP4_PIXEL_EVIDENCE_UNKNOWN', 'SAFE_AREA_BOUNDARY_WITHIN_SEGMENTATION_TOLERANCE', safeUnknown)
        : check('pass')
  const clipped = (['caption', 'cta'] as const).filter((kind) => facts[kind].pixels > 0 && facts[kind].touchesCanvasEdge)
  const inkPresent = facts.caption.pixels > 0 || facts.cta.pixels > 0
  const canvasClipping: Mp4SampleCheck = !inkPresent ? check('not-applicable', null, 'NO_INK_IN_FRAME')
    : clipped.length > 0 ? check('fail', 'INK_CLIPPED_BY_CANVAS_IN_PIXELS', null, clipped) : check('pass')
  let subjectVisibility: Mp4SampleCheck
  if (subjectFacts.state === 'not-applicable') subjectVisibility = check('not-applicable', null, subjectFacts.reason)
  else if (subjectFacts.state === 'unknown') subjectVisibility = check('unknown', 'MP4_PIXEL_EVIDENCE_UNKNOWN', subjectFacts.reason, ['subject'])
  else if (subjectFacts.visibleFraction < policy.subject.lostBelowVisibleFraction) subjectVisibility = check('fail', 'SUBJECT_NOT_VISIBLE_IN_PIXELS', null, ['subject'])
  else if (subjectFacts.visibleFraction < policy.subject.clippedBelowVisibleFraction) subjectVisibility = check('fail', 'SUBJECT_CLIPPED_IN_PIXELS', null, ['subject'])
  else if (subjectFacts.outputConfirmed) subjectVisibility = check('pass')
  else subjectVisibility = check('unknown', 'MP4_PIXEL_EVIDENCE_UNKNOWN', 'SUBJECT_NOT_CONFIRMED_BY_OUTPUT_ORACLE', ['subject'])
  const density: Mp4SampleCheck = !inkPresent ? check('not-applicable', null, 'NO_INK_IN_FRAME')
    : facts.inkDensity > policy.density.limitFractionOfCanvasPixels ? check('fail', 'INK_DENSITY_EXCESS_IN_PIXELS', null, ['overlays']) : check('pass')
  return Object.freeze({
    sampleId: facts.sampleId, frameIndex: facts.frameIndex,
    checks: Object.freeze({
      captionFaceOverlap: overlap('caption'), ctaFaceOverlap: overlap('cta'), safeArea, canvasClipping, subjectVisibility, density,
    }),
  })
}

const SEVERITY: Readonly<Record<Mp4PixelCode, 'hard' | 'warning'>> = Object.freeze({
  SUBTITLE_FACE_OVERLAP_IN_PIXELS: 'hard', CTA_FACE_OVERLAP_IN_PIXELS: 'hard', INK_OUTSIDE_SAFE_AREA_IN_PIXELS: 'hard',
  INK_CLIPPED_BY_CANVAS_IN_PIXELS: 'hard', SUBJECT_NOT_VISIBLE_IN_PIXELS: 'hard', SUBJECT_CLIPPED_IN_PIXELS: 'hard',
  INK_DENSITY_EXCESS_IN_PIXELS: 'warning', MP4_PIXEL_EVIDENCE_UNKNOWN: 'warning', MP4_PIXEL_COVERAGE_PARTIAL: 'warning', MP4_DECODE_FAILED: 'hard',
})
const MESSAGE: Readonly<Record<Mp4PixelCode, string>> = Object.freeze({
  SUBTITLE_FACE_OVERLAP_IN_PIXELS: 'Caption ink touches a face the oracle found on the overlay-free frame.',
  CTA_FACE_OVERLAP_IN_PIXELS: 'CTA ink touches a face the oracle found on the overlay-free frame.',
  INK_OUTSIDE_SAFE_AREA_IN_PIXELS: 'Overlay ink leaves the safe area of the output.',
  INK_CLIPPED_BY_CANVAS_IN_PIXELS: 'Overlay ink reaches the edge of the canvas and is clipped by it.',
  SUBJECT_NOT_VISIBLE_IN_PIXELS: 'The subject seen in the source frame is not inside the output frame.',
  SUBJECT_CLIPPED_IN_PIXELS: 'The subject seen in the source frame is cut by the edge of the output frame.',
  INK_DENSITY_EXCESS_IN_PIXELS: 'Overlay ink covers more of the canvas than the density limit.',
  MP4_PIXEL_EVIDENCE_UNKNOWN: 'The pixels of this stretch could not establish the check; it is not safe, it is unknown.',
  MP4_PIXEL_COVERAGE_PARTIAL: 'Frames between the sampled ones were not measured.',
  MP4_DECODE_FAILED: 'The delivered file did not decode completely.',
})

type Run = { code: Mp4PixelCode; check: Mp4CheckId; elementIds: readonly string[]; reason: string | null; frames: number[]; sampleIds: string[] }

/** Folds the per-sample verdicts into localized issues: consecutive sampled frames with the same finding form one half-open range. */
export function localizeMp4Issues(verdicts: readonly Readonly<Mp4SampleVerdict>[], mergeGapFrames = 1): readonly Mp4PixelIssueV1[] {
  const ordered = [...verdicts].toSorted((left, right) => left.frameIndex - right.frameIndex)
  const open = new Map<string, Run>()
  const closed: Run[] = []
  const seenThisSample = new Set<string>()
  let previousFrame: number | null = null
  for (const verdict of ordered) {
    seenThisSample.clear()
    for (const checkId of MP4_CHECKS) {
      const result = verdict.checks[checkId]
      if ((result.verdict !== 'fail' && result.verdict !== 'unknown') || result.code === null) continue
      const key = `${checkId}|${result.code}|${result.elementIds.join(',')}|${result.reason ?? ''}`
      seenThisSample.add(key)
      const run = open.get(key)
      if (run && previousFrame !== null && run.frames.at(-1) === previousFrame && verdict.frameIndex - previousFrame <= mergeGapFrames) { run.frames.push(verdict.frameIndex); run.sampleIds.push(verdict.sampleId); continue }
      if (run) closed.push(run)
      open.set(key, { code: result.code, check: checkId, elementIds: result.elementIds, reason: result.reason, frames: [verdict.frameIndex], sampleIds: [verdict.sampleId] })
    }
    for (const [key, run] of open) if (!seenThisSample.has(key)) { closed.push(run); open.delete(key) }
    previousFrame = verdict.frameIndex
  }
  closed.push(...open.values())
  return Object.freeze(closed.map((run) => {
    const first = run.frames[0]!, last = run.frames.at(-1)!
    const suffix = run.reason ? ` (${run.reason})` : ''
    return Object.freeze({
      code: run.code, severity: SEVERITY[run.code],
      evidenceRange: Object.freeze({ startFrame: first, endFrame: last + 1 }),
      elementIds: Object.freeze(run.elementIds.map((id) => `${run.check}:${id}`)),
      evidenceIds: Object.freeze([`mp4-pixel-critic:${MP4_PIXEL_CRITIC_POLICY_SHA256}`]),
      message: `${MESSAGE[run.code]}${suffix}`, sampleIds: Object.freeze([...run.sampleIds]),
    })
  }).toSorted((left, right) => left.evidenceRange.startFrame - right.evidenceRange.startFrame || left.code.localeCompare(right.code) ||
    left.elementIds.join(':').localeCompare(right.elementIds.join(':'))))
}

/** Frames the critic measures: every frame of a short output, else a stride plus the edges that matter (ink runs, cuts, first, last). */
export function planMp4SampleFrames(input: Readonly<{
  totalFrames: number
  cutFrames?: readonly number[]
  inkFrames?: ReadonlySet<number>
  policy?: Readonly<{ sampling: Readonly<{ allFramesUpTo: number; strideFrames: number; includeInkRunEdges: boolean; includeCutBoundaries: boolean }> }>
}>): readonly number[] {
  const policy = input.policy ?? MP4_PIXEL_CRITIC_POLICY
  assertDomain(Number.isSafeInteger(input.totalFrames) && input.totalFrames >= 1, 'INVALID_RENDER_INPUT', 'MP4 critic needs a positive frame count')
  if (input.totalFrames <= policy.sampling.allFramesUpTo) return Object.freeze(Array.from({ length: input.totalFrames }, (_unused, index) => index))
  const frames = new Set<number>([0, input.totalFrames - 1])
  for (let frame = 0; frame < input.totalFrames; frame += policy.sampling.strideFrames) frames.add(frame)
  if (policy.sampling.includeCutBoundaries) for (const cut of input.cutFrames ?? []) { frames.add(cut - 1); frames.add(cut) }
  if (policy.sampling.includeInkRunEdges && input.inkFrames) {
    for (const frame of input.inkFrames) if (!input.inkFrames.has(frame - 1) || !input.inkFrames.has(frame + 1)) frames.add(frame)
  }
  return Object.freeze([...frames].filter((frame) => frame >= 0 && frame < input.totalFrames).toSorted((left, right) => left - right))
}

/** Maximal runs of consecutive frames NOT in `sampled`, as half-open ranges. */
export function unsampledRanges(totalFrames: number, sampled: readonly number[]): readonly Readonly<{ startFrame: number; endFrame: number }>[] {
  const gaps: Array<{ startFrame: number; endFrame: number }> = []
  let cursor = 0
  for (const frame of [...sampled].toSorted((left, right) => left - right)) {
    if (frame > cursor) gaps.push({ startFrame: cursor, endFrame: frame })
    cursor = Math.max(cursor, frame + 1)
  }
  if (cursor < totalFrames) gaps.push({ startFrame: cursor, endFrame: totalFrames })
  return Object.freeze(gaps.map((gap) => Object.freeze(gap)))
}

export type Mp4ArtifactIdentity = Readonly<{
  sha256: string
  byteSize: number
  container: string
  videoCodec: string
  pixelFormat: string
  width: number
  height: number
  frameRate: Readonly<{ num: number; den: number }>
  timeBase: Readonly<{ num: number; den: number }>
  frameCount: number
  durationTicks: number
}>
export type Mp4DecodeReceipt = Readonly<{
  status: 'complete' | 'failed'
  framesExpected: number
  framesDecoded: number
  /** SHA-256 over the ordered `frameIndex:ptsTicks:frameSha256` lines of EVERY decoded frame. */
  frameListSha256: string
  stderrSha256: string
  ffmpegBinarySha256: string | null
}>
export type Mp4ControlReceipt = Readonly<{ kind: 'captions-off' | 'cta-off' | 'overlays-off'; sha256: string; byteSize: number; frameCount: number }>
export type Mp4OracleReceipt = Readonly<{
  protocol: string
  models: ReturnType<typeof pixelOracleModelPins>
  bridgeSha256: string
  pythonSha256: string
  runtime: Readonly<Record<string, string>>
  registration: typeof MP4_PIXEL_CRITIC_POLICY.registration
  /** Reason codes of the oracle batches that could not run; their frames are `unknown`, never empty. */
  failures: readonly string[]
  /** Per sample: the SHA-256 of each model's raw tensor on the output frame and of the source frame. */
  perSample: readonly Readonly<{ sampleId: string; outputRawSha256: Readonly<Record<string, string | null>>; sourceRawSha256: Readonly<Record<string, string | null>> | null; sourceFrameSha256: string | null }>[]
}>
export type Mp4ReportIdentity = Readonly<{
  workspaceId: string
  projectId: string
  projectVersionId: string
  variantId: string
  outputSpecId: string
  format: string
  operationId: string
  renderInputHash: string
}>
export type Mp4NoiseProbe = Readonly<{ framesProbed: number; maxChangedPixels: number; medianChangedPixels: number; p95ChangedPixels: number }> | null

export type Mp4CheckSummary = Readonly<{
  verdict: 'pass' | 'fail' | 'unknown' | 'not-applicable'
  pass: number
  fail: number
  unknown: number
  notApplicable: number
}>

export type Mp4QualityReportV1 = Readonly<{
  schemaVersion: 'mp4-quality-report/v1'
  identity: Mp4ReportIdentity
  artifact: Mp4ArtifactIdentity
  decode: Mp4DecodeReceipt
  policy: Readonly<{ id: string; sha256: string; body: typeof MP4_PIXEL_CRITIC_POLICY }>
  outputSpec: Readonly<{ width: number; height: number; safeArea: Readonly<NormalizedInsets> }>
  controls: readonly Mp4ControlReceipt[]
  oracle: Mp4OracleReceipt
  sampling: Readonly<{
    strategy: 'all-frames' | 'stride-with-edges'
    totalFrames: number
    sampledFrames: number
    /** The sampling parameters actually used (the policy's, unless a caller measured a long output with other ones). */
    policy: Readonly<{ allFramesUpTo: number; strideFrames: number }>
    frameRanges: readonly Readonly<{ startFrame: number; endFrame: number }>[]
    gaps: readonly Readonly<{ startFrame: number; endFrame: number }>[]
  }>
  noiseProbe: Mp4NoiseProbe
  samples: readonly Readonly<{
    sampleId: string; frameIndex: number; ptsTicks: number; frameSha256: string
    facts: Readonly<Mp4SampleFacts>; verdict: Mp4SampleVerdict
  }>[]
  checks: Readonly<Record<Mp4CheckId, Mp4CheckSummary>>
  issues: readonly Readonly<Mp4PixelIssueV1>[]
  unknowns: readonly Readonly<{ check: Mp4CheckId; reason: string | null; evidenceRange: Readonly<{ startFrame: number; endFrame: number }> }>[]
  verdict: 'passed' | 'warning' | 'blocked'
  exportAllowed: boolean
  reportHash: string
}>

const SHA256 = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

function rangesOf(frames: readonly number[]): readonly Readonly<{ startFrame: number; endFrame: number }>[] {
  const ranges: Array<{ startFrame: number; endFrame: number }> = []
  for (const frame of [...frames].toSorted((left, right) => left - right)) {
    const last = ranges.at(-1)
    if (last && last.endFrame === frame) last.endFrame = frame + 1
    else ranges.push({ startFrame: frame, endFrame: frame + 1 })
  }
  return Object.freeze(ranges.map((range) => Object.freeze(range)))
}

export function createMp4QualityReport(input: Readonly<{
  identity: Mp4ReportIdentity
  artifact: Mp4ArtifactIdentity
  decode: Mp4DecodeReceipt
  outputSpec: Readonly<{ width: number; height: number; safeArea: Readonly<NormalizedInsets> }>
  controls: readonly Mp4ControlReceipt[]
  oracle: Mp4OracleReceipt
  samples: readonly Readonly<Mp4SampleFacts>[]
  noiseProbe: Mp4NoiseProbe
  samplingPolicy?: Readonly<{ allFramesUpTo: number; strideFrames: number }>
}>): Readonly<Mp4QualityReportV1> {
  const { identity, artifact, decode } = input
  assertDomain(
    ID.test(identity.workspaceId) && ID.test(identity.projectId) && ID.test(identity.projectVersionId) && ID.test(identity.variantId) &&
    ID.test(identity.outputSpecId) && ID.test(identity.operationId) && SHA256.test(identity.renderInputHash) &&
    SHA256.test(artifact.sha256) && Number.isSafeInteger(artifact.byteSize) && artifact.byteSize > 0 && artifact.frameCount >= 0,
    'INVALID_RENDER_INPUT', 'MP4 quality report identity is invalid',
  )
  assertDomain(artifact.width === input.outputSpec.width && artifact.height === input.outputSpec.height, 'INVALID_RENDER_INPUT', 'MP4 quality report canvas differs from the decoded file')
  const issues: Mp4PixelIssueV1[] = []
  const unknowns: Array<Readonly<{ check: Mp4CheckId; reason: string | null; evidenceRange: Readonly<{ startFrame: number; endFrame: number }> }>> = []
  const verdicts = input.samples.map((facts) => evaluateMp4Sample({ facts, canvas: input.outputSpec, safeArea: input.outputSpec.safeArea }))
  const decodeFailed = decode.status !== 'complete' || decode.framesDecoded !== decode.framesExpected || decode.framesExpected !== artifact.frameCount
  if (decodeFailed) {
    issues.push(Object.freeze({
      code: 'MP4_DECODE_FAILED', severity: 'hard', evidenceRange: Object.freeze({ startFrame: 0, endFrame: Math.max(1, artifact.frameCount) }),
      elementIds: Object.freeze(['decode']), evidenceIds: Object.freeze([`mp4-sha256:${artifact.sha256}`]),
      message: `${MESSAGE.MP4_DECODE_FAILED} (${decode.framesDecoded} of ${decode.framesExpected} frames).`, sampleIds: Object.freeze([]),
    }))
  }
  const localized = localizeMp4Issues(verdicts)
  issues.push(...localized)
  for (const issue of localized) {
    if (issue.code === 'MP4_PIXEL_EVIDENCE_UNKNOWN') {
      unknowns.push(Object.freeze({ check: issue.elementIds[0]!.split(':')[0] as Mp4CheckId, reason: issue.message, evidenceRange: issue.evidenceRange }))
    }
  }
  const sampledFrames = verdicts.map((verdict) => verdict.frameIndex)
  const gaps = unsampledRanges(artifact.frameCount, sampledFrames)
  if (gaps.length > 0) {
    issues.push(Object.freeze({
      code: 'MP4_PIXEL_COVERAGE_PARTIAL', severity: 'warning', evidenceRange: Object.freeze({ startFrame: gaps[0]!.startFrame, endFrame: gaps.at(-1)!.endFrame }),
      elementIds: Object.freeze(['coverage']), evidenceIds: Object.freeze([`mp4-pixel-critic:${MP4_PIXEL_CRITIC_POLICY_SHA256}`]),
      message: `${MESSAGE.MP4_PIXEL_COVERAGE_PARTIAL} (${gaps.length} gap(s), ${artifact.frameCount - sampledFrames.length} of ${artifact.frameCount} frames unmeasured).`, sampleIds: Object.freeze([]),
    }))
  }
  if (verdicts.length === 0 && !decodeFailed) {
    issues.push(Object.freeze({
      code: 'MP4_PIXEL_EVIDENCE_UNKNOWN', severity: 'warning', evidenceRange: Object.freeze({ startFrame: 0, endFrame: Math.max(1, artifact.frameCount) }),
      elementIds: Object.freeze(['coverage:no-sample']), evidenceIds: Object.freeze([`mp4-pixel-critic:${MP4_PIXEL_CRITIC_POLICY_SHA256}`]),
      message: `${MESSAGE.MP4_PIXEL_EVIDENCE_UNKNOWN} (no frame was measured).`, sampleIds: Object.freeze([]),
    }))
  }
  const summary = (id: Mp4CheckId): Mp4CheckSummary => {
    const counts = { pass: 0, fail: 0, unknown: 0, notApplicable: 0 }
    for (const verdict of verdicts) {
      const value = verdict.checks[id].verdict
      if (value === 'pass') counts.pass += 1
      else if (value === 'fail') counts.fail += 1
      else if (value === 'unknown') counts.unknown += 1
      else counts.notApplicable += 1
    }
    const overall = counts.fail > 0 ? 'fail' : counts.unknown > 0 ? 'unknown' : counts.pass > 0 ? 'pass' : 'not-applicable'
    return Object.freeze({ verdict: overall as Mp4CheckSummary['verdict'], ...counts })
  }
  const checks = Object.freeze(Object.fromEntries(MP4_CHECKS.map((id) => [id, summary(id)])) as Record<Mp4CheckId, Mp4CheckSummary>)
  const sortedIssues = Object.freeze(issues.toSorted((left, right) => left.evidenceRange.startFrame - right.evidenceRange.startFrame ||
    left.code.localeCompare(right.code) || left.elementIds.join(':').localeCompare(right.elementIds.join(':'))))
  const verdict = sortedIssues.some((issue) => issue.severity === 'hard') ? 'blocked' as const : sortedIssues.length > 0 ? 'warning' as const : 'passed' as const
  const body = Object.freeze({
    schemaVersion: 'mp4-quality-report/v1' as const, identity, artifact, decode,
    policy: Object.freeze({ id: MP4_PIXEL_CRITIC_POLICY_ID, sha256: MP4_PIXEL_CRITIC_POLICY_SHA256, body: MP4_PIXEL_CRITIC_POLICY }),
    outputSpec: input.outputSpec, controls: Object.freeze([...input.controls]), oracle: input.oracle,
    sampling: Object.freeze({
      strategy: gaps.length === 0 && sampledFrames.length === artifact.frameCount ? 'all-frames' as const : 'stride-with-edges' as const,
      totalFrames: artifact.frameCount, sampledFrames: sampledFrames.length,
      policy: Object.freeze({ allFramesUpTo: input.samplingPolicy?.allFramesUpTo ?? MP4_PIXEL_CRITIC_POLICY.sampling.allFramesUpTo, strideFrames: input.samplingPolicy?.strideFrames ?? MP4_PIXEL_CRITIC_POLICY.sampling.strideFrames }),
      frameRanges: rangesOf(sampledFrames), gaps,
    }),
    noiseProbe: input.noiseProbe,
    samples: Object.freeze(input.samples.map((facts, index) => Object.freeze({
      sampleId: facts.sampleId, frameIndex: facts.frameIndex, ptsTicks: facts.ptsTicks, frameSha256: facts.frameSha256, facts, verdict: verdicts[index]!,
    }))),
    checks, issues: sortedIssues, unknowns: Object.freeze(unknowns), verdict, exportAllowed: verdict !== 'blocked',
  })
  return Object.freeze({ ...body, reportHash: calculateCanonicalHash(body) })
}

/** Recomputes the seal and the verdict arithmetic of a report; a report that was edited after sealing does not verify. */
export function verifyMp4QualityReport(report: Readonly<Mp4QualityReportV1>): void {
  const { reportHash, ...body } = report
  assertDomain(SHA256.test(reportHash) && reportHash === calculateCanonicalHash(body), 'INVALID_RENDER_INPUT', 'MP4 quality report hash is inconsistent')
  assertDomain(report.schemaVersion === 'mp4-quality-report/v1', 'INVALID_RENDER_INPUT', 'MP4 quality report schema is unsupported')
  assertDomain(report.policy.sha256 === calculateCanonicalHash(report.policy.body), 'INVALID_RENDER_INPUT', 'MP4 quality report policy digest is inconsistent')
  const hard = report.issues.some((issue) => issue.severity === 'hard')
  const expected = hard ? 'blocked' : report.issues.length > 0 ? 'warning' : 'passed'
  assertDomain(report.verdict === expected && report.exportAllowed === (expected !== 'blocked'), 'INVALID_RENDER_INPUT', 'MP4 quality report verdict does not follow its issues')
  assertDomain(report.sampling.sampledFrames === report.samples.length, 'INVALID_RENDER_INPUT', 'MP4 quality report sampling disagrees with its samples')
}

/**
 * The report must describe THIS delivered file for THIS variant: a report of another file, another variant or another operation does not
 * authorize it. Returns the reasons it does not (empty when it does).
 */
export function mp4ReportMismatches(report: Readonly<Mp4QualityReportV1>, expected: Readonly<{
  artifactSha256: string; artifactByteSize: number; identity: Mp4ReportIdentity
}>): readonly string[] {
  const reasons: string[] = []
  if (report.artifact.sha256 !== expected.artifactSha256) reasons.push('ARTIFACT_SHA256')
  if (report.artifact.byteSize !== expected.artifactByteSize) reasons.push('ARTIFACT_SIZE')
  for (const key of Object.keys(expected.identity) as Array<keyof Mp4ReportIdentity>) {
    if (report.identity[key] !== expected.identity[key]) reasons.push(`IDENTITY_${key.toUpperCase()}`)
  }
  return Object.freeze(reasons)
}

/**
 * The summary of a sealed MP4 report that travels inside the per-variant format report (`format-quality-report/v3`): enough to bind
 * the variant's verdict to the exact file, input, policy and oracle that produced it, and to find the full report by its hash.
 */
export type Mp4EvidenceSealV1 = Readonly<{
  schemaVersion: 'mp4-evidence-seal/v1'
  reportSchemaVersion: 'mp4-quality-report/v1'
  reportHash: string
  /** SHA-256 of the exact bytes `serializeMp4QualityReport` writes: the content address of the stored report file. */
  reportFileSha256: string
  artifactSha256: string
  artifactByteSize: number
  renderInputHash: string
  workspaceId: string
  projectId: string
  projectVersionId: string
  variantId: string
  outputSpecId: string
  operationId: string
  policySha256: string
  oracleModelDigests: readonly Readonly<{ id: string; xmlSha256: string; binSha256: string; scoreFloor: number }>[]
  sampledFrames: number
  totalFrames: number
  verdict: 'passed' | 'warning' | 'blocked'
}>

/** The one serialization of a sealed report (canonical key order); a stored report file is these bytes. */
export const serializeMp4QualityReport = (report: Readonly<Mp4QualityReportV1>): string => stableSerialize(report)

export function sealMp4Evidence(report: Readonly<Mp4QualityReportV1>): Readonly<Mp4EvidenceSealV1> {
  verifyMp4QualityReport(report)
  return Object.freeze({
    schemaVersion: 'mp4-evidence-seal/v1' as const, reportSchemaVersion: report.schemaVersion, reportHash: report.reportHash,
    reportFileSha256: createHash('sha256').update(serializeMp4QualityReport(report)).digest('hex'),
    artifactSha256: report.artifact.sha256, artifactByteSize: report.artifact.byteSize, renderInputHash: report.identity.renderInputHash,
    workspaceId: report.identity.workspaceId, projectId: report.identity.projectId, projectVersionId: report.identity.projectVersionId,
    variantId: report.identity.variantId, outputSpecId: report.identity.outputSpecId, operationId: report.identity.operationId,
    policySha256: report.policy.sha256,
    oracleModelDigests: Object.freeze(report.oracle.models.map((model) => Object.freeze({ id: model.id, xmlSha256: model.xmlSha256, binSha256: model.binSha256, scoreFloor: model.scoreFloor }))),
    sampledFrames: report.sampling.sampledFrames, totalFrames: report.sampling.totalFrames, verdict: report.verdict,
  })
}

/** Whether a seal is well formed and (when given) belongs to the file, variant and operation it is presented for. */
export function mp4EvidenceSealMismatches(seal: Readonly<Mp4EvidenceSealV1>, expected?: Readonly<{ artifactSha256?: string; outputSpecId?: string; variantId?: string; operationId?: string }>): readonly string[] {
  const reasons: string[] = []
  if (seal.schemaVersion !== 'mp4-evidence-seal/v1' || seal.reportSchemaVersion !== 'mp4-quality-report/v1') reasons.push('SCHEMA')
  for (const key of ['reportHash', 'reportFileSha256', 'artifactSha256', 'renderInputHash', 'policySha256'] as const) if (!SHA256.test(seal[key])) reasons.push(`${key.toUpperCase()}_INVALID`)
  if (expected?.artifactSha256 !== undefined && seal.artifactSha256 !== expected.artifactSha256) reasons.push('ARTIFACT_SHA256')
  if (expected?.outputSpecId !== undefined && seal.outputSpecId !== expected.outputSpecId) reasons.push('OUTPUT_SPEC')
  if (expected?.variantId !== undefined && seal.variantId !== expected.variantId) reasons.push('VARIANT')
  if (expected?.operationId !== undefined && seal.operationId !== expected.operationId) reasons.push('OPERATION')
  return Object.freeze(reasons)
}
