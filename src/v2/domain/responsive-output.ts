import { customizeOutputFormatPreset, OUTPUT_FORMAT_REGISTRY } from './output-format-registry.ts'
import { OUTPUT_ASPECT_RATIOS, type OutputAspectRatio, type OutputSpec } from './output-spec.ts'
import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import { deriveSubtitleRegion, type SubtitleRegionV1 } from './subtitle-region.ts'
import { SUBTITLE_STYLE_REGISTRY } from './subtitle-system.ts'

export const VERSIONED_OUTPUT_PRESETS = Object.freeze(Object.fromEntries(OUTPUT_ASPECT_RATIOS.map((ratio) => {
  const preset = OUTPUT_FORMAT_REGISTRY.presets[ratio]
  return [ratio, Object.freeze({ version: preset.version, export: preset.exportDefaults.final, spec: preset.spec })]
})) as unknown as Readonly<Record<OutputAspectRatio, { version: 1; export: { codec: 'h264'; audioCodec: 'aac'; pixelFormat: 'yuv420p' }; spec: OutputSpec }>>)
export function customizeOutputPreset(ratio: OutputAspectRatio, input: Partial<Pick<OutputSpec, 'width' | 'height' | 'fps' | 'safeArea'>>) { return customizeOutputFormatPreset(ratio, input).spec }

export const RESPONSIVE_PLACEMENT_POLICY_VERSION = 'responsive-placement-2026-08-v1'
export type PlacementKind = 'subtitle' | 'logo' | 'cta' | 'insert'
export type PlacementAnchor = 'auto' | 'top-left' | 'top-center' | 'top-right' | 'center-left' | 'center' | 'center-right' | 'bottom-left' | 'bottom-center' | 'bottom-right'
export type ProtectedRegionKind = 'face' | 'roi' | 'reading-order'

export interface PlacementElement {
  id: string
  kind: PlacementKind
  anchor: PlacementAnchor
  priority: number
  readingOrder: number
  minWidth: number
  maxWidth: number
  minHeight: number
  maxHeight: number
}

export interface ProtectedPlacementRegion {
  id: string
  kind: ProtectedRegionKind
  x: number
  y: number
  width: number
  height: number
}

export interface ResponsivePlacementInput {
  spec: Readonly<OutputSpec>
  elements: readonly Readonly<PlacementElement>[]
  protectedRegions?: readonly Readonly<ProtectedPlacementRegion>[]
  /**
   * Subtitle geometry derived from the resolved subtitle preset + this OutputSpec
   * (`deriveSubtitleRegion`). When present it *is* the subtitle candidate: width, height and the
   * preferred box come from the registry, not from a rectangle authored here. `subtitle` elements
   * fall back to the format rule below only when no region was resolved (e.g. subtitles are off).
   */
  subtitleRegion?: Readonly<SubtitleRegionV1>
}

export interface PlacedElement {
  id: string
  kind: PlacementKind
  anchor: Exclude<PlacementAnchor, 'auto'>
  readingOrder: number
  x: number
  y: number
  width: number
  height: number
}

export interface PlacementIssue {
  elementId: string
  code: 'IMPOSSIBLE_CONSTRAINTS' | 'ANCHOR_FALLBACK' | 'FACE_COLLISION_AVOIDED' | 'ROI_COLLISION_AVOIDED' | 'READING_ORDER_COLLISION_AVOIDED'
  severity: 'warning' | 'review'
  reason: string
  attemptedAnchors: readonly string[]
}

export interface ResponsivePlacementResult {
  schemaVersion: 'responsive-placement/v2'
  policyVersion: typeof RESPONSIVE_PLACEMENT_POLICY_VERSION
  registryHash: string
  format: OutputAspectRatio
  canvas: Readonly<{ width: number; height: number }>
  safeArea: Readonly<{ top: number; right: number; bottom: number; left: number }>
  /**
   * Provenance of the subtitle geometry used by this solve, or `null` when no subtitle preset was
   * resolved. Being hash-covered, a reviewer can prove which registry preset produced the
   * subtitle box instead of trusting that some shared constant was the right one.
   */
  subtitleRegion: Readonly<SubtitleRegionV1> | null
  elements: readonly Readonly<PlacedElement>[]
  issues: readonly Readonly<PlacementIssue>[]
  reviewRequired: boolean
  placementHash: string
}

