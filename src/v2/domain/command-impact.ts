import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import type { ManualGesture, ManualVersionAction } from './manual-editing.ts'
import type { PatchOperation } from './review-system.ts'

export type CommandImpactDependency =
  | 'content'
  | 'timing'
  | 'visual'
  | 'audio'
  | 'policy'
  | 'rights'

export interface CommandImpactOutputReference {
  artifactId: string
  kind: 'proxy' | 'final'
  sourceVersionId: string
  variantId: string
}

export interface CommandImpactRange {
  startFrame: number
  endFrame: number
}

export interface CommandImpactV1 {
  schemaVersion: 'command-impact/v1'
  commandId: string
  commandType:
    | 'manual-edit'
    | 'apply-review-patch'
    | 'apply-review-patch-batch'
    | 'apply-subtitle-segment-override'
  baseVersionId: string
  resultVersionId: string
  changeKinds: readonly string[]
  dependencyTypes: readonly CommandImpactDependency[]
  affectedRanges: readonly Readonly<CommandImpactRange>[]
  affectedVariantIds: readonly string[]
  affectedArtifacts: readonly Readonly<CommandImpactOutputReference>[]
  minimalRenders: readonly Readonly<{
    kind: 'proxy'
    variantId: string
    ranges: readonly Readonly<CommandImpactRange>[]
  }>[]
  renderSemanticsChanged: boolean
  impactHash: string
}

export interface CommandArtifactInvalidationV1 {
  schemaVersion: 'command-artifact-invalidation/v1'
  id: string
  status: 'stale'
  commandId: string
  baseVersionId: string
  resultVersionId: string
  artifactId: string
  kind: 'proxy' | 'final'
  variantId: string
  dependencyTypes: readonly CommandImpactDependency[]
  affectedRanges: readonly Readonly<CommandImpactRange>[]
  impactHash: string
  createdAt: string
}

function outputReferenceKey(value: CommandImpactOutputReference): string {
  return `${value.kind}:${value.artifactId}:${value.sourceVersionId}:${value.variantId}`
}

type RecordValue = Record<string, unknown>
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const DEPENDENCIES = new Set<CommandImpactDependency>([
  'content', 'timing', 'visual', 'audio', 'policy', 'rights',
])

function record(value: unknown, field: string): RecordValue {
  assertDomain(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'INVALID_ARGUMENT',
    `${field} must be an object`,
  )
  return value as RecordValue
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function exactKeys(value: RecordValue, expected: readonly string[], field: string): void {
  const actual = Object.keys(value).sort()
  assertDomain(
    actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]),
    'PERSISTENCE_CONFLICT',
    `Stored ${field} fields are invalid`,
  )
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value)
}

function planClips(planValue: Readonly<Record<string, unknown>>): readonly RecordValue[] {
  const plan = record(planValue, 'EditPlan')
  assertDomain(
    plan.schemaVersion === 2 && Array.isArray(plan.videoTracks),
    'INVALID_ARGUMENT',
    'Command impact requires an EditPlan v2',
  )
  return plan.videoTracks.flatMap((trackValue) => {
    const track = record(trackValue, 'EditPlan track')
    assertDomain(Array.isArray(track.clips), 'INVALID_ARGUMENT', 'EditPlan track clips are invalid')
    return track.clips.map((clip) => record(clip, 'EditPlan clip'))
  })
}

function clipRanges(
  plan: Readonly<Record<string, unknown>>,
  targetId: string,
): readonly CommandImpactRange[] {
  return planClips(plan)
    .filter((clip) => clip.id === targetId || String(clip.id).startsWith(`${targetId}:`))
    .map((clip) => {
      const startFrame = Number(clip.timelineInFrame)
      const endFrame = Number(clip.timelineOutFrame)
      assertDomain(
        Number.isSafeInteger(startFrame) && Number.isSafeInteger(endFrame) &&
          startFrame >= 0 && endFrame > startFrame,
        'INVALID_ARGUMENT',
        'EditPlan clip timeline range is invalid',
      )
      return { startFrame, endFrame }
    })
}

