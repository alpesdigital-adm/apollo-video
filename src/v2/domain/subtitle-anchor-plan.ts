import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import type { NormalizedBounds, OutputAspectRatio, OutputSpec } from './output-spec.ts'
import {
  createPerceptionTimeline,
  PERCEPTION_KINDS,
  queryPerceptionRange,
  type PerceptionKind,
  type PerceptionObservation,
  type PerceptionRange,
  type PerceptionTimeline,
} from './perception-timeline.ts'
import type { SubtitleRegionV1 } from './subtitle-region.ts'
import type { SubtitleAnchor } from './subtitle-system.ts'

/**
 * F1.036 / FR-173 — the subtitle anchor is **decided**, never authored.
 *
 * For every cue the decision consults two independent sources of evidence and nothing else:
 *
 * 1. the content-addressed `PerceptionTimeline` (`face`, `ocr`, `image-insert` observations that
 *    carry normalized geometry), identified by `perceptionTimelineHash`; and
 * 2. the `cta` / `logo` placements the placement plan itself solved — the only trustworthy
 *    description of what this render actually draws.
 *
 * A caller-supplied list of "occupied regions" is deliberately **not** accepted: an arbitrary
 * rectangle handed in by a client is not evidence, and accepting one would let a caller move a
 * subtitle onto a face by omitting the face.
 *
 * The five eligible bands are derived from the resolved subtitle region (`SubtitleRegionV1`, which
 * is itself derived from the F1.033 preset) projected on the variant's safe area. Nothing here is
 * a hardcoded rectangle: change the preset or the output preset and every band moves, through
 * `presetHash` / `outputSpecId`.
 */
export const SUBTITLE_ANCHOR_PREFERENCE = Object.freeze([
  'bottom', 'lower-third', 'upper-third', 'top', 'center',
] as const satisfies readonly SubtitleAnchor[])

/** The five blockers a subtitle must never be placed on top of. */
export const SUBTITLE_ANCHOR_BLOCKER_KINDS = Object.freeze([
  'face', 'ocr', 'insert', 'cta', 'logo',
] as const)
export type SubtitleAnchorBlockerKind = (typeof SUBTITLE_ANCHOR_BLOCKER_KINDS)[number]

/** Perception kinds that can block a band, mapped onto the blocker vocabulary above. */
const PERCEPTION_BLOCKER_KIND = Object.freeze({
  face: 'face', ocr: 'ocr', 'image-insert': 'insert',
} as const satisfies Partial<Record<PerceptionKind, SubtitleAnchorBlockerKind>>)
const PERCEPTION_BLOCKER_KINDS = Object.freeze(
  Object.keys(PERCEPTION_BLOCKER_KIND) as readonly PerceptionKind[],
)

/**
 * A face is *critical*: covering it is the exact failure the recovery E2E forbids, so no fallback
 * may ever land on one. The other blockers are avoided, and only relaxed with a recorded warning.
 */
const CRITICAL_BLOCKER_KINDS = Object.freeze(['face'] as const)

export const SUBTITLE_ANCHOR_REASON_CODES = Object.freeze([
  'NO_SAFE_SUBTITLE_REGION', 'SUBTITLE_ANCHOR_FALLBACK', 'SUBTITLE_ANCHOR_UNSTABLE',
] as const)
export type SubtitleAnchorReasonCode = (typeof SUBTITLE_ANCHOR_REASON_CODES)[number]

export interface SubtitleAnchorBlockerV1 {
  id: string
  kind: SubtitleAnchorBlockerKind
  source: 'perception' | 'placement-plan'
  critical: boolean
  bounds: Readonly<NormalizedBounds>
  startFrame: number
  endFrame: number
}

export interface SubtitleAnchorIssueV1 {
  code: SubtitleAnchorReasonCode
  severity: 'hard' | 'warning'
  cueId: string
  /** Half-open `[startFrame, endFrame)`, like every other frame interval in the product. */
  evidenceRange: Readonly<{ startFrame: number; endFrame: number }>
  rangeMs: readonly [number, number]
  elementIds: readonly string[]
  evidenceIds: readonly string[]
  message: string
}

