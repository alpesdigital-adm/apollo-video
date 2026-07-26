import { createHash } from 'node:crypto'

import { stableSerialize } from './canonical-hash.ts'
import { assertDomain, DomainError } from './errors.ts'

export interface ManualInspectorPatch {
  layout?: string
  text?: string
  subtitle?: string
  color?: string
  motion?: string
  audioGain?: number
}

export interface TimelineClip {
  id: string
  sourceId: string
  startMs: number
  endMs: number
  track: number
  selected: boolean
  inspector: ManualInspectorPatch
}

export interface TimelineViewModel {
  versionId: string
  revision: number
  clips: readonly Readonly<TimelineClip>[]
  snapPointsMs: readonly number[]
}

export type ManualGesture =
  | { kind: 'select'; clipId: string }
  | { kind: 'trim'; clipId: string; edge: 'start' | 'end'; atMs: number }
  | { kind: 'split'; clipId: string; atMs: number }
  | { kind: 'move'; clipId: string; startMs: number; track: number }
  | { kind: 'replace'; clipId: string; sourceId: string }
  | { kind: 'inspect'; clipId: string; patch: ManualInspectorPatch }

export interface ManualEditCommand {
  id: string
  scope: { projectId: string; variantId: string; targetId: string }
  baseVersionId: string
  expectedRevision: number
  operation: ManualGesture
  createdBy: string
}

export type ManualVersionAction = 'apply' | 'undo' | 'redo' | 'restore'

export interface PersistedManualEditPayload {
  schemaVersion: 1
  action: ManualVersionAction
  expectedRevision: number
  variantId: string
  targetId: string
  operation?: ManualGesture
  restoresVersionId?: string
}

type MutableRecord = Record<string, unknown>

function asRecord(value: unknown, field: string): MutableRecord {
  assertDomain(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'INVALID_ARGUMENT',
    `${field} must be an object`,
  )
  return value as MutableRecord
}

function asRecords(value: unknown, field: string): MutableRecord[] {
  assertDomain(
    Array.isArray(value) &&
      value.every((item) => typeof item === 'object' && item !== null && !Array.isArray(item)),
    'INVALID_ARGUMENT',
    `${field} must be an object array`,
  )
  return value as MutableRecord[]
}

function finiteNonNegative(value: number, field: string): void {
  assertDomain(Number.isFinite(value) && value >= 0, 'INVALID_ARGUMENT', `${field} is invalid`)
}

function validateInspectorPatch(patch: ManualInspectorPatch): void {
  const keys = Object.keys(patch)
  assertDomain(
    keys.length > 0 &&
      keys.every((key) => ['layout', 'text', 'subtitle', 'color', 'motion', 'audioGain'].includes(key)),
    'INVALID_ARGUMENT',
    'Inspector patch is empty or contains unsupported fields',
  )
  for (const field of ['layout', 'text', 'subtitle', 'color', 'motion'] as const) {
    const value = patch[field]
    if (value !== undefined) {
      assertDomain(
        typeof value === 'string' && value.trim().length > 0 && value.length <= 500,
        'INVALID_ARGUMENT',
        `Inspector ${field} is invalid`,
      )
    }
  }
  if (patch.audioGain !== undefined) {
    assertDomain(
      Number.isFinite(patch.audioGain) && patch.audioGain >= 0 && patch.audioGain <= 4,
      'INVALID_ARGUMENT',
      'Inspector audioGain must be between 0 and 4',
    )
  }
}

export function validateManualGesture(gesture: ManualGesture): Readonly<ManualGesture> {
  assertDomain(
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(gesture.clipId),
    'INVALID_ARGUMENT',
    'Manual gesture clipId is invalid',
  )
  if (gesture.kind === 'trim') {
    finiteNonNegative(gesture.atMs, 'Trim position')
    assertDomain(['start', 'end'].includes(gesture.edge), 'INVALID_ARGUMENT', 'Trim edge is invalid')
  } else if (gesture.kind === 'split') {
    finiteNonNegative(gesture.atMs, 'Split position')
  } else if (gesture.kind === 'move') {
    finiteNonNegative(gesture.startMs, 'Move position')
    assertDomain(
      Number.isInteger(gesture.track) && gesture.track >= 0 && gesture.track <= 63,
      'INVALID_ARGUMENT',
      'Move track is invalid',
    )
  } else if (gesture.kind === 'replace') {
    assertDomain(
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(gesture.sourceId),
      'INVALID_ARGUMENT',
      'Replacement sourceId is invalid',
    )
  } else if (gesture.kind === 'inspect') {
    validateInspectorPatch(gesture.patch)
  }
  return Object.freeze(structuredClone(gesture))
}