function changedSubtitleTextRange(input: {
  before: Readonly<Record<string, unknown>>
  after: Readonly<Record<string, unknown>>
}): readonly Readonly<CommandImpactRange>[] {
  const cues = (planValue: Readonly<Record<string, unknown>>, field: string) => {
    const plan = record(planValue, field)
    assertDomain(Array.isArray(plan.subtitleTracks), 'INVALID_ARGUMENT', `${field} subtitle tracks are invalid`)
    return new Map(plan.subtitleTracks.flatMap((trackValue, trackIndex) => {
      const track = record(trackValue, `${field} subtitle track`)
      assertDomain(Array.isArray(track.cues), 'INVALID_ARGUMENT', `${field} subtitle cues are invalid`)
      return track.cues.map((cueValue, cueIndex) => {
        const cue = record(cueValue, `${field} subtitle cue`)
        const id = String(cue.id)
        const startFrame = Number(cue.startFrame)
        const endFrame = Number(cue.endFrame)
        assertDomain(
          validId(id) && Number.isSafeInteger(startFrame) && Number.isSafeInteger(endFrame) &&
            startFrame >= 0 && endFrame > startFrame && typeof cue.text === 'string',
          'INVALID_ARGUMENT',
          `${field} subtitle cue ${trackIndex}:${cueIndex} is invalid`,
        )
        return [id, { startFrame, endFrame, text: cue.text }] as const
      })
    }))
  }
  const before = cues(input.before, 'Before EditPlan')
  const after = cues(input.after, 'After EditPlan')
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .filter((id) => before.get(id)?.text !== after.get(id)?.text)
  assertDomain(changed.length === 1, 'INVALID_ARGUMENT', 'Manual subtitle text edit must change exactly one cue')
  const ranges = [before.get(changed[0]!), after.get(changed[0]!)]
    .filter((cue): cue is { startFrame: number; endFrame: number; text: string } => Boolean(cue))
  return Object.freeze([Object.freeze({
    startFrame: Math.min(...ranges.map((range) => range.startFrame)),
    endFrame: Math.max(...ranges.map((range) => range.endFrame)),
  })])
}

function planDuration(plan: Readonly<Record<string, unknown>>): number {
  const value = Number(plan.durationFrames)
  assertDomain(
    Number.isSafeInteger(value) && value > 0,
    'INVALID_ARGUMENT',
    'EditPlan durationFrames is invalid',
  )
  return value
}

/**
 * Canonical form of a stale-range list: ordered by startFrame, with overlapping
 * AND adjacent ranges fused into one. Adjacency is fused rather than rejected so
 * that `[0,30]` + `[30,60]` always collapses to `[0,60]`; consumers may therefore
 * rely on `ranges[i].startFrame > ranges[i - 1].endFrame` (strictly disjoint,
 * never merely touching) and on the list being duplicate-free.
 */
export function canonicalCommandImpactRanges(
  input: readonly Readonly<CommandImpactRange>[],
): readonly Readonly<CommandImpactRange>[] {
  const sorted = [...input].toSorted((left, right) =>
    left.startFrame - right.startFrame || left.endFrame - right.endFrame)
  const merged: CommandImpactRange[] = []
  for (const range of sorted) {
    assertDomain(
      Number.isSafeInteger(range.startFrame) && Number.isSafeInteger(range.endFrame) &&
        range.startFrame >= 0 && range.endFrame > range.startFrame,
      'INVALID_ARGUMENT',
      'Command impact range is invalid',
    )
    const previous = merged.at(-1)
    if (previous && range.startFrame <= previous.endFrame) {
      previous.endFrame = Math.max(previous.endFrame, range.endFrame)
    } else merged.push({ startFrame: range.startFrame, endFrame: range.endFrame })
  }
  assertDomain(merged.length > 0, 'INVALID_ARGUMENT', 'Command impact produced no range')
  return Object.freeze(merged.map((range) => Object.freeze(range)))
}

function mergedRange(input: {
  before: Readonly<Record<string, unknown>>
  after: Readonly<Record<string, unknown>>
  targetId: string
  throughEnd: boolean
}): readonly Readonly<CommandImpactRange>[] {
  const ranges = [
    ...clipRanges(input.before, input.targetId),
    ...clipRanges(input.after, input.targetId),
  ]
  assertDomain(ranges.length > 0, 'INVALID_ARGUMENT', 'Command impact target clip is missing')
  if (!input.throughEnd) return canonicalCommandImpactRanges(ranges)
  const startFrame = Math.min(...ranges.map((range) => range.startFrame))
  const endFrame = Math.max(planDuration(input.before), planDuration(input.after))
  // Timing edits retime every downstream clip. Even if the target's old and new
  // locations are disjoint, frames between them are not reusable because their
  // timeline-to-source mapping shifted.
  return Object.freeze([Object.freeze({ startFrame, endFrame })])
}

