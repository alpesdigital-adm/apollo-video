import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import { readOutputFormatPreset } from './output-format-registry.ts'
import { OUTPUT_ASPECT_RATIOS, type NormalizedBounds, type OutputAspectRatio } from './output-spec.ts'
import {
  solveResponsivePlacement,
  type PlacementAnchor,
  type PlacementIssue,
  type ProtectedPlacementRegion,
} from './responsive-output.ts'
import type { PerceptionTimeline } from './perception-timeline.ts'
import {
  createSubtitleAnchorPlan,
  validateSubtitleAnchorPlan,
  type SubtitleAnchorCueV1,
  type SubtitleAnchorPlanV1,
  type SubtitleAnchorPolicyV1,
} from './subtitle-anchor-plan.ts'
import { deriveSubtitleRegion, type SubtitleRegionV1 } from './subtitle-region.ts'
import { SUBTITLE_STYLE_REGISTRY, type SubtitlePresetId } from './subtitle-system.ts'

/**
 * Content-addressed geometry the renderer receives inside a materialized `RenderInput`.
 *
 * The renderer never solves anything: it draws what the plan already decided. Every placement
 * carries normalized bounds inside the canvas, a **half-open** `[startFrame, endFrame)` interval
 * and — when it draws an image — the exact `sha256` of the asset it is allowed to read. The worker
 * recomputes `placementPlanHash` and the asset digests before the first frame; a drifted byte,
 * a rewritten bound or a swapped asset fails closed with `INVALID_RENDER_INPUT`.
 */
export const RENDER_PLACEMENT_KINDS = ['logo', 'cta', 'insert', 'subtitle-region'] as const
export type RenderPlacementKind = (typeof RENDER_PLACEMENT_KINDS)[number]

export interface RenderPlacementV1 {
  elementId: string
  kind: RenderPlacementKind
  bounds: Readonly<NormalizedBounds>
  /** Present only for drawable image placements; `null` marks a reserved (non-drawn) region. */
  assetArtifactId: string | null
  assetSha256: string | null
  zIndex: number
  timeRange: Readonly<{ startFrame: number; endFrame: number }>
}

export interface RenderPlacementPlanV1 {
  schemaVersion: 'render-placement-plan/v1'
  outputSpecId: string
  outputPresetHash: string
  format: OutputAspectRatio
  canvas: Readonly<{ width: number; height: number }>
  durationFrames: number
  subtitleRegion: Readonly<SubtitleRegionV1> | null
  /**
   * F1.036 / FR-173. Per-cue anchor decided from the perception timeline and from the cta/logo
   * placements below — the only two trustworthy descriptions of what is on screen. `null` when the
   * render carries no cues (or no subtitles at all), which is itself evidence.
   */
  subtitleAnchorPlan: Readonly<SubtitleAnchorPlanV1> | null
  placements: readonly Readonly<RenderPlacementV1>[]
  issues: readonly Readonly<PlacementIssue>[]
  placementPlanHash: string
}

const SHA256 = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const EPSILON = 1e-7
const MAX_PLACEMENTS = 64

export interface RenderPlacementRequestV1 {
  id: string
  kind: Exclude<RenderPlacementKind, 'subtitle-region'>
  anchor: PlacementAnchor
  priority: number
  readingOrder: number
  minWidth: number
  maxWidth: number
  minHeight: number
  maxHeight: number
  timeRange: Readonly<{ startFrame: number; endFrame: number }>
  assetArtifactId?: string
  assetSha256?: string
}

function assertBounds(bounds: Readonly<NormalizedBounds>, field: string): Readonly<NormalizedBounds> {
  assertDomain(
    [bounds.x, bounds.y, bounds.width, bounds.height].every((value) => typeof value === 'number' && Number.isFinite(value)) &&
    bounds.x >= -EPSILON && bounds.y >= -EPSILON && bounds.width > 0 && bounds.height > 0 &&
    bounds.x + bounds.width <= 1 + EPSILON && bounds.y + bounds.height <= 1 + EPSILON,
    'INVALID_RENDER_INPUT', `${field} is not inside the render canvas`, { bounds },
  )
  return Object.freeze({ ...bounds })
}

