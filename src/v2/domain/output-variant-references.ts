import { DomainError } from './errors.ts'
import { outputVariantsOf, type OutputConsumptionState } from './output-consumption.ts'
import type { CommandImpactOutputReference } from './command-impact.ts'

/**
 * Which output of a project a persisted render belongs to.
 *
 * A proxy render or a final export is made for ONE output: the stable State variant its sealed consumption named at enqueue
 * (`outputVariantId`). Impact, stale outputs and sidecars name that variant, never an aspect ratio and never a guess.
 *
 * A row written before the column existed (null) is resolved only when the answer is exact: a final export names its aspect
 * ratio, which must be the ratio of exactly one output of the State; a proxy names nothing, so it belongs to the State's only
 * output. Anything else is a conflict, because attributing a render to the wrong output would mark the wrong outputs stale.
 */
export type RenderOperationVariantFacts = Readonly<{
  outputVariantId: string | null
  /** The aspect ratio a final export carries; absent for a proxy. */
  outputAspectRatio?: string | null
}>

export function renderOperationVariantId(state: OutputConsumptionState, row: RenderOperationVariantFacts): string {
  const variants = outputVariantsOf(state)
  if (row.outputVariantId !== null) {
    if (!variants.some((variant) => variant.variantId === row.outputVariantId)) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'A render operation names an output its Version does not carry')
    }
    return row.outputVariantId
  }
  if (row.outputAspectRatio !== undefined && row.outputAspectRatio !== null) {
    const matches = variants.filter((variant) => variant.aspectRatio === row.outputAspectRatio)
    if (matches.length === 1) return matches[0]!.variantId
    throw new DomainError('PERSISTENCE_CONFLICT', 'A final export without a stated output matches no single output of its Version')
  }
  if (variants.length === 1) return variants[0]!.variantId
  throw new DomainError('PERSISTENCE_CONFLICT', 'A proxy render without a stated output cannot be attributed in a Version with several outputs')
}

/**
 * The renders of one Version as the output references an impact document lists, each attributed to its output. Sorted by kind and
 * artifact, which is the order the Command's sealed `affectedArtifacts` use.
 */
export function renderOutputReferences(input: Readonly<{
  state: OutputConsumptionState
  sourceVersionId: string
  proxies: readonly Readonly<{ outputArtifactId: string; outputVariantId: string | null }>[]
  finals: readonly Readonly<{ outputArtifactId: string; outputVariantId: string | null; outputAspectRatio: string }>[]
}>): readonly Readonly<CommandImpactOutputReference>[] {
  return Object.freeze([
    ...input.proxies.map((row) => Object.freeze({ artifactId: row.outputArtifactId, kind: 'proxy' as const,
      sourceVersionId: input.sourceVersionId, variantId: renderOperationVariantId(input.state, row) })),
    ...input.finals.map((row) => Object.freeze({ artifactId: row.outputArtifactId, kind: 'final' as const,
      sourceVersionId: input.sourceVersionId, variantId: renderOperationVariantId(input.state, row) })),
  ].toSorted((left, right) => `${left.kind}:${left.artifactId}`.localeCompare(`${right.kind}:${right.artifactId}`)))
}

/** The renders that belong to one output (the others stay valid when a variant-specific Command changes only that output). */
export function referencesOfVariant(references: readonly Readonly<CommandImpactOutputReference>[], variantId: string): readonly Readonly<CommandImpactOutputReference>[] {
  return Object.freeze(references.filter((reference) => reference.variantId === variantId))
}
