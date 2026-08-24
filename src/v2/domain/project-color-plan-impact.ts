import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import type {
  CommandArtifactInvalidationV1,
  CommandImpactOutputReference,
  CommandImpactRange,
} from './command-impact.ts'
import { assertDomain } from './errors.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const SHA = /^[a-f0-9]{64}$/

function id(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

function sha(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && SHA.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

export interface ProjectColorPlanImpactV1 {
  schemaVersion: 'project-color-plan-impact/v1'
  commandId: string
  commandType: 'set-project-color-plan'
  baseVersionId: string
  resultVersionId: string
  colorPlanId: string
  colorPlanHash: string
  compiledManifestHash: string
  changeKinds: readonly ['color-plan']
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

export function createProjectColorPlanImpact(input: {
  commandId: string
  baseVersionId: string
  resultVersionId: string
  colorPlanId: string
  colorPlanHash: string
  compiledManifestHash: string
  durationFrames: number
  proxyVariantId: string
  outputReferences: readonly Readonly<CommandImpactOutputReference>[]
}): Readonly<ProjectColorPlanImpactV1> {
  assertDomain(
    Number.isSafeInteger(input.durationFrames) && input.durationFrames >= 0,
    'INVALID_ARGUMENT',
    'durationFrames is invalid',
  )
  const baseVersionId = id(input.baseVersionId, 'baseVersionId')
  assertDomain(
    input.durationFrames > 0 || input.outputReferences.length === 0,
    'INVALID_ARGUMENT',
    'outputs cannot exist before a renderable timeline',
  )
  const seen = new Set<string>()
  const outputs = input.outputReferences.map((output, index) => {
    const artifactId = id(output.artifactId, `outputReferences[${index}].artifactId`)
    assertDomain(!seen.has(artifactId), 'INVALID_ARGUMENT', `outputReferences[${index}] is duplicated`)
    seen.add(artifactId)
    assertDomain(output.kind === 'proxy' || output.kind === 'final', 'INVALID_ARGUMENT', `outputReferences[${index}].kind is invalid`)
    assertDomain(output.sourceVersionId === baseVersionId, 'INVALID_ARGUMENT', `outputReferences[${index}] belongs to another version`)
    return Object.freeze({
      artifactId,
      kind: output.kind,
      sourceVersionId: id(output.sourceVersionId, `outputReferences[${index}].sourceVersionId`),
      variantId: id(output.variantId, `outputReferences[${index}].variantId`),
    })
  }).sort((left, right) => `${left.kind}:${left.artifactId}`.localeCompare(`${right.kind}:${right.artifactId}`))
  const range = input.durationFrames > 0
    ? Object.freeze({ startFrame: 0, endFrame: input.durationFrames })
    : undefined
  const body = Object.freeze({
    schemaVersion: 'project-color-plan-impact/v1' as const,
    commandId: id(input.commandId, 'commandId'),
    commandType: 'set-project-color-plan' as const,
    baseVersionId,
    resultVersionId: id(input.resultVersionId, 'resultVersionId'),
    colorPlanId: id(input.colorPlanId, 'colorPlanId'),
    colorPlanHash: sha(input.colorPlanHash, 'colorPlanHash'),
    compiledManifestHash: sha(input.compiledManifestHash, 'compiledManifestHash'),
    changeKinds: Object.freeze(['color-plan'] as const),
    dependencyTypes: Object.freeze(['visual'] as const),
    affectedRanges: Object.freeze(range ? [range] : []),
    affectedVariantIds: Object.freeze([...new Set(outputs.map((output) => output.variantId))].sort()),
    affectedArtifacts: Object.freeze(outputs),
    minimalRenders: Object.freeze(range ? [Object.freeze({
      kind: 'proxy' as const,
      variantId: id(input.proxyVariantId, 'proxyVariantId'),
      ranges: Object.freeze([range]),
    })] : []),
    renderSemanticsChanged: true as const,
    renderDeferredUntilTimeline: input.durationFrames === 0,
  })
  return Object.freeze({ ...body, impactHash: calculateCanonicalHash(body) })
}

export function parseProjectColorPlanImpact(value: unknown): Readonly<ProjectColorPlanImpactV1> {
  assertDomain(value !== null && typeof value === 'object' && !Array.isArray(value), 'PERSISTENCE_CONFLICT', 'Stored project ColorPlan impact is invalid')
  const impact = value as ProjectColorPlanImpactV1
  const range = impact.affectedRanges?.[0]
  const minimal = impact.minimalRenders?.[0]
  const recreated = createProjectColorPlanImpact({
    commandId: impact.commandId,
    baseVersionId: impact.baseVersionId,
    resultVersionId: impact.resultVersionId,
    colorPlanId: impact.colorPlanId,
    colorPlanHash: impact.colorPlanHash,
    compiledManifestHash: impact.compiledManifestHash,
    durationFrames: impact.renderDeferredUntilTimeline ? 0 : range?.endFrame ?? -1,
    proxyVariantId: impact.renderDeferredUntilTimeline ? 'deferred' : minimal?.variantId ?? '',
    outputReferences: impact.affectedArtifacts ?? [],
  })
  assertDomain(stableSerialize(recreated) === stableSerialize(impact), 'PERSISTENCE_CONFLICT', 'Stored project ColorPlan impact is inconsistent')
  return recreated
}

export function createProjectColorPlanInvalidations(input: {
  impact: Readonly<ProjectColorPlanImpactV1>
  createdAt: string
}): readonly Readonly<CommandArtifactInvalidationV1>[] {
  const impact = parseProjectColorPlanImpact(input.impact)
  assertDomain(!Number.isNaN(Date.parse(input.createdAt)), 'INVALID_ARGUMENT', 'createdAt is invalid')
  return Object.freeze(impact.affectedArtifacts.map((artifact) => {
    const identity = Object.freeze({
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
    return Object.freeze({ ...identity, id: calculateCanonicalHash(identity) })
  }))
}
