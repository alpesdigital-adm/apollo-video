import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import { OUTPUT_ASPECT_RATIOS, type NormalizedBounds, type OutputAspectRatio } from './output-spec.ts'

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
