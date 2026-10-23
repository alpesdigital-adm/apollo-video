import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import { readOutputFormatPreset } from './output-format-registry.ts'
import { OUTPUT_ASPECT_RATIOS, type NormalizedBounds, type OutputAspectRatio } from './output-spec.ts'
import type { CaptionPixelIssueV1 } from './caption-pixel-verdict.ts'
import type { CaptionLayoutOverflowV1 } from './caption-burn-layout.ts'
import { mp4EvidenceSealMismatches, type Mp4EvidenceSealV1, type Mp4PixelIssueV1 } from './mp4-pixel-quality.ts'
import type { RenderElementMap } from './review-system.ts'
import type { SubtitleAnchorPlan } from './subtitle-anchor-plan.ts'
import type { VariantReframeIssueV1 } from './variant-reframe-plan.ts'

/** The report schema the critic emits and `selectExportableVariants` accepts. */
export const FORMAT_QUALITY_REPORT_SCHEMA_VERSION = 'format-quality-report/v3' as const

/**
 * The numeric policy `critiqueOutputFormat` judges under (the safe area comes from the output preset, pinned by the registry hash). The
 * critic reads these values, and the proxy render content address is derived from this same object: a changed threshold is another address.
 */
export const FORMAT_QUALITY_POLICY = Object.freeze({
  defaultDensityLimit: 0.72,
  densityLimitRange: Object.freeze({ min: 0.25, max: 1 }),
})

export const FORMAT_QUALITY_CODES = [
  'OUTPUT_CLIPPING', 'OUTPUT_SAFE_AREA', 'SUBJECT_NOT_VISIBLE',
  'SUBTITLE_SUBJECT_COLLISION', 'OUTPUT_DENSITY_EXCESS',
  // F1.036 / FR-173: the anchor decision reports into the variant's own report, so a cue that had
  // nowhere safe to go blocks *this* output instead of being discovered by eye on the MP4.
  'NO_SAFE_SUBTITLE_REGION', 'SUBTITLE_ANCHOR_FALLBACK', 'SUBTITLE_ANCHOR_UNSTABLE',
  'FACE_PERCEPTION_UNAVAILABLE',
  // W65: where the captions of the delivered MP4 really are, measured on its pixels (see caption-pixel-verdict.ts).
  'CAPTION_PLACEMENT_MISMATCH', 'SUBTITLE_FACE_OVERLAP_IN_PIXELS', 'FACE_PIXEL_CHECK_UNAVAILABLE',
  // W66r: the persisted reframe plan of THIS output reports into its own verdict, localized by range and evidence. Two of them block the
  // output (the trajectory cannot keep the subject in frame); two ask a person to look (no subject, or evidence that is absent or uncertain).
  'REFRAME_SUBJECTS_DO_NOT_FIT', 'REFRAME_TRACKING_LIMIT_EXCEEDED', 'REFRAME_PERCEPTION_UNCERTAIN', 'REFRAME_NO_SUBJECT_OBSERVATION',
  // W67: what the independent critic read on the pixels of the delivered MP4 (see mp4-pixel-quality.ts). SUBTITLE_FACE_OVERLAP_IN_PIXELS is shared with W65.
  'CTA_FACE_OVERLAP_IN_PIXELS', 'INK_OUTSIDE_SAFE_AREA_IN_PIXELS', 'INK_CLIPPED_BY_CANVAS_IN_PIXELS', 'SUBJECT_NOT_VISIBLE_IN_PIXELS', 'SUBJECT_CLIPPED_IN_PIXELS',
  'INK_DENSITY_EXCESS_IN_PIXELS', 'MP4_PIXEL_EVIDENCE_UNKNOWN', 'MP4_PIXEL_COVERAGE_PARTIAL', 'MP4_DECODE_FAILED',
  // W70 readiness (R3): a drawn caption whose text does not fit the band it was certified in (decided by the layout before rendering).
  'CAPTION_TEXT_DOES_NOT_FIT',
] as const
export type FormatQualityCode = (typeof FORMAT_QUALITY_CODES)[number]

