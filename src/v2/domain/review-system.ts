import { createHash } from 'node:crypto'

import { DomainError, assertDomain } from './errors.ts'

export interface PreviewSession {
  projectVersionId: string
  proxyArtifactId?: string
  proxyUrl: string
  proxyHash: string
  fps: number
  resolution: { width: number; height: number }
  durationFrames?: number
  stale: boolean
  frame: number
  playing: boolean
}

export function controlPreview(
  session: PreviewSession,
  action: { type: 'play' | 'pause' | 'seek-frame' | 'seek-time'; value?: number },
) {
  const frame = action.type === 'seek-time'
    ? Math.round((action.value ?? 0) * session.fps)
    : action.type === 'seek-frame'
      ? Math.round(action.value ?? 0)
      : session.frame
  assertDomain(frame >= 0, 'INVALID_ARGUMENT', 'Preview frame cannot be negative')
  if (session.durationFrames !== undefined) {
    assertDomain(frame < session.durationFrames, 'INVALID_ARGUMENT', 'Preview frame is outside the proxy')
  }
  return Object.freeze({
    ...session,
    frame,
    playing: action.type === 'play' ? true : action.type === 'pause' ? false : session.playing,
    timecodeMs: Math.round(frame / session.fps * 1000),
  })
}

export function previewMetrics(samples: {
  firstFrameMs: number
  seekMs: readonly number[]
  renderedFrames: number
  droppedFrames: number
}) {
  assertDomain(
    [samples.firstFrameMs, samples.renderedFrames, samples.droppedFrames, ...samples.seekMs]
      .every((value) => Number.isFinite(value) && value >= 0),
    'INVALID_ARGUMENT',
    'Preview metrics cannot contain negative or non-finite samples',
  )
  const sorted = [...samples.seekMs].toSorted((left, right) => left - right)
  return Object.freeze({
    firstFrameMs: samples.firstFrameMs,
    seekP95Ms: sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : 0,
    droppedFrameRate: samples.renderedFrames ? samples.droppedFrames / samples.renderedFrames : 0,
  })
}

export type ReviewAnnotationScope = 'point' | 'region' | 'scene'

export interface ReviewAnnotation {
  id: string
  projectVersionId: string
  proxyArtifactId?: string
  proxyHash?: string
  frame: number
  timeRangeMs: readonly [number, number]
  screenshotRef: string
  scope?: ReviewAnnotationScope
  region?: { x: number; y: number; width: number; height: number }
  targetIds: readonly string[]
  applicationScope: ReviewScope
  affectedCount: number
  text: string
  author: { id: string; name: string; type?: 'user' | 'api-client' }
  status: 'open' | 'applied' | 'dismissed'
  createdAt: string
}

export function createReviewAnnotation(input: ReviewAnnotation) {
  const scope = input.scope ?? (input.region ? 'region' : input.targetIds.length ? 'scene' : 'point')
  assertDomain(
    Boolean(input.id.trim()) && Boolean(input.projectVersionId.trim()) && Boolean(input.text.trim()) &&
      Boolean(input.screenshotRef.trim()) && Boolean(input.author.id.trim()) && Boolean(input.author.name.trim()) &&
      Number.isInteger(input.frame) && input.frame >= 0 &&
      Number.isInteger(input.timeRangeMs[0]) && Number.isInteger(input.timeRangeMs[1]) &&
      input.timeRangeMs[0] >= 0 && input.timeRangeMs[1] >= input.timeRangeMs[0] &&
      Number.isInteger(input.affectedCount) && input.affectedCount >= 1 &&
      REVIEW_SCOPE_KINDS.includes(input.applicationScope.kind) &&
      !Number.isNaN(Date.parse(input.createdAt)),
    'INVALID_ARGUMENT',
    'Annotation fields are invalid',
  )
  if (scope === 'region') {
    assertDomain(Boolean(input.region), 'INVALID_ARGUMENT', 'Region annotation requires normalized bounds')
  } else {
    assertDomain(!input.region, 'INVALID_ARGUMENT', 'Only region annotations accept normalized bounds')
  }
  if (input.region) {
    const { x, y, width, height } = input.region
    assertDomain(
      [x, y, width, height].every(Number.isFinite) && x >= 0 && y >= 0 && width > 0 && height > 0 &&
        x + width <= 1 && y + height <= 1,
      'INVALID_ARGUMENT',
      'Annotation region must be normalized',
    )
  }
  if (scope === 'scene') {
    assertDomain(input.targetIds.length === 1, 'INVALID_ARGUMENT', 'Scene annotation requires one scene target')
  }
  return Object.freeze({
    ...input,
    scope,
    text: input.text.trim(),
    author: Object.freeze({ ...input.author, type: input.author.type ?? 'api-client' as const }),
    targetIds: Object.freeze([...new Set(input.targetIds)]),
    applicationScope: Object.freeze({
      ...input.applicationScope,
      targetIds: Object.freeze([...new Set(input.applicationScope.targetIds)]),
      formatIds: Object.freeze([...new Set(input.applicationScope.formatIds)]),
      localeIds: Object.freeze([...new Set(input.applicationScope.localeIds)]),
      recipeIds: Object.freeze([...new Set(input.applicationScope.recipeIds)]),
    }),
    status: input.status,
  })
}

