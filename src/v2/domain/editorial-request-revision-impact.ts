import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import type {
  CommandArtifactInvalidationV1,
  CommandImpactDependency,
  CommandImpactOutputReference,
  CommandImpactRange,
} from './command-impact.ts'
import { assertDomain } from './errors.ts'

export interface EditorialRequestRevisionImpactV1 {
  schemaVersion: 'editorial-request-revision-impact/v1'
  commandId: string
  commandType: 'revise-editorial-request'
  baseVersionId: string
  resultVersionId: string
  briefSnapshotId: string
  briefSnapshotHash: string
  previousRequestHash: string
  resultRequestHash: string
  changeKinds: readonly ['editorial-request']
  dependencyTypes: readonly CommandImpactDependency[]
  affectedRanges: readonly Readonly<CommandImpactRange>[]
  affectedVariantIds: readonly string[]
  affectedArtifacts: readonly Readonly<CommandImpactOutputReference>[]
  requiredRecomputations: readonly ['treatment', 'story', 'edit-plan', 'proxy', 'final']
  renderSemanticsChanged: boolean
  renderBlockedUntilDirectorRun: true
  impactHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
function identifier(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}
function sha256(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}
function record(value: unknown, field: string): Record<string, unknown> {
  assertDomain(typeof value === 'object' && value !== null && !Array.isArray(value), 'INVALID_ARGUMENT', `${field} must be an object`)
  return value as Record<string, unknown>
}

export function createEditorialRequestRevisionImpact(input: {
  commandId: string
  baseVersionId: string
  resultVersionId: string
  briefSnapshotId: string
  briefSnapshotHash: string
  previousRequestHash: string
  resultRequestHash: string
  durationFrames: number
  outputReferences: readonly Readonly<CommandImpactOutputReference>[]
}): Readonly<EditorialRequestRevisionImpactV1> {
  assertDomain(Number.isSafeInteger(input.durationFrames) && input.durationFrames >= 0, 'INVALID_ARGUMENT', 'durationFrames is invalid')
  const baseVersionId = identifier(input.baseVersionId, 'baseVersionId')
  const renderSemanticsChanged = sha256(input.previousRequestHash, 'previousRequestHash') !== sha256(input.resultRequestHash, 'resultRequestHash')
  const seen = new Set<string>()
  const outputs = input.outputReferences.map((item, index) => {
    const artifactId = identifier(item.artifactId, `outputReferences[${index}].artifactId`)
    assertDomain(item.kind === 'proxy' || item.kind === 'final', 'INVALID_ARGUMENT', `outputReferences[${index}].kind is invalid`)
    assertDomain(identifier(item.sourceVersionId, `outputReferences[${index}].sourceVersionId`) === baseVersionId, 'INVALID_ARGUMENT', `outputReferences[${index}] belongs to another version`)
    assertDomain(!seen.has(artifactId), 'INVALID_ARGUMENT', `outputReferences[${index}].artifactId is duplicated`)
    seen.add(artifactId)
    return Object.freeze({ artifactId, kind: item.kind, sourceVersionId: baseVersionId, variantId: identifier(item.variantId, `outputReferences[${index}].variantId`) })
  }).toSorted((left, right) => `${left.kind}:${left.artifactId}`.localeCompare(`${right.kind}:${right.artifactId}`))
  assertDomain(input.durationFrames > 0 || outputs.length === 0, 'INVALID_ARGUMENT', 'outputs cannot exist before a renderable timeline')
  const affectedOutputs = renderSemanticsChanged ? outputs : []
  const range = renderSemanticsChanged && input.durationFrames > 0
    ? Object.freeze({ startFrame: 0, endFrame: input.durationFrames })
    : undefined
  const body = Object.freeze({
    schemaVersion: 'editorial-request-revision-impact/v1' as const,
    commandId: identifier(input.commandId, 'commandId'),
    commandType: 'revise-editorial-request' as const,
    baseVersionId,
    resultVersionId: identifier(input.resultVersionId, 'resultVersionId'),
    briefSnapshotId: identifier(input.briefSnapshotId, 'briefSnapshotId'),
    briefSnapshotHash: sha256(input.briefSnapshotHash, 'briefSnapshotHash'),
    previousRequestHash: input.previousRequestHash,
    resultRequestHash: input.resultRequestHash,
    changeKinds: Object.freeze(['editorial-request'] as const),
    dependencyTypes: Object.freeze((renderSemanticsChanged ? ['content', 'policy', 'visual'] : ['policy']) as CommandImpactDependency[]),
    affectedRanges: Object.freeze(range ? [range] : []),
    affectedVariantIds: Object.freeze([...new Set(affectedOutputs.map((item) => item.variantId))].sort()),
    affectedArtifacts: Object.freeze(affectedOutputs),
    requiredRecomputations: Object.freeze(['treatment', 'story', 'edit-plan', 'proxy', 'final'] as const),
    renderSemanticsChanged,
    renderBlockedUntilDirectorRun: true as const,
  })
  return Object.freeze({ ...body, impactHash: calculateCanonicalHash(body) })
}

export function parseEditorialRequestRevisionImpact(value: unknown): Readonly<EditorialRequestRevisionImpactV1> {
  const impact = record(value, 'editorial request revision impact') as unknown as EditorialRequestRevisionImpactV1
  const expected = [
    'schemaVersion', 'commandId', 'commandType', 'baseVersionId', 'resultVersionId',
    'briefSnapshotId', 'briefSnapshotHash', 'previousRequestHash', 'resultRequestHash',
    'changeKinds', 'dependencyTypes', 'affectedRanges', 'affectedVariantIds',
    'affectedArtifacts', 'requiredRecomputations', 'renderSemanticsChanged',
    'renderBlockedUntilDirectorRun', 'impactHash',
  ].toSorted()
  const actual = Object.keys(impact).toSorted()
  assertDomain(actual.length === expected.length && actual.every((key, index) => key === expected[index]), 'PERSISTENCE_CONFLICT', 'Stored editorial request impact fields are invalid')
  const range = Array.isArray(impact.affectedRanges) ? impact.affectedRanges[0] : undefined
  assertDomain(
    impact.schemaVersion === 'editorial-request-revision-impact/v1' && impact.commandType === 'revise-editorial-request' &&
    impact.renderBlockedUntilDirectorRun === true && typeof impact.renderSemanticsChanged === 'boolean' &&
    JSON.stringify(impact.changeKinds) === JSON.stringify(['editorial-request']) &&
    JSON.stringify(impact.requiredRecomputations) === JSON.stringify(['treatment', 'story', 'edit-plan', 'proxy', 'final']) &&
    Array.isArray(impact.dependencyTypes) && Array.isArray(impact.affectedRanges) && Array.isArray(impact.affectedVariantIds) && Array.isArray(impact.affectedArtifacts) &&
    (impact.renderSemanticsChanged
      ? JSON.stringify(impact.dependencyTypes) === JSON.stringify(['content', 'policy', 'visual']) && impact.affectedRanges.length <= 1 && (impact.affectedRanges.length === 0 || (range?.startFrame === 0 && Number.isSafeInteger(range?.endFrame) && Number(range?.endFrame) > 0))
      : JSON.stringify(impact.dependencyTypes) === JSON.stringify(['policy']) && impact.affectedRanges.length === 0 && impact.affectedArtifacts.length === 0 && impact.affectedVariantIds.length === 0),
    'PERSISTENCE_CONFLICT',
    'Stored editorial request impact is invalid',
  )
  const recreated = createEditorialRequestRevisionImpact({
    commandId: impact.commandId,
    baseVersionId: impact.baseVersionId,
    resultVersionId: impact.resultVersionId,
    briefSnapshotId: impact.briefSnapshotId,
    briefSnapshotHash: impact.briefSnapshotHash,
    previousRequestHash: impact.previousRequestHash,
    resultRequestHash: impact.resultRequestHash,
    durationFrames: range?.endFrame ?? 0,
    outputReferences: impact.affectedArtifacts,
  })
  sha256(impact.impactHash, 'impactHash')
  assertDomain(stableSerialize(recreated) === stableSerialize(impact), 'PERSISTENCE_CONFLICT', 'Stored editorial request impact is inconsistent')
  return Object.freeze(impact)
}

export function createEditorialRequestRevisionInvalidations(input: {
  impact: Readonly<EditorialRequestRevisionImpactV1>
  createdAt: string
}): readonly Readonly<CommandArtifactInvalidationV1>[] {
  const impact = parseEditorialRequestRevisionImpact(input.impact)
  assertDomain(!Number.isNaN(Date.parse(input.createdAt)), 'INVALID_ARGUMENT', 'createdAt is invalid')
  return Object.freeze(impact.affectedArtifacts.map((artifact) => {
    const body = Object.freeze({
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
    })
    return Object.freeze({ ...body, id: calculateCanonicalHash(body) })
  }))
}