function classify(action: ManualVersionAction, operation?: ManualGesture): Readonly<{
  changeKinds: readonly string[]
  dependencies: readonly CommandImpactDependency[]
  renderSemanticsChanged: boolean
  throughEnd: boolean
}> {
  if (action !== 'apply') {
    return Object.freeze({
      changeKinds: Object.freeze(['restore']),
      dependencies: Object.freeze(
        ['content', 'timing', 'visual', 'audio'] satisfies CommandImpactDependency[],
      ),
      renderSemanticsChanged: true,
      throughEnd: true,
    })
  }
  assertDomain(Boolean(operation), 'INVALID_ARGUMENT', 'Apply impact requires an operation')
  if (operation!.kind === 'select') {
    return Object.freeze({
      changeKinds: Object.freeze(['selection']),
      dependencies: Object.freeze([]),
      renderSemanticsChanged: false,
      throughEnd: false,
    })
  }
  if (operation!.kind === 'trim' || operation!.kind === 'move') {
    return Object.freeze({
      changeKinds: Object.freeze([operation!.kind]),
      dependencies: Object.freeze(
        ['timing', 'visual', 'audio'] satisfies CommandImpactDependency[],
      ),
      renderSemanticsChanged: true,
      throughEnd: true,
    })
  }
  if (operation!.kind === 'split') {
    return Object.freeze({
      changeKinds: Object.freeze(['split']),
      dependencies: Object.freeze(
        ['timing', 'visual', 'audio'] satisfies CommandImpactDependency[],
      ),
      renderSemanticsChanged: true,
      throughEnd: false,
    })
  }
  if (operation!.kind === 'replace') {
    return Object.freeze({
      changeKinds: Object.freeze(['replace-source']),
      dependencies: Object.freeze(
        ['content', 'visual', 'audio'] satisfies CommandImpactDependency[],
      ),
      renderSemanticsChanged: true,
      throughEnd: false,
    })
  }
  if (operation!.kind === 'crop') {
    return Object.freeze({
      changeKinds: Object.freeze(['crop']),
      dependencies: Object.freeze(
        ['visual'] satisfies CommandImpactDependency[],
      ),
      renderSemanticsChanged: true,
      throughEnd: false,
    })
  }
  const keys = Object.keys(operation!.patch).sort()
  const dependencies = new Set<CommandImpactDependency>()
  if (keys.some((key) => ['layout', 'text', 'subtitle', 'color', 'motion'].includes(key))) {
    dependencies.add('visual')
  }
  if (keys.includes('audioGain')) dependencies.add('audio')
  return Object.freeze({
    changeKinds: Object.freeze(keys.map((key) => `inspect:${key}`)),
    dependencies: Object.freeze([...dependencies].sort()),
    renderSemanticsChanged: true,
    throughEnd: false,
  })
}