export const REVIEW_SCOPE_KINDS = Object.freeze([
  'frame', 'region', 'clip', 'scene', 'range', 'project', 'formats', 'locales', 'recipes',
] as const)
export type ReviewScopeKind = (typeof REVIEW_SCOPE_KINDS)[number]
export interface ReviewScope {
  kind: ReviewScopeKind
  targetIds: readonly string[]
  formatIds: readonly string[]
  localeIds: readonly string[]
  recipeIds: readonly string[]
  global: boolean
}

export function resolveReviewScope(input: {
  requested?: Partial<ReviewScope>
  current: { targetId: string; formatId: string; localeId: string; recipeId?: string }
  availableCounts: Record<ReviewScopeKind, number>
  confirmedGlobal?: boolean
}) {
  const kind = input.requested?.kind ?? 'region'
  assertDomain(REVIEW_SCOPE_KINDS.includes(kind), 'INVALID_SCOPE', 'Review scope kind is invalid')
  assertDomain(
    Boolean(input.current.targetId.trim()) && Boolean(input.current.formatId.trim()) && Boolean(input.current.localeId.trim()) &&
      Object.values(input.availableCounts).every((count) => Number.isInteger(count) && count >= 0),
    'INVALID_SCOPE',
    'Review scope context is invalid',
  )
  const global = Boolean(input.requested?.global)
  if (global && !input.confirmedGlobal) {
    throw new DomainError('PRECONDITION_REQUIRED', 'Global review scope requires confirmation')
  }
  const affectedCount = global ? input.availableCounts[kind] : 1
  assertDomain(affectedCount > 0, 'INVALID_SCOPE', `Review scope ${kind} has no available target`)
  const unique = (values: readonly string[] | undefined) => Object.freeze([
    ...new Set((values ?? []).map((value) => value.trim()).filter(Boolean)),
  ])
  const resolved: ReviewScope = {
    kind,
    targetIds: global ? unique(input.requested?.targetIds) : Object.freeze([input.current.targetId]),
    formatIds: global ? unique(input.requested?.formatIds) : Object.freeze([input.current.formatId]),
    localeIds: global ? unique(input.requested?.localeIds) : Object.freeze([input.current.localeId]),
    recipeIds: global
      ? unique(input.requested?.recipeIds)
      : Object.freeze(input.current.recipeId ? [input.current.recipeId] : []),
    global,
  }
  return Object.freeze({
    scope: Object.freeze(resolved),
    affectedCount,
    confirmationRequired: global,
  })
}

export const RENDER_ELEMENT_TYPES = Object.freeze([
  'background', 'presenter', 'subtitle', 'b-roll', 'cta', 'transformation',
] as const)
export type RenderElementType = (typeof RENDER_ELEMENT_TYPES)[number]