export interface SubtitleAnchorDecisionV1 {
  cueId: string
  startFrame: number
  endFrame: number
  /** `null` only when no band survived and the policy chose to suppress instead of drawing. */
  anchor: SubtitleAnchor | null
  bounds: Readonly<NormalizedBounds> | null
  /** The previous anchor was still safe and was preserved — hysteresis, not a re-solve. */
  stable: boolean
  changedFromPrevious: boolean
  /** The cue is not drawn: no band was safe and the policy suppresses instead of covering a face. */
  suppressed: boolean
  /** Bands that were safe over the stability window, in preference order. */
  eligibleAnchors: readonly SubtitleAnchor[]
  /** Evidence identities that removed a band from `eligibleAnchors`. */
  blockerIds: readonly string[]
  /** Every evidence identity consulted for this cue, blocking or not. */
  evidenceIds: readonly string[]
  issues: readonly Readonly<SubtitleAnchorIssueV1>[]
}

export interface SubtitleAnchorPolicyV1 {
  /** Minimum frames a decision must hold before another change is considered stable. */
  minFramesBetweenChanges: number
  /** What to do when every band is blocked. Never "draw it anyway". */
  onNoSafeRegion: 'suppress-cue' | 'fail-closed'
}

export interface SubtitleAnchorPlanV1 {
  schemaVersion: 'subtitle-anchor-plan/v1'
  outputSpecId: string
  format: OutputAspectRatio
  canvas: Readonly<{ width: number; height: number }>
  fps: number
  durationFrames: number
  subtitleRegionHash: string
  presetId: SubtitleRegionV1['presetId']
  presetHash: string
  registryHash: string
  /** Content address of the perception evidence consulted; `null` means no timeline was available. */
  perceptionTimelineHash: string | null
  /** Content address of the cta/logo placements consulted, so the evidence set is reproducible. */
  placementEvidenceHash: string
  policy: Readonly<SubtitleAnchorPolicyV1>
  bands: Readonly<Record<SubtitleAnchor, Readonly<NormalizedBounds>>>
  decisions: readonly Readonly<SubtitleAnchorDecisionV1>[]
  issues: readonly Readonly<SubtitleAnchorIssueV1>[]
  /**
   * Observations whose value carried no normalized geometry. They cannot prove a band is free, so
   * a `face` among them makes the whole canvas blocked (see `readObservationBounds`).
   */
  evidenceWithoutGeometry: readonly string[]
  anchorPlanHash: string
}

export interface SubtitleAnchorCueV1 {
  id: string
  startFrame: number
  endFrame: number
}

const EPSILON = 1e-7
const SHA256 = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export const DEFAULT_SUBTITLE_ANCHOR_POLICY: Readonly<SubtitleAnchorPolicyV1> = Object.freeze({
  minFramesBetweenChanges: 30,
  onNoSafeRegion: 'suppress-cue' as const,
})

function overlaps(left: Readonly<NormalizedBounds>, right: Readonly<NormalizedBounds>): boolean {
  return left.x < right.x + right.width - EPSILON && left.x + left.width > right.x + EPSILON &&
    left.y < right.y + right.height - EPSILON && left.y + left.height > right.y + EPSILON
}

function validBounds(value: unknown): value is NormalizedBounds {
  if (typeof value !== 'object' || value === null) return false
  const bounds = value as Record<string, unknown>
  const numbers = [bounds.x, bounds.y, bounds.width, bounds.height]
  return numbers.every((entry) => typeof entry === 'number' && Number.isFinite(entry)) &&
    (bounds.x as number) >= -EPSILON && (bounds.y as number) >= -EPSILON &&
    (bounds.width as number) > 0 && (bounds.height as number) > 0 &&
    (bounds.x as number) + (bounds.width as number) <= 1 + EPSILON &&
    (bounds.y as number) + (bounds.height as number) <= 1 + EPSILON
}

/**
 * Perception values are untrusted data, never instructions. Only the two shapes the rest of the
 * product already uses are read: `{ bounds: {x,y,width,height} }` (the reframe ROI shape) and
 * `{ box: [x,y,width,height] }`. Anything else yields `null` and is recorded, not guessed.
 */
function readObservationBounds(value: unknown): Readonly<NormalizedBounds> | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (validBounds(record.bounds)) {
    const bounds = record.bounds as NormalizedBounds
    return Object.freeze({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height })
  }
  if (Array.isArray(record.box) && record.box.length === 4) {
    const [x, y, width, height] = record.box as unknown[]
    const candidate = { x, y, width, height }
    if (validBounds(candidate)) return Object.freeze(candidate as NormalizedBounds)
  }
  return null
}

