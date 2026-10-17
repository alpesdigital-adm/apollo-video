/** Any sealed bundle of the project (a creation root, an operational head or the child about to replace it): it only needs its State's entries. */
type BundleWithState = Readonly<{ state: Readonly<{ document: Readonly<{ entries: readonly Readonly<{ spec: unknown }>[] }> }> }>

/**
 * The format the single-output flows (LUT selection, ColorPlan, policy overrides, Director and the multicam cut) call the
 * project's format: the aspect ratio their proxy and final outputs are keyed by.
 *
 * A project created under 6.0.0 has no format of its own (`projects.format` is null by the creation guard); what it has is its
 * explicit output variants. A project with exactly one output keeps the contract these flows always had: that output's aspect
 * ratio is its format. A project with several outputs has no single format: the answer is `null`, and each caller refuses with
 * its own "context is incomplete" instead of guessing which output it meant. An output whose spec carries no aspect ratio of its
 * own (a fork's inherited one) is also `null`.
 */
export function projectOutputFormat(project: Readonly<{ format: string | null }>, bundle: BundleWithState): string | null {
  if (project.format) return project.format
  const entries = bundle.state.document.entries
  if (entries.length !== 1) return null
  const ratio = (entries[0]!.spec as { output?: { aspectRatio?: unknown } }).output?.aspectRatio
  return typeof ratio === 'string' && ratio.length > 0 ? ratio : null
}