type NormalizedBox = Readonly<{ x: number; y: number; width: number; height: number }>
type FormatRule = Readonly<Record<PlacementKind, Readonly<{
  width: number
  height: number
  anchors: readonly Exclude<PlacementAnchor, 'auto'>[]
}>>>
const formatRule = (width: number, height: number, anchors: FormatRule[PlacementKind]['anchors']) =>
  Object.freeze({ width, height, anchors: Object.freeze([...anchors]) })

const FORMAT_RULES = {
  '9:16': Object.freeze({
    subtitle: formatRule(0.84, 0.15, ['bottom-center', 'top-center']),
    logo: formatRule(0.18, 0.08, ['top-right', 'top-left']),
    cta: formatRule(0.58, 0.11, ['bottom-center', 'center']),
    insert: formatRule(0.86, 0.34, ['center', 'center-right']),
  }),
  '16:9': Object.freeze({
    subtitle: formatRule(0.72, 0.19, ['bottom-center', 'bottom-left']),
    logo: formatRule(0.12, 0.14, ['top-left', 'top-right']),
    cta: formatRule(0.26, 0.15, ['bottom-right', 'bottom-left']),
    insert: formatRule(0.42, 0.58, ['center-right', 'center-left']),
  }),
  '4:5': Object.freeze({
    subtitle: formatRule(0.84, 0.17, ['bottom-center', 'top-center']),
    logo: formatRule(0.16, 0.1, ['top-right', 'top-left']),
    cta: formatRule(0.48, 0.12, ['bottom-center', 'center']),
    insert: formatRule(0.76, 0.44, ['center', 'center-right']),
  }),
  '1:1': Object.freeze({
    subtitle: formatRule(0.8, 0.19, ['bottom-center', 'top-center']),
    logo: formatRule(0.15, 0.15, ['top-left', 'top-right']),
    cta: formatRule(0.5, 0.14, ['bottom-center', 'center']),
    insert: formatRule(0.68, 0.54, ['center', 'center-right']),
  }),
  '21:9': Object.freeze({
    subtitle: formatRule(0.56, 0.23, ['bottom-center', 'bottom-left']),
    logo: formatRule(0.1, 0.2, ['top-left', 'top-right']),
    cta: formatRule(0.22, 0.2, ['bottom-right', 'bottom-left']),
    insert: formatRule(0.34, 0.7, ['center-right', 'center-left']),
  }),
} as const satisfies Readonly<Record<OutputAspectRatio, FormatRule>>

const finiteUnit = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1
const overlaps = (a: NormalizedBox, b: NormalizedBox) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

function boxForAnchor(
  anchor: Exclude<PlacementAnchor, 'auto'>,
  width: number,
  height: number,
  safe: NormalizedBox,
): NormalizedBox {
  const left = safe.x
  const centerX = safe.x + (safe.width - width) / 2
  const right = safe.x + safe.width - width
  const top = safe.y
  const centerY = safe.y + (safe.height - height) / 2
  const bottom = safe.y + safe.height - height
  const positions = {
    'top-left': [left, top], 'top-center': [centerX, top], 'top-right': [right, top],
    'center-left': [left, centerY], center: [centerX, centerY], 'center-right': [right, centerY],
    'bottom-left': [left, bottom], 'bottom-center': [centerX, bottom], 'bottom-right': [right, bottom],
  } as const
  const [x, y] = positions[anchor]
  return Object.freeze({ x, y, width, height })
}