const FULL_CANVAS: Readonly<NormalizedBounds> = Object.freeze({ x: 0, y: 0, width: 1, height: 1 })

function msToFrame(ms: number, fps: number): number {
  return Math.round(ms / 1_000 * fps)
}

function frameToMs(frame: number, fps: number): number {
  return Math.round(frame / fps * 1_000)
}

/**
 * The five bands, derived from the resolved subtitle region and the variant safe area.
 *
 * `bottom` is the region exactly as the preset placed it. The other four keep the same box and
 * travel inside the safe area: `top` at the safe ceiling, `center` at the middle of the travel,
 * and the two thirds at 1/3 and 2/3 of it. So a preset that grows its font moves every band, and a
 * format with a taller safe area spreads them further apart — nothing is authored here.
 */
export function deriveSubtitleAnchorBands(input: Readonly<{
  region: Readonly<SubtitleRegionV1>
  safeArea: Readonly<OutputSpec['safeArea']>
}>): Readonly<Record<SubtitleAnchor, Readonly<NormalizedBounds>>> {
  const { x, width, height } = input.region.bounds
  const top = input.safeArea.top
  const travel = 1 - input.safeArea.bottom - top - height
  assertDomain(
    travel >= -EPSILON,
    'INVALID_RENDER_INPUT', 'Subtitle anchor bands do not fit the output safe area',
    { height, safeArea: input.safeArea },
  )
  const at = (fraction: number) => Object.freeze({
    x, width, height,
    y: Number((top + Math.max(0, travel) * fraction).toFixed(9)),
  })
  return Object.freeze({
    top: at(0),
    'upper-third': at(1 / 3),
    center: at(1 / 2),
    'lower-third': at(2 / 3),
    // The bottom band is the region itself: it is what a render with no perception already draws.
    bottom: Object.freeze({ x, width, height, y: input.region.bounds.y }),
  })
}

function collectBlockers(input: Readonly<{
  timeline?: Readonly<PerceptionTimeline>
  placements: readonly Readonly<{ elementId: string; kind: string; bounds: Readonly<NormalizedBounds>; timeRange: Readonly<{ startFrame: number; endFrame: number }> }>[]
  fps: number
  durationFrames: number
}>): Readonly<{ blockers: readonly Readonly<SubtitleAnchorBlockerV1>[]; withoutGeometry: readonly string[] }> {
  const blockers: SubtitleAnchorBlockerV1[] = []
  const withoutGeometry: string[] = []
  if (input.timeline) {
    const endMs = Math.min(input.timeline.durationMs, Math.max(1, frameToMs(input.durationFrames, input.fps)))
    const queried = queryPerceptionRange(input.timeline, {
      startMs: 0, endMs, kinds: PERCEPTION_BLOCKER_KINDS,
    })
    for (const observation of queried.observations) {
      const kind = PERCEPTION_BLOCKER_KIND[observation.kind as keyof typeof PERCEPTION_BLOCKER_KIND]
      if (!kind) continue
      const bounds = readObservationBounds(observation.value)
      const critical = CRITICAL_BLOCKER_KINDS.includes(kind as (typeof CRITICAL_BLOCKER_KINDS)[number])
      if (!bounds) {
        withoutGeometry.push(observation.id)
        // A face we cannot localize cannot be avoided. Blocking the whole canvas makes the render
        // fall into the documented "no safe region" path instead of silently guessing a band.
        if (!critical) continue
        blockers.push(Object.freeze({
          id: observation.id, kind, source: 'perception' as const, critical: true,
          bounds: FULL_CANVAS,
          startFrame: Math.max(0, Math.min(input.durationFrames - 1, msToFrame(observation.startMs, input.fps))),
          endFrame: Math.max(1, Math.min(input.durationFrames, msToFrame(observation.endMs, input.fps))),
        }))
        continue
      }
      blockers.push(Object.freeze({
        id: observation.id, kind, source: 'perception' as const, critical,
        bounds,
        startFrame: Math.max(0, Math.min(input.durationFrames - 1, msToFrame(observation.startMs, input.fps))),
        endFrame: Math.max(1, Math.min(input.durationFrames, msToFrame(observation.endMs, input.fps))),
      }))
    }
  }
  for (const placement of input.placements) {
    if (placement.kind !== 'cta' && placement.kind !== 'logo') continue
    blockers.push(Object.freeze({
      id: placement.elementId, kind: placement.kind, source: 'placement-plan' as const,
      critical: false, bounds: Object.freeze({ ...placement.bounds }),
      startFrame: placement.timeRange.startFrame, endFrame: placement.timeRange.endFrame,
    }))
  }
  return Object.freeze({
    blockers: Object.freeze(blockers.filter((blocker) => blocker.endFrame > blocker.startFrame)
      .toSorted((left, right) => left.startFrame - right.startFrame || left.id.localeCompare(right.id))),
    withoutGeometry: Object.freeze([...new Set(withoutGeometry)].toSorted()),
  })
}

