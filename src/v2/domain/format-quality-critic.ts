import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import { readOutputFormatPreset } from './output-format-registry.ts'
import { OUTPUT_ASPECT_RATIOS, type NormalizedBounds, type OutputAspectRatio } from './output-spec.ts'
import type { RenderElementMap } from './review-system.ts'

export const FORMAT_QUALITY_CODES = [
  'OUTPUT_CLIPPING', 'OUTPUT_SAFE_AREA', 'SUBJECT_NOT_VISIBLE',
  'SUBTITLE_SUBJECT_COLLISION', 'OUTPUT_DENSITY_EXCESS',
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

export interface FormatQualityReportV2 {
  schemaVersion: 'format-quality-report/v2'
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
}>): Readonly<FormatQualityReportV2> {
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
  const densityLimit = input.densityLimit ?? 0.72
  assertDomain(Number.isFinite(densityLimit) && densityLimit >= 0.25 && densityLimit <= 1, 'INVALID_ARGUMENT', 'Format density limit is invalid')
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
    schemaVersion: 'format-quality-report/v2' as const, outputSpecId: input.outputSpecId, format: input.format, proxyHash: input.proxyHash,
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
  return `${outputSpecId} (${format}) passed every format check over ${durationFrames} frames: no clipping, safe area, subject visibility, subtitle collision or density issue was found.`
}

export function selectExportableVariants(reports: readonly Readonly<FormatQualityReportV2>[]): Readonly<{
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
