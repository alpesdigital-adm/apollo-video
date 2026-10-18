import { DomainError } from '../../domain/errors.ts'
import { outputEntryAspectRatio } from '../../domain/output-consumption.ts'

/** Any sealed bundle of the project (a creation root, an operational head or the child about to replace it): it only needs its State's entries. */
type BundleWithState = Readonly<{ state: Readonly<{ document: Readonly<{ entries: readonly Readonly<{ spec: unknown }>[] }> }> }>

/**
 * The format the single-output flows (LUT selection, ColorPlan, policy overrides, Director and the multicam cut) call the
 * project's format: the aspect ratio their proxy and final outputs are keyed by.
 *
 * A project created under 6.0.0 has no format of its own (`projects.format` is null by the creation guard); what it has is its
 * explicit output variants. A project with exactly one output keeps the contract these flows always had: that output's aspect
 * ratio is its format. A project with several outputs has no single format: the answer is `null`, and each caller refuses with
 * its own "context is incomplete" instead of guessing which output it meant. An output whose spec carries no aspect ratio at all
 * is also `null`; a copy's fork revision answers with the geometry it was copied with.
 */
export function projectOutputFormat(project: Readonly<{ format: string | null }>, bundle: BundleWithState): string | null {
  if (project.format) return project.format
  const entries = bundle.state.document.entries
  if (entries.length !== 1) return null
  return outputEntryAspectRatio(entries[0]!)
}

/**
 * `projectOutputFormat` for a caller that cannot go on without one: a project with several outputs (or none, or an output whose
 * spec names no aspect ratio) has no single format, and a child Command that attributes proxy and final outputs by format must
 * refuse that project with the reason an operator can act on, never attribute its outputs to a guessed ratio.
 */
export function requireProjectOutputFormat(project: Readonly<{ format: string | null }>, bundle: BundleWithState): string {
  const format = projectOutputFormat(project, bundle)
  if (format === null) {
    throw new DomainError('PRECONDITION_REQUIRED', 'This project has no single output format: name the output the Command applies to',
      { reason: 'output-variant-required' })
  }
  return format
}
