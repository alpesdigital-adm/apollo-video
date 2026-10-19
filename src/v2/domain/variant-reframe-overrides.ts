import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import { OUTPUT_ASPECT_RATIOS, type NormalizedBounds, type OutputAspectRatio } from './output-spec.ts'
import { maximumReframeCrop } from './reframe-plan.ts'

/** Manual crop preferences scoped to one immutable ProjectVersion; they are not ROI evidence. */
export interface VariantReframeSourceClipV1 {
  clipId: string
  sourceArtifactId: string
  sourceSha256: string
  sourceWidth: number
  sourceHeight: number
  sourceFps: number
  sourceInFrame: number
  sourceOutFrame: number
  timelineInFrame: number
  timelineOutFrame: number
  rate: number
}

export interface VariantReframeOverrideV1 {
  id: string
  variantId: OutputAspectRatio
  clipId: string
  startFrame: number
  endFrame: number
  crop: Readonly<NormalizedBounds>
  provenance: 'manual-command'
  commandId: string
}

export interface VariantReframeOverrideSetV1 {
  schemaVersion: 'variant-reframe-overrides/v1'
  id: string
  workspaceId: string
  projectId: string
  baseVersionId: string
  resultVersionId: string
  commandId: string
  editPlanHash: string
  sourceMapHash: string
  timelineFps: number
  sourceClips: readonly Readonly<VariantReframeSourceClipV1>[]
  overrides: readonly Readonly<VariantReframeOverrideV1>[]
  createdAt: string
  contentHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const SHA256 = /^[a-f0-9]{64}$/
const ASPECT_TOLERANCE = 0.002
const MAX_CLIPS = 20_000
const MAX_OVERRIDES = 20_000

function record(value: unknown, field: string): Record<string, unknown> {
  assertDomain(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_RENDER_INPUT', `${field} must be an object`)
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  assertDomain(Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)),
    'INVALID_RENDER_INPUT', `${field} fields are invalid`)
}

function id(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && ID.test(value), 'INVALID_RENDER_INPUT', `${field} is invalid`)
  return value
}

function sha(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && SHA256.test(value), 'INVALID_RENDER_INPUT', `${field} is invalid`)
  return value
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  assertDomain(Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum,
    'INVALID_RENDER_INPUT', `${field} is invalid`)
  return Number(value)
}

function parseSourceClip(value: unknown): Readonly<VariantReframeSourceClipV1> {
  const clip = record(value, 'source clip')
  exact(clip, ['clipId', 'sourceArtifactId', 'sourceSha256', 'sourceWidth', 'sourceHeight', 'sourceFps',
    'sourceInFrame', 'sourceOutFrame', 'timelineInFrame', 'timelineOutFrame', 'rate'], 'source clip')
  const parsed = {
    clipId: id(clip.clipId, 'source clip id'),
    sourceArtifactId: id(clip.sourceArtifactId, 'source artifact id'),
    sourceSha256: sha(clip.sourceSha256, 'source SHA-256'),
    sourceWidth: integer(clip.sourceWidth, 'source width', 2, 16_384),
    sourceHeight: integer(clip.sourceHeight, 'source height', 2, 16_384),
    sourceFps: integer(clip.sourceFps, 'source fps', 1, 240),
    sourceInFrame: integer(clip.sourceInFrame, 'source in frame', 0, 2_592_000),
    sourceOutFrame: integer(clip.sourceOutFrame, 'source out frame', 1, 2_592_000),
    timelineInFrame: integer(clip.timelineInFrame, 'timeline in frame', 0, 2_592_000),
    timelineOutFrame: integer(clip.timelineOutFrame, 'timeline out frame', 1, 2_592_000),
    rate: integer(clip.rate, 'source rate', 1, 1),
  }
  assertDomain(parsed.sourceOutFrame > parsed.sourceInFrame &&
    parsed.timelineOutFrame > parsed.timelineInFrame && parsed.rate === 1 &&
    parsed.sourceOutFrame - parsed.sourceInFrame === parsed.timelineOutFrame - parsed.timelineInFrame,
  'INVALID_RENDER_INPUT', 'Reframe override supports only a rate-one source map with equal frame spans')
  return Object.freeze(parsed)
}