export interface RenderElement {
  elementId: string
  type: RenderElementType
  clipId: string
  sceneId: string
  sourceId: string
  frame: number
  bounds: { x: number; y: number; width: number; height: number }
  zIndex: number
  opacity: number
  priority: number
}
export interface RenderElementMap {
  schemaVersion: 'render-element-map/v1'
  proxyHash: string
  fps: number
  durationFrames: number
  canvas: { width: number; height: number }
  elements: readonly RenderElement[]
}
export function validateRenderElementMap(map: RenderElementMap, proxyHash: string) {
  if (map.proxyHash !== proxyHash) throw new DomainError('VERSION_CONFLICT', 'RenderElementMap hash does not match proxy')
  assertDomain(
    map.schemaVersion === 'render-element-map/v1' && /^[a-f0-9]{64}$/.test(map.proxyHash) &&
      Number.isFinite(map.fps) && map.fps > 0 && Number.isSafeInteger(map.durationFrames) && map.durationFrames > 0 &&
      Number.isSafeInteger(map.canvas.width) && map.canvas.width > 0 &&
      Number.isSafeInteger(map.canvas.height) && map.canvas.height > 0 && Array.isArray(map.elements),
    'INVALID_ARGUMENT',
    'RenderElementMap metadata is invalid',
  )
  const identities = new Set<string>()
  const elements = map.elements.map((element) => {
    const identity = `${element.frame}:${element.elementId}`
    const bounds = element.bounds
    assertDomain(
      Boolean(element.elementId.trim()) && RENDER_ELEMENT_TYPES.includes(element.type) &&
        Boolean(element.clipId.trim()) && Boolean(element.sceneId.trim()) && Boolean(element.sourceId.trim()) &&
        Number.isSafeInteger(element.frame) && element.frame >= 0 && element.frame < map.durationFrames &&
        [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) &&
        bounds.x >= 0 && bounds.y >= 0 && bounds.width > 0 && bounds.height > 0 &&
        bounds.x + bounds.width <= map.canvas.width && bounds.y + bounds.height <= map.canvas.height &&
        Number.isSafeInteger(element.zIndex) && Number.isFinite(element.opacity) &&
        element.opacity >= 0 && element.opacity <= 1 && Number.isSafeInteger(element.priority) &&
        !identities.has(identity),
      'INVALID_ARGUMENT',
      'RenderElementMap element is invalid',
    )
    identities.add(identity)
    return Object.freeze({ ...element, bounds: Object.freeze({ ...bounds }) })
  })
  return Object.freeze({
    ...map,
    canvas: Object.freeze({ ...map.canvas }),
    elements: Object.freeze(elements),
  })
}

function elementFrames(startFrame: number, endFrame: number, create: (frame: number) => RenderElement): RenderElement[] {
  const elements: RenderElement[] = []
  for (let frame = startFrame; frame < endFrame; frame += 1) elements.push(create(frame))
  return elements
}