export function snapTimelineMs(
  value: number,
  points: readonly number[],
  thresholdMs = 120,
): number {
  finiteNonNegative(value, 'Timeline position')
  assertDomain(
    Number.isFinite(thresholdMs) && thresholdMs >= 0 && thresholdMs <= 1000,
    'INVALID_ARGUMENT',
    'Snap threshold is invalid',
  )
  const candidates = points.filter((point) => Math.abs(point - value) <= thresholdMs)
  if (candidates.length === 0) return value
  return candidates.reduce((best, point) =>
    Math.abs(point - value) < Math.abs(best - value) ? point : best)
}

export function gestureToCommand(input: {
  gesture: ManualGesture
  model: TimelineViewModel
  projectId: string
  variantId: string
  actor: string
}): Readonly<ManualEditCommand> {
  const operation = validateManualGesture(input.gesture)
  for (const [field, value] of Object.entries({
    projectId: input.projectId,
    variantId: input.variantId,
    actor: input.actor,
    versionId: input.model.versionId,
  })) {
    assertDomain(value.trim().length > 0, 'INVALID_ARGUMENT', `${field} is required`)
  }
  assertDomain(
    Number.isInteger(input.model.revision) && input.model.revision >= 1,
    'INVALID_ARGUMENT',
    'Timeline revision is invalid',
  )
  return Object.freeze({
    id: `cmd_${createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 12)}`,
    scope: Object.freeze({
      projectId: input.projectId,
      variantId: input.variantId,
      targetId: operation.clipId,
    }),
    baseVersionId: input.model.versionId,
    expectedRevision: input.model.revision,
    operation,
    createdBy: input.actor,
  })
}

function freezeTimeline(model: TimelineViewModel): Readonly<TimelineViewModel> {
  return Object.freeze({
    ...model,
    clips: Object.freeze(model.clips.map((clip) => Object.freeze({
      ...clip,
      inspector: Object.freeze({ ...clip.inspector }),
    }))),
    snapPointsMs: Object.freeze([...model.snapPointsMs]),
  })
}

export function applyManualEdit(
  model: TimelineViewModel,
  command: ManualEditCommand,
): Readonly<TimelineViewModel> {
  if (
    command.baseVersionId !== model.versionId ||
    command.expectedRevision !== model.revision
  ) {
    throw new DomainError('VERSION_CONFLICT', 'Manual edit base is stale')
  }
  const operation = validateManualGesture(command.operation)
  const clips = model.clips.map((item) => ({
    ...item,
    inspector: { ...item.inspector },
  }))
  const index = clips.findIndex((item) => item.id === operation.clipId)
  if (index < 0) throw new DomainError('INVALID_ARGUMENT', 'Timeline clip not found')
  const clip = clips[index]!
  if (operation.kind === 'select') {
    clips.forEach((item) => { item.selected = item.id === clip.id })
  } else if (operation.kind === 'trim') {
    const atMs = snapTimelineMs(operation.atMs, model.snapPointsMs)
    if (operation.edge === 'start') clip.startMs = atMs
    else clip.endMs = atMs
    assertDomain(clip.endMs > clip.startMs, 'INVALID_ARGUMENT', 'Trim must keep positive duration')
  } else if (operation.kind === 'split') {
    const atMs = snapTimelineMs(operation.atMs, model.snapPointsMs)
    assertDomain(
      atMs > clip.startMs && atMs < clip.endMs,
      'INVALID_ARGUMENT',
      'Split must be inside clip',
    )
    clips.splice(
      index,
      1,
      { ...clip, id: `${clip.id}:a`, endMs: atMs },
      { ...clip, id: `${clip.id}:b`, startMs: atMs, selected: false },
    )
  } else if (operation.kind === 'move') {
    const duration = clip.endMs - clip.startMs
    clip.startMs = snapTimelineMs(operation.startMs, model.snapPointsMs)
    clip.endMs = clip.startMs + duration
    clip.track = operation.track
  } else if (operation.kind === 'replace') {
    clip.sourceId = operation.sourceId
  } else if (operation.kind === 'inspect') {
    clip.inspector = { ...clip.inspector, ...operation.patch }
  }
  return freezeTimeline({
    versionId: `${model.versionId}:next:${command.id}`,
    revision: model.revision + 1,
    clips,
    snapPointsMs: model.snapPointsMs,
  })
}