function parseCrop(value: unknown, variantId: OutputAspectRatio, source: Readonly<VariantReframeSourceClipV1>): Readonly<NormalizedBounds> {
  const crop = record(value, 'manual crop')
  exact(crop, ['x', 'y', 'width', 'height'], 'manual crop')
  const values = ['x', 'y', 'width', 'height'].map((key) => crop[key])
  assertDomain(values.every((item) => typeof item === 'number' && Number.isFinite(item)), 'INVALID_RENDER_INPUT', 'Manual crop coordinates must be finite')
  const [x, y, width, height] = values as number[]
  assertDomain(x! >= 0 && y! >= 0 && width! > 0 && height! > 0 && x! + width! <= 1 && y! + height! <= 1,
    'INVALID_RENDER_INPUT', 'Manual crop must remain within source bounds')
  const [numerator, denominator] = variantId.split(':').map(Number)
  const actualRatio = width! * source.sourceWidth / (height! * source.sourceHeight)
  assertDomain(Math.abs(actualRatio - numerator! / denominator!) <= ASPECT_TOLERANCE,
    'INVALID_RENDER_INPUT', 'Manual crop aspect differs from its output variant')
  return Object.freeze({ x: x!, y: y!, width: width!, height: height! })
}

function parseOverride(value: unknown, clips: ReadonlyMap<string, Readonly<VariantReframeSourceClipV1>>): Readonly<VariantReframeOverrideV1> {
  const item = record(value, 'reframe override')
  exact(item, ['id', 'variantId', 'clipId', 'startFrame', 'endFrame', 'crop', 'provenance', 'commandId'], 'reframe override')
  assertDomain(typeof item.variantId === 'string' && OUTPUT_ASPECT_RATIOS.includes(item.variantId as OutputAspectRatio),
    'INVALID_RENDER_INPUT', 'Reframe override variant is invalid')
  const variantId = item.variantId as OutputAspectRatio
  const clipId = id(item.clipId, 'override clip id')
  const source = clips.get(clipId)
  assertDomain(Boolean(source), 'INVALID_RENDER_INPUT', 'Reframe override clip is absent from the source map')
  const startFrame = integer(item.startFrame, 'override start frame', source!.timelineInFrame, source!.timelineOutFrame - 1)
  const endFrame = integer(item.endFrame, 'override end frame', startFrame + 1, source!.timelineOutFrame)
  assertDomain(item.provenance === 'manual-command', 'INVALID_RENDER_INPUT', 'Reframe override cannot claim detector provenance')
  return Object.freeze({
    id: id(item.id, 'override id'), variantId, clipId, startFrame, endFrame,
    crop: parseCrop(item.crop, variantId, source!), provenance: 'manual-command' as const,
    commandId: id(item.commandId, 'override command id'),
  })
}

function sortOverrides(values: readonly Readonly<VariantReframeOverrideV1>[]): readonly Readonly<VariantReframeOverrideV1>[] {
  const sorted = [...values].toSorted((left, right) => left.variantId.localeCompare(right.variantId) ||
    left.clipId.localeCompare(right.clipId) || left.startFrame - right.startFrame ||
    left.endFrame - right.endFrame || left.id.localeCompare(right.id))
  assertDomain(sorted.length <= MAX_OVERRIDES, 'INVALID_RENDER_INPUT', 'Too many reframe overrides')
  assertDomain(new Set(sorted.map((item) => item.id)).size === sorted.length,
    'INVALID_RENDER_INPUT', 'Duplicate reframe override id')
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!
    const current = sorted[index]!
    assertDomain(previous.variantId !== current.variantId || previous.clipId !== current.clipId || previous.endFrame <= current.startFrame,
      'INVALID_RENDER_INPUT', 'Reframe override ranges overlap in one variant and clip')
  }
  return Object.freeze(sorted)
}