function assertPlacementInput(input: ResponsivePlacementInput): void {
  assertDomain(OUTPUT_ASPECT_RATIOS.includes(input.spec.aspectRatio), 'INVALID_OUTPUT_SPEC', 'Responsive placement format is not registered')
  assertDomain(input.elements.length >= 1 && input.elements.length <= 64, 'INVALID_ARGUMENT', 'Responsive placement requires 1 to 64 elements')
  assertDomain(new Set(input.elements.map((element) => element.id)).size === input.elements.length, 'INVALID_ARGUMENT', 'Responsive placement element ids must be unique')
  for (const element of input.elements) {
    assertDomain(element.id.trim().length >= 1 && element.id.length <= 128, 'INVALID_ARGUMENT', 'Responsive placement element id is invalid')
    assertDomain(['subtitle', 'logo', 'cta', 'insert'].includes(element.kind), 'INVALID_ARGUMENT', 'Responsive placement element kind is invalid')
    assertDomain(Number.isSafeInteger(element.priority) && element.priority >= 0 && element.priority <= 100, 'INVALID_ARGUMENT', 'Responsive placement priority is invalid')
    assertDomain(Number.isSafeInteger(element.readingOrder) && element.readingOrder >= 0, 'INVALID_ARGUMENT', 'Responsive placement reading order is invalid')
    assertDomain([element.minWidth, element.maxWidth, element.minHeight, element.maxHeight].every(finiteUnit) && element.minWidth > 0 && element.minHeight > 0 && element.minWidth <= element.maxWidth && element.minHeight <= element.maxHeight, 'INVALID_ARGUMENT', 'Responsive placement min/max constraints are invalid')
  }
  assertDomain(new Set(input.elements.map((element) => element.readingOrder)).size === input.elements.length, 'INVALID_ARGUMENT', 'Responsive placement reading order must be unique')
  assertDomain(new Set((input.protectedRegions ?? []).map((region) => region.id)).size === (input.protectedRegions ?? []).length, 'INVALID_ARGUMENT', 'Protected placement region ids must be unique')
  for (const region of input.protectedRegions ?? []) {
    assertDomain(region.id.trim().length >= 1 && ['face', 'roi', 'reading-order'].includes(region.kind), 'INVALID_ARGUMENT', 'Protected placement region is invalid')
    assertDomain([region.x, region.y, region.width, region.height].every(finiteUnit) && region.width > 0 && region.height > 0 && region.x + region.width <= 1 && region.y + region.height <= 1, 'INVALID_ARGUMENT', 'Protected placement region bounds are invalid')
  }
}

/**
 * Re-derives the supplied region from this exact OutputSpec and preset. A region copied from
 * another format, another preset or another registry revision cannot survive this check, so the
 * solve can never place a subtitle against geometry that belongs to a different variant.
 */
function assertSubtitleRegion(spec: Readonly<OutputSpec>, region: Readonly<SubtitleRegionV1>): void {
  assertDomain(region.schemaVersion === 'subtitle-region/v1', 'INVALID_ARGUMENT', 'Subtitle region schema version is unsupported')
  assertDomain(region.registryHash === SUBTITLE_STYLE_REGISTRY.registryHash, 'INVALID_ARGUMENT', 'Subtitle region registry hash drifted from the subtitle style registry')
  const rederived = deriveSubtitleRegion({ spec, presetId: region.presetId, presetHash: region.presetHash, registryHash: region.registryHash })
  assertDomain(
    rederived.outputSpecId === region.outputSpecId && rederived.subtitleFormat === region.subtitleFormat &&
    (['x', 'y', 'width', 'height'] as const).every((key) => Math.abs(rederived.bounds[key] - region.bounds[key]) <= 1e-9),
    'INVALID_ARGUMENT', 'Subtitle region was not derived from this output spec and preset',
  )
}