function timelineTracks(plan: MutableRecord): MutableRecord[] {
  return asRecords(plan.videoTracks, 'EditPlan.videoTracks')
}

function clipDurationFrames(clip: MutableRecord): number {
  const sourceIn = Number(clip.sourceInFrame)
  const sourceOut = Number(clip.sourceOutFrame)
  assertDomain(
    Number.isSafeInteger(sourceIn) && Number.isSafeInteger(sourceOut) && sourceOut > sourceIn,
    'INVALID_ARGUMENT',
    'Manual edit clip source range is invalid',
  )
  return sourceOut - sourceIn
}

function retimeTrack(track: MutableRecord): number {
  let cursor = 0
  for (const clip of asRecords(track.clips, 'EditPlan track clips')) {
    clip.timelineInFrame = cursor
    cursor += clipDurationFrames(clip)
    clip.timelineOutFrame = cursor
  }
  return cursor
}

function findClip(plan: MutableRecord, clipId: string) {
  const tracks = timelineTracks(plan)
  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex += 1) {
    const clips = asRecords(tracks[trackIndex]!.clips, 'EditPlan track clips')
    const clipIndex = clips.findIndex((clip) => clip.id === clipId)
    if (clipIndex >= 0) {
      return { tracks, track: tracks[trackIndex]!, trackIndex, clips, clipIndex, clip: clips[clipIndex]! }
    }
  }
  throw new DomainError('INVALID_ARGUMENT', 'Manual edit target clip was not found')
}

function snapPointsFromPlan(plan: MutableRecord, fps: number): readonly number[] {
  const points = new Set<number>([0])
  for (const track of timelineTracks(plan)) {
    for (const clip of asRecords(track.clips, 'EditPlan track clips')) {
      points.add(Number(clip.timelineInFrame) / fps * 1000)
      points.add(Number(clip.timelineOutFrame) / fps * 1000)
    }
  }
  for (const track of asRecords(plan.subtitleTracks ?? [], 'EditPlan.subtitleTracks')) {
    for (const cue of asRecords(track.cues ?? [], 'EditPlan subtitle cues')) {
      points.add(Number(cue.startFrame) / fps * 1000)
      points.add(Number(cue.endFrame) / fps * 1000)
    }
  }
  return Object.freeze([...points].filter(Number.isFinite).toSorted((left, right) => left - right))
}

function applyInspectorToPlan(
  plan: MutableRecord,
  clip: MutableRecord,
  patch: ManualInspectorPatch,
): void {
  const inspector = typeof clip.manualInspector === 'object' && clip.manualInspector !== null
    ? asRecord(clip.manualInspector, 'Clip manual inspector')
    : {}
  clip.manualInspector = { ...inspector, ...patch }
  if (patch.layout !== undefined) {
    const composition = typeof plan.composition === 'object' && plan.composition !== null
      ? asRecord(plan.composition, 'EditPlan composition')
      : {}
    plan.composition = { ...composition, manualLayout: patch.layout }
  }
  const clipStart = Number(clip.timelineInFrame)
  const clipEnd = Number(clip.timelineOutFrame)
  const subtitleTracks = asRecords(plan.subtitleTracks ?? [], 'EditPlan.subtitleTracks')
  const overlappingCues = subtitleTracks.flatMap((track) =>
    asRecords(track.cues ?? [], 'EditPlan subtitle cues').filter((cue) =>
      Number(cue.startFrame) < clipEnd && Number(cue.endFrame) > clipStart))
  if (patch.text !== undefined) {
    assertDomain(overlappingCues.length > 0, 'INVALID_ARGUMENT', 'Text inspector requires a subtitle cue overlapping the clip')
    overlappingCues[0]!.text = patch.text.trim()
  }
  if (patch.subtitle !== undefined) {
    assertDomain(subtitleTracks.length > 0, 'INVALID_ARGUMENT', 'Subtitle inspector requires a subtitle track')
    subtitleTracks[0]!.presetId = patch.subtitle.trim()
  }
}

