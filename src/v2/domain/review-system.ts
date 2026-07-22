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
  composition?: Readonly<{ foregroundScale: number; verticalPosition: number }>
}): Readonly<RenderElementMap> {
  assertDomain(
    Number.isSafeInteger(input.source.width) && input.source.width > 0 &&
      Number.isSafeInteger(input.source.height) && input.source.height > 0,
    'INVALID_ARGUMENT',
    'RenderElementMap source dimensions are invalid',
  )
  const scale = Math.min(input.canvas.width / input.source.width, input.canvas.height / input.source.height)
  const foregroundScale = input.composition?.foregroundScale ?? 1
  const foregroundWidth = Math.min(input.canvas.width, Math.round(input.source.width * scale * foregroundScale))
  const foregroundHeight = Math.min(input.canvas.height, Math.round(input.source.height * scale * foregroundScale))
  const verticalPosition = input.composition?.verticalPosition ?? 0.5
  const foregroundBounds = Object.freeze({
    x: Math.floor((input.canvas.width - foregroundWidth) / 2),
    y: Math.max(0, Math.min(input.canvas.height - foregroundHeight, Math.round(input.canvas.height * verticalPosition - foregroundHeight / 2))),
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
    const anchor = 'anchor' in cue && typeof cue.anchor === 'string' ? cue.anchor : 'bottom'
    const anchorY = anchor === 'top' ? marginBottom : anchor === 'upper-third' ? Math.round(input.canvas.height * 0.22) : anchor === 'center' ? Math.round(input.canvas.height * 0.42) : anchor === 'lower-third' ? Math.round(input.canvas.height * 0.64) : input.canvas.height - marginBottom - height
    const bounds = Object.freeze({
      x: Math.max(0, Math.floor((input.canvas.width - width) / 2)),
      y: Math.max(0, Math.min(input.canvas.height - height, anchorY)),
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

export const PATCH_OPERATION_KINDS = Object.freeze([
  'trim', 'replace-asset', 'update-text', 'update-layout', 'update-subtitle', 'move',
] as const)
export type PatchOperationKind = (typeof PATCH_OPERATION_KINDS)[number]

export interface PatchOperation {
  op: PatchOperationKind
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
export interface PatchGateResult {
  gate: 'ambiguity' | 'protected-elements' | 'policy' | 'budget'
  passed: boolean
  code?: 'AMBIGUOUS_INTENT' | 'PROTECTED_TARGET' | 'POLICY_DENIED' | 'BUDGET_EXCEEDED'
  message: string
  targetIds: readonly string[]
}

export interface PatchImpact {
  operationCount: number
  cost: number
  invalidatedRanges: readonly (readonly [number, number])[]
  changedTargets: readonly string[]
  expectedScoreDelta: number
  invalidatedArtifacts: readonly string[]
}

function normalizedRange(range: readonly [number, number] | undefined, fallback: readonly [number, number]) {
  const value = range ?? fallback
  assertDomain(
    Number.isSafeInteger(value[0]) && Number.isSafeInteger(value[1]) && value[0] >= 0 && value[1] >= value[0],
    'INVALID_ARGUMENT',
    'Patch operation range is invalid',
  )
  return Object.freeze([value[0], value[1]] as const)
}

function patchValueRecord(value: unknown, operation: PatchOperationKind): Record<string, unknown> {
  assertDomain(typeof value === 'object' && value !== null && !Array.isArray(value), 'INVALID_ARGUMENT', `${operation} value must be an object`)
  return value as Record<string, unknown>
}

export function validatePatchOperation(operation: PatchOperation): Readonly<PatchOperation> {
  assertDomain(PATCH_OPERATION_KINDS.includes(operation.op), 'INVALID_ARGUMENT', 'Patch operation is not allowlisted')
  const targetId = operation.targetId.trim()
  assertDomain(targetId.length >= 3 && targetId.length <= 160, 'INVALID_ARGUMENT', 'Patch target is invalid')
  const value = patchValueRecord(operation.value, operation.op)
  const allowedKeys: Readonly<Record<PatchOperationKind, readonly string[]>> = Object.freeze({
    trim: ['mode'],
    'replace-asset': ['assetId'],
    'update-text': ['text'],
    'update-layout': ['anchor', 'verticalPosition', 'foregroundScale', 'faceProtection'],
    'update-subtitle': ['text', 'anchor', 'presetId'],
    move: ['beforeTargetId', 'afterTargetId'],
  })
  assertDomain(Object.keys(value).length > 0 && Object.keys(value).every((key) => allowedKeys[operation.op].includes(key)), 'INVALID_ARGUMENT', `${operation.op} value contains an unsupported field`)
  if (operation.op === 'trim') {
    assertDomain(value.mode === 'remove-range' && Boolean(operation.rangeMs) && operation.rangeMs![1] > operation.rangeMs![0], 'INVALID_ARGUMENT', 'trim requires a non-empty remove-range')
  }
  if (operation.op === 'replace-asset') assertDomain(typeof value.assetId === 'string' && value.assetId.trim().length >= 3, 'INVALID_ARGUMENT', 'replace-asset requires assetId')
  if (operation.op === 'update-text') assertDomain(typeof value.text === 'string' && value.text.trim().length > 0 && value.text.trim().length <= 500, 'INVALID_ARGUMENT', 'update-text requires bounded text')
  if (operation.op === 'update-layout') {
    if (value.anchor !== undefined) assertDomain(['top', 'upper-third', 'center', 'lower-third', 'bottom'].includes(value.anchor as string), 'INVALID_ARGUMENT', 'update-layout anchor is invalid')
    if (value.verticalPosition !== undefined) assertDomain(typeof value.verticalPosition === 'number' && value.verticalPosition >= 0.1 && value.verticalPosition <= 0.9, 'INVALID_ARGUMENT', 'update-layout verticalPosition is invalid')
    if (value.foregroundScale !== undefined) assertDomain(typeof value.foregroundScale === 'number' && value.foregroundScale >= 0.5 && value.foregroundScale <= 1.5, 'INVALID_ARGUMENT', 'update-layout foregroundScale is invalid')
    if (value.faceProtection !== undefined) assertDomain(value.faceProtection === true, 'INVALID_ARGUMENT', 'Subtitle face protection cannot be disabled by review patch')
  }
  if (operation.op === 'update-subtitle') {
    if (value.text !== undefined) assertDomain(typeof value.text === 'string' && value.text.trim().length > 0 && value.text.trim().length <= 96, 'INVALID_ARGUMENT', 'update-subtitle text is invalid')
    if (value.anchor !== undefined) assertDomain(['top', 'upper-third', 'center', 'lower-third', 'bottom'].includes(value.anchor as string), 'INVALID_ARGUMENT', 'update-subtitle anchor is invalid')
    if (value.presetId !== undefined) assertDomain(['kinetic', 'karaoke-box', 'karaoke-pill', 'caps-stroke', 'clean-color'].includes(value.presetId as string), 'INVALID_ARGUMENT', 'update-subtitle preset is invalid')
  }
  if (operation.op === 'move') {
    const before = typeof value.beforeTargetId === 'string' ? value.beforeTargetId.trim() : ''
    const after = typeof value.afterTargetId === 'string' ? value.afterTargetId.trim() : ''
    assertDomain(Boolean(before) !== Boolean(after), 'INVALID_ARGUMENT', 'move requires exactly one beforeTargetId or afterTargetId')
  }
  return Object.freeze({ ...operation, targetId, value: Object.freeze({ ...value }), ...(operation.rangeMs ? { rangeMs: normalizedRange(operation.rangeMs, operation.rangeMs) } : {}) })
}

function quotedText(value: string): string | undefined {
  return value.match(/["“](.+?)["”]/)?.[1]?.trim() || value.match(/'(.+?)'/)?.[1]?.trim()
}

function choice(operation: PatchOperation, index: number) {
  const normalized = validatePatchOperation(operation)
  return Object.freeze({ ...normalized, choiceId: `choice-${index + 1}-${normalized.op}` })
}

export function interpretReviewAnnotation(annotation: ReviewAnnotation): readonly Readonly<PatchOperation & { choiceId: string }>[] {
  const text = annotation.text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  const targetId = annotation.targetIds[0] ?? annotation.applicationScope.targetIds[0] ?? `frame:${annotation.frame}`
  const quoted = quotedText(annotation.text)
  const interpretations: PatchOperation[] = []
  if (/\b(cort|remov|retir|exclu|encurt)/.test(text)) {
    interpretations.push({ op: 'trim', targetId, value: { mode: 'remove-range' }, rangeMs: annotation.timeRangeMs })
  } else if (/\b(troc|substitu).*(asset|imagem|video|b-roll|broll)/.test(text) && quoted) {
    interpretations.push({ op: 'replace-asset', targetId, value: { assetId: quoted } })
  } else if (/\b(mov|reposicion|reorden).*(antes|depois)/.test(text) && quoted) {
    interpretations.push(/antes/.test(text)
      ? { op: 'move', targetId, value: { beforeTargetId: quoted } }
      : { op: 'move', targetId, value: { afterTargetId: quoted } })
  } else if (/legenda|subtitle/.test(text) && /baixo|inferior|acima|cima|centro|posi|rosto|face/.test(text)) {
    const anchor = /acima|cima|superior/.test(text) ? 'upper-third' : /centro/.test(text) ? 'center' : 'bottom'
    interpretations.push({ op: 'update-layout', targetId, value: { anchor, faceProtection: true }, rangeMs: annotation.timeRangeMs })
  } else if (/legenda|subtitle/.test(text) && quoted) {
    interpretations.push({ op: 'update-subtitle', targetId, value: { text: quoted }, rangeMs: annotation.timeRangeMs })
  } else if (/\b(texto|copy|cta|titulo)\b/.test(text) && quoted) {
    interpretations.push({ op: 'update-text', targetId, value: { text: quoted }, rangeMs: annotation.timeRangeMs })
  } else if (/enquadr|layout|escala|zoom|posi/.test(text)) {
    interpretations.push({ op: 'update-layout', targetId, value: { verticalPosition: 0.5 }, rangeMs: annotation.timeRangeMs })
  } else {
    interpretations.push(
      { op: 'update-layout', targetId, value: { verticalPosition: 0.5 }, rangeMs: annotation.timeRangeMs },
      { op: 'update-text', targetId, value: { text: annotation.text.trim().slice(0, 500) }, rangeMs: annotation.timeRangeMs },
    )
  }
  return Object.freeze(interpretations.map(choice))
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
  const operations = input.interpretations.map(validatePatchOperation)
  const ambiguityGate: PatchGateResult = Object.freeze({
    gate: 'ambiguity', passed: operations.length === 1,
    ...(operations.length === 1 ? {} : { code: 'AMBIGUOUS_INTENT' as const }),
    message: operations.length === 1 ? 'Uma interpretação tipada foi resolvida.' : 'Escolha uma das interpretações antes de aplicar.',
    targetIds: Object.freeze([...new Set(operations.map((item) => item.targetId))]),
  })
  const operation = operations[0]
  const protectedTargets = operation && input.protectedTargetIds.includes(operation.targetId) ? [operation.targetId] : []
  const protectedGate: PatchGateResult = Object.freeze({ gate: 'protected-elements', passed: protectedTargets.length === 0, ...(protectedTargets.length ? { code: 'PROTECTED_TARGET' as const } : {}), message: protectedTargets.length ? 'O alvo está protegido nesta versão.' : 'Nenhum alvo protegido será alterado.', targetIds: Object.freeze(protectedTargets) })
  const policyPassed = Boolean(operation && input.policyAllowedOps.includes(operation.op))
  const policyGate: PatchGateResult = Object.freeze({ gate: 'policy', passed: policyPassed, ...(!policyPassed ? { code: 'POLICY_DENIED' as const } : {}), message: policyPassed ? 'A operação é permitida pela policy ativa.' : 'A operação não é permitida pela policy ativa.', targetIds: Object.freeze(operation ? [operation.targetId] : []) })
  const budgetPassed = input.estimatedCost <= input.budgetRemaining
  const budgetGate: PatchGateResult = Object.freeze({ gate: 'budget', passed: budgetPassed, ...(!budgetPassed ? { code: 'BUDGET_EXCEEDED' as const } : {}), message: budgetPassed ? 'O custo estimado cabe no budget restante.' : 'O custo estimado excede o budget restante.', targetIds: Object.freeze(operation ? [operation.targetId] : []) })
  const gates = Object.freeze([ambiguityGate, protectedGate, policyGate, budgetGate])
  if (!ambiguityGate.passed) return Object.freeze({ status: 'ambiguous' as const, patch: null, choices: Object.freeze(operations), gates })
  if (!protectedGate.passed || !policyGate.passed) return Object.freeze({ status: 'prohibited' as const, patch: null, choices: Object.freeze([]), gates })
  if (!budgetGate.passed) return Object.freeze({ status: 'budget-blocked' as const, patch: null, choices: Object.freeze([]), gates })
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
    gates,
    impact: Object.freeze({
      operationCount: 1,
      cost: input.estimatedCost,
      invalidatedRanges: Object.freeze(ranges),
      changedTargets: Object.freeze([operation.targetId]),
      expectedScoreDelta: operation.op === 'update-layout' || operation.op === 'update-subtitle' ? 3 : 2,
      invalidatedArtifacts: Object.freeze(['proxy', 'final']),
    }) satisfies PatchImpact,
  })
}

type MutableRecord = Record<string, unknown>

function asMutableRecord(value: unknown, field: string): MutableRecord {
  assertDomain(typeof value === 'object' && value !== null && !Array.isArray(value), 'INVALID_ARGUMENT', `${field} must be an object`)
  return value as MutableRecord
}

function asMutableRecords(value: unknown, field: string): MutableRecord[] {
  assertDomain(Array.isArray(value) && value.every((item) => typeof item === 'object' && item !== null && !Array.isArray(item)), 'INVALID_ARGUMENT', `${field} must be an object array`)
  return value as MutableRecord[]
}

function unprefixTarget(targetId: string): string {
  return targetId.replace(/^(?:subtitle|presenter|background|scene|clip):/, '')
}

function retimeClips(clips: MutableRecord[]): void {
  let cursor = 0
  for (const clip of clips) {
    const sourceIn = Number(clip.sourceInFrame)
    const sourceOut = Number(clip.sourceOutFrame)
    assertDomain(Number.isSafeInteger(sourceIn) && Number.isSafeInteger(sourceOut) && sourceOut > sourceIn, 'INVALID_ARGUMENT', 'Patched clip timing is invalid')
    clip.timelineInFrame = cursor
    cursor += sourceOut - sourceIn
    clip.timelineOutFrame = cursor
  }
}

function timelineCues(plan: MutableRecord): MutableRecord[] {
  return asMutableRecords(plan.subtitleTracks ?? [], 'EditPlan.subtitleTracks')
    .flatMap((track) => asMutableRecords(track.cues ?? [], 'EditPlan subtitle cues'))
}

function findCue(plan: MutableRecord, targetId: string): { track: MutableRecord; cue?: MutableRecord } | undefined {
  const target = unprefixTarget(targetId)
  for (const track of asMutableRecords(plan.subtitleTracks ?? [], 'EditPlan.subtitleTracks')) {
    if (track.id === targetId || track.id === target) return { track }
    const cue = asMutableRecords(track.cues ?? [], 'EditPlan subtitle cues').find((candidate) => candidate.id === target)
    if (cue) return { track, cue }
  }
  return undefined
}

function applyTrim(plan: MutableRecord, operation: Readonly<PatchOperation>): void {
  const fps = Number(plan.fps)
  assertDomain(Number.isFinite(fps) && fps > 0 && operation.rangeMs, 'INVALID_ARGUMENT', 'Trim requires EditPlan fps and range')
  const startFrame = Math.floor(operation.rangeMs[0] / 1000 * fps)
  const endFrame = Math.ceil(operation.rangeMs[1] / 1000 * fps)
  assertDomain(endFrame > startFrame, 'INVALID_ARGUMENT', 'Trim range is empty')
  const videoTrack = asMutableRecords(plan.videoTracks, 'EditPlan.videoTracks').find((track) => track.kind === 'base-video')
  assertDomain(Boolean(videoTrack), 'INVALID_ARGUMENT', 'Trim requires a base-video track')
  const originalClips = asMutableRecords(videoTrack!.clips, 'EditPlan clips')
  const target = unprefixTarget(operation.targetId)
  const targetIsTimeline = /^(?:frame|range|project|scene):/.test(operation.targetId)
  let affected = false
  const nextClips: MutableRecord[] = []
  for (const clip of originalClips) {
    const clipId = String(clip.id)
    const timelineIn = Number(clip.timelineInFrame)
    const timelineOut = Number(clip.timelineOutFrame)
    const eligible = targetIsTimeline || clipId === target
    const overlapStart = Math.max(startFrame, timelineIn)
    const overlapEnd = Math.min(endFrame, timelineOut)
    if (!eligible || overlapEnd <= overlapStart) {
      nextClips.push(clip)
      continue
    }
    affected = true
    const sourceIn = Number(clip.sourceInFrame)
    if (overlapStart > timelineIn) nextClips.push({ ...clip, id: overlapEnd < timelineOut ? `${clipId}-before-${startFrame}` : clipId, sourceOutFrame: sourceIn + overlapStart - timelineIn })
    if (overlapEnd < timelineOut) nextClips.push({ ...clip, id: overlapStart > timelineIn ? `${clipId}-after-${endFrame}` : clipId, sourceInFrame: sourceIn + overlapEnd - timelineIn })
  }
  assertDomain(affected && nextClips.length > 0, 'INVALID_ARGUMENT', 'Trim target does not overlap a retained clip')
  retimeClips(nextClips)
  videoTrack!.clips = nextClips
  const removed = endFrame - startFrame
  for (const track of asMutableRecords(plan.subtitleTracks ?? [], 'EditPlan.subtitleTracks')) {
    const nextCues = asMutableRecords(track.cues ?? [], 'EditPlan subtitle cues').flatMap((cue) => {
      const cueStart = Number(cue.startFrame)
      const cueEnd = Number(cue.endFrame)
      if (cueEnd <= startFrame) return [cue]
      if (cueStart >= endFrame) return [{ ...cue, startFrame: cueStart - removed, endFrame: cueEnd - removed }]
      const retainedStart = Math.min(cueStart, startFrame)
      const retainedEnd = Math.max(startFrame, cueEnd - removed)
      return retainedEnd > retainedStart ? [{ ...cue, startFrame: retainedStart, endFrame: retainedEnd }] : []
    })
    track.cues = nextCues
  }
  plan.durationFrames = nextClips.reduce((total, clip) => total + Number(clip.sourceOutFrame) - Number(clip.sourceInFrame), 0)
  if (Array.isArray(plan.transitions)) {
    const ids = new Set(nextClips.map((clip) => String(clip.id)))
    plan.transitions = (plan.transitions as MutableRecord[]).filter((transition) => ids.has(String(transition.fromClipId)) && ids.has(String(transition.toClipId)))
  }
}

function applyMove(plan: MutableRecord, operation: Readonly<PatchOperation>): void {
  const videoTrack = asMutableRecords(plan.videoTracks, 'EditPlan.videoTracks').find((track) => track.kind === 'base-video')
  assertDomain(Boolean(videoTrack), 'INVALID_ARGUMENT', 'Move requires a base-video track')
  const clips = asMutableRecords(videoTrack!.clips, 'EditPlan clips')
  const target = unprefixTarget(operation.targetId)
  const index = clips.findIndex((clip) => clip.id === target)
  assertDomain(index >= 0, 'INVALID_ARGUMENT', 'Move target clip was not found')
  const value = asMutableRecord(operation.value, 'move value')
  const referenceId = unprefixTarget(String(value.beforeTargetId ?? value.afterTargetId))
  const reference = clips.findIndex((clip) => clip.id === referenceId)
  assertDomain(reference >= 0 && reference !== index, 'INVALID_ARGUMENT', 'Move reference clip was not found')
  const cueAssignments = new Map<string, MutableRecord[]>()
  for (const clip of clips) cueAssignments.set(String(clip.id), timelineCues(plan).filter((cue) => Number(cue.startFrame) >= Number(clip.timelineInFrame) && Number(cue.startFrame) < Number(clip.timelineOutFrame)).map((cue) => ({ ...cue, __offset: Number(cue.startFrame) - Number(clip.timelineInFrame), __duration: Number(cue.endFrame) - Number(cue.startFrame) })))
  const [moved] = clips.splice(index, 1)
  const updatedReference = clips.findIndex((clip) => clip.id === referenceId)
  clips.splice(value.beforeTargetId ? updatedReference : updatedReference + 1, 0, moved!)
  retimeClips(clips)
  videoTrack!.clips = clips
  const reorderedCues = clips.flatMap((clip) => (cueAssignments.get(String(clip.id)) ?? []).map((cue) => {
    const { __offset, __duration, ...rest } = cue
    return { ...rest, startFrame: Number(clip.timelineInFrame) + Number(__offset), endFrame: Number(clip.timelineInFrame) + Number(__offset) + Number(__duration) }
  }))
  const firstTrack = asMutableRecords(plan.subtitleTracks ?? [], 'EditPlan.subtitleTracks')[0]
  if (firstTrack) firstTrack.cues = reorderedCues
  if (Array.isArray(plan.transitions)) plan.transitions = []
}

export function materializePatchEditPlan(input: {
  editPlan: Readonly<Record<string, unknown>>
  patch: Readonly<PatchSet>
  newVersionId: string
  createdAt: string
  availableAssetIds?: readonly string[]
}): Readonly<Record<string, unknown>> {
  const plan = structuredClone(input.editPlan) as MutableRecord
  assertDomain(plan.schemaVersion === 2 && plan.state === 'compiled', 'INVALID_ARGUMENT', 'Patch requires a compiled EditPlan v2')
  for (const rawOperation of input.patch.operations) {
    const operation = validatePatchOperation(rawOperation)
    const value = asMutableRecord(operation.value, `${operation.op} value`)
    if (operation.op === 'trim') applyTrim(plan, operation)
    else if (operation.op === 'move') applyMove(plan, operation)
    else if (operation.op === 'replace-asset') {
      const assetId = String(value.assetId)
      assertDomain(input.availableAssetIds?.includes(assetId), 'INVALID_ARGUMENT', 'Replacement asset is not available in this project')
      const clips = asMutableRecords(plan.videoTracks, 'EditPlan.videoTracks').flatMap((track) => asMutableRecords(track.clips ?? [], 'EditPlan clips'))
      const clip = clips.find((candidate) => candidate.id === unprefixTarget(operation.targetId))
      assertDomain(Boolean(clip), 'INVALID_ARGUMENT', 'Replacement target clip was not found')
      clip!.sourceArtifactId = assetId
    } else if (operation.op === 'update-text' || operation.op === 'update-subtitle') {
      const match = findCue(plan, operation.targetId)
      assertDomain(Boolean(match), 'INVALID_ARGUMENT', 'Subtitle target was not found')
      if (value.text !== undefined) {
        assertDomain(Boolean(match!.cue), 'INVALID_ARGUMENT', 'Subtitle text patch must target one cue')
        match!.cue!.text = String(value.text).trim()
      }
      if (value.anchor !== undefined) {
        if (match!.cue) match!.cue.anchor = value.anchor
        else match!.track.anchor = value.anchor
      }
      if (value.presetId !== undefined) match!.track.presetId = value.presetId
    } else if (operation.op === 'update-layout') {
      const subtitle = findCue(plan, operation.targetId)
      if (subtitle) {
        if (value.anchor !== undefined) {
          if (subtitle.cue) subtitle.cue.anchor = value.anchor
          else subtitle.track.anchor = value.anchor
        }
        if (value.faceProtection === true) subtitle.track.faceProtection = true
      } else {
        const composition = asMutableRecord(plan.composition, 'EditPlan composition')
        if (value.verticalPosition !== undefined) composition.verticalPosition = value.verticalPosition
        if (value.foregroundScale !== undefined) composition.foregroundScale = value.foregroundScale
      }
    }
  }
  plan.id = `edit-plan-${input.newVersionId}`
  plan.projectVersionId = input.newVersionId
  plan.createdAt = input.createdAt
  plan.reviewPatch = Object.freeze({ patchId: input.patch.id, baseVersionId: input.patch.baseVersionId, annotationIds: Object.freeze([...input.patch.annotationIds]) })
  return Object.freeze(plan)
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