export function buildRenderElementMap(input: {
  proxyHash: string
  fps: number
  durationFrames: number
  canvas: { width: number; height: number }
  source: { width: number; height: number }
  clips: readonly Readonly<{
    id: string
    sourceArtifactId: string
    timelineInFrame: number
    timelineOutFrame: number
  }>[]
  subtitleCues?: readonly Readonly<{ id: string; startFrame: number; endFrame: number; text: string }>[]
}): Readonly<RenderElementMap> {
  assertDomain(
    Number.isSafeInteger(input.source.width) && input.source.width > 0 &&
      Number.isSafeInteger(input.source.height) && input.source.height > 0,
    'INVALID_ARGUMENT',
    'RenderElementMap source dimensions are invalid',
  )
  const scale = Math.min(input.canvas.width / input.source.width, input.canvas.height / input.source.height)
  const foregroundWidth = Math.min(input.canvas.width, Math.round(input.source.width * scale))
  const foregroundHeight = Math.min(input.canvas.height, Math.round(input.source.height * scale))
  const foregroundBounds = Object.freeze({
    x: Math.floor((input.canvas.width - foregroundWidth) / 2),
    y: Math.floor((input.canvas.height - foregroundHeight) / 2),
    width: foregroundWidth,
    height: foregroundHeight,
  })
  const backgroundBounds = Object.freeze({ x: 0, y: 0, width: input.canvas.width, height: input.canvas.height })
  const elements: RenderElement[] = []
  for (const clip of input.clips) {
    const sceneId = `scene:${clip.id}`
    elements.push(...elementFrames(clip.timelineInFrame, clip.timelineOutFrame, (frame) => ({
      elementId: `background:${clip.id}`,
      type: 'background',
      clipId: clip.id,
      sceneId,
      sourceId: clip.sourceArtifactId,
      frame,
      bounds: backgroundBounds,
      zIndex: 0,
      opacity: 1,
      priority: 100,
    })))
    elements.push(...elementFrames(clip.timelineInFrame, clip.timelineOutFrame, (frame) => ({
      elementId: `presenter:${clip.id}`,
      type: 'presenter',
      clipId: clip.id,
      sceneId,
      sourceId: clip.sourceArtifactId,
      frame,
      bounds: foregroundBounds,
      zIndex: 10,
      opacity: 1,
      priority: 200,
    })))
  }
  for (const cue of input.subtitleCues ?? []) {
    const clip = input.clips.find((item) => cue.startFrame < item.timelineOutFrame && cue.endFrame > item.timelineInFrame)
    if (!clip) continue
    const fontSize = Math.max(32, Math.min(72, Math.round(input.canvas.width * 0.059)))
    const lineCount = cue.text.trim().length > 20 ? 2 : 1
    const width = Math.min(
      Math.round(input.canvas.width * 0.86),
      Math.max(Math.round(input.canvas.width * 0.28), Math.round(Math.min(20, cue.text.trim().length) * fontSize * 0.62)),
    )
    const height = Math.min(input.canvas.height, Math.round(lineCount * fontSize * 1.35))
    const marginBottom = Math.round(input.canvas.height * 0.075)
    const bounds = Object.freeze({
      x: Math.max(0, Math.floor((input.canvas.width - width) / 2)),
      y: Math.max(0, input.canvas.height - marginBottom - height),
      width,
      height,
    })
    elements.push(...elementFrames(cue.startFrame, cue.endFrame, (frame) => ({
      elementId: `subtitle:${cue.id}`,
      type: 'subtitle',
      clipId: clip.id,
      sceneId: `scene:${clip.id}`,
      sourceId: clip.sourceArtifactId,
      frame,
      bounds,
      zIndex: 20,
      opacity: 1,
      priority: 300,
    })))
  }
  return validateRenderElementMap({
    schemaVersion: 'render-element-map/v1',
    proxyHash: input.proxyHash,
    fps: input.fps,
    durationFrames: input.durationFrames,
    canvas: input.canvas,
    elements,
  }, input.proxyHash)
}

export function renderElementMapHash(map: RenderElementMap): string {
  return createHash('sha256').update(JSON.stringify(map)).digest('hex')
}

export function hitTestRenderElements(
  map: RenderElementMap,
  input: { frame: number; x: number; y: number; displayWidth: number; displayHeight: number },
) {
  assertDomain(
    Number.isSafeInteger(input.frame) && input.frame >= 0 && input.frame < map.durationFrames &&
      [input.x, input.y, input.displayWidth, input.displayHeight].every(Number.isFinite) &&
      input.displayWidth > 0 && input.displayHeight > 0 && input.x >= 0 && input.y >= 0 &&
      input.x <= input.displayWidth && input.y <= input.displayHeight,
    'INVALID_ARGUMENT',
    'Render element hit-test coordinates are invalid',
  )
  const x = input.x / input.displayWidth * map.canvas.width
  const y = input.y / input.displayHeight * map.canvas.height
  const matches = map.elements
    .filter((item) => item.frame === input.frame && item.opacity > 0.05 && x >= item.bounds.x && y >= item.bounds.y && x <= item.bounds.x + item.bounds.width && y <= item.bounds.y + item.bounds.height)
    .toSorted((left, right) => right.priority - left.priority || right.zIndex - left.zIndex || left.elementId.localeCompare(right.elementId))
  return Object.freeze({ selected: matches[0] ?? null, chooserRequired: matches.length > 1, candidates: Object.freeze(matches) })
}