export function timelineViewModelFromEditPlan(input: {
  editPlan: Readonly<Record<string, unknown>>
  versionId: string
  revision: number
  selectedClipId?: string
}): Readonly<TimelineViewModel> {
  const plan = structuredClone(input.editPlan) as MutableRecord
  assertDomain(
    plan.schemaVersion === 2 && plan.state === 'compiled',
    'PRECONDITION_REQUIRED',
    'Manual editing requires a compiled EditPlan v2',
  )
  const fps = Number(plan.fps)
  assertDomain(Number.isFinite(fps) && fps > 0, 'INVALID_ARGUMENT', 'EditPlan fps is invalid')
  const clips = timelineTracks(plan).flatMap((track, trackIndex) =>
    asRecords(track.clips, 'EditPlan track clips').map((clip) => {
      const inspector = typeof clip.manualInspector === 'object' && clip.manualInspector !== null
        ? asRecord(clip.manualInspector, 'Clip manual inspector') as ManualInspectorPatch
        : {}
      return Object.freeze({
        id: String(clip.id),
        sourceId: String(clip.sourceArtifactId),
        startMs: Number(clip.timelineInFrame) / fps * 1000,
        endMs: Number(clip.timelineOutFrame) / fps * 1000,
        track: trackIndex,
        selected: clip.id === input.selectedClipId,
        inspector: Object.freeze({ ...inspector }),
      })
    }))
  return freezeTimeline({
    versionId: input.versionId,
    revision: input.revision,
    clips,
    snapPointsMs: snapPointsFromPlan(plan, fps),
  })
}