/** Hydration checks the complete persisted document and its canonical content hash. */
export function parseVariantReframeOverrideSet(value: unknown): Readonly<VariantReframeOverrideSetV1> {
  const item = record(value, 'variant reframe override set')
  exact(item, ['schemaVersion', 'id', 'workspaceId', 'projectId', 'baseVersionId', 'resultVersionId',
    'commandId', 'editPlanHash', 'sourceMapHash', 'timelineFps', 'sourceClips', 'overrides', 'createdAt', 'contentHash'],
  'variant reframe override set')
  assertDomain(item.schemaVersion === 'variant-reframe-overrides/v1', 'INVALID_RENDER_INPUT', 'Reframe override schema is unsupported')
  assertDomain(Array.isArray(item.sourceClips) && item.sourceClips.length > 0 && item.sourceClips.length <= MAX_CLIPS,
    'INVALID_RENDER_INPUT', 'Reframe override source clips are invalid')
  const sourceClips = Object.freeze(item.sourceClips.map(parseSourceClip))
  assertDomain(sourceClips.every((clip, index) => index === 0 || sourceClips[index - 1]!.clipId < clip.clipId),
    'INVALID_RENDER_INPUT', 'Reframe source clips must be unique and sorted by id')
  const clips = new Map(sourceClips.map((clip) => [clip.clipId, clip]))
  assertDomain(Array.isArray(item.overrides), 'INVALID_RENDER_INPUT', 'Reframe overrides must be an array')
  const suppliedOverrides = item.overrides.map((override) => parseOverride(override, clips))
  const overrides = sortOverrides(suppliedOverrides)
  assertDomain(overrides.every((override, index) => override.id === suppliedOverrides[index]?.id),
    'INVALID_RENDER_INPUT', 'Reframe overrides must be in canonical order')
  const createdAt = item.createdAt
  assertDomain(typeof createdAt === 'string' && !Number.isNaN(Date.parse(createdAt)), 'INVALID_RENDER_INPUT', 'Reframe override timestamp is invalid')
  const body = Object.freeze({
    schemaVersion: 'variant-reframe-overrides/v1' as const,
    id: id(item.id, 'override set id'), workspaceId: id(item.workspaceId, 'workspace id'),
    projectId: id(item.projectId, 'project id'), baseVersionId: id(item.baseVersionId, 'base version id'),
    resultVersionId: id(item.resultVersionId, 'result version id'), commandId: id(item.commandId, 'command id'),
    editPlanHash: sha(item.editPlanHash, 'EditPlan hash'), sourceMapHash: sha(item.sourceMapHash, 'source map hash'),
    timelineFps: integer(item.timelineFps, 'timeline fps', 1, 240), sourceClips, overrides, createdAt,
  })
  assertDomain(body.baseVersionId !== body.resultVersionId, 'INVALID_RENDER_INPUT', 'Override result must create a new version')
  assertDomain(body.sourceClips.every((clip) => clip.sourceFps === body.timelineFps),
    'INVALID_RENDER_INPUT', 'Reframe override requires source FPS equal to timeline FPS')
  assertDomain(body.sourceMapHash === calculateCanonicalHash({ timelineFps: body.timelineFps, sourceClips: body.sourceClips }),
    'INVALID_RENDER_INPUT', 'Reframe source map hash is inconsistent')
  const contentHash = sha(item.contentHash, 'override set hash')
  assertDomain(contentHash === calculateCanonicalHash(body), 'INVALID_RENDER_INPUT', 'Reframe override content hash is inconsistent')
  return Object.freeze({ ...body, contentHash })
}