export interface PatchOperation {
  op: 'trim' | 'replace-asset' | 'update-text' | 'update-layout' | 'update-subtitle' | 'move'
  targetId: string
  value: unknown
  rangeMs?: readonly [number, number]
}
export interface PatchSet {
  id: string
  baseVersionId: string
  operations: readonly PatchOperation[]
  annotationIds: readonly string[]
  estimatedCost: number
  invalidatedRanges: readonly (readonly [number, number])[]
}
export function proposePatchFromAnnotation(input: {
  annotation: ReviewAnnotation
  baseVersionId: string
  interpretations: readonly PatchOperation[]
  protectedTargetIds: readonly string[]
  policyAllowedOps: readonly PatchOperation['op'][]
  budgetRemaining: number
  estimatedCost: number
}) {
  if (input.interpretations.length !== 1) return Object.freeze({ status: 'ambiguous' as const, patch: null, choices: Object.freeze(input.interpretations) })
  const operation = input.interpretations[0]
  if (input.protectedTargetIds.includes(operation.targetId) || !input.policyAllowedOps.includes(operation.op)) {
    return Object.freeze({ status: 'prohibited' as const, patch: null, choices: Object.freeze([]) })
  }
  if (input.estimatedCost > input.budgetRemaining) return Object.freeze({ status: 'budget-blocked' as const, patch: null, choices: Object.freeze([]) })
  const ranges = operation.rangeMs ? [operation.rangeMs] : [input.annotation.timeRangeMs]
  const patch: PatchSet = Object.freeze({
    id: `patch_${input.annotation.id}`,
    baseVersionId: input.baseVersionId,
    operations: Object.freeze([operation]),
    annotationIds: Object.freeze([input.annotation.id]),
    estimatedCost: input.estimatedCost,
    invalidatedRanges: Object.freeze(ranges),
  })
  return Object.freeze({
    status: 'ready' as const,
    patch,
    choices: Object.freeze([]),
    impact: Object.freeze({ operationCount: 1, cost: input.estimatedCost, invalidatedRanges: ranges }),
  })
}

export function applyPatchAsVersion(input: { patch: PatchSet; currentVersionId: string; renderSucceeded: boolean }) {
  if (input.patch.baseVersionId !== input.currentVersionId) throw new DomainError('VERSION_CONFLICT', 'Patch base version is stale')
  if (!input.renderSucceeded) return Object.freeze({ status: 'render-failed' as const, newVersion: null, comparison: null })
  const hash = createHash('sha256').update(JSON.stringify(input.patch)).digest('hex')
  return Object.freeze({
    status: 'applied' as const,
    newVersion: Object.freeze({ id: `version_${hash.slice(0, 12)}`, parentId: input.currentVersionId, patchId: input.patch.id }),
    comparison: Object.freeze({ beforeVersionId: input.currentVersionId, afterHash: hash }),
  })
}

export function compileBatchReview(input: {
  annotations: readonly ReviewAnnotation[]
  proposals: readonly { annotationId: string; operation: PatchOperation }[]
  baseVersionId: string
  mode?: 'all-or-nothing' | 'partial-retry'
}) {
  const byTarget = new Map<string, PatchOperation>()
  const conflicts: string[] = []
  for (const proposal of input.proposals) {
    const previous = byTarget.get(proposal.operation.targetId)
    if (previous && JSON.stringify(previous) !== JSON.stringify(proposal.operation)) conflicts.push(proposal.annotationId)
    else byTarget.set(proposal.operation.targetId, proposal.operation)
  }
  if (conflicts.length && input.mode !== 'partial-retry') {
    return Object.freeze({
      status: 'conflict' as const,
      patch: null,
      conflicts: Object.freeze(conflicts),
      results: Object.freeze(input.annotations.map((annotation) => ({ annotationId: annotation.id, status: 'rolled-back' }))),
    })
  }
  const accepted = input.proposals.filter((proposal) => !conflicts.includes(proposal.annotationId))
  return Object.freeze({
    status: conflicts.length ? 'partial' as const : 'ready' as const,
    patch: Object.freeze({
      id: `batch_${input.annotations.map((item) => item.id).join('_')}`,
      baseVersionId: input.baseVersionId,
      operations: Object.freeze(accepted.map((item) => item.operation)),
      annotationIds: Object.freeze(accepted.map((item) => item.annotationId)),
      estimatedCost: 0,
      invalidatedRanges: Object.freeze(accepted.flatMap((item) => item.operation.rangeMs ? [item.operation.rangeMs] : [])),
    }),
    conflicts: Object.freeze(conflicts),
    results: Object.freeze(input.annotations.map((annotation) => ({ annotationId: annotation.id, status: conflicts.includes(annotation.id) ? 'retryable' : 'included' }))),
  })
}