export interface FormatSubjectEvidenceV1 {
  id: string
  startFrame: number
  endFrame: number
  bounds: Readonly<NormalizedBounds>
  critical: boolean
}

/**
 * A format quality issue is localized by six independent coordinates so a reviewer can
 * reach the exact pixel evidence without opening the plan:
 * - the output identity (`outputSpecId` plus the content-addressed `outputPresetHash`);
 * - the **geometry actually rendered** (`placementPlanHash`, `reframePlanHash`), so an issue can
 *   never be read against a placement or a crop trajectory other than the one that produced the
 *   frames — `null` means the render carried no such plan, which is itself evidence;
 * - the frame interval `evidenceRange`, always **half-open** `[startFrame, endFrame)`
 *   (`endFrame` is the first frame that no longer carries the defect) and its `rangeMs` mirror;
 * - the render element identities (`elementIds`);
 * - the perception/evidence identities (`evidenceIds`).
 * `code` is the reason code and `severity` decides whether the variant is blocked.
 */
export interface FormatQualityIssueV2 {
  code: FormatQualityCode
  severity: 'hard' | 'warning'
  category: 'editorial'
  outputSpecId: string
  outputPresetHash: string
  placementPlanHash: string | null
  reframePlanHash: string | null
  format: OutputAspectRatio
  message: string
  rangeMs: readonly [number, number]
  evidenceRange: Readonly<{ startFrame: number; endFrame: number }>
  elementIds: readonly string[]
  evidenceIds: readonly string[]
  correctable: boolean
}

/**
 * `format-quality-report/v3` (W67) adds `mp4Evidence`: the seal of the independent MP4 critic's report that judged the delivered file, or
 * null when no such critic ran. v2 reports did not carry it and are not accepted by `selectExportableVariants`.
 */
export interface FormatQualityReportV3 {
  schemaVersion: typeof FORMAT_QUALITY_REPORT_SCHEMA_VERSION
  mp4Evidence: Readonly<Mp4EvidenceSealV1> | null
  outputSpecId: string
  format: OutputAspectRatio
  proxyHash: string
  renderElementMapHash: string
  outputPresetHash: string
  placementPlanHash: string | null
  reframePlanHash: string | null
  status: 'passed' | 'warning' | 'blocked'
  exportAllowed: boolean
  explanation: string
  issues: readonly Readonly<FormatQualityIssueV2>[]
  reportHash: string
}

export interface FormatVariantDecisionV2 {
  outputSpecId: string
  outputPresetHash: string
  placementPlanHash: string | null
  reframePlanHash: string | null
  format: OutputAspectRatio
  status: 'passed' | 'warning' | 'blocked'
  exportAllowed: boolean
  blockingCodes: readonly FormatQualityCode[]
  warningCodes: readonly FormatQualityCode[]
  explanation: string
  reportHash: string
}

const SHA256 = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

function normalized(bounds: RenderElementMap['elements'][number]['bounds'], canvas: RenderElementMap['canvas']): NormalizedBounds {
  return { x: bounds.x / canvas.width, y: bounds.y / canvas.height, width: bounds.width / canvas.width, height: bounds.height / canvas.height }
}

function overlaps(left: NormalizedBounds, right: NormalizedBounds): boolean {
  return left.x < right.x + right.width && left.x + left.width > right.x &&
    left.y < right.y + right.height && left.y + left.height > right.y
}

function validBounds(value: NormalizedBounds): boolean {
  return [value.x, value.y, value.width, value.height].every(Number.isFinite) &&
    value.x >= 0 && value.y >= 0 && value.width > 0 && value.height > 0 &&
    value.x + value.width <= 1 && value.y + value.height <= 1
}

function rangeMs(startFrame: number, endFrame: number, fps: number): readonly [number, number] {
  return Object.freeze([Math.round(startFrame / fps * 1_000), Math.round(endFrame / fps * 1_000)])
}