export function materializeManualEditPlan(input: {
  editPlan: Readonly<Record<string, unknown>>
  operation: ManualGesture
  newVersionId: string
  createdAt: string
  availableAssetIds: readonly string[]
  variantId: string
}): Readonly<Record<string, unknown>> {
  const operation = validateManualGesture(input.operation)
  const plan = structuredClone(input.editPlan) as MutableRecord
  assertDomain(
    plan.schemaVersion === 2 && plan.state === 'compiled',
    'PRECONDITION_REQUIRED',
    'Manual editing requires a compiled EditPlan v2',
  )
  const fps = Number(plan.fps)
  assertDomain(Number.isFinite(fps) && fps > 0, 'INVALID_ARGUMENT', 'EditPlan fps is invalid')
  const located = findClip(plan, operation.clipId)
  const points = snapPointsFromPlan(plan, fps)
  if (operation.kind === 'select') {
    // Selection is preserved in the immutable editing audit without changing render semantics.
  } else if (operation.kind === 'trim') {
    const frame = Math.round(snapTimelineMs(operation.atMs, points) / 1000 * fps)
    const timelineIn = Number(located.clip.timelineInFrame)
    const timelineOut = Number(located.clip.timelineOutFrame)
    assertDomain(frame > timelineIn && frame < timelineOut, 'INVALID_ARGUMENT', 'Trim must remain inside the clip')
    if (operation.edge === 'start') {
      located.clip.sourceInFrame = Number(located.clip.sourceInFrame) + frame - timelineIn
    } else {
      located.clip.sourceOutFrame = Number(located.clip.sourceOutFrame) - (timelineOut - frame)
    }
  } else if (operation.kind === 'split') {
    const frame = Math.round(snapTimelineMs(operation.atMs, points) / 1000 * fps)
    const timelineIn = Number(located.clip.timelineInFrame)
    const timelineOut = Number(located.clip.timelineOutFrame)
    assertDomain(frame > timelineIn && frame < timelineOut, 'INVALID_ARGUMENT', 'Split must be inside the clip')
    const sourceFrame = Number(located.clip.sourceInFrame) + frame - timelineIn
    located.clips.splice(
      located.clipIndex,
      1,
      { ...located.clip, id: `${located.clip.id}:a`, sourceOutFrame: sourceFrame },
      { ...located.clip, id: `${located.clip.id}:b`, sourceInFrame: sourceFrame },
    )
  } else if (operation.kind === 'move') {
    assertDomain(
      operation.track < located.tracks.length,
      'INVALID_ARGUMENT',
      'Move target track does not exist',
    )
    const [moving] = located.clips.splice(located.clipIndex, 1)
    const targetTrack = located.tracks[operation.track]!
    const targetClips = asRecords(targetTrack.clips, 'EditPlan target track clips')
    const desiredFrame = Math.round(snapTimelineMs(operation.startMs, points) / 1000 * fps)
    const insertAt = targetClips.findIndex((clip) => Number(clip.timelineInFrame) >= desiredFrame)
    targetClips.splice(insertAt < 0 ? targetClips.length : insertAt, 0, moving!)
    targetTrack.clips = targetClips
  } else if (operation.kind === 'replace') {
    assertDomain(
      input.availableAssetIds.includes(operation.sourceId),
      'INVALID_ARGUMENT',
      'Replacement source is not available in this project',
    )
    located.clip.sourceArtifactId = operation.sourceId
  } else if (operation.kind === 'inspect') {
    applyInspectorToPlan(plan, located.clip, operation.patch)
  }
  const durations = timelineTracks(plan).map(retimeTrack)
  plan.durationFrames = Math.max(0, ...durations)
  plan.id = `edit-plan-${input.newVersionId}`
  plan.projectVersionId = input.newVersionId
  plan.createdAt = input.createdAt
  plan.manualEditing = Object.freeze({
    schemaVersion: 1,
    action: 'apply',
    operation,
    variantId: input.variantId,
  })
  return Object.freeze(plan)
}

export function materializeManualRestorePlan(input: {
  targetEditPlan: Readonly<Record<string, unknown>>
  action: 'undo' | 'redo' | 'restore'
  targetVersionId: string
  newVersionId: string
  createdAt: string
  variantId: string
}): Readonly<Record<string, unknown>> {
  const plan = structuredClone(input.targetEditPlan) as MutableRecord
  assertDomain(
    plan.schemaVersion === 2 && plan.state === 'compiled',
    'PRECONDITION_REQUIRED',
    'Restore requires a compiled EditPlan v2 target',
  )
  plan.id = `edit-plan-${input.newVersionId}`
  plan.projectVersionId = input.newVersionId
  plan.createdAt = input.createdAt
  plan.manualEditing = Object.freeze({
    schemaVersion: 1,
    action: input.action,
    restoresVersionId: input.targetVersionId,
    variantId: input.variantId,
  })
  return Object.freeze(plan)
}

export function createAuditVersion(input: {
  current: TimelineViewModel
  command: ManualEditCommand
  action: ManualVersionAction
  targetVersionId?: string
}) {
  return Object.freeze({
    id: `version_${input.action}_${input.command.id}`,
    parentId: input.current.versionId,
    restoresVersionId: input.targetVersionId ?? null,
    commandId: input.command.id,
    action: input.action,
    auditable: true,
  })
}

export function manualGestureFromInteraction(input: {
  type: 'keyboard' | 'mouse'
  key?: string
  clipId: string
  pointerMs?: number
}): ManualGesture {
  if (input.type === 'keyboard') {
    if (input.key?.toLowerCase() === 's') {
      return { kind: 'split', clipId: input.clipId, atMs: input.pointerMs ?? 0 }
    }
    if (input.key === 'Delete') {
      return { kind: 'trim', clipId: input.clipId, edge: 'end', atMs: input.pointerMs ?? 0 }
    }
    return { kind: 'select', clipId: input.clipId }
  }
  return { kind: 'move', clipId: input.clipId, startMs: input.pointerMs ?? 0, track: 0 }
}