/**
 * Decides one anchor per cue.
 *
 * Stability is not a preference, it is the algorithm: a band is only eligible when it stays free
 * over a **stability window** that reaches at least `minFramesBetweenChanges` past the cue start,
 * so two adjacent cues that see the same evidence necessarily reach the same answer. On top of
 * that, hysteresis preserves the previous anchor whenever it is still eligible, even if a
 * higher-preference band became free — the subtitle does not chase the layout around.
 */
export function createSubtitleAnchorPlan(input: Readonly<{
  spec: Readonly<OutputSpec>
  format: OutputAspectRatio
  canvas: Readonly<{ width: number; height: number }>
  fps: number
  durationFrames: number
  region: Readonly<SubtitleRegionV1>
  cues: readonly Readonly<SubtitleAnchorCueV1>[]
  perceptionTimeline?: Readonly<PerceptionTimeline>
  placements?: readonly Readonly<{ elementId: string; kind: string; bounds: Readonly<NormalizedBounds>; timeRange: Readonly<{ startFrame: number; endFrame: number }> }>[]
  policy?: Partial<SubtitleAnchorPolicyV1>
}>): Readonly<SubtitleAnchorPlanV1> {
  assertDomain(
    Number.isFinite(input.fps) && input.fps > 0 &&
    Number.isSafeInteger(input.durationFrames) && input.durationFrames >= 1,
    'INVALID_RENDER_INPUT', 'Subtitle anchor plan timeline is invalid',
  )
  const policy = Object.freeze({ ...DEFAULT_SUBTITLE_ANCHOR_POLICY, ...input.policy })
  assertDomain(
    Number.isSafeInteger(policy.minFramesBetweenChanges) && policy.minFramesBetweenChanges >= 0 &&
    (policy.onNoSafeRegion === 'suppress-cue' || policy.onNoSafeRegion === 'fail-closed'),
    'INVALID_RENDER_INPUT', 'Subtitle anchor policy is invalid',
  )
  const bands = deriveSubtitleAnchorBands({ region: input.region, safeArea: input.spec.safeArea })
  const placements = input.placements ?? []
  const { blockers, withoutGeometry } = collectBlockers({
    ...(input.perceptionTimeline ? { timeline: input.perceptionTimeline } : {}),
    placements, fps: input.fps, durationFrames: input.durationFrames,
  })
  const cues = [...input.cues].toSorted((left, right) => left.startFrame - right.startFrame || left.id.localeCompare(right.id))
  const decisions: SubtitleAnchorDecisionV1[] = []
  const issues: SubtitleAnchorIssueV1[] = []
  let previous: SubtitleAnchor | null = null
  let lastChangeFrame: number | null = null
  for (const cue of cues) {
    assertDomain(
      ID.test(cue.id) && Number.isSafeInteger(cue.startFrame) && Number.isSafeInteger(cue.endFrame) &&
      cue.startFrame >= 0 && cue.endFrame > cue.startFrame && cue.endFrame <= input.durationFrames,
      'INVALID_RENDER_INPUT', `Subtitle anchor cue ${cue.id} is not inside the timeline`,
    )
    // Half-open window: the cue itself, extended so a decision cannot be undone one cue later.
    const windowEnd = Math.min(input.durationFrames, Math.max(cue.endFrame, cue.startFrame + policy.minFramesBetweenChanges))
    const active = blockers.filter((blocker) => blocker.startFrame < windowEnd && blocker.endFrame > cue.startFrame)
    const evidenceIds = Object.freeze([...new Set(active.map((blocker) => blocker.id))].toSorted())
    const blocking = new Map<SubtitleAnchor, Readonly<SubtitleAnchorBlockerV1>[]>()
    const eligible: SubtitleAnchor[] = []
    const nonCritical: SubtitleAnchor[] = []
    for (const anchor of SUBTITLE_ANCHOR_PREFERENCE) {
      const band = bands[anchor]
      const hits = active.filter((blocker) => overlaps(band, blocker.bounds))
      blocking.set(anchor, hits)
      if (hits.length === 0) eligible.push(anchor)
      else if (!hits.some((blocker) => blocker.critical)) nonCritical.push(anchor)
    }
    const cueIssues: SubtitleAnchorIssueV1[] = []
    const range = Object.freeze({ startFrame: cue.startFrame, endFrame: cue.endFrame })
    const rangeMs = Object.freeze([frameToMs(cue.startFrame, input.fps), frameToMs(cue.endFrame, input.fps)] as const)
    const addIssue = (code: SubtitleAnchorReasonCode, severity: 'hard' | 'warning', message: string, evidence: readonly string[]) => {
      cueIssues.push(Object.freeze({
        code, severity, cueId: cue.id, evidenceRange: range, rangeMs,
        elementIds: Object.freeze([`subtitle:${cue.id}`]),
        evidenceIds: Object.freeze([...new Set(evidence)].toSorted()),
        message,
      }))
    }
    let anchor: SubtitleAnchor | null = null
    let suppressed = false
    if (previous !== null && eligible.includes(previous)) {
      anchor = previous
    } else if (eligible.length > 0) {
      anchor = eligible[0]!
    } else if (nonCritical.length > 0) {
      // Never a face. A non-critical overlap is allowed only with the warning that records it.
      anchor = (previous !== null && nonCritical.includes(previous)) ? previous : nonCritical[0]!
      addIssue('SUBTITLE_ANCHOR_FALLBACK', 'warning',
        `No subtitle band is free for cue ${cue.id}; the ${anchor} band was used and overlaps non-critical evidence.`,
        blocking.get(anchor)!.map((blocker) => blocker.id))
    } else {
      assertDomain(
        policy.onNoSafeRegion === 'suppress-cue',
        'INVALID_RENDER_INPUT', `No safe subtitle region for cue ${cue.id}`, { cueId: cue.id, evidenceIds },
      )
      suppressed = true
      addIssue('NO_SAFE_SUBTITLE_REGION', 'hard',
        `Every subtitle band collides with protected evidence during cue ${cue.id}; the cue was suppressed instead of covering it.`,
        evidenceIds)
    }
    const stable = anchor !== null && previous !== null && anchor === previous
    const changedFromPrevious = anchor !== null && previous !== null && anchor !== previous
    if (changedFromPrevious && lastChangeFrame !== null && cue.startFrame - lastChangeFrame < policy.minFramesBetweenChanges) {
      addIssue('SUBTITLE_ANCHOR_UNSTABLE', 'warning',
        `Cue ${cue.id} had to move from ${previous} to ${anchor} only ${cue.startFrame - lastChangeFrame} frames after the previous change.`,
        evidenceIds)
    }
    const blockerIds = Object.freeze([...new Set(
      SUBTITLE_ANCHOR_PREFERENCE.flatMap((candidate) => (blocking.get(candidate) ?? []).map((blocker) => blocker.id)),
    )].toSorted())
    decisions.push(Object.freeze({
      cueId: cue.id, startFrame: cue.startFrame, endFrame: cue.endFrame,
      anchor, bounds: anchor ? bands[anchor] : null,
      stable, changedFromPrevious, suppressed,
      eligibleAnchors: Object.freeze([...eligible]),
      blockerIds, evidenceIds,
      issues: Object.freeze([...cueIssues]),
    }))
    issues.push(...cueIssues)
    if (anchor !== null) {
      if (changedFromPrevious || previous === null) lastChangeFrame = cue.startFrame
      previous = anchor
    }
  }
  const body = Object.freeze({
    schemaVersion: 'subtitle-anchor-plan/v1' as const,
    outputSpecId: input.spec.id,
    format: input.format,
    canvas: Object.freeze({ width: input.canvas.width, height: input.canvas.height }),
    fps: Number(input.fps.toFixed(6)),
    durationFrames: input.durationFrames,
    subtitleRegionHash: calculateCanonicalHash(input.region),
    presetId: input.region.presetId,
    presetHash: input.region.presetHash,
    registryHash: input.region.registryHash,
    perceptionTimelineHash: input.perceptionTimeline?.timelineHash ?? null,
    placementEvidenceHash: calculateCanonicalHash(Object.freeze(
      blockers.filter((blocker) => blocker.source === 'placement-plan')
        .map((blocker) => Object.freeze({ id: blocker.id, kind: blocker.kind, bounds: blocker.bounds, startFrame: blocker.startFrame, endFrame: blocker.endFrame })),
    )),
    policy,
    bands,
    decisions: Object.freeze(decisions),
    issues: Object.freeze(issues.toSorted((left, right) =>
      left.evidenceRange.startFrame - right.evidenceRange.startFrame || left.code.localeCompare(right.code) || left.cueId.localeCompare(right.cueId))),
    evidenceWithoutGeometry: withoutGeometry,
  })
  return Object.freeze({ ...body, anchorPlanHash: calculateCanonicalHash(body) })
}

