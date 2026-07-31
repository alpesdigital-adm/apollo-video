import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import type { ManualGesture, ManualVersionAction } from './manual-editing.ts'

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
  commandType: 'manual-edit'
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

function planDuration(plan: Readonly<Record<string, unknown>>): number {
  const value = Number(plan.durationFrames)
  assertDomain(
    Number.isSafeInteger(value) && value > 0,
    'INVALID_ARGUMENT',
    'EditPlan durationFrames is invalid',
  )
  return value
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
  const startFrame = Math.min(...ranges.map((range) => range.startFrame))
  const endFrame = input.throughEnd
    ? Math.max(planDuration(input.before), planDuration(input.after))
    : Math.max(...ranges.map((range) => range.endFrame))
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
    ? mergedRange({
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
      impact.commandType === 'manual-edit' &&
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
  const { impactHash, ...body } = impact
  assertDomain(
    calculateCanonicalHash(body) === impactHash,
    'PERSISTENCE_CONFLICT',
    'Stored Command impact hash is invalid',
  )
  return deepFreeze(structuredClone(impact))
}