/** A newer manual Command replaces only an exact range; partial overlaps are refused. */
export function createVariantReframeOverrideSet(input: Readonly<{
  id: string
  workspaceId: string
  projectId: string
  baseVersionId: string
  resultVersionId: string
  commandId: string
  editPlanHash: string
  timelineFps: number
  sourceClips: readonly Readonly<VariantReframeSourceClipV1>[]
  override: Omit<VariantReframeOverrideV1, 'provenance' | 'commandId'>
  previous?: Readonly<VariantReframeOverrideSetV1>
  createdAt: string
}>): Readonly<VariantReframeOverrideSetV1> {
  const sourceClips = Object.freeze(input.sourceClips.map(parseSourceClip).toSorted((left, right) => left.clipId.localeCompare(right.clipId)))
  const sourceMapHash = calculateCanonicalHash({ timelineFps: input.timelineFps, sourceClips })
  const previous = input.previous ? parseVariantReframeOverrideSet(input.previous) : undefined
  if (previous) {
    assertDomain(previous.workspaceId === input.workspaceId && previous.projectId === input.projectId &&
      previous.resultVersionId === input.baseVersionId && previous.editPlanHash === input.editPlanHash &&
      previous.sourceMapHash === sourceMapHash,
    'INVALID_RENDER_INPUT', 'Prior reframe overrides cannot cross version, EditPlan or source map changes')
  }
  const clips = new Map(sourceClips.map((clip) => [clip.clipId, clip]))
  const override = parseOverride({ ...input.override, provenance: 'manual-command', commandId: input.commandId }, clips)
  const inherited = previous?.overrides.filter((item) => !(item.variantId === override.variantId &&
    item.clipId === override.clipId && item.startFrame === override.startFrame && item.endFrame === override.endFrame)) ?? []
  const overrides = sortOverrides([...inherited, override])
  const body = Object.freeze({
    schemaVersion: 'variant-reframe-overrides/v1' as const,
    id: input.id, workspaceId: input.workspaceId, projectId: input.projectId,
    baseVersionId: input.baseVersionId, resultVersionId: input.resultVersionId,
    commandId: input.commandId, editPlanHash: input.editPlanHash, sourceMapHash,
    timelineFps: input.timelineFps,
    sourceClips, overrides, createdAt: input.createdAt,
  })
  return parseVariantReframeOverrideSet({ ...body, contentHash: calculateCanonicalHash(body) })
}

/** Exact-version lookup for render materialization; no ancestor or sibling-variant fallback. */
export function selectVariantReframeOverrides(input: Readonly<{
  set: unknown
  workspaceId: string
  projectId: string
  projectVersionId: string
  editPlanHash: string
  sourceMapHash: string
  variantId: OutputAspectRatio
}>): readonly Readonly<VariantReframeOverrideV1>[] {
  const set = parseVariantReframeOverrideSet(input.set)
  assertDomain(set.workspaceId === input.workspaceId && set.projectId === input.projectId &&
    set.resultVersionId === input.projectVersionId && set.editPlanHash === input.editPlanHash &&
    set.sourceMapHash === input.sourceMapHash,
  'INVALID_RENDER_INPUT', 'Reframe override set is stale or belongs to another rendering context')
  return Object.freeze(set.overrides.filter((override) => override.variantId === input.variantId))
}

/* -------------------------------------------------------------------------- */
/* W66r. One override per Command, bound to the STABLE output variant         */
/* -------------------------------------------------------------------------- */
//
// The set above is version-bound and keyed by aspect ratio: two outputs of one ratio collide in it, and any other Command that
// recompiles a Version would silently leave it behind. The per-Command document below names the stable variant, carries the
// facts of the clip it was authored against, and is chained (`previousOverrideId`) so a reset is a new row, not a delete. Which
// overrides are active for a Version is decided by comparing those facts with the Version's own clips, never by version order.

export interface VariantReframeClipFactsV1 {
  clipId: string
  sourceArtifactId: string
  sourceSha256: string
  sourceWidth: number
  sourceHeight: number
  sourceInFrame: number
  sourceOutFrame: number
  timelineInFrame: number
  timelineOutFrame: number
  rate: number
  fps: number
}

/** The identity of what an override was authored against: any change of the clip's source, window or timing is another clip. */
export function reframeClipBindingHash(clip: Readonly<VariantReframeClipFactsV1>): string {
  return calculateCanonicalHash({
    schemaVersion: 'variant-reframe-clip-binding/v1',
    clipId: clip.clipId, sourceArtifactId: clip.sourceArtifactId, sourceSha256: clip.sourceSha256,
    sourceWidth: clip.sourceWidth, sourceHeight: clip.sourceHeight, sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame,
    timelineInFrame: clip.timelineInFrame, timelineOutFrame: clip.timelineOutFrame, rate: clip.rate, fps: clip.fps,
  })
}

export const VARIANT_REFRAME_OVERRIDE_ACTIONS = ['set', 'reset'] as const
export type VariantReframeOverrideAction = (typeof VARIANT_REFRAME_OVERRIDE_ACTIONS)[number]

