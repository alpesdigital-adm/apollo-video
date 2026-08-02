import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import type { CommandArtifactInvalidationV1, CommandImpactOutputReference, CommandImpactRange } from './command-impact.ts'
import { assertDomain } from './errors.ts'

export interface EditorialCutImpactV1 {
  schemaVersion: 'editorial-cut-impact/v1'
  commandId: string
  commandType: 'remove-spoken-content'
  baseVersionId: string
  resultVersionId: string
  sourceTranscriptId: string
  sourceTranscriptHash: string
  changeKinds: readonly ['spoken-content-removal']
  dependencyTypes: readonly ['audio', 'content', 'timing', 'visual']
  affectedRanges: readonly Readonly<CommandImpactRange>[]
  affectedVariantIds: readonly string[]
  affectedArtifacts: readonly Readonly<CommandImpactOutputReference>[]
  minimalRenders: readonly Readonly<{
    kind: 'proxy'
    variantId: string
    ranges: readonly Readonly<CommandImpactRange>[]
  }>[]
  renderSemanticsChanged: true
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

export function createEditorialCutImpact(input: {
  commandId: string
  baseVersionId: string
  resultVersionId: string
  sourceTranscriptId: string
  sourceTranscriptHash: string
  affectedEndFrame: number
  renderEndFrame: number
  proxyVariantId: string
  outputReferences: readonly Readonly<CommandImpactOutputReference>[]
}): Readonly<EditorialCutImpactV1> {
  assertDomain(Number.isSafeInteger(input.affectedEndFrame) && input.affectedEndFrame > 0, 'INVALID_ARGUMENT', 'affectedEndFrame is invalid')
  assertDomain(Number.isSafeInteger(input.renderEndFrame) && input.renderEndFrame > 0 && input.renderEndFrame <= input.affectedEndFrame, 'INVALID_ARGUMENT', 'renderEndFrame is invalid')
  const baseVersionId = identifier(input.baseVersionId, 'baseVersionId')
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
  const affectedRanges = Object.freeze([Object.freeze({ startFrame: 0, endFrame: input.affectedEndFrame })])
  const renderRanges = Object.freeze([Object.freeze({ startFrame: 0, endFrame: input.renderEndFrame })])
  const affectedVariantIds = Object.freeze([...new Set(outputs.map((item) => item.variantId))].sort())
  const proxyVariantId = identifier(input.proxyVariantId, 'proxyVariantId')
  const body = {
    schemaVersion: 'editorial-cut-impact/v1' as const,
    commandId: identifier(input.commandId, 'commandId'),
    commandType: 'remove-spoken-content' as const,
    baseVersionId,
    resultVersionId: identifier(input.resultVersionId, 'resultVersionId'),
    sourceTranscriptId: identifier(input.sourceTranscriptId, 'sourceTranscriptId'),
    sourceTranscriptHash: sha256(input.sourceTranscriptHash, 'sourceTranscriptHash'),
    changeKinds: Object.freeze(['spoken-content-removal'] as const),
    dependencyTypes: Object.freeze(['audio', 'content', 'timing', 'visual'] as const),
    affectedRanges,
    affectedVariantIds,
    affectedArtifacts: Object.freeze(outputs),
    minimalRenders: Object.freeze([Object.freeze({ kind: 'proxy' as const, variantId: proxyVariantId, ranges: renderRanges })]),
    renderSemanticsChanged: true as const,
  }
  return Object.freeze({ ...body, impactHash: calculateCanonicalHash(body) })
}

export function parseEditorialCutImpact(value: unknown): Readonly<EditorialCutImpactV1> {
  const impact = record(value, 'Editorial cut impact') as unknown as EditorialCutImpactV1
  const expectedKeys = [
    'schemaVersion', 'commandId', 'commandType', 'baseVersionId', 'resultVersionId',
    'sourceTranscriptId', 'sourceTranscriptHash', 'changeKinds', 'dependencyTypes',
    'affectedRanges', 'affectedVariantIds', 'affectedArtifacts', 'minimalRenders',
    'renderSemanticsChanged', 'impactHash',
  ].sort()
  const actualKeys = Object.keys(impact).sort()
  assertDomain(actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index]), 'PERSISTENCE_CONFLICT', 'Stored editorial cut impact fields are invalid')
  assertDomain(
    impact.schemaVersion === 'editorial-cut-impact/v1' && impact.commandType === 'remove-spoken-content' &&
    impact.renderSemanticsChanged === true && JSON.stringify(impact.changeKinds) === JSON.stringify(['spoken-content-removal']) &&
    JSON.stringify(impact.dependencyTypes) === JSON.stringify(['audio', 'content', 'timing', 'visual']) &&
    Array.isArray(impact.affectedRanges) && impact.affectedRanges.length === 1 && impact.affectedRanges[0]?.startFrame === 0 &&
    Number.isSafeInteger(impact.affectedRanges[0]?.endFrame) && Number(impact.affectedRanges[0]?.endFrame) > 0 &&
    Array.isArray(impact.affectedVariantIds) && Array.isArray(impact.affectedArtifacts) &&
    Array.isArray(impact.minimalRenders) && impact.minimalRenders.length === 1 &&
    impact.minimalRenders[0]?.kind === 'proxy' && Array.isArray(impact.minimalRenders[0].ranges) &&
    impact.minimalRenders[0].ranges.length === 1 && impact.minimalRenders[0].ranges[0]?.startFrame === 0 &&
    Number.isSafeInteger(impact.minimalRenders[0].ranges[0]?.endFrame) &&
    Number(impact.minimalRenders[0].ranges[0]?.endFrame) > 0 &&
    Number(impact.minimalRenders[0].ranges[0]?.endFrame) <= Number(impact.affectedRanges[0]?.endFrame),
    'PERSISTENCE_CONFLICT',
    'Stored editorial cut impact is invalid',
  )
  identifier(impact.commandId, 'impact commandId')
  identifier(impact.baseVersionId, 'impact baseVersionId')
  identifier(impact.resultVersionId, 'impact resultVersionId')
  identifier(impact.sourceTranscriptId, 'impact sourceTranscriptId')
  sha256(impact.sourceTranscriptHash, 'impact sourceTranscriptHash')
  sha256(impact.impactHash, 'impactHash')
  const recreated = createEditorialCutImpact({
    commandId: impact.commandId,
    baseVersionId: impact.baseVersionId,
    resultVersionId: impact.resultVersionId,
    sourceTranscriptId: impact.sourceTranscriptId,
    sourceTranscriptHash: impact.sourceTranscriptHash,
    affectedEndFrame: impact.affectedRanges[0]!.endFrame,
    renderEndFrame: impact.minimalRenders[0]!.ranges[0]!.endFrame,
    proxyVariantId: impact.minimalRenders[0]!.variantId,
    outputReferences: impact.affectedArtifacts,
  })
  assertDomain(stableSerialize(recreated) === stableSerialize(impact), 'PERSISTENCE_CONFLICT', 'Stored editorial cut impact is inconsistent')
  return Object.freeze(impact)
}

export function createEditorialCutInvalidations(input: {
  impact: Readonly<EditorialCutImpactV1>
  createdAt: string
}): readonly Readonly<CommandArtifactInvalidationV1>[] {
  const impact = parseEditorialCutImpact(input.impact)
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