export function createManualCommandImpact(input: {
  commandId: string
  baseVersionId: string
  resultVersionId: string
  variantId: string
  targetId: string
  action: ManualVersionAction
  operation?: ManualGesture
  beforeEditPlan: Readonly<Record<string, unknown>>
  afterEditPlan: Readonly<Record<string, unknown>>
  outputReferences: readonly Readonly<CommandImpactOutputReference>[]
}): Readonly<CommandImpactV1> {
  for (const [field, value] of Object.entries({
    commandId: input.commandId,
    baseVersionId: input.baseVersionId,
    resultVersionId: input.resultVersionId,
    variantId: input.variantId,
    targetId: input.targetId,
  })) {
    assertDomain(validId(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  }
  const classification = classify(input.action, input.operation)
  const affectedRanges = input.action === 'apply'
    ? input.operation?.kind === 'inspect' &&
        Object.keys(input.operation.patch).length === 1 &&
        input.operation.patch.text !== undefined
      ? changedSubtitleTextRange({ before: input.beforeEditPlan, after: input.afterEditPlan })
      : mergedRange({
        before: input.beforeEditPlan,
        after: input.afterEditPlan,
        targetId: input.targetId,
        throughEnd: classification.throughEnd,
      })
    : Object.freeze([Object.freeze({
        startFrame: 0,
        endFrame: Math.max(planDuration(input.beforeEditPlan), planDuration(input.afterEditPlan)),
      })])
  const affectedArtifacts = classification.renderSemanticsChanged
    ? normalizeCommandImpactOutputReferences(
        input.outputReferences.filter((output) => output.variantId === input.variantId),
      )
    : []
  const body = {
    schemaVersion: 'command-impact/v1' as const,
    commandId: input.commandId,
    commandType: 'manual-edit' as const,
    baseVersionId: input.baseVersionId,
    resultVersionId: input.resultVersionId,
    changeKinds: Object.freeze([...classification.changeKinds]),
    dependencyTypes: Object.freeze([...classification.dependencies]),
    affectedRanges: Object.freeze(affectedRanges),
    affectedVariantIds: Object.freeze(
      classification.renderSemanticsChanged ? [input.variantId] : [],
    ),
    affectedArtifacts: Object.freeze(affectedArtifacts),
    minimalRenders: Object.freeze(classification.renderSemanticsChanged
      ? [{ kind: 'proxy' as const, variantId: input.variantId, ranges: affectedRanges }]
      : []),
    renderSemanticsChanged: classification.renderSemanticsChanged,
  }
  return Object.freeze({ ...body, impactHash: calculateCanonicalHash(body) })
}

function reviewPatchClassification(operations: readonly Readonly<PatchOperation>[]): Readonly<{
  changeKinds: readonly string[]
  dependencyTypes: readonly CommandImpactDependency[]
  throughEnd: boolean
}> {
  assertDomain(operations.length > 0 && operations.length <= 100, 'INVALID_ARGUMENT', 'Review patch operations are invalid')
  const dependencies = new Set<CommandImpactDependency>()
  let throughEnd = false
  for (const operation of operations) {
    assertDomain(validId(operation.targetId), 'INVALID_ARGUMENT', 'Review patch targetId is invalid')
    if (operation.op === 'trim' || operation.op === 'move') {
      dependencies.add('timing'); dependencies.add('visual'); dependencies.add('audio')
      throughEnd = true
    } else if (operation.op === 'replace-asset') {
      dependencies.add('content'); dependencies.add('visual'); dependencies.add('audio')
    } else if (operation.op === 'update-text') {
      dependencies.add('content'); dependencies.add('visual')
    } else {
      dependencies.add('visual')
    }
  }
  return Object.freeze({
    changeKinds: Object.freeze([...new Set(operations.map((operation) => operation.op))].toSorted()),
    dependencyTypes: Object.freeze([...dependencies].toSorted()),
    throughEnd,
  })
}

function reviewPatchFrameRanges(input: {
  rangesMs: readonly (readonly [number, number])[]
  fps: number
  durationFrames: number
}): readonly Readonly<CommandImpactRange>[] {
  assertDomain(
    Number.isFinite(input.fps) && input.fps > 0 &&
      Number.isSafeInteger(input.durationFrames) && input.durationFrames > 0 &&
      input.rangesMs.length > 0 && input.rangesMs.length <= 100,
    'INVALID_ARGUMENT',
    'Review patch timing is invalid',
  )
  const ranges = input.rangesMs.map((range) => {
    assertDomain(
      Array.isArray(range) && range.length === 2 &&
        Number.isSafeInteger(range[0]) && Number.isSafeInteger(range[1]) &&
        range[0] >= 0 && range[1] >= range[0],
      'INVALID_ARGUMENT',
      'Review patch range is invalid',
    )
    const startFrame = Math.floor(range[0] * input.fps / 1000 + 1e-7)
    const rawEndFrame = Math.ceil(range[1] * input.fps / 1000 - 1e-7)
    assertDomain(startFrame < input.durationFrames, 'INVALID_ARGUMENT', 'Review patch range starts outside the timeline')
    return Object.freeze({
      startFrame,
      endFrame: Math.min(input.durationFrames, Math.max(startFrame + 1, rawEndFrame)),
    })
  })
  return canonicalCommandImpactRanges(ranges)
}

export function createReviewPatchCommandImpact(input: {
  commandType?: 'apply-review-patch' | 'apply-review-patch-batch'
  commandId: string
  baseVersionId: string
  resultVersionId: string
  variantIds: readonly string[]
  operations: readonly Readonly<PatchOperation>[]
  invalidatedRangesMs: readonly (readonly [number, number])[]
  beforeEditPlan: Readonly<Record<string, unknown>>
  afterEditPlan: Readonly<Record<string, unknown>>
  outputReferences: readonly Readonly<CommandImpactOutputReference>[]
}): Readonly<CommandImpactV1> {
  for (const [field, value] of Object.entries({
    commandId: input.commandId,
    baseVersionId: input.baseVersionId,
    resultVersionId: input.resultVersionId,
  })) assertDomain(validId(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  const variants = Object.freeze([...new Set(input.variantIds.map((item) => item.trim()))].toSorted())
  assertDomain(variants.length > 0 && variants.every(validId), 'INVALID_ARGUMENT', 'Review patch variants are invalid')
  const beforeFps = Number(input.beforeEditPlan.fps)
  const afterFps = Number(input.afterEditPlan.fps)
  assertDomain(Number.isFinite(beforeFps) && beforeFps > 0 && beforeFps === afterFps, 'INVALID_ARGUMENT', 'Review patch EditPlan FPS is inconsistent')
  const classification = reviewPatchClassification(input.operations)
  const durationFrames = Math.max(planDuration(input.beforeEditPlan), planDuration(input.afterEditPlan))
  const reviewedRanges = reviewPatchFrameRanges({
    rangesMs: input.invalidatedRangesMs,
    fps: beforeFps,
    durationFrames,
  })
  const timingTargetRanges = input.operations
    .filter((operation) => operation.op === 'trim' || operation.op === 'move')
    .flatMap((operation) => {
      const targetId = operation.targetId.replace(/^(?:subtitle|presenter|background|scene|clip):/, '')
      return [...clipRanges(input.beforeEditPlan, targetId), ...clipRanges(input.afterEditPlan, targetId)]
    })
  const affectedRanges = classification.throughEnd
    ? Object.freeze([Object.freeze({
        startFrame: Math.min(reviewedRanges[0]!.startFrame, ...timingTargetRanges.map((range) => range.startFrame)),
        endFrame: durationFrames,
      })])
    : reviewedRanges
  const affectedArtifacts = normalizeCommandImpactOutputReferences(
    input.outputReferences.filter((output) => variants.includes(output.variantId)),
  )
  const body = {
    schemaVersion: 'command-impact/v1' as const,
    commandId: input.commandId,
    commandType: input.commandType ?? 'apply-review-patch',
    baseVersionId: input.baseVersionId,
    resultVersionId: input.resultVersionId,
    changeKinds: classification.changeKinds,
    dependencyTypes: classification.dependencyTypes,
    affectedRanges,
    affectedVariantIds: variants,
    affectedArtifacts,
    minimalRenders: Object.freeze(variants.map((variantId) => Object.freeze({
      kind: 'proxy' as const,
      variantId,
      ranges: affectedRanges,
    }))),
    renderSemanticsChanged: true,
  }
  return Object.freeze({ ...body, impactHash: calculateCanonicalHash(body) })
}

/**
 * F1.037 / FR-174 — impact of one subtitle exception scoped to a single segment.
 *
 * This is genuinely partial-range: the invalidated region is the half-open range of
 * the overridden segment, clamped to the compiled timeline, and never frame 0 to the
 * end unless the segment itself spans the whole timeline. It is also genuinely
 * variant-scoped: `affectedVariantIds`, `affectedArtifacts` and `minimalRenders`
 * only ever mention the target variant, so a 9:16 exception cannot invalidate the
 * 16:9 export.
 */
export function createSubtitleSegmentOverrideCommandImpact(input: {
  commandId: string
  baseVersionId: string
  resultVersionId: string
  variantId: string
  segmentId: string
  range: Readonly<CommandImpactRange>
  /** Overridden dimensions; `[]` means the segment went back to the inherited resolution. */
  dimensionKinds: readonly string[]
  durationFrames: number
  outputReferences: readonly Readonly<CommandImpactOutputReference>[]
}): Readonly<CommandImpactV1> {
  for (const [field, value] of Object.entries({
    commandId: input.commandId,
    baseVersionId: input.baseVersionId,
    resultVersionId: input.resultVersionId,
    variantId: input.variantId,
    segmentId: input.segmentId,
  })) assertDomain(validId(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  assertDomain(
    Number.isSafeInteger(input.durationFrames) && input.durationFrames > 0,
    'INVALID_ARGUMENT',
    'Subtitle segment override impact requires a compiled timeline',
  )
  assertDomain(
    Number.isSafeInteger(input.range.startFrame) && Number.isSafeInteger(input.range.endFrame) &&
      input.range.startFrame >= 0 && input.range.endFrame > input.range.startFrame &&
      input.range.endFrame <= input.durationFrames,
    'INVALID_ARGUMENT',
    'Subtitle segment override range must sit inside the compiled timeline',
  )
  const kinds = [...new Set(input.dimensionKinds)].toSorted()
  assertDomain(
    kinds.length <= 4 && kinds.every((kind) => typeof kind === 'string' && /^[a-z-]{3,32}$/.test(kind)),
    'INVALID_ARGUMENT',
    'Subtitle segment override impact dimensions are invalid',
  )
  const affectedRanges = canonicalCommandImpactRanges([input.range])
  // Text is the only dimension that changes what the video says; the other three
  // move how an unchanged line is drawn.
  const dependencyTypes: CommandImpactDependency[] = kinds.includes('text')
    ? ['content', 'visual']
    : ['visual']
  const affectedArtifacts = normalizeCommandImpactOutputReferences(
    input.outputReferences.filter((output) => output.variantId === input.variantId),
  )
  const body = {
    schemaVersion: 'command-impact/v1' as const,
    commandId: input.commandId,
    commandType: 'apply-subtitle-segment-override' as const,
    baseVersionId: input.baseVersionId,
    resultVersionId: input.resultVersionId,
    // The segment travels in the classification so an operator reading the impact
    // sees which exception moved, not only that "a subtitle changed".
    changeKinds: Object.freeze(
      kinds.length > 0
        ? kinds.map((kind) => `subtitle-segment:${kind}`)
        : ['subtitle-segment:inherit'],
    ),
    dependencyTypes: Object.freeze(dependencyTypes),
    affectedRanges,
    affectedVariantIds: Object.freeze([input.variantId]),
    affectedArtifacts,
    minimalRenders: Object.freeze([
      Object.freeze({ kind: 'proxy' as const, variantId: input.variantId, ranges: affectedRanges }),
    ]),
    renderSemanticsChanged: true,
  }
  return Object.freeze({ ...body, impactHash: calculateCanonicalHash(body) })
}

export function createCommandArtifactInvalidations(input: {
  impact: Readonly<CommandImpactV1>
  createdAt: string
}): readonly Readonly<CommandArtifactInvalidationV1>[] {
  const impact = parseCommandImpact(input.impact)
  assertDomain(
    Number.isFinite(Date.parse(input.createdAt)) && new Date(input.createdAt).toISOString() === input.createdAt,
    'INVALID_ARGUMENT',
    'Command artifact invalidation createdAt is invalid',
  )
  return Object.freeze(impact.affectedArtifacts.map((artifact) => {
    const identity = {
      schemaVersion: 'command-artifact-invalidation/v1' as const,
      status: 'stale' as const,
      commandId: impact.commandId,
      baseVersionId: impact.baseVersionId,
      resultVersionId: impact.resultVersionId,
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      variantId: artifact.variantId,
      dependencyTypes: impact.dependencyTypes,
      affectedRanges: impact.affectedRanges,
      impactHash: impact.impactHash,
      createdAt: input.createdAt,
    }
    return deepFreeze({ ...identity, id: calculateCanonicalHash(identity) })
  }))
}

export function parseCommandArtifactInvalidation(
  value: unknown,
): Readonly<CommandArtifactInvalidationV1> {
  const stored = record(value, 'Command artifact invalidation')
  exactKeys(stored, [
    'schemaVersion', 'id', 'status', 'commandId', 'baseVersionId', 'resultVersionId',
    'artifactId', 'kind', 'variantId', 'dependencyTypes', 'affectedRanges',
    'impactHash', 'createdAt',
  ], 'Command artifact invalidation')
  const invalidation = stored as unknown as CommandArtifactInvalidationV1
  assertDomain(
    invalidation.schemaVersion === 'command-artifact-invalidation/v1' &&
      /^[a-f0-9]{64}$/.test(invalidation.id) &&
      invalidation.status === 'stale' &&
      validId(invalidation.commandId) && validId(invalidation.baseVersionId) &&
      validId(invalidation.resultVersionId) && validId(invalidation.artifactId) &&
      ['proxy', 'final'].includes(invalidation.kind) && validId(invalidation.variantId) &&
      Array.isArray(invalidation.dependencyTypes) &&
      invalidation.dependencyTypes.every((item) => DEPENDENCIES.has(item)) &&
      new Set(invalidation.dependencyTypes).size === invalidation.dependencyTypes.length &&
      Array.isArray(invalidation.affectedRanges) && invalidation.affectedRanges.length > 0 &&
      /^[a-f0-9]{64}$/.test(invalidation.impactHash) &&
      Number.isFinite(Date.parse(invalidation.createdAt)) &&
      new Date(invalidation.createdAt).toISOString() === invalidation.createdAt,
    'PERSISTENCE_CONFLICT',
    'Stored Command artifact invalidation is invalid',
  )
  for (const rangeValue of invalidation.affectedRanges) {
    const range = record(rangeValue, 'Command artifact invalidation range')
    exactKeys(range, ['startFrame', 'endFrame'], 'Command artifact invalidation range')
    assertDomain(
      Number.isSafeInteger(range.startFrame) && Number.isSafeInteger(range.endFrame) &&
        Number(range.startFrame) >= 0 && Number(range.endFrame) > Number(range.startFrame),
      'PERSISTENCE_CONFLICT',
      'Stored Command artifact invalidation range is invalid',
    )
  }
  const { id, ...identity } = invalidation
  assertDomain(
    calculateCanonicalHash(identity) === id,
    'PERSISTENCE_CONFLICT',
    'Stored Command artifact invalidation hash is invalid',
  )
  return deepFreeze(invalidation)
}

export function normalizeCommandImpactOutputReferences(
  input: readonly Readonly<CommandImpactOutputReference>[],
): readonly Readonly<CommandImpactOutputReference>[] {
  const keyed = input.map((output) => {
    assertDomain(
      validId(output.artifactId) && validId(output.sourceVersionId) &&
        validId(output.variantId) && ['proxy', 'final'].includes(output.kind),
      'INVALID_ARGUMENT',
      'Command impact output reference is invalid',
    )
    const frozen = Object.freeze({ ...output })
    return [outputReferenceKey(frozen), frozen] as const
  })
  return Object.freeze(
    [...new Map(keyed).values()]
      .toSorted((left, right) => outputReferenceKey(left).localeCompare(outputReferenceKey(right))),
  )
}

export function parseCommandImpact(value: unknown): Readonly<CommandImpactV1> {
  const stored = record(value, 'Command impact')
  exactKeys(stored, [
    'schemaVersion', 'commandId', 'commandType', 'baseVersionId', 'resultVersionId',
    'changeKinds', 'dependencyTypes', 'affectedRanges', 'affectedVariantIds',
    'affectedArtifacts', 'minimalRenders', 'renderSemanticsChanged', 'impactHash',
  ], 'Command impact')
  const impact = stored as unknown as CommandImpactV1
  assertDomain(
    impact.schemaVersion === 'command-impact/v1' &&
      ['manual-edit', 'apply-review-patch', 'apply-review-patch-batch', 'apply-subtitle-segment-override']
        .includes(impact.commandType) &&
      validId(impact.commandId) &&
      validId(impact.baseVersionId) &&
      validId(impact.resultVersionId) &&
      Array.isArray(impact.changeKinds) &&
      Array.isArray(impact.dependencyTypes) &&
      Array.isArray(impact.affectedRanges) &&
      Array.isArray(impact.affectedVariantIds) &&
      Array.isArray(impact.affectedArtifacts) &&
      Array.isArray(impact.minimalRenders) &&
      typeof impact.renderSemanticsChanged === 'boolean' &&
      /^[a-f0-9]{64}$/.test(impact.impactHash),
    'PERSISTENCE_CONFLICT',
    'Stored Command impact is invalid',
  )
  assertDomain(
    impact.changeKinds.length >= 1 && impact.changeKinds.length <= 16 &&
      impact.changeKinds.every((item) => typeof item === 'string' && item.length >= 1 && item.length <= 64) &&
      new Set(impact.changeKinds).size === impact.changeKinds.length &&
      impact.dependencyTypes.every((item) => DEPENDENCIES.has(item)) &&
      new Set(impact.dependencyTypes).size === impact.dependencyTypes.length &&
      impact.affectedVariantIds.every(validId) &&
      new Set(impact.affectedVariantIds).size === impact.affectedVariantIds.length,
    'PERSISTENCE_CONFLICT',
    'Stored Command impact classification is invalid',
  )
  for (const rangeValue of impact.affectedRanges) {
    const range = record(rangeValue, 'Command impact range')
    exactKeys(range, ['startFrame', 'endFrame'], 'Command impact range')
    assertDomain(
      Number.isSafeInteger(range.startFrame) && Number.isSafeInteger(range.endFrame) &&
        Number(range.startFrame) >= 0 && Number(range.endFrame) > Number(range.startFrame),
      'PERSISTENCE_CONFLICT',
      'Stored Command impact range is invalid',
    )
  }
  for (const artifactValue of impact.affectedArtifacts) {
    const artifact = record(artifactValue, 'Command impact artifact')
    exactKeys(
      artifact,
      ['artifactId', 'kind', 'sourceVersionId', 'variantId'],
      'Command impact artifact',
    )
    assertDomain(
      validId(artifact.artifactId) && ['proxy', 'final'].includes(String(artifact.kind)) &&
        artifact.sourceVersionId === impact.baseVersionId &&
        validId(artifact.variantId) && impact.affectedVariantIds.includes(artifact.variantId),
      'PERSISTENCE_CONFLICT',
      'Stored Command impact artifact is invalid',
    )
  }
  for (const renderValue of impact.minimalRenders) {
    const render = record(renderValue, 'Command impact render')
    exactKeys(render, ['kind', 'variantId', 'ranges'], 'Command impact render')
    assertDomain(
      render.kind === 'proxy' && validId(render.variantId) &&
        impact.affectedVariantIds.includes(render.variantId) && Array.isArray(render.ranges) &&
        calculateCanonicalHash(render.ranges) === calculateCanonicalHash(impact.affectedRanges),
      'PERSISTENCE_CONFLICT',
      'Stored Command impact render is invalid',
    )
  }
  const artifactKeys = impact.affectedArtifacts.map(outputReferenceKey)
  assertDomain(
    new Set(artifactKeys).size === artifactKeys.length &&
      (impact.renderSemanticsChanged
        ? impact.affectedVariantIds.length > 0 && impact.minimalRenders.length > 0
        : impact.affectedVariantIds.length === 0 &&
          impact.affectedArtifacts.length === 0 && impact.minimalRenders.length === 0),
    'PERSISTENCE_CONFLICT',
    'Stored Command impact dependencies are inconsistent',
  )
  if (impact.commandType === 'apply-review-patch' || impact.commandType === 'apply-review-patch-batch') {
    const renderVariants = impact.minimalRenders.map((render) => render.variantId).toSorted()
    assertDomain(
      impact.renderSemanticsChanged === true && impact.dependencyTypes.length > 0 &&
        impact.affectedVariantIds.length > 0 &&
        calculateCanonicalHash(renderVariants) === calculateCanonicalHash([...impact.affectedVariantIds].toSorted()),
      'PERSISTENCE_CONFLICT',
      'Stored review patch impact is inconsistent',
    )
  }
  if (impact.commandType === 'apply-subtitle-segment-override') {
    // A subtitle exception is scoped to exactly one variant and one contiguous
    // half-open range. Anything wider stored under this type is a defect, not a
    // conservative invalidation: it would let one segment invalidate a whole export.
    assertDomain(
      impact.renderSemanticsChanged === true &&
        impact.affectedVariantIds.length === 1 &&
        impact.affectedRanges.length === 1 &&
        impact.minimalRenders.length === 1 &&
        impact.minimalRenders[0]!.variantId === impact.affectedVariantIds[0] &&
        impact.affectedArtifacts.every((artifact) => artifact.variantId === impact.affectedVariantIds[0]) &&
        impact.changeKinds.every((kind) => kind.startsWith('subtitle-segment:')) &&
        impact.dependencyTypes.length > 0 &&
        impact.dependencyTypes.every((dependency) => dependency === 'visual' || dependency === 'content'),
      'PERSISTENCE_CONFLICT',
      'Stored subtitle segment override impact is inconsistent',
    )
  }
  const { impactHash, ...body } = impact
  assertDomain(
    calculateCanonicalHash(body) === impactHash,
    'PERSISTENCE_CONFLICT',
    'Stored Command impact hash is invalid',
  )
  return deepFreeze(structuredClone(impact))
}