function assertTimeRange(range: Readonly<{ startFrame: number; endFrame: number }>, durationFrames: number, field: string): Readonly<{ startFrame: number; endFrame: number }> {
  assertDomain(
    Number.isSafeInteger(range.startFrame) && Number.isSafeInteger(range.endFrame) &&
    range.startFrame >= 0 && range.endFrame > range.startFrame && range.endFrame <= durationFrames,
    'INVALID_RENDER_INPUT', `${field} is not a non-empty half-open frame interval inside the timeline`, { range, durationFrames },
  )
  return Object.freeze({ startFrame: range.startFrame, endFrame: range.endFrame })
}

/**
 * Builds the plan from the same solver the public preflight uses, so what the renderer draws and
 * what an operator previewed cannot diverge. The subtitle region always comes from the resolved
 * preset (`deriveSubtitleRegion`), never from a rectangle authored at the call site.
 */
export function createRenderPlacementPlan(input: Readonly<{
  format: OutputAspectRatio
  canvas: Readonly<{ width: number; height: number }>
  durationFrames: number
  subtitlePresetId?: SubtitlePresetId | null
  elements: readonly Readonly<RenderPlacementRequestV1>[]
  protectedRegions?: readonly Readonly<ProtectedPlacementRegion>[]
  /**
   * Cues to anchor by perception. The evidence is read here, inside the plan, from the
   * content-addressed timeline and from the placements this same call solved — a caller cannot
   * hand in a rectangle and move a subtitle onto a face by omitting the face.
   */
  subtitleAnchor?: Readonly<{
    fps: number
    cues: readonly Readonly<SubtitleAnchorCueV1>[]
    perceptionTimeline?: Readonly<PerceptionTimeline>
    policy?: Partial<SubtitleAnchorPolicyV1>
  }>
}>): Readonly<RenderPlacementPlanV1> {
  assertDomain(OUTPUT_ASPECT_RATIOS.includes(input.format), 'INVALID_RENDER_INPUT', 'Placement plan format is not registered')
  const preset = readOutputFormatPreset(input.format)
  assertDomain(
    Number.isSafeInteger(input.canvas.width) && Number.isSafeInteger(input.canvas.height) &&
    input.canvas.width >= 2 && input.canvas.height >= 2 &&
    input.canvas.width % 2 === 0 && input.canvas.height % 2 === 0,
    'INVALID_RENDER_INPUT', 'Placement plan canvas is invalid',
  )
  assertDomain(Number.isSafeInteger(input.durationFrames) && input.durationFrames >= 1, 'INVALID_RENDER_INPUT', 'Placement plan duration is invalid')
  assertDomain(input.elements.length <= MAX_PLACEMENTS, 'INVALID_RENDER_INPUT', 'Placement plan accepts at most 64 elements')
  const subtitleRegion = input.subtitlePresetId
    ? deriveSubtitleRegion({ spec: preset.spec, presetId: input.subtitlePresetId })
    : null
  const timeRangeById = new Map(input.elements.map((element) =>
    [element.id, assertTimeRange(element.timeRange, input.durationFrames, `placement ${element.id} timeRange`)]))
  const assetById = new Map(input.elements.map((element) => [element.id, element]))
  const solverElements = input.elements.map((element) => Object.freeze({
    id: element.id, kind: element.kind, anchor: element.anchor, priority: element.priority,
    readingOrder: element.readingOrder, minWidth: element.minWidth, maxWidth: element.maxWidth,
    minHeight: element.minHeight, maxHeight: element.maxHeight,
  }))
  // A subtitle region is reserved even when no element competes for it, so a later CTA or logo can
  // never be solved into the band the subtitles already own.
  const solved = solverElements.length
    ? solveResponsivePlacement({
        spec: preset.spec,
        elements: solverElements,
        protectedRegions: input.protectedRegions ?? [],
        ...(subtitleRegion ? { subtitleRegion } : {}),
      })
    : null
  const placements: RenderPlacementV1[] = (solved?.elements ?? []).map((element, index) => {
    const request = assetById.get(element.id)!
    const drawable = request.assetArtifactId !== undefined
    if (drawable) {
      assertDomain(typeof request.assetArtifactId === 'string' && ID.test(request.assetArtifactId), 'INVALID_RENDER_INPUT', 'Placement asset artifact id is invalid', { elementId: element.id })
      assertDomain(typeof request.assetSha256 === 'string' && SHA256.test(request.assetSha256), 'INVALID_RENDER_INPUT', 'Placement asset sha256 is invalid', { elementId: element.id })
    }
    return Object.freeze({
      elementId: element.id,
      kind: element.kind === 'subtitle' ? 'subtitle-region' as const : element.kind,
      bounds: assertBounds(Object.freeze({ x: element.x, y: element.y, width: element.width, height: element.height }), `placement ${element.id} bounds`),
      assetArtifactId: drawable ? request.assetArtifactId! : null,
      assetSha256: drawable ? request.assetSha256! : null,
      zIndex: index + 1,
      timeRange: timeRangeById.get(element.id)!,
    })
  })
  if (subtitleRegion && !placements.some((placement) => placement.kind === 'subtitle-region')) {
    placements.push(Object.freeze({
      elementId: `subtitle-region-${subtitleRegion.presetId}`,
      kind: 'subtitle-region' as const,
      bounds: assertBounds(subtitleRegion.bounds, 'subtitle region bounds'),
      assetArtifactId: null, assetSha256: null,
      zIndex: placements.length + 1,
      timeRange: Object.freeze({ startFrame: 0, endFrame: input.durationFrames }),
    }))
  }
  const orderedPlacements = Object.freeze(placements.toSorted((left, right) => left.zIndex - right.zIndex))
  // Decided *after* the solver, so the evidence is the geometry this plan actually reserved for the
  // CTA and the logo, not the geometry someone hoped for.
  const subtitleAnchorPlan = subtitleRegion && input.subtitleAnchor && input.subtitleAnchor.cues.length
    ? createSubtitleAnchorPlan({
        spec: preset.spec,
        format: input.format,
        canvas: input.canvas,
        fps: input.subtitleAnchor.fps,
        durationFrames: input.durationFrames,
        region: subtitleRegion,
        cues: input.subtitleAnchor.cues,
        ...(input.subtitleAnchor.perceptionTimeline ? { perceptionTimeline: input.subtitleAnchor.perceptionTimeline } : {}),
        placements: orderedPlacements,
        ...(input.subtitleAnchor.policy ? { policy: input.subtitleAnchor.policy } : {}),
      })
    : null
  const body = Object.freeze({
    schemaVersion: 'render-placement-plan/v1' as const,
    outputSpecId: preset.spec.id,
    outputPresetHash: preset.presetHash,
    format: input.format,
    canvas: Object.freeze({ ...input.canvas }),
    durationFrames: input.durationFrames,
    subtitleRegion,
    subtitleAnchorPlan,
    placements: orderedPlacements,
    issues: Object.freeze([...(solved?.issues ?? [])]),
  })
  const plan = Object.freeze({ ...body, placementPlanHash: calculateCanonicalHash(body) })
  validateRenderPlacementPlan(plan)
  return plan
}