/**
 * Fail-closed gate. Everything the plan claims is re-derived from the region it declares: a
 * rewritten band, a moved decision or an edited hash cannot reach the renderer.
 */
export function validateSubtitleAnchorPlan(plan: Readonly<SubtitleAnchorPlanV1>, expected: Readonly<{
  region: Readonly<SubtitleRegionV1>
  safeArea: Readonly<OutputSpec['safeArea']>
  outputSpecId: string
  format: OutputAspectRatio
  canvas: Readonly<{ width: number; height: number }>
  durationFrames: number
}>): void {
  assertDomain(plan.schemaVersion === 'subtitle-anchor-plan/v1', 'INVALID_RENDER_INPUT', 'Subtitle anchor plan schema version is unsupported')
  assertDomain(
    plan.outputSpecId === expected.outputSpecId && plan.format === expected.format &&
    plan.canvas.width === expected.canvas.width && plan.canvas.height === expected.canvas.height &&
    plan.durationFrames === expected.durationFrames,
    'INVALID_RENDER_INPUT', 'Subtitle anchor plan does not describe this render',
  )
  assertDomain(
    plan.subtitleRegionHash === calculateCanonicalHash(expected.region) &&
    plan.presetId === expected.region.presetId && plan.presetHash === expected.region.presetHash &&
    plan.registryHash === expected.region.registryHash,
    'INVALID_RENDER_INPUT', 'Subtitle anchor plan is not bound to the resolved subtitle region',
  )
  assertDomain(
    plan.perceptionTimelineHash === null || SHA256.test(plan.perceptionTimelineHash),
    'INVALID_RENDER_INPUT', 'Subtitle anchor plan perception identity is invalid',
  )
  const bands = deriveSubtitleAnchorBands({ region: expected.region, safeArea: expected.safeArea })
  assertDomain(
    calculateCanonicalHash(plan.bands) === calculateCanonicalHash(bands),
    'INVALID_RENDER_INPUT', 'Subtitle anchor bands were not derived from this output preset',
  )
  const seen = new Set<string>()
  for (const decision of plan.decisions) {
    assertDomain(!seen.has(decision.cueId), 'INVALID_RENDER_INPUT', 'Subtitle anchor decisions must be unique per cue')
    seen.add(decision.cueId)
    assertDomain(
      Number.isSafeInteger(decision.startFrame) && Number.isSafeInteger(decision.endFrame) &&
      decision.startFrame >= 0 && decision.endFrame > decision.startFrame && decision.endFrame <= plan.durationFrames,
      'INVALID_RENDER_INPUT', `Subtitle anchor decision ${decision.cueId} is not a half-open interval inside the timeline`,
    )
    if (decision.anchor === null) {
      assertDomain(decision.suppressed && decision.bounds === null, 'INVALID_RENDER_INPUT', 'A subtitle cue without an anchor must be suppressed')
      assertDomain(
        decision.issues.some((issue) => issue.code === 'NO_SAFE_SUBTITLE_REGION' && issue.severity === 'hard'),
        'INVALID_RENDER_INPUT', 'A suppressed subtitle cue must carry its localized reason code',
      )
    } else {
      assertDomain(
        !decision.suppressed && decision.bounds !== null &&
        calculateCanonicalHash(decision.bounds) === calculateCanonicalHash(bands[decision.anchor]),
        'INVALID_RENDER_INPUT', `Subtitle anchor decision ${decision.cueId} does not sit on its declared band`,
      )
    }
  }
  const flattened = plan.decisions.flatMap((decision) => decision.issues)
  assertDomain(flattened.length === plan.issues.length, 'INVALID_RENDER_INPUT', 'Subtitle anchor plan issues do not match its decisions')
  const { anchorPlanHash, ...body } = plan
  assertDomain(SHA256.test(anchorPlanHash) && anchorPlanHash === calculateCanonicalHash(body), 'INVALID_RENDER_INPUT', 'Subtitle anchor plan hash is inconsistent')
}

