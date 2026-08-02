import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import type { CommandArtifactInvalidationV1, CommandImpactOutputReference, CommandImpactRange } from './command-impact.ts'
import { assertDomain } from './errors.ts'

export interface ProjectLutSelectionImpactV1 {
  schemaVersion: 'project-lut-selection-impact/v1'
  commandId: string
  commandType: 'set-project-lut-selection'
  baseVersionId: string
  resultVersionId: string
  selectionId: string
  selectionHash: string
  resolvedMode: 'none' | 'lut-version'
  resolvedLutVersionId: string | null
  resolvedLutRecordHash: string | null
  intensity: number
  changeKinds: readonly ['color-pipeline-selection']
  dependencyTypes: readonly ['visual']
  affectedRanges: readonly Readonly<CommandImpactRange>[]
  affectedVariantIds: readonly string[]
  affectedArtifacts: readonly Readonly<CommandImpactOutputReference>[]
  minimalRenders: readonly Readonly<{
    kind: 'proxy'
    variantId: string
    ranges: readonly Readonly<CommandImpactRange>[]
  }>[]
  renderSemanticsChanged: true
  renderDeferredUntilTimeline: boolean
  impactHash: string
}

type MutableRecord = Record<string, unknown>
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

function identifier(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

function sha256(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

function record(value: unknown, field: string): MutableRecord {
  assertDomain(typeof value === 'object' && value !== null && !Array.isArray(value), 'INVALID_ARGUMENT', `${field} must be an object`)
  return value as MutableRecord
}

export function createProjectLutSelectionImpact(input: {
  commandId: string
  baseVersionId: string
  resultVersionId: string
  selectionId: string
  selectionHash: string
  resolvedMode: 'none' | 'lut-version'
  resolvedLutVersionId?: string
  resolvedLutRecordHash?: string
  intensity: number
  durationFrames: number
  proxyVariantId: string
  outputReferences: readonly Readonly<CommandImpactOutputReference>[]
}): Readonly<ProjectLutSelectionImpactV1> {
  assertDomain(Number.isSafeInteger(input.durationFrames) && input.durationFrames >= 0, 'INVALID_ARGUMENT', 'durationFrames is invalid')
  assertDomain(Number.isFinite(input.intensity) && input.intensity >= 0 && input.intensity <= 1, 'INVALID_ARGUMENT', 'intensity is invalid')
  assertDomain(
    input.resolvedMode === 'none'
      ? input.resolvedLutVersionId === undefined && input.resolvedLutRecordHash === undefined
      : input.resolvedMode === 'lut-version' && input.resolvedLutVersionId !== undefined && input.resolvedLutRecordHash !== undefined,
    'INVALID_ARGUMENT',
    'resolved LUT identity is inconsistent',
  )
  const baseVersionId = identifier(input.baseVersionId, 'baseVersionId')
  assertDomain(input.durationFrames > 0 || input.outputReferences.length === 0, 'INVALID_ARGUMENT', 'outputs cannot exist before a renderable timeline')
  const seenArtifacts = new Set<string>()
  const outputs = input.outputReferences.map((item, index) => {
    const artifactId = identifier(item.artifactId, `outputReferences[${index}].artifactId`)
    const sourceVersionId = identifier(item.sourceVersionId, `outputReferences[${index}].sourceVersionId`)
    const variantId = identifier(item.variantId, `outputReferences[${index}].variantId`)
    assertDomain(item.kind === 'proxy' || item.kind === 'final', 'INVALID_ARGUMENT', `outputReferences[${index}].kind is invalid`)
    assertDomain(sourceVersionId === baseVersionId, 'INVALID_ARGUMENT', `outputReferences[${index}] belongs to another version`)
    assertDomain(!seenArtifacts.has(artifactId), 'INVALID_ARGUMENT', `outputReferences[${index}].artifactId is duplicated`)
    seenArtifacts.add(artifactId)
    return Object.freeze({ artifactId, sourceVersionId, variantId, kind: item.kind })
  }).sort((left, right) => `${left.kind}:${left.artifactId}`.localeCompare(`${right.kind}:${right.artifactId}`))
  const range = input.durationFrames > 0 ? Object.freeze({ startFrame: 0, endFrame: input.durationFrames }) : undefined
  const body = {
    schemaVersion: 'project-lut-selection-impact/v1' as const,
    commandId: identifier(input.commandId, 'commandId'),
    commandType: 'set-project-lut-selection' as const,
    baseVersionId,
    resultVersionId: identifier(input.resultVersionId, 'resultVersionId'),
    selectionId: identifier(input.selectionId, 'selectionId'),
    selectionHash: sha256(input.selectionHash, 'selectionHash'),
    resolvedMode: input.resolvedMode,
    resolvedLutVersionId: input.resolvedMode === 'lut-version' ? identifier(input.resolvedLutVersionId, 'resolvedLutVersionId') : null,
    resolvedLutRecordHash: input.resolvedMode === 'lut-version' ? sha256(input.resolvedLutRecordHash, 'resolvedLutRecordHash') : null,
    intensity: input.intensity,
    changeKinds: Object.freeze(['color-pipeline-selection'] as const),
    dependencyTypes: Object.freeze(['visual'] as const),
    affectedRanges: Object.freeze(range ? [range] : []),
    affectedVariantIds: Object.freeze([...new Set(outputs.map((item) => item.variantId))].sort()),
    affectedArtifacts: Object.freeze(outputs),
    minimalRenders: Object.freeze(range ? [Object.freeze({
      kind: 'proxy' as const,
      variantId: identifier(input.proxyVariantId, 'proxyVariantId'),
      ranges: Object.freeze([range]),
    })] : []),
    renderSemanticsChanged: true as const,
    renderDeferredUntilTimeline: input.durationFrames === 0,
  }
  return Object.freeze({ ...body, impactHash: calculateCanonicalHash(body) })
}

export function parseProjectLutSelectionImpact(value: unknown): Readonly<ProjectLutSelectionImpactV1> {
  const impact = record(value, 'project LUT selection impact') as unknown as ProjectLutSelectionImpactV1
  const expectedKeys = [
    'schemaVersion', 'commandId', 'commandType', 'baseVersionId', 'resultVersionId',
    'selectionId', 'selectionHash', 'resolvedMode', 'resolvedLutVersionId',
    'resolvedLutRecordHash', 'intensity', 'changeKinds', 'dependencyTypes',
    'affectedRanges', 'affectedVariantIds', 'affectedArtifacts', 'minimalRenders',
    'renderSemanticsChanged', 'renderDeferredUntilTimeline', 'impactHash',
  ].sort()
  const actualKeys = Object.keys(impact).sort()
  const affected = Array.isArray(impact.affectedRanges) ? impact.affectedRanges[0] : undefined
  const minimal = Array.isArray(impact.minimalRenders) ? impact.minimalRenders[0] : undefined
  const render = minimal && Array.isArray(minimal.ranges) ? minimal.ranges[0] : undefined
  assertDomain(actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index]), 'PERSISTENCE_CONFLICT', 'Stored project LUT selection impact fields are invalid')
  assertDomain(
    impact.schemaVersion === 'project-lut-selection-impact/v1' && impact.commandType === 'set-project-lut-selection' &&
    impact.renderSemanticsChanged === true && typeof impact.renderDeferredUntilTimeline === 'boolean' && JSON.stringify(impact.changeKinds) === JSON.stringify(['color-pipeline-selection']) &&
    JSON.stringify(impact.dependencyTypes) === JSON.stringify(['visual']) &&
    (impact.resolvedMode === 'none' || impact.resolvedMode === 'lut-version') &&
    Number.isFinite(impact.intensity) && impact.intensity >= 0 && impact.intensity <= 1 &&
    Array.isArray(impact.affectedRanges) && impact.affectedRanges.length === (impact.renderDeferredUntilTimeline ? 0 : 1) &&
    (impact.renderDeferredUntilTimeline || (affected?.startFrame === 0 && Number.isSafeInteger(affected?.endFrame) && Number(affected?.endFrame) > 0)) &&
    Array.isArray(impact.affectedVariantIds) && Array.isArray(impact.affectedArtifacts) &&
    Array.isArray(impact.minimalRenders) && impact.minimalRenders.length === (impact.renderDeferredUntilTimeline ? 0 : 1) &&
    (impact.renderDeferredUntilTimeline
      ? impact.affectedArtifacts.length === 0 && impact.affectedVariantIds.length === 0
      : minimal?.kind === 'proxy' && Array.isArray(minimal.ranges) && minimal.ranges.length === 1 && render?.startFrame === 0 && render?.endFrame === affected?.endFrame),
    'PERSISTENCE_CONFLICT',
    'Stored project LUT selection impact is invalid',
  )
  sha256(impact.impactHash, 'impactHash')
  const recreated = createProjectLutSelectionImpact({
    commandId: impact.commandId,
    baseVersionId: impact.baseVersionId,
    resultVersionId: impact.resultVersionId,
    selectionId: impact.selectionId,
    selectionHash: impact.selectionHash,
    resolvedMode: impact.resolvedMode,
    ...(impact.resolvedMode === 'lut-version'
      ? { resolvedLutVersionId: impact.resolvedLutVersionId!, resolvedLutRecordHash: impact.resolvedLutRecordHash! }
      : {}),
    intensity: impact.intensity,
    durationFrames: impact.renderDeferredUntilTimeline ? 0 : affected!.endFrame,
    proxyVariantId: impact.renderDeferredUntilTimeline ? 'deferred' : minimal!.variantId,
    outputReferences: impact.affectedArtifacts,
  })
  assertDomain(stableSerialize(recreated) === stableSerialize(impact), 'PERSISTENCE_CONFLICT', 'Stored project LUT selection impact is inconsistent')
  return Object.freeze(impact)
}

export function createProjectLutSelectionInvalidations(input: {
  impact: Readonly<ProjectLutSelectionImpactV1>
  createdAt: string
}): readonly Readonly<CommandArtifactInvalidationV1>[] {
  const impact = parseProjectLutSelectionImpact(input.impact)
  assertDomain(typeof input.createdAt === 'string' && !Number.isNaN(Date.parse(input.createdAt)), 'INVALID_ARGUMENT', 'createdAt must be an ISO timestamp')
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
    return Object.freeze({ ...identity, id: calculateCanonicalHash(identity) })
  }))
}
