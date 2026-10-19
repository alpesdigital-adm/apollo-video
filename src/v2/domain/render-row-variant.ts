import { outputVariantsOf, type OutputConsumptionState } from './output-consumption.ts'

/** What a persisted render operation says about the output it was made for. A final export also names its aspect ratio; a proxy does not. */
export type RenderRowFacts = Readonly<{ outputVariantId: string | null; outputAspectRatio?: string | null }>

/**
 * Whether a persisted render (of any Version of the project) was made for the output `variantId` of `state`.
 *
 * A render made after the output was recorded names its stable State variant (`outputVariantId`) and that is the whole answer.
 * A row written before the column existed (null) belongs to an output only when that is exact: a final export names its aspect
 * ratio, which must be the ratio of that output and of no other output of the State; a proxy names nothing, so it belongs to the
 * State's only output. Anything else is not evidence for this output (it never marks, selects or aligns the wrong one).
 */
export function renderRowIsOfVariant(state: OutputConsumptionState, row: RenderRowFacts, variantId: string): boolean {
  if (typeof row.outputVariantId === 'string') return row.outputVariantId === variantId
  const variants = outputVariantsOf(state)
  const target = variants.find((variant) => variant.variantId === variantId)
  if (!target) return false
  if (row.outputAspectRatio !== undefined && row.outputAspectRatio !== null) {
    return target.aspectRatio === row.outputAspectRatio &&
      variants.filter((variant) => variant.aspectRatio === row.outputAspectRatio).length === 1
  }
  return variants.length === 1
}

/** The renders that belong to one output of `state`, in the order given. */
export function renderRowsOfVariant<Row extends RenderRowFacts>(state: OutputConsumptionState, rows: readonly Row[], variantId: string): readonly Row[] {
  return rows.filter((row) => renderRowIsOfVariant(state, row, variantId))
}