export function solveResponsivePlacement(input: ResponsivePlacementInput): Readonly<ResponsivePlacementResult> {
  assertPlacementInput(input)
  const { spec } = input
  const subtitleRegion = input.subtitleRegion ?? null
  if (subtitleRegion) assertSubtitleRegion(spec, subtitleRegion)
  const safe = Object.freeze({ x: spec.safeArea.left, y: spec.safeArea.top, width: 1 - spec.safeArea.left - spec.safeArea.right, height: 1 - spec.safeArea.top - spec.safeArea.bottom })
  const placed: PlacedElement[] = []
  const issues: PlacementIssue[] = []
  const ordered = [...input.elements].toSorted((left, right) => right.priority - left.priority || left.readingOrder - right.readingOrder || left.id.localeCompare(right.id))
  for (const element of ordered) {
    const rule = FORMAT_RULES[spec.aspectRatio][element.kind]
    const reserved = element.kind === 'subtitle' ? subtitleRegion : null
    const width = Math.min(element.maxWidth, Math.max(element.minWidth, reserved?.bounds.width ?? rule.width))
    const height = Math.min(element.maxHeight, Math.max(element.minHeight, reserved?.bounds.height ?? rule.height))
    const anchors = element.anchor === 'auto'
      ? rule.anchors
      : Object.freeze([element.anchor, ...rule.anchors.filter((anchor) => anchor !== element.anchor)])
    // The registry-derived region is the first candidate for a subtitle; the format anchors stay
    // available (with the region's own dimensions) so a face or ROI collision still has an exit.
    const candidates: readonly Readonly<{ anchor: Exclude<PlacementAnchor, 'auto'>; box: NormalizedBox }>[] = Object.freeze([
      ...(reserved && width === reserved.bounds.width && height === reserved.bounds.height
        ? [Object.freeze({ anchor: 'bottom-center' as const, box: Object.freeze({ ...reserved.bounds }) })]
        : []),
      ...anchors.map((anchor) => Object.freeze({ anchor, box: boxForAnchor(anchor, width, height, safe) })),
    ])
    const attempted: string[] = []
    let selected: { anchor: Exclude<PlacementAnchor, 'auto'>; box: NormalizedBox } | undefined
    let selectedIndex = -1
    const avoided = new Set<ProtectedRegionKind>()
    for (const [index, candidate] of candidates.entries()) {
      if (!attempted.includes(candidate.anchor)) attempted.push(candidate.anchor)
      const { box } = candidate
      if (box.x < safe.x || box.y < safe.y || box.x + box.width > safe.x + safe.width || box.y + box.height > safe.y + safe.height) continue
      const collidingRegions = (input.protectedRegions ?? []).filter((region) => overlaps(box, region))
      collidingRegions.forEach((region) => avoided.add(region.kind))
      if (!collidingRegions.length && !placed.some((existing) => overlaps(box, existing))) {
        selected = { anchor: candidate.anchor, box }
        selectedIndex = index
        break
      }
    }
    if (!selected) {
      issues.push(Object.freeze({ elementId: element.id, code: 'IMPOSSIBLE_CONSTRAINTS' as const, severity: 'review' as const, reason: 'No format-specific candidate satisfies safe area, protected regions and collision constraints.', attemptedAnchors: Object.freeze(attempted) }))
      continue
    }
    if (selectedIndex !== 0) issues.push(Object.freeze({ elementId: element.id, code: 'ANCHOR_FALLBACK' as const, severity: 'warning' as const, reason: `Preferred anchor ${candidates[0]!.anchor} was blocked; ${selected.anchor} was selected.`, attemptedAnchors: Object.freeze(attempted) }))
    for (const kind of [...avoided].sort()) issues.push(Object.freeze({ elementId: element.id, code: kind === 'face' ? 'FACE_COLLISION_AVOIDED' as const : kind === 'roi' ? 'ROI_COLLISION_AVOIDED' as const : 'READING_ORDER_COLLISION_AVOIDED' as const, severity: 'warning' as const, reason: `A ${kind} protected region blocked an earlier candidate.`, attemptedAnchors: Object.freeze(attempted) }))
    placed.push(Object.freeze({ id: element.id, kind: element.kind, anchor: selected.anchor, readingOrder: element.readingOrder, ...selected.box }))
  }
  const visible = placed.toSorted((left, right) => left.readingOrder - right.readingOrder)
  const body = Object.freeze({ schemaVersion: 'responsive-placement/v2' as const, policyVersion: RESPONSIVE_PLACEMENT_POLICY_VERSION, registryHash: OUTPUT_FORMAT_REGISTRY.registryHash, format: spec.aspectRatio, canvas: Object.freeze({ width: spec.width, height: spec.height }), safeArea: Object.freeze({ ...spec.safeArea }), subtitleRegion, elements: Object.freeze(visible), issues: Object.freeze(issues), reviewRequired: issues.some((issue) => issue.severity === 'review') })
  return Object.freeze({ ...body, placementHash: calculateCanonicalHash(body) })
}