export function critiqueOutputFormat(input: Readonly<{
  outputSpecId: string
  format: OutputAspectRatio
  proxyHash: string
  map: Readonly<RenderElementMap>
  /** Content address of the placement geometry that produced these frames, when the render had one. */
  placementPlanHash?: string | null
  /** Content address of the crop trajectory that produced these frames, when the render had one. */
  reframePlanHash?: string | null
  subjects?: readonly Readonly<FormatSubjectEvidenceV1>[]
  densityLimit?: number
  /**
   * The F1.036 anchor decision that produced these frames. Its localized reason codes are lifted
   * into this report so the variant verdict already carries them: a suppressed cue is a hard block,
   * a relaxed band or a forced early move is a warning the reviewer can see next to the pixels.
   */
  subtitleAnchorPlan?: Readonly<SubtitleAnchorPlan> | null
  /**
   * W65. What the pixel critic found on the delivered frames. Like the anchor decision it is lifted into this report, so a caption
   * that is not where the plan put it, or that covers a face a veto detector found, blocks this output.
   */
  captionPixelIssues?: readonly Readonly<CaptionPixelIssueV1>[]
  /**
   * W70 readiness (R3). The drawn captions whose text does not fit the band the plan certified, as the layout decided before the render: each
   * is a HARD issue of this output (the pixel critic's tolerance can hide an overflow of a few pixels; the layout cannot).
   */
  captionLayoutOverflows?: readonly Readonly<CaptionLayoutOverflowV1>[]
  /**
   * W66r. The localized issues of the reframe plan record these frames were made from. Each carries its severity from the record (the policy
   * decided it), its range in timeline frames and the evidence it came from; the variant is blocked or reviewable by them, and no other output is.
   */
  reframeIssues?: readonly Readonly<VariantReframeIssueV1>[]
  reframeRecordHash?: string | null
  /**
   * W67. What the independent MP4 critic found on the decoded pixels of THIS delivered file, with the content address of the sealed
   * report they came from. A hard issue blocks this output, and only this output.
   */
  mp4PixelIssues?: readonly Readonly<Mp4PixelIssueV1>[]
  mp4Evidence?: Readonly<Mp4EvidenceSealV1> | null
}>): Readonly<FormatQualityReportV3> {
  assertDomain(ID.test(input.outputSpecId) && OUTPUT_ASPECT_RATIOS.includes(input.format), 'INVALID_OUTPUT_SPEC', 'Format critic output identity is invalid')
  assertDomain(SHA256.test(input.proxyHash) && input.map.proxyHash === input.proxyHash, 'INVALID_RENDER_INPUT', 'Format critic proxy evidence is inconsistent')
  const placementPlanHash = input.placementPlanHash ?? null
  const reframePlanHash = input.reframePlanHash ?? null
  assertDomain(
    (placementPlanHash === null || SHA256.test(placementPlanHash)) &&
    (reframePlanHash === null || SHA256.test(reframePlanHash)),
    'INVALID_RENDER_INPUT', 'Format critic geometry identity is invalid',
  )
  assertDomain(input.map.fps > 0 && Number.isFinite(input.map.fps) && input.map.durationFrames > 0, 'INVALID_RENDER_INPUT', 'Format critic timeline is invalid')
  const preset = readOutputFormatPreset(input.format)
  assertDomain(input.outputSpecId === preset.spec.id, 'INVALID_OUTPUT_SPEC', 'Format critic outputSpecId does not match the canonical registry preset')
  const densityLimit = input.densityLimit ?? FORMAT_QUALITY_POLICY.defaultDensityLimit
  assertDomain(Number.isFinite(densityLimit) && densityLimit >= FORMAT_QUALITY_POLICY.densityLimitRange.min && densityLimit <= FORMAT_QUALITY_POLICY.densityLimitRange.max, 'INVALID_ARGUMENT', 'Format density limit is invalid')
  const subjects = (input.subjects ?? []).map((subject) => {
    assertDomain(ID.test(subject.id) && Number.isSafeInteger(subject.startFrame) && Number.isSafeInteger(subject.endFrame) && subject.startFrame >= 0 && subject.endFrame > subject.startFrame && subject.endFrame <= input.map.durationFrames && validBounds(subject.bounds), 'INVALID_RENDER_INPUT', 'Format subject evidence is invalid')
    return Object.freeze({ ...subject, bounds: Object.freeze({ ...subject.bounds }) })
  })
  const issues: FormatQualityIssueV2[] = []
  const add = (issue: Omit<FormatQualityIssueV2, 'category' | 'outputSpecId' | 'outputPresetHash' | 'placementPlanHash' | 'reframePlanHash' | 'format' | 'rangeMs' | 'correctable'>) => {
    assertDomain(issue.evidenceRange.endFrame > issue.evidenceRange.startFrame, 'INVALID_RENDER_INPUT', 'Format issue frame range must be a non-empty half-open interval')
    issues.push(Object.freeze({
      ...issue, category: 'editorial' as const, outputSpecId: input.outputSpecId, outputPresetHash: preset.presetHash,
      placementPlanHash, reframePlanHash, format: input.format,
      rangeMs: rangeMs(issue.evidenceRange.startFrame, issue.evidenceRange.endFrame, input.map.fps), correctable: true,
      evidenceRange: Object.freeze({ ...issue.evidenceRange }), elementIds: Object.freeze([...issue.elementIds]), evidenceIds: Object.freeze([...issue.evidenceIds]),
    }))
  }
  const byFrame = new Map<number, typeof input.map.elements>()
  for (const element of input.map.elements) byFrame.set(element.frame, Object.freeze([...(byFrame.get(element.frame) ?? []), element]))
  for (const [frame, elements] of byFrame) {
    const visible = elements.filter((element) => element.opacity > 0)
    for (const element of visible) {
      const box = normalized(element.bounds, input.map.canvas)
      const clipped = box.x < 0 || box.y < 0 || box.x + box.width > 1 || box.y + box.height > 1
      if (clipped) add({ code: 'OUTPUT_CLIPPING', severity: 'hard', message: `${element.type} is clipped by the ${input.format} canvas.`, evidenceRange: { startFrame: frame, endFrame: frame + 1 }, elementIds: [element.elementId], evidenceIds: [`render-map:${input.proxyHash}`] })
      if (['subtitle', 'cta'].includes(element.type) && !clipped) {
        const safe = preset.spec.safeArea
        if (box.x < safe.left || box.y < safe.top || box.x + box.width > 1 - safe.right || box.y + box.height > 1 - safe.bottom) add({ code: 'OUTPUT_SAFE_AREA', severity: 'warning', message: `${element.type} leaves the ${input.format} safe area.`, evidenceRange: { startFrame: frame, endFrame: frame + 1 }, elementIds: [element.elementId], evidenceIds: [`render-map:${input.proxyHash}`] })
      }
      if (element.type === 'subtitle') for (const subject of subjects.filter((item) => item.startFrame <= frame && item.endFrame > frame)) {
        if (overlaps(box, subject.bounds)) add({ code: 'SUBTITLE_SUBJECT_COLLISION', severity: 'hard', message: `Subtitle collides with protected subject ${subject.id} in ${input.format}.`, evidenceRange: { startFrame: frame, endFrame: frame + 1 }, elementIds: [element.elementId], evidenceIds: [subject.id, `render-map:${input.proxyHash}`] })
      }
    }
    const occupied = visible.filter((element) => !['background', 'presenter'].includes(element.type)).reduce((sum, element) => {
      const box = normalized(element.bounds, input.map.canvas); return sum + Math.max(0, box.width) * Math.max(0, box.height)
    }, 0)
    if (occupied > densityLimit) add({ code: 'OUTPUT_DENSITY_EXCESS', severity: 'warning', message: `Visible overlays occupy ${Math.round(occupied * 100)}% of the ${input.format} canvas.`, evidenceRange: { startFrame: frame, endFrame: frame + 1 }, elementIds: visible.filter((element) => !['background', 'presenter'].includes(element.type)).map((element) => element.elementId), evidenceIds: [`render-map:${input.proxyHash}`] })
  }
  // The anchor decision is evidence about this render, so it is localized exactly like the pixel
  // checks above: same frame interval semantics, same element ids, same evidence ids.
  for (const issue of input.subtitleAnchorPlan?.issues ?? []) {
    assertDomain(
      issue.evidenceRange.startFrame >= 0 && issue.evidenceRange.endFrame <= input.map.durationFrames,
      'INVALID_RENDER_INPUT', 'Subtitle anchor issue is outside the rendered timeline',
    )
    add({
      code: issue.code, severity: issue.severity, message: issue.message,
      evidenceRange: issue.evidenceRange,
      elementIds: issue.elementIds,
      evidenceIds: [...issue.evidenceIds, `subtitle-anchor-plan:${input.subtitleAnchorPlan!.anchorPlanHash}`],
    })
  }
  for (const issue of input.captionPixelIssues ?? []) {
    assertDomain(
      issue.evidenceRange.startFrame >= 0 && issue.evidenceRange.endFrame <= input.map.durationFrames,
      'INVALID_RENDER_INPUT', 'Caption pixel issue is outside the rendered timeline',
    )
    add({
      code: issue.code, severity: issue.severity, message: issue.message,
      evidenceRange: issue.evidenceRange, elementIds: issue.elementIds,
      evidenceIds: [...issue.evidenceIds, `render-map:${input.proxyHash}`],
    })
  }
  for (const overflow of input.captionLayoutOverflows ?? []) {
    assertDomain(
      overflow.code === 'CAPTION_TEXT_DOES_NOT_FIT' && Number.isSafeInteger(overflow.startFrame) && Number.isSafeInteger(overflow.endFrame) &&
        overflow.startFrame >= 0 && overflow.endFrame > overflow.startFrame && overflow.endFrame <= input.map.durationFrames,
      'INVALID_RENDER_INPUT', 'Caption layout issue is outside the rendered timeline',
    )
    add({
      code: 'CAPTION_TEXT_DOES_NOT_FIT', severity: 'hard', message: overflow.message,
      evidenceRange: { startFrame: overflow.startFrame, endFrame: overflow.endFrame }, elementIds: [`subtitle:${overflow.cueId}`],
      evidenceIds: [`caption-layout:${overflow.layoutId}`, ...(input.subtitleAnchorPlan ? [`subtitle-anchor-plan:${input.subtitleAnchorPlan.anchorPlanHash}`] : [])],
    })
  }
  const mp4Evidence = input.mp4Evidence ?? null
  assertDomain((input.mp4PixelIssues ?? []).length === 0 || mp4Evidence !== null, 'INVALID_RENDER_INPUT', 'MP4 pixel issues need the seal of the report they came from')
  if (mp4Evidence) {
    assertDomain(mp4EvidenceSealMismatches(mp4Evidence, { artifactSha256: input.proxyHash, outputSpecId: input.outputSpecId }).length === 0, 'INVALID_RENDER_INPUT', 'MP4 evidence does not belong to this delivered file and output')
  }
  for (const issue of input.mp4PixelIssues ?? []) {
    assertDomain(
      issue.evidenceRange.startFrame >= 0 && issue.evidenceRange.endFrame <= input.map.durationFrames && issue.evidenceRange.endFrame > issue.evidenceRange.startFrame,
      'INVALID_RENDER_INPUT', 'MP4 pixel issue is outside the rendered timeline',
    )
    add({
      code: issue.code, severity: issue.severity, message: issue.message,
      evidenceRange: issue.evidenceRange, elementIds: issue.elementIds,
      evidenceIds: [...issue.evidenceIds, `mp4-quality-report:${mp4Evidence!.reportHash}`, `render-map:${input.proxyHash}`],
    })
  }
  for (const issue of input.reframeIssues ?? []) {
    assertDomain(
      issue.startFrame >= 0 && issue.endFrame > issue.startFrame && issue.endFrame <= input.map.durationFrames,
      'INVALID_RENDER_INPUT', 'Reframe issue is outside the rendered timeline',
    )
    assertDomain(issue.aspectRatio === input.format, 'INVALID_RENDER_INPUT', 'Reframe issue belongs to another output')
    const messages: Readonly<Record<VariantReframeIssueV1['code'], string>> = {
      SUBJECTS_DO_NOT_FIT: `The subjects cannot be framed together in ${input.format}; no crop shows them all.`,
      TRACKING_LIMIT_EXCEEDED: `The ${input.format} crop cannot follow the subject within its speed and acceleration limits.`,
      PERCEPTION_UNCERTAIN: `The ${input.format} crop rests on evidence that is absent, refused or under the confidence floor.`,
      NO_SUBJECT_OBSERVATION: `No subject was observed in this stretch of ${input.format}; its crop is carried over from the nearest framed subject, or the whole clip is shown when none was framed in it.`,
    }
    add({
      code: `REFRAME_${issue.code}` as FormatQualityCode, severity: issue.severity, message: messages[issue.code],
      evidenceRange: { startFrame: issue.startFrame, endFrame: issue.endFrame }, elementIds: [],
      evidenceIds: [...issue.evidenceIds, ...(input.reframeRecordHash ? [`reframe-plan-record:${input.reframeRecordHash}`] : [])],
    })
  }
  for (const subject of subjects.filter((item) => item.critical)) {
    const presenterFrames = [...byFrame].filter(([frame, elements]) => frame >= subject.startFrame && frame < subject.endFrame && elements.some((element) => element.type === 'presenter' && element.opacity > 0 && overlaps(normalized(element.bounds, input.map.canvas), subject.bounds))).map(([frame]) => frame)
    if (presenterFrames.length === 0) add({ code: 'SUBJECT_NOT_VISIBLE', severity: 'hard', message: `Critical subject ${subject.id} is not visible in ${input.format}.`, evidenceRange: { startFrame: subject.startFrame, endFrame: subject.endFrame }, elementIds: [], evidenceIds: [subject.id] })
  }
  const sortedIssues = issues.toSorted((left, right) => left.code.localeCompare(right.code) || left.elementIds.join(':').localeCompare(right.elementIds.join(':')) || left.evidenceIds.join(':').localeCompare(right.evidenceIds.join(':')) || left.evidenceRange.startFrame - right.evidenceRange.startFrame)
  const grouped: FormatQualityIssueV2[] = []
  for (const issue of sortedIssues) {
    const previous = grouped.at(-1)
    if (previous && previous.code === issue.code && previous.severity === issue.severity && previous.elementIds.join(':') === issue.elementIds.join(':') && previous.evidenceIds.join(':') === issue.evidenceIds.join(':') && previous.evidenceRange.endFrame === issue.evidenceRange.startFrame) {
      grouped[grouped.length - 1] = Object.freeze({ ...previous, rangeMs: rangeMs(previous.evidenceRange.startFrame, issue.evidenceRange.endFrame, input.map.fps), evidenceRange: Object.freeze({ startFrame: previous.evidenceRange.startFrame, endFrame: issue.evidenceRange.endFrame }) })
    } else grouped.push(issue)
  }
  const canonicalIssues = Object.freeze(grouped.toSorted((left, right) => left.evidenceRange.startFrame - right.evidenceRange.startFrame || left.code.localeCompare(right.code) || left.elementIds.join(':').localeCompare(right.elementIds.join(':'))))
  const status = canonicalIssues.some((issue) => issue.severity === 'hard') ? 'blocked' as const : canonicalIssues.length ? 'warning' as const : 'passed' as const
  const body = Object.freeze({
    schemaVersion: FORMAT_QUALITY_REPORT_SCHEMA_VERSION, mp4Evidence, outputSpecId: input.outputSpecId, format: input.format, proxyHash: input.proxyHash,
    renderElementMapHash: calculateCanonicalHash(input.map), outputPresetHash: preset.presetHash,
    placementPlanHash, reframePlanHash, status, exportAllowed: status !== 'blocked',
    explanation: explain(input.outputSpecId, input.format, status, canonicalIssues, input.map.durationFrames), issues: canonicalIssues,
  })
  return Object.freeze({ ...body, reportHash: calculateCanonicalHash(body) })
}