const observation = (
  id: string, kind: PerceptionKind, startMs: number, endMs: number, bounds: NormalizedBounds,
): PerceptionObservation => ({
  id, kind, startMs, endMs, value: { bounds },
  provenance: { source: 'fixture', model: 'anchor-golden', version: 'v1', confidence: 0.99 },
})

const coverageFor = (entries: Partial<Record<PerceptionKind, readonly PerceptionRange[]>>) =>
  PERCEPTION_KINDS.map((kind) => ({ kind, ranges: entries[kind] ?? [] }))

/**
 * Perception timelines for the FR-173 compositions. They are real `PerceptionTimeline` documents —
 * content-addressed and validated by the same constructor production uses — not literal rectangles
 * handed to the solver.
 */
export const SUBTITLE_ANCHOR_PERCEPTION_FIXTURES = Object.freeze({
  /** A presenter framed low: the bottom bands are taken, the decision must climb. */
  lowerFace: createPerceptionTimeline({
    durationMs: 3_000,
    observations: [observation('face-lower', 'face', 0, 3_000, { x: 0.22, y: 0.6, width: 0.56, height: 0.38 })],
    coverage: coverageFor({ face: [[0, 3_000]] }),
  }),
  /** A shared screen with text edge to edge: no band is free, but no face is at risk either. */
  fullScreenOcr: createPerceptionTimeline({
    durationMs: 3_000,
    observations: [observation('ocr-fullscreen', 'ocr', 0, 3_000, { x: 0, y: 0, width: 1, height: 1 })],
    coverage: coverageFor({ ocr: [[0, 3_000]] }),
  }),
  /** An insert in the middle plus a face at the top; the cta/logo evidence comes from the plan. */
  multipleOverlays: createPerceptionTimeline({
    durationMs: 3_000,
    observations: [
      observation('face-upper', 'face', 0, 3_000, { x: 0.3, y: 0.04, width: 0.4, height: 0.26 }),
      observation('insert-middle', 'image-insert', 0, 3_000, { x: 0.08, y: 0.34, width: 0.84, height: 0.24 }),
    ],
    coverage: coverageFor({ face: [[0, 3_000]], 'image-insert': [[0, 3_000]] }),
  }),
  /**
   * The same low face, but it blinks out for a fifth of a second between two adjacent cues. A
   * solver without a stability window would drop back to `bottom` and jump straight back up.
   */
  flickeringFace: createPerceptionTimeline({
    durationMs: 3_000,
    observations: [
      observation('face-before', 'face', 0, 1_000, { x: 0.22, y: 0.6, width: 0.56, height: 0.38 }),
      observation('face-after', 'face', 1_200, 3_000, { x: 0.22, y: 0.6, width: 0.56, height: 0.38 }),
    ],
    coverage: coverageFor({ face: [[0, 1_000], [1_200, 3_000]] }),
  }),
  /** A face filling the frame: every band is critical, nothing may be drawn over it. */
  noSafeRegion: createPerceptionTimeline({
    durationMs: 3_000,
    observations: [observation('face-fullscreen', 'face', 0, 3_000, { x: 0, y: 0, width: 1, height: 1 })],
    coverage: coverageFor({ face: [[0, 3_000]] }),
  }),
})

/** The decision that governs `cueId`, or `null` when the plan never saw that cue. */
export function subtitleAnchorDecisionFor(
  plan: Readonly<SubtitleAnchorPlanV1>, cueId: string,
): Readonly<SubtitleAnchorDecisionV1> | null {
  return plan.decisions.find((decision) => decision.cueId === cueId) ?? null
}
