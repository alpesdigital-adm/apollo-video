import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import type { CommandArtifactInvalidationV1, CommandImpactOutputReference, CommandImpactRange } from './command-impact.ts'
import { assertDomain } from './errors.ts'

export interface DirectorRunImpactV1 {
  schemaVersion: 'director-run-impact/v1'
  commandId: string
  commandType: 'run-director'
  baseVersionId: string
  resultVersionId: string
  sourceTranscriptId: string
  sourceTranscriptHash: string
  plannerVersion: string
  criticVersion: string
  changeKinds: readonly ['director-replan']
  dependencyTypes: readonly ['audio', 'content', 'policy', 'timing', 'visual']
  affectedRanges: readonly Readonly<CommandImpactRange>[]
  affectedVariantIds: readonly string[]
  affectedArtifacts: readonly Readonly<CommandImpactOutputReference>[]
  minimalRenders: readonly Readonly<{ kind: 'proxy'; variantId: string; ranges: readonly Readonly<CommandImpactRange>[] }>[]
  renderSemanticsChanged: true
  impactHash: string
}

type MutableRecord = Record<string, unknown>
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/

function identifier(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

function version(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && VERSION.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
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

export function createDirectorRunImpact(input: {
  commandId: string
  baseVersionId: string
  resultVersionId: string
  sourceTranscriptId: string
  sourceTranscriptHash: string
  plannerVersion: string
  criticVersion: string
  affectedEndFrame: number
  renderEndFrame: number
  proxyVariantId: string
  outputReferences: readonly Readonly<CommandImpactOutputReference>[]
}): Readonly<DirectorRunImpactV1> {
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
  const proxyVariantId = identifier(input.proxyVariantId, 'proxyVariantId')
  const body = {
    schemaVersion: 'director-run-impact/v1' as const,
    commandId: identifier(input.commandId, 'commandId'), commandType: 'run-director' as const,
    baseVersionId, resultVersionId: identifier(input.resultVersionId, 'resultVersionId'),
    sourceTranscriptId: identifier(input.sourceTranscriptId, 'sourceTranscriptId'),
    sourceTranscriptHash: sha256(input.sourceTranscriptHash, 'sourceTranscriptHash'),
    plannerVersion: version(input.plannerVersion, 'plannerVersion'),
    criticVersion: version(input.criticVersion, 'criticVersion'),
    changeKinds: Object.freeze(['director-replan'] as const),
    dependencyTypes: Object.freeze(['audio', 'content', 'policy', 'timing', 'visual'] as const),
    affectedRanges,
    affectedVariantIds: Object.freeze([...new Set(outputs.map((item) => item.variantId))].sort()),
    affectedArtifacts: Object.freeze(outputs),
    minimalRenders: Object.freeze([Object.freeze({ kind: 'proxy' as const, variantId: proxyVariantId, ranges: renderRanges })]),
    renderSemanticsChanged: true as const,
  }
  return Object.freeze({ ...body, impactHash: calculateCanonicalHash(body) })
}

export function parseDirectorRunImpact(value: unknown): Readonly<DirectorRunImpactV1> {
  const impact = record(value, 'DirectorRun impact') as unknown as DirectorRunImpactV1
  const expectedKeys = [
    'schemaVersion', 'commandId', 'commandType', 'baseVersionId', 'resultVersionId',
    'sourceTranscriptId', 'sourceTranscriptHash', 'plannerVersion', 'criticVersion',
    'changeKinds', 'dependencyTypes', 'affectedRanges', 'affectedVariantIds',
    'affectedArtifacts', 'minimalRenders', 'renderSemanticsChanged', 'impactHash',
  ].sort()
  const actualKeys = Object.keys(impact).sort()
  assertDomain(actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index]), 'PERSISTENCE_CONFLICT', 'Stored DirectorRun impact fields are invalid')
  const affected = Array.isArray(impact.affectedRanges) ? impact.affectedRanges[0] : undefined
  const minimal = Array.isArray(impact.minimalRenders) ? impact.minimalRenders[0] : undefined
  const render = minimal && Array.isArray(minimal.ranges) ? minimal.ranges[0] : undefined
  assertDomain(
    impact.schemaVersion === 'director-run-impact/v1' && impact.commandType === 'run-director' &&
    impact.renderSemanticsChanged === true && JSON.stringify(impact.changeKinds) === JSON.stringify(['director-replan']) &&
    JSON.stringify(impact.dependencyTypes) === JSON.stringify(['audio', 'content', 'policy', 'timing', 'visual']) &&
    Array.isArray(impact.affectedRanges) && impact.affectedRanges.length === 1 && affected?.startFrame === 0 &&
    Number.isSafeInteger(affected?.endFrame) && Number(affected?.endFrame) > 0 &&
    Array.isArray(impact.affectedVariantIds) && Array.isArray(impact.affectedArtifacts) &&
    Array.isArray(impact.minimalRenders) && impact.minimalRenders.length === 1 && minimal?.kind === 'proxy' &&
    Array.isArray(minimal?.ranges) && minimal.ranges.length === 1 && render?.startFrame === 0 &&
    Number.isSafeInteger(render?.endFrame) && Number(render?.endFrame) > 0 && Number(render?.endFrame) <= Number(affected?.endFrame),
    'PERSISTENCE_CONFLICT',
    'Stored DirectorRun impact is invalid',
  )
  sha256(impact.impactHash, 'impactHash')
  const recreated = createDirectorRunImpact({
    commandId: impact.commandId, baseVersionId: impact.baseVersionId, resultVersionId: impact.resultVersionId,
    sourceTranscriptId: impact.sourceTranscriptId, sourceTranscriptHash: impact.sourceTranscriptHash,
    plannerVersion: impact.plannerVersion, criticVersion: impact.criticVersion,
    affectedEndFrame: affected!.endFrame, renderEndFrame: render!.endFrame,
    proxyVariantId: impact.minimalRenders[0]!.variantId, outputReferences: impact.affectedArtifacts,
  })
  assertDomain(stableSerialize(recreated) === stableSerialize(impact), 'PERSISTENCE_CONFLICT', 'Stored DirectorRun impact is inconsistent')
  return Object.freeze(impact)
}

export function createDirectorRunInvalidations(input: {
  impact: Readonly<DirectorRunImpactV1>
  createdAt: string
}): readonly Readonly<CommandArtifactInvalidationV1>[] {
  const impact = parseDirectorRunImpact(input.impact)
  assertDomain(typeof input.createdAt === 'string' && !Number.isNaN(Date.parse(input.createdAt)), 'INVALID_ARGUMENT', 'createdAt must be an ISO timestamp')
  return Object.freeze(impact.affectedArtifacts.map((artifact) => {
    const identity = {
      schemaVersion: 'command-artifact-invalidation/v1' as const, status: 'stale' as const,
      commandId: impact.commandId, baseVersionId: impact.baseVersionId, resultVersionId: impact.resultVersionId,
      artifactId: artifact.artifactId, kind: artifact.kind, variantId: artifact.variantId,
      dependencyTypes: impact.dependencyTypes, affectedRanges: impact.affectedRanges,
      impactHash: impact.impactHash, createdAt: input.createdAt,
    }
    return Object.freeze({ ...identity, id: calculateCanonicalHash(identity) })
  }))
}