function distinctCodes(issues: readonly Readonly<FormatQualityIssueV2>[], severity: 'hard' | 'warning'): readonly FormatQualityCode[] {
  return Object.freeze([...new Set(issues.filter((issue) => issue.severity === severity).map((issue) => issue.code))].toSorted())
}

function explain(outputSpecId: string, format: OutputAspectRatio, status: 'passed' | 'warning' | 'blocked', issues: readonly Readonly<FormatQualityIssueV2>[], durationFrames: number): string {
  const blocking = distinctCodes(issues, 'hard')
  const warnings = distinctCodes(issues, 'warning')
  if (status === 'blocked') {
    return `${outputSpecId} (${format}) is blocked by ${blocking.length} hard format reason code(s): ${blocking.join(', ')}. Only this output is blocked; other outputs keep their own verdict.`
  }
  if (status === 'warning') {
    return `${outputSpecId} (${format}) is exportable with ${warnings.length} warning reason code(s): ${warnings.join(', ')}. No hard clipping, subject visibility or subtitle collision issue was found.`
  }
  return `${outputSpecId} (${format}) passed every format check over ${durationFrames} frames: no clipping, safe area, subject visibility, subtitle collision, subtitle anchor or density issue was found.`
}

export function selectExportableVariants(reports: readonly Readonly<FormatQualityReportV3>[]): Readonly<{
  approvedOutputSpecIds: readonly string[]
  blockedOutputSpecIds: readonly string[]
  decisions: readonly Readonly<FormatVariantDecisionV2>[]
}> {
  const ordered = [...reports].toSorted((left, right) => left.outputSpecId.localeCompare(right.outputSpecId))
  for (const report of ordered) {
    const { reportHash, ...body } = report
    assertDomain(SHA256.test(reportHash) && reportHash === calculateCanonicalHash(body), 'INVALID_RENDER_INPUT', 'Format quality report hash is inconsistent')
    assertDomain(readOutputFormatPreset(report.format).spec.id === report.outputSpecId, 'INVALID_OUTPUT_SPEC', 'Format quality report is not bound to the canonical output preset')
    assertDomain(report.issues.every((issue) => issue.outputSpecId === report.outputSpecId && issue.outputPresetHash === report.outputPresetHash), 'INVALID_OUTPUT_SPEC', 'Format quality issue is not localized in its own output')
    // An issue always carries the geometry of the render it came from; a report that mixes two
    // placement plans or two trajectories is not evidence about any single variant.
    assertDomain(report.issues.every((issue) => issue.placementPlanHash === report.placementPlanHash && issue.reframePlanHash === report.reframePlanHash), 'INVALID_RENDER_INPUT', 'Format quality issue is not bound to the geometry of its own render')
    // A report that carries the seal of the MP4 critic cannot allow an export the seal's own verdict forbids.
    assertDomain(report.schemaVersion === FORMAT_QUALITY_REPORT_SCHEMA_VERSION, 'INVALID_RENDER_INPUT', 'Format quality report schema is unsupported')
    assertDomain(report.mp4Evidence === null || (mp4EvidenceSealMismatches(report.mp4Evidence, { artifactSha256: report.proxyHash, outputSpecId: report.outputSpecId }).length === 0 && !(report.mp4Evidence.verdict === 'blocked' && report.exportAllowed)), 'INVALID_RENDER_INPUT', 'Format quality report disagrees with its MP4 evidence')
  }
  assertDomain(new Set(ordered.map((report) => report.outputSpecId)).size === ordered.length, 'INVALID_ARGUMENT', 'Format quality reports must be unique per output')
  return Object.freeze({
    approvedOutputSpecIds: Object.freeze(ordered.filter((report) => report.exportAllowed).map((report) => report.outputSpecId)),
    blockedOutputSpecIds: Object.freeze(ordered.filter((report) => !report.exportAllowed).map((report) => report.outputSpecId)),
    decisions: Object.freeze(ordered.map((report) => Object.freeze({
      outputSpecId: report.outputSpecId, outputPresetHash: report.outputPresetHash,
      placementPlanHash: report.placementPlanHash, reframePlanHash: report.reframePlanHash, format: report.format,
      status: report.status, exportAllowed: report.exportAllowed,
      blockingCodes: distinctCodes(report.issues, 'hard'), warningCodes: distinctCodes(report.issues, 'warning'),
      explanation: report.explanation, reportHash: report.reportHash,
    }))),
  })
}