export interface VersionComparison {
  before: { id: string; durationMs: number; mappingId?: string; score: number; issues: readonly string[] }
  after: { id: string; durationMs: number; mappingId?: string; score: number; issues: readonly string[] }
  semanticChanges: readonly { category: string; target: string; summary: string }[]
}

export type VersionCompareMode = 'toggle' | 'split' | 'overlay'
export type VersionCompareAction = 'accept' | 'reopen' | 'restore'

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function comparisonIssues(plan: Record<string, unknown>): readonly string[] {
  const quality = optionalRecord(plan.quality) ?? optionalRecord(plan.qualityReport)
  const critic = optionalRecord(plan.critic)
  const raw = Array.isArray(quality?.issues)
    ? quality.issues
    : Array.isArray(critic?.issues)
      ? critic.issues
      : []
  return Object.freeze([...new Set(raw.map((item) => {
    if (typeof item === 'string') return item.trim()
    const record = optionalRecord(item)
    return typeof record?.code === 'string'
      ? record.code.trim()
      : typeof record?.message === 'string'
        ? record.message.trim()
        : ''
  }).filter((item) => item.length > 0))].toSorted())
}

function comparisonScore(plan: Record<string, unknown>): number {
  const quality = optionalRecord(plan.quality) ?? optionalRecord(plan.qualityReport)
  const director = optionalRecord(plan.director)
  const candidates = [quality?.score, director?.qualityScore, plan.qualityScore]
  const score = candidates.find((value) => typeof value === 'number' && Number.isFinite(value))
  return typeof score === 'number' ? score : 0
}

function comparisonMappingId(plan: Record<string, unknown>): string | undefined {
  const sync = optionalRecord(plan.sync) ?? optionalRecord(plan.synchronization)
  const director = optionalRecord(plan.director)
  const value = [plan.mappingId, plan.syncMappingId, sync?.mappingId, director?.syncMappingId]
    .find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0)
  return typeof value === 'string' ? value.trim() : undefined
}

function comparisonDurationMs(plan: Record<string, unknown>): number {
  const fps = Number(plan.fps)
  const durationFrames = Number(plan.durationFrames)
  assertDomain(
    Number.isFinite(fps) && fps > 0 &&
      Number.isSafeInteger(durationFrames) && durationFrames >= 0,
    'PERSISTENCE_CONFLICT',
    'Compared EditPlan duration is invalid',
  )
  return Math.round(durationFrames / fps * 1000)
}

function comparisonClips(plan: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const tracks = Array.isArray(plan.videoTracks) ? plan.videoTracks : []
  const entries: [string, Record<string, unknown>][] = []
  for (const rawTrack of tracks) {
    const track = optionalRecord(rawTrack)
    if (!track || !Array.isArray(track.clips)) continue
    for (const rawClip of track.clips) {
      const clip = optionalRecord(rawClip)
      if (clip && typeof clip.id === 'string') entries.push([clip.id, clip])
    }
  }
  return new Map(entries)
}