export function validateResponsivePlacement(result: Readonly<ResponsivePlacementResult>): void {
  assertDomain(result.schemaVersion === 'responsive-placement/v2' && result.policyVersion === RESPONSIVE_PLACEMENT_POLICY_VERSION && result.registryHash === OUTPUT_FORMAT_REGISTRY.registryHash, 'INVALID_ARGUMENT', 'Responsive placement identity is invalid')
  if (result.subtitleRegion) {
    assertDomain(result.subtitleRegion.registryHash === SUBTITLE_STYLE_REGISTRY.registryHash, 'INVALID_ARGUMENT', 'Responsive placement subtitle region is not bound to the published subtitle registry')
  }
  const { placementHash: _hash, ...body } = result
  assertDomain(result.placementHash === calculateCanonicalHash(body), 'INVALID_ARGUMENT', 'Responsive placement hash is invalid')
  assertDomain([result.safeArea.top, result.safeArea.right, result.safeArea.bottom, result.safeArea.left].every((value) => Number.isFinite(value) && value >= 0 && value < 0.5) && result.safeArea.top + result.safeArea.bottom < 1 && result.safeArea.left + result.safeArea.right < 1, 'INVALID_ARGUMENT', 'Responsive placement safe area is invalid')
  const safe = { x: result.safeArea.left, y: result.safeArea.top, width: 1 - result.safeArea.left - result.safeArea.right, height: 1 - result.safeArea.top - result.safeArea.bottom }
  for (const element of result.elements) {
    assertDomain(element.x >= safe.x && element.y >= safe.y && element.x + element.width <= safe.x + safe.width && element.y + element.height <= safe.y + safe.height, 'INVALID_ARGUMENT', 'Responsive placement escaped its safe area')
  }
  for (let index = 0; index < result.elements.length; index += 1) for (let other = index + 1; other < result.elements.length; other += 1) assertDomain(!overlaps(result.elements[index]!, result.elements[other]!), 'INVALID_ARGUMENT', 'Responsive placement elements overlap')
  assertDomain(result.elements.every((element, index) => index === 0 || result.elements[index - 1]!.readingOrder < element.readingOrder), 'INVALID_ARGUMENT', 'Responsive placement reading order is not monotonic')
  assertDomain(result.reviewRequired === result.issues.some((issue) => issue.severity === 'review'), 'INVALID_ARGUMENT', 'Responsive placement review state is inconsistent')
}
export interface RoiObservation { atMs: number; x: number; y: number; width: number; height: number; confidence: number; kind: 'face' | 'object' | 'screen' }
export function createReframePlan(input: { format: OutputAspectRatio; observations: readonly RoiObservation[]; maxVelocityPerSecond: number; margin: number; overrides?: readonly { atMs: number; x: number; y: number }[] }) { const overrides = new Map((input.overrides ?? []).map((value) => [value.atMs, value])); const issues: { atMs: number; code: string }[] = []; const keyframes = input.observations.map((observation, index) => { const override = overrides.get(observation.atMs); const target = override ?? { x: observation.x + observation.width / 2, y: observation.y + observation.height / 2 }; if (observation.confidence < .6) issues.push({ atMs: observation.atMs, code: 'REFRAME_UNCERTAIN' }); if (observation.width + input.margin * 2 > 1 || observation.height + input.margin * 2 > 1) issues.push({ atMs: observation.atMs, code: 'SUBJECT_DOES_NOT_FIT' }); const previous = index ? input.observations[index - 1] : undefined; if (!override && previous) { const elapsed = Math.max((observation.atMs - previous.atMs) / 1000, .001); const maxMove = input.maxVelocityPerSecond * elapsed; const previousCenter = { x: previous.x + previous.width / 2, y: previous.y + previous.height / 2 }; target.x = previousCenter.x + Math.max(-maxMove, Math.min(maxMove, target.x - previousCenter.x)); target.y = previousCenter.y + Math.max(-maxMove, Math.min(maxMove, target.y - previousCenter.y)) } return Object.freeze({ atMs: observation.atMs, centerX: target.x, centerY: target.y, source: override ? 'manual' as const : observation.kind }) }); return Object.freeze({ format: input.format, keyframes: Object.freeze(keyframes), issues: Object.freeze(issues) }) }
export const REFRAME_GOLDEN_FIXTURES = Object.freeze({ onePerson: [{ atMs: 0, x: .35, y: .2, width: .3, height: .5, confidence: .98, kind: 'face' as const }], twoPeople: [{ atMs: 0, x: .1, y: .2, width: .3, height: .5, confidence: .95, kind: 'face' as const }, { atMs: 0, x: .6, y: .2, width: .3, height: .5, confidence: .95, kind: 'face' as const }], screen: [{ atMs: 0, x: .05, y: .05, width: .9, height: .9, confidence: .99, kind: 'screen' as const }], movingObject: [{ atMs: 0, x: .1, y: .4, width: .2, height: .2, confidence: .9, kind: 'object' as const }, { atMs: 1000, x: .7, y: .4, width: .2, height: .2, confidence: .9, kind: 'object' as const }] })
export function critiqueOutputVariant(input: { spec: OutputSpec; proxyHash: string; elements: readonly { id: string; fromFrame: number; toFrame: number; x: number; y: number; width: number; height: number; kind: string }[]; subjectVisible: boolean; density: number }) { const issues: { code: string; format: OutputAspectRatio; frameRange: readonly [number, number]; elementIds: readonly string[] }[] = []; const { spec } = input; for (const element of input.elements) { const clipped = element.x < 0 || element.y < 0 || element.x + element.width > spec.width || element.y + element.height > spec.height; const safe = element.x < spec.width * spec.safeArea.left || element.y < spec.height * spec.safeArea.top || element.x + element.width > spec.width * (1 - spec.safeArea.right) || element.y + element.height > spec.height * (1 - spec.safeArea.bottom); if (clipped || safe) issues.push({ code: clipped ? 'CLIPPING' : 'SAFE_AREA', format: spec.aspectRatio, frameRange: Object.freeze([element.fromFrame, element.toFrame]), elementIds: Object.freeze([element.id]) }) } if (!input.subjectVisible) issues.push({ code: 'SUBJECT_HIDDEN', format: spec.aspectRatio, frameRange: Object.freeze([0, 0]), elementIds: Object.freeze([]) }); if (input.density > .85) issues.push({ code: 'DENSITY_EXCESS', format: spec.aspectRatio, frameRange: Object.freeze([0, input.elements.reduce((max, item) => Math.max(max, item.toFrame), 0)]), elementIds: Object.freeze(input.elements.map((item) => item.id)) }); return Object.freeze({ format: spec.aspectRatio, proxyHash: input.proxyHash, valid: issues.length === 0, issues: Object.freeze(issues) }) }
export const RESPONSIVE_VISUAL_GOLDENS = Object.freeze(OUTPUT_ASPECT_RATIOS.flatMap((ratio) =>
  (['subtitle', 'logo', 'cta', 'insert'] as const).map((kind, readingOrder) => Object.freeze({
    id: `${ratio}-${kind}`,
    ratio,
    kind,
    placement: solveResponsivePlacement({
      spec: VERSIONED_OUTPUT_PRESETS[ratio].spec,
      elements: [{
        id: `${ratio}-${kind}`,
        kind,
        anchor: 'auto',
        priority: 10,
        readingOrder,
        minWidth: 0.08,
        maxWidth: 0.9,
        minHeight: 0.06,
        maxHeight: 0.8,
      }],
      protectedRegions: [],
    }),
  })),
))