export interface VariantReframeOverrideV2 {
  schemaVersion: 'variant-reframe-override/v2'
  id: string
  workspaceId: string
  projectId: string
  baseVersionId: string
  resultVersionId: string
  commandId: string
  /** The stable State variant. Never an aspect ratio. */
  variantId: string
  aspectRatio: OutputAspectRatio
  clipId: string
  /** Half-open timeline range inside the clip. */
  startFrame: number
  endFrame: number
  action: VariantReframeOverrideAction
  /** The editor's crop for a `set`; null for a `reset` (back to the automatic level). */
  crop: Readonly<NormalizedBounds> | null
  clipBindingHash: string
  previousOverrideId: string | null
  provenance: 'manual-command'
  createdAt: string
  overrideHash: string
}

const EPS = 1e-6

export function createVariantReframeOverride(input: Readonly<{
  id: string
  workspaceId: string
  projectId: string
  baseVersionId: string
  resultVersionId: string
  commandId: string
  variantId: string
  aspectRatio: OutputAspectRatio
  clip: Readonly<VariantReframeClipFactsV1>
  startFrame: number
  endFrame: number
  action: VariantReframeOverrideAction
  crop?: Readonly<NormalizedBounds> | null
  /** The current override of this exact range (the one this replaces or resets), or null. */
  previous: Readonly<VariantReframeOverrideV2> | null
  createdAt: string
}>): Readonly<VariantReframeOverrideV2> {
  for (const [field, value] of Object.entries({ id: input.id, workspaceId: input.workspaceId, projectId: input.projectId,
    baseVersionId: input.baseVersionId, resultVersionId: input.resultVersionId, commandId: input.commandId, variantId: input.variantId,
    clipId: input.clip.clipId })) assertDomain(typeof value === 'string' && ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  assertDomain(input.baseVersionId !== input.resultVersionId, 'INVALID_ARGUMENT', 'An override produces a new version')
  assertDomain(OUTPUT_ASPECT_RATIOS.includes(input.aspectRatio), 'INVALID_ARGUMENT', 'Override aspect ratio is invalid')
  assertDomain(VARIANT_REFRAME_OVERRIDE_ACTIONS.includes(input.action), 'INVALID_ARGUMENT', 'Override action is invalid')
  const clip = input.clip
  assertDomain(clip.rate === 1 && clip.fps >= 1, 'INVALID_ARGUMENT', 'A reframe override needs a real-time clip')
  assertDomain(
    Number.isSafeInteger(input.startFrame) && Number.isSafeInteger(input.endFrame) &&
    input.startFrame >= clip.timelineInFrame && input.endFrame > input.startFrame && input.endFrame <= clip.timelineOutFrame,
    'INVALID_ARGUMENT', 'Override range must sit inside the clip it names',
  )
  assertDomain(Number.isFinite(Date.parse(input.createdAt)) && new Date(input.createdAt).toISOString() === input.createdAt, 'INVALID_ARGUMENT', 'Override timestamp is invalid')
  const previous = input.previous
  if (previous) {
    assertDomain(previous.workspaceId === input.workspaceId && previous.projectId === input.projectId && previous.variantId === input.variantId &&
      previous.clipId === clip.clipId && previous.startFrame === input.startFrame && previous.endFrame === input.endFrame,
    'INVALID_ARGUMENT', 'The override being replaced belongs to another variant, clip or range')
  }
  let crop: Readonly<NormalizedBounds> | null = null
  if (input.action === 'set') {
    const candidate = input.crop
    assertDomain(candidate !== null && candidate !== undefined && typeof candidate === 'object', 'INVALID_ARGUMENT', 'A set override requires a crop')
    const values = [candidate.x, candidate.y, candidate.width, candidate.height]
    assertDomain(values.every((value) => typeof value === 'number' && Number.isFinite(value)), 'INVALID_ARGUMENT', 'Manual crop coordinates must be finite')
    const viewport = maximumReframeCrop(input.aspectRatio, clip.sourceWidth, clip.sourceHeight)
    // A trajectory pans with a constant crop size, so an editor crop is the size of the variant's crop and can only be moved.
    assertDomain(Math.abs(candidate.width - viewport.width) <= EPS && Math.abs(candidate.height - viewport.height) <= EPS,
      'INVALID_ARGUMENT', 'Manual crop must have the size of the variant crop; it can be moved but not zoomed')
    assertDomain(candidate.x >= -EPS && candidate.y >= -EPS && candidate.x + candidate.width <= 1 + EPS && candidate.y + candidate.height <= 1 + EPS,
      'INVALID_ARGUMENT', 'Manual crop must remain within source bounds')
    crop = Object.freeze({ x: Math.max(0, candidate.x), y: Math.max(0, candidate.y), width: viewport.width, height: viewport.height })
  } else {
    assertDomain(input.crop === undefined || input.crop === null, 'INVALID_ARGUMENT', 'A reset override carries no crop')
    assertDomain(previous !== null && previous.action === 'set', 'INVALID_ARGUMENT', 'There is no manual reframe on this range to reset')
  }
  const body = Object.freeze({
    schemaVersion: 'variant-reframe-override/v2' as const,
    id: input.id, workspaceId: input.workspaceId, projectId: input.projectId, baseVersionId: input.baseVersionId,
    resultVersionId: input.resultVersionId, commandId: input.commandId, variantId: input.variantId, aspectRatio: input.aspectRatio,
    clipId: clip.clipId, startFrame: input.startFrame, endFrame: input.endFrame, action: input.action, crop,
    clipBindingHash: reframeClipBindingHash(clip), previousOverrideId: previous?.id ?? null,
    provenance: 'manual-command' as const, createdAt: input.createdAt,
  })
  return Object.freeze({ ...body, overrideHash: calculateCanonicalHash(body) })
}

/** Hydration of one stored override: the whole document and its content address. */
export function parseVariantReframeOverride(value: unknown): Readonly<VariantReframeOverrideV2> {
  const item = record(value, 'variant reframe override')
  exact(item, ['schemaVersion', 'id', 'workspaceId', 'projectId', 'baseVersionId', 'resultVersionId', 'commandId', 'variantId', 'aspectRatio',
    'clipId', 'startFrame', 'endFrame', 'action', 'crop', 'clipBindingHash', 'previousOverrideId', 'provenance', 'createdAt', 'overrideHash'], 'variant reframe override')
  assertDomain(item.schemaVersion === 'variant-reframe-override/v2' && item.provenance === 'manual-command', 'INVALID_RENDER_INPUT', 'Reframe override schema or provenance is unsupported')
  assertDomain(OUTPUT_ASPECT_RATIOS.includes(item.aspectRatio as OutputAspectRatio) && VARIANT_REFRAME_OVERRIDE_ACTIONS.includes(item.action as VariantReframeOverrideAction),
    'INVALID_RENDER_INPUT', 'Reframe override aspect ratio or action is invalid')
  const startFrame = integer(item.startFrame, 'override start frame', 0, 2_592_000)
  const endFrame = integer(item.endFrame, 'override end frame', startFrame + 1, 2_592_000)
  let crop: Readonly<NormalizedBounds> | null = null
  if (item.action === 'set') {
    const raw = record(item.crop, 'manual crop')
    exact(raw, ['x', 'y', 'width', 'height'], 'manual crop')
    assertDomain(['x', 'y', 'width', 'height'].every((key) => typeof raw[key] === 'number' && Number.isFinite(raw[key])), 'INVALID_RENDER_INPUT', 'Manual crop coordinates must be finite')
    crop = Object.freeze({ x: raw.x as number, y: raw.y as number, width: raw.width as number, height: raw.height as number })
  } else assertDomain(item.crop === null, 'INVALID_RENDER_INPUT', 'A reset override carries no crop')
  assertDomain(typeof item.createdAt === 'string' && !Number.isNaN(Date.parse(item.createdAt)), 'INVALID_RENDER_INPUT', 'Reframe override timestamp is invalid')
  const parsed = Object.freeze({
    schemaVersion: 'variant-reframe-override/v2' as const,
    id: id(item.id, 'override id'), workspaceId: id(item.workspaceId, 'workspace id'), projectId: id(item.projectId, 'project id'),
    baseVersionId: id(item.baseVersionId, 'base version id'), resultVersionId: id(item.resultVersionId, 'result version id'),
    commandId: id(item.commandId, 'command id'), variantId: id(item.variantId, 'variant id'), aspectRatio: item.aspectRatio as OutputAspectRatio,
    clipId: id(item.clipId, 'clip id'), startFrame, endFrame, action: item.action as VariantReframeOverrideAction, crop,
    clipBindingHash: sha(item.clipBindingHash, 'clip binding hash'),
    previousOverrideId: item.previousOverrideId === null ? null : id(item.previousOverrideId, 'previous override id'),
    provenance: 'manual-command' as const, createdAt: item.createdAt as string,
  })
  const overrideHash = sha(item.overrideHash, 'override hash')
  assertDomain(overrideHash === calculateCanonicalHash(parsed), 'INVALID_RENDER_INPUT', 'Reframe override content hash is inconsistent')
  assertDomain(parsed.baseVersionId !== parsed.resultVersionId && (parsed.action === 'set' ? parsed.crop !== null : parsed.previousOverrideId !== null),
    'INVALID_RENDER_INPUT', 'Reframe override lineage is inconsistent')
  return Object.freeze({ ...parsed, overrideHash })
}

/** A manual range may replace the exact range of an existing one; any other overlap with an active override of that clip is refused. */
export function assertReframeOverrideDoesNotOverlap(active: readonly Readonly<VariantReframeOverrideV2>[], candidate: Readonly<Pick<VariantReframeOverrideV2,
  'variantId' | 'clipId' | 'startFrame' | 'endFrame'>>): void {
  for (const other of active) {
    if (other.action !== 'set' || other.variantId !== candidate.variantId || other.clipId !== candidate.clipId) continue
    if (other.startFrame === candidate.startFrame && other.endFrame === candidate.endFrame) continue
    assertDomain(!(other.startFrame < candidate.endFrame && candidate.startFrame < other.endFrame),
      'INVALID_ARGUMENT', 'A manual reframe may replace an exact range but cannot partially overlap another', { overlaps: other.id })
  }
}

export const REFRAME_OVERRIDE_INACTIVE_REASONS = ['CLIP_ABSENT', 'CLIP_CHANGED', 'HIDES_CRITICAL_SUBJECT'] as const
export type ReframeOverrideInactiveReason = (typeof REFRAME_OVERRIDE_INACTIVE_REASONS)[number]

/**
 * Which head overrides apply to the Version whose clips are given. A `reset` head applies nothing (the automatic level is back).
 * A `set` head applies only to the very clip it was authored against; otherwise it is reported inactive with the reason, never dropped
 * and never bent onto another clip.
 */
export function selectReframeOverridesForClips(input: Readonly<{
  variantId: string
  heads: readonly Readonly<VariantReframeOverrideV2>[]
  clips: readonly Readonly<VariantReframeClipFactsV1>[]
}>): Readonly<{
  applicable: readonly Readonly<VariantReframeOverrideV2>[]
  inactive: readonly Readonly<{ override: Readonly<VariantReframeOverrideV2>; reasonCode: ReframeOverrideInactiveReason }>[]
}> {
  const applicable: Readonly<VariantReframeOverrideV2>[] = []
  const inactive: Array<{ override: Readonly<VariantReframeOverrideV2>; reasonCode: ReframeOverrideInactiveReason }> = []
  const byId = new Map(input.clips.map((clip) => [clip.clipId, clip]))
  for (const head of input.heads.filter((item) => item.variantId === input.variantId && item.action === 'set')
    .toSorted((left, right) => left.clipId.localeCompare(right.clipId) || left.startFrame - right.startFrame)) {
    const clip = byId.get(head.clipId)
    if (!clip) { inactive.push({ override: head, reasonCode: 'CLIP_ABSENT' }); continue }
    if (reframeClipBindingHash(clip) !== head.clipBindingHash || head.startFrame < clip.timelineInFrame || head.endFrame > clip.timelineOutFrame) {
      inactive.push({ override: head, reasonCode: 'CLIP_CHANGED' }); continue
    }
    applicable.push(head)
  }
  return Object.freeze({ applicable: Object.freeze(applicable), inactive: Object.freeze(inactive) })
}