function semanticChangesBetweenPlans(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): readonly { category: string; target: string; summary: string }[] {
  const changes: { category: string; target: string; summary: string }[] = []
  const beforeClips = comparisonClips(before)
  const afterClips = comparisonClips(after)
  for (const id of [...new Set([...beforeClips.keys(), ...afterClips.keys()])].toSorted()) {
    const left = beforeClips.get(id)
    const right = afterClips.get(id)
    if (!left) {
      changes.push({ category: 'timeline', target: id, summary: 'Clip added.' })
      continue
    }
    if (!right) {
      changes.push({ category: 'timeline', target: id, summary: 'Clip removed.' })
      continue
    }
    if (left.sourceArtifactId !== right.sourceArtifactId) {
      changes.push({ category: 'source', target: id, summary: 'Source asset changed.' })
    }
    const timingFields = ['sourceInFrame', 'sourceOutFrame', 'timelineInFrame', 'timelineOutFrame']
    if (timingFields.some((field) => left[field] !== right[field])) {
      changes.push({ category: 'timeline', target: id, summary: 'Clip timing changed.' })
    }
    if (stableSerialize(left.manualInspector ?? null) !== stableSerialize(right.manualInspector ?? null)) {
      changes.push({ category: 'visual', target: id, summary: 'Inspector settings changed.' })
    }
  }
  if (stableSerialize(before.composition ?? null) !== stableSerialize(after.composition ?? null)) {
    changes.push({ category: 'composition', target: 'project-composition', summary: 'Composition changed.' })
  }
  if (stableSerialize(before.subtitleTracks ?? []) !== stableSerialize(after.subtitleTracks ?? [])) {
    changes.push({ category: 'subtitle', target: 'subtitle-tracks', summary: 'Subtitle content or style changed.' })
  }
  if (comparisonDurationMs(before) !== comparisonDurationMs(after)) {
    changes.push({ category: 'duration', target: 'project-timeline', summary: 'Total duration changed.' })
  }
  return Object.freeze(changes.slice(0, 100).map((change) => Object.freeze(change)))
}

export function versionComparisonFromEditPlans(input: {
  before: { id: string; editPlan: Readonly<Record<string, unknown>> }
  after: { id: string; editPlan: Readonly<Record<string, unknown>> }
  mode: VersionCompareMode
}) {
  assertDomain(
    ['toggle', 'split', 'overlay'].includes(input.mode),
    'INVALID_ARGUMENT',
    'Version compare mode is invalid',
  )
  assertDomain(
    input.before.id !== input.after.id,
    'INVALID_ARGUMENT',
    'Version comparison requires two different versions',
  )
  for (const [side, record] of Object.entries({
    before: input.before,
    after: input.after,
  })) {
    assertDomain(
      /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(record.id) &&
        record.editPlan.schemaVersion === 2 &&
        record.editPlan.state === 'compiled',
      'INVALID_ARGUMENT',
      `${side} comparison version is invalid`,
    )
  }
  const before = {
    id: input.before.id,
    durationMs: comparisonDurationMs(input.before.editPlan),
    ...(comparisonMappingId(input.before.editPlan)
      ? { mappingId: comparisonMappingId(input.before.editPlan)! }
      : {}),
    score: comparisonScore(input.before.editPlan),
    issues: comparisonIssues(input.before.editPlan),
  }
  const after = {
    id: input.after.id,
    durationMs: comparisonDurationMs(input.after.editPlan),
    ...(comparisonMappingId(input.after.editPlan)
      ? { mappingId: comparisonMappingId(input.after.editPlan)! }
      : {}),
    score: comparisonScore(input.after.editPlan),
    issues: comparisonIssues(input.after.editPlan),
  }
  return Object.freeze({
    before: Object.freeze(before),
    after: Object.freeze(after),
    ...compareVersions({
      before,
      after,
      semanticChanges: semanticChangesBetweenPlans(input.before.editPlan, input.after.editPlan),
    }, input.mode),
  })
}

export function compareVersions(
  input: VersionComparison,
  mode: VersionCompareMode,
) {
  assertDomain(['toggle', 'split', 'overlay'].includes(mode), 'INVALID_ARGUMENT', 'Version compare mode is invalid')
  const synchronized = Boolean(
    input.before.mappingId && input.before.mappingId === input.after.mappingId,
  )
  return Object.freeze({
    mode,
    synchronized,
    playheadMapping: synchronized ? 'shared' : 'independent',
    durationDeltaMs: input.after.durationMs - input.before.durationMs,
    scoreDelta: input.after.score - input.before.score,
    issuesAdded: Object.freeze(
      input.after.issues.filter((issue) => !input.before.issues.includes(issue)),
    ),
    issuesResolved: Object.freeze(
      input.before.issues.filter((issue) => !input.after.issues.includes(issue)),
    ),
    semanticChanges: Object.freeze([...input.semanticChanges]),
    actions: Object.freeze(['accept', 'reopen', 'restore'] as const),
    versionsPreserved: true,
  })
}