/**
 * Fail-closed gate the worker runs **before** the renderer starts. Everything is re-derived:
 * the preset identity from the registry, the subtitle region from the resolved preset, and the
 * plan hash from the plan body itself.
 */
export function validateRenderPlacementPlan(plan: Readonly<RenderPlacementPlanV1>): void {
  assertDomain(plan.schemaVersion === 'render-placement-plan/v1', 'INVALID_RENDER_INPUT', 'Placement plan schema version is unsupported')
  assertDomain(OUTPUT_ASPECT_RATIOS.includes(plan.format), 'INVALID_RENDER_INPUT', 'Placement plan format is not registered')
  const preset = readOutputFormatPreset(plan.format)
  assertDomain(plan.outputSpecId === preset.spec.id && plan.outputPresetHash === preset.presetHash, 'INVALID_RENDER_INPUT', 'Placement plan output identity drifted from the registry')
  assertDomain(
    Number.isSafeInteger(plan.canvas.width) && Number.isSafeInteger(plan.canvas.height) &&
    plan.canvas.width >= 2 && plan.canvas.height >= 2,
    'INVALID_RENDER_INPUT', 'Placement plan canvas is invalid',
  )
  assertDomain(Number.isSafeInteger(plan.durationFrames) && plan.durationFrames >= 1, 'INVALID_RENDER_INPUT', 'Placement plan duration is invalid')
  assertDomain(plan.placements.length <= MAX_PLACEMENTS, 'INVALID_RENDER_INPUT', 'Placement plan carries too many placements')
  if (plan.subtitleRegion) {
    assertDomain(plan.subtitleRegion.registryHash === SUBTITLE_STYLE_REGISTRY.registryHash, 'INVALID_RENDER_INPUT', 'Placement plan subtitle region is not bound to the published subtitle registry')
    const rederived = deriveSubtitleRegion({ spec: preset.spec, presetId: plan.subtitleRegion.presetId, presetHash: plan.subtitleRegion.presetHash, registryHash: plan.subtitleRegion.registryHash })
    assertDomain(
      calculateCanonicalHash(rederived) === calculateCanonicalHash(plan.subtitleRegion),
      'INVALID_RENDER_INPUT', 'Placement plan subtitle region was not derived from this output preset',
    )
  }
  if (plan.subtitleAnchorPlan) {
    assertDomain(plan.subtitleRegion !== null, 'INVALID_RENDER_INPUT', 'A subtitle anchor plan requires the subtitle region it was decided against')
    validateSubtitleAnchorPlan(plan.subtitleAnchorPlan, {
      region: plan.subtitleRegion!, safeArea: preset.spec.safeArea, outputSpecId: plan.outputSpecId,
      format: plan.format, canvas: plan.canvas, durationFrames: plan.durationFrames,
    })
  }
  const seenIds = new Set<string>()
  const seenZ = new Set<number>()
  let previousZ = 0
  for (const placement of plan.placements) {
    assertDomain(ID.test(placement.elementId), 'INVALID_RENDER_INPUT', 'Placement element id is invalid')
    assertDomain(!seenIds.has(placement.elementId), 'INVALID_RENDER_INPUT', 'Placement element ids must be unique', { elementId: placement.elementId })
    seenIds.add(placement.elementId)
    assertDomain(RENDER_PLACEMENT_KINDS.includes(placement.kind), 'INVALID_RENDER_INPUT', 'Placement kind is not registered')
    assertBounds(placement.bounds, `placement ${placement.elementId} bounds`)
    assertTimeRange(placement.timeRange, plan.durationFrames, `placement ${placement.elementId} timeRange`)
    assertDomain(Number.isSafeInteger(placement.zIndex) && placement.zIndex > previousZ && !seenZ.has(placement.zIndex), 'INVALID_RENDER_INPUT', 'Placement zIndex must be unique and ascending', { elementId: placement.elementId })
    seenZ.add(placement.zIndex)
    previousZ = placement.zIndex
    if (placement.assetArtifactId === null) {
      assertDomain(placement.assetSha256 === null, 'INVALID_RENDER_INPUT', 'Reserved placement cannot carry an asset digest', { elementId: placement.elementId })
    } else {
      assertDomain(ID.test(placement.assetArtifactId) && typeof placement.assetSha256 === 'string' && SHA256.test(placement.assetSha256), 'INVALID_RENDER_INPUT', 'Drawable placement asset identity is invalid', { elementId: placement.elementId })
      assertDomain(placement.kind !== 'subtitle-region', 'INVALID_RENDER_INPUT', 'A subtitle region is reserved, never drawn from an asset')
    }
  }
  const { placementPlanHash, ...body } = plan
  assertDomain(SHA256.test(placementPlanHash) && placementPlanHash === calculateCanonicalHash(body), 'INVALID_RENDER_INPUT', 'Placement plan hash is inconsistent')
}

/** Placements a renderer must actually draw at `frame` (half-open interval, painter order). */
export function drawablePlacementsAtFrame(plan: Readonly<RenderPlacementPlanV1>, frame: number): readonly Readonly<RenderPlacementV1>[] {
  return Object.freeze(plan.placements.filter((placement) =>
    placement.assetArtifactId !== null &&
    placement.timeRange.startFrame <= frame && placement.timeRange.endFrame > frame))
}
