import type { CommandImpactOutputReference, CommandImpactRange } from './command-impact.ts'
import { assertDomain } from './errors.ts'

/**
 * What a PROJECT-WIDE Command (a LUT selection, a ColorPlan, a Director re-run) says about the renders of a project.
 *
 * Such a Command changes the ONE EditPlan every output of the project re-materializes from, so every output's renders go stale and
 * every output needs its own minimal proxy render. The impact therefore carries the State's variant ids (the stable ids of the
 * outputs the Command's child Version carries) and lists exactly one minimal proxy render per variant, never "the" proxy variant.
 */
export type ProjectWideProxyRender = Readonly<{
  kind: 'proxy'
  variantId: string
  ranges: readonly Readonly<CommandImpactRange>[]
}>

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

/**
 * The State's variant ids as an impact states them: a duplicate-free list of stable ids, sorted so the document does not depend on
 * the order the State happens to list its entries in. A Command with a renderable timeline needs at least one output.
 */
export function projectWideVariantIds(value: unknown, renderable: boolean): readonly string[] {
  assertDomain(Array.isArray(value), 'INVALID_ARGUMENT', 'variantIds must be a list')
  const ids = (value as readonly unknown[]).map((item, index) => {
    assertDomain(typeof item === 'string' && ID.test(item), 'INVALID_ARGUMENT', `variantIds[${index}] is invalid`)
    return item as string
  })
  assertDomain(new Set(ids).size === ids.length, 'INVALID_ARGUMENT', 'variantIds are duplicated')
  assertDomain(!renderable || ids.length > 0, 'INVALID_ARGUMENT', 'variantIds must name every output of a renderable project')
  return Object.freeze([...ids].sort())
}

/** Every render the Command lists belongs to an output the State carries: attributing a render to a stranger would stale the wrong output. */
export function assertRendersBelongToVariants(
  renders: readonly Readonly<Pick<CommandImpactOutputReference, 'variantId'>>[],
  variantIds: readonly string[],
): void {
  for (const [index, render] of renders.entries()) {
    assertDomain(variantIds.includes(render.variantId), 'INVALID_ARGUMENT', `outputReferences[${index}].variantId is not an output of the project`)
  }
}

/** One minimal proxy render per variant, all over the same range, in variant order. */
export function projectWideProxyRenders(
  variantIds: readonly string[],
  range: Readonly<CommandImpactRange> | undefined,
): readonly ProjectWideProxyRender[] {
  if (!range) return Object.freeze([])
  return Object.freeze(variantIds.map((variantId) => Object.freeze({
    kind: 'proxy' as const,
    variantId,
    ranges: Object.freeze([range]),
  })))
}

function isRange(value: unknown): value is CommandImpactRange {
  if (typeof value !== 'object' || value === null) return false
  const range = value as Record<string, unknown>
  return Number.isSafeInteger(range.startFrame) && Number.isSafeInteger(range.endFrame)
}

/**
 * Whether a stored minimal render is a proxy render of exactly one range starting at frame 0. `endFrame` is checked by the caller
 * against the Command's own rule (the whole timeline for a LUT selection or a ColorPlan, at most the affected range for a Director).
 */
export function isProxyRenderFromStart(value: unknown): value is ProjectWideProxyRender {
  if (typeof value !== 'object' || value === null) return false
  const render = value as Record<string, unknown>
  return render.kind === 'proxy' && typeof render.variantId === 'string' && Array.isArray(render.ranges) &&
    render.ranges.length === 1 && isRange(render.ranges[0]) && (render.ranges[0] as CommandImpactRange).startFrame === 0 &&
    (render.ranges[0] as CommandImpactRange).endFrame > 0
}
