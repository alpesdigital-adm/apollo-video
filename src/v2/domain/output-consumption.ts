import { calculateCanonicalHash } from './canonical-hash.ts'
import { DomainError } from './errors.ts'
import { COPY_REQUIRES_EDITORIAL_CUT_REASON } from './output-child-command.ts'
import type { ProjectOutputStateV2, ProjectOutputStateV3 } from './project-output-state.ts'

/**
 * The one decision about whether a sealed State may be consumed, and the facts a consumer seals into its own context.
 *
 * Every consumer of an output (the proxy render, the proxy review, the final export, the sidecar, the critics, the workspace read)
 * asks this and nothing else: the State of the exact Version it was asked about, the entry of the exact variant, the purpose. A
 * consumer never completes a gap with the project's format, the head Version, a manifest or a fallback.
 *
 * The verdict is geometry/clock dependency admission only. It infers no approval: the consumer still evaluates its own current
 * rights, lease and quality fences inside its owner transaction.
 */
export const OUTPUT_CONSUMPTION_PURPOSES = Object.freeze(['render', 'critic', 'final'] as const)
export type OutputConsumptionPurpose = (typeof OUTPUT_CONSUMPTION_PURPOSES)[number]

export type OutputConsumptionState = Readonly<ProjectOutputStateV2 | ProjectOutputStateV3>
export type OutputConsumptionEntry = Readonly<ProjectOutputStateV3['document']['entries'][number]>
export type OutputConsumptionVersion = Readonly<{ id: string; baseHash: string }>

export type OutputConsumptionVerdictV3 = Readonly<
  | { status: 'blocked'; reasons: readonly string[] }
  | { status: 'allowed'; entry: OutputConsumptionEntry }
>

/**
 * `variantId` absent means "the State's only output": a State with several outputs is refused with `output-variant-required`
 * rather than guessed. A Creation fork (a copy that was never configured or cut) and a State without outputs are blocked with the
 * reasons their State records.
 *
 * Policy for a cut copy (an editorial-derived materialization that still carries the fork lineage): its transcript and geometry
 * are sealed by the cut, so it is consumable to render and to critique; the target owns no perception (face) authority of its own
 * yet, so the final export stays blocked with `derived-source-perception-authority-required` until it does.
 */
export function outputConsumptionVerdictV3(state: OutputConsumptionState, variantId: string | undefined, purpose: OutputConsumptionPurpose): OutputConsumptionVerdictV3 {
  if (!(OUTPUT_CONSUMPTION_PURPOSES as readonly string[]).includes(purpose)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Unknown output consumption purpose')
  }
  const document = state.document
  if (document.schemaVersion === 'project-output-state/v2') {
    const consumption = document.consumption as Extract<typeof document.consumption, { reasons: unknown }>
    return Object.freeze({ status: 'blocked', reasons: Object.freeze([...consumption.reasons]) })
  }
  const entries = document.entries
  if (entries.length === 0) return Object.freeze({ status: 'blocked', reasons: Object.freeze(['empty-project']) })
  let entry: OutputConsumptionEntry | undefined
  if (variantId === undefined) {
    if (entries.length !== 1) return Object.freeze({ status: 'blocked', reasons: Object.freeze(['output-variant-required']) })
    entry = entries[0]
  } else {
    entry = entries.find((candidate) => candidate.variantId === variantId)
    if (!entry) throw new DomainError('PRECONDITION_REQUIRED', 'Requested stable variant is not an exact State member', { reason: 'output-variant-unknown' })
  }
  if (entry!.consumption.status === 'blocked') return Object.freeze({ status: 'blocked', reasons: Object.freeze([...entry!.consumption.reasons]) })
  if (purpose === 'final' && entry!.consumption.materialization.document.schemaVersion === 'editorial-derived-materialization/v1' &&
    document.sourceDependencies !== null) {
    return Object.freeze({ status: 'blocked', reasons: Object.freeze(['derived-source-perception-authority-required']) })
  }
  const ratio = outputEntryAspectRatio(entry!)
  if (ratio !== null && entries.some((other) => other !== entry && outputEntryAspectRatio(other) === ratio)) {
    return Object.freeze({ status: 'blocked', reasons: Object.freeze(['output-variant-ambiguous']) })
  }
  return Object.freeze({ status: 'allowed', entry: entry! })
}

/** One output of a State: the stable variant and the aspect ratio its sealed spec carries (the key the render pipeline and the presets use). */
export type OutputVariantRef = Readonly<{ variantId: string; aspectRatio: string | null }>

/** Every output of a State, in State order. A Creation fork root has no consumable output and answers an empty list. */
export function outputVariantsOf(state: OutputConsumptionState): readonly OutputVariantRef[] {
  if (state.document.schemaVersion === 'project-output-state/v2') return Object.freeze([])
  return Object.freeze(state.document.entries.map((entry) => Object.freeze({ variantId: entry.variantId, aspectRatio: outputEntryAspectRatio(entry) })))
}

/**
 * The output a variant-specific Command or consumer names. The variant must be an exact member of the State (`output-variant-unknown`
 * otherwise) and its aspect ratio must be unique in it (`output-variant-ambiguous`: until presets are keyed by variant, two outputs
 * of one ratio cannot be rendered, exported or invalidated apart). Never guesses: a caller that names no variant asks the verdict.
 */
export function requireOutputVariant(state: OutputConsumptionState, variantId: string): OutputVariantRef & Readonly<{ aspectRatio: string }> {
  const variants = outputVariantsOf(state)
  const found = variants.find((candidate) => candidate.variantId === variantId)
  if (!found) throw new DomainError('PRECONDITION_REQUIRED', 'Requested stable variant is not an exact State member', { reason: 'output-variant-unknown' })
  if (found.aspectRatio === null) throw new DomainError('PRECONDITION_REQUIRED', 'The output names no aspect ratio', { reason: 'output-not-consumable' })
  if (variants.some((other) => other !== found && other.aspectRatio === found.aspectRatio)) {
    throw new DomainError('PRECONDITION_REQUIRED', 'Two outputs of this project share one aspect ratio', { reason: 'output-variant-ambiguous' })
  }
  return found as OutputVariantRef & Readonly<{ aspectRatio: string }>
}

/**
 * The aspect ratio an entry's sealed spec carries: its own, or (a copy's literal fork revision, which keeps the geometry it was
 * copied with as `effectiveSpec`) the effective one. `null` when the spec carries none: the output then has no format of its own.
 */
export function outputEntryAspectRatio(entry: OutputConsumptionEntry): string | null {
  const spec = entry.spec as { output?: { aspectRatio?: unknown }; effectiveSpec?: { output?: { aspectRatio?: unknown } } }
  const ratio = spec.output?.aspectRatio ?? spec.effectiveSpec?.output?.aspectRatio
  return typeof ratio === 'string' && ratio.length > 0 ? ratio : null
}

/** What a consumer seals into its context and input hash: the exact Version, State, variant revision and materialization it consumes. */
export interface OutputConsumptionSealV3 {
  schemaVersion: 'output-consumption-seal/v1'
  purpose: OutputConsumptionPurpose
  projectVersionId: string
  projectVersionHash: string
  outputStateId: string
  outputStateHash: string
  variantId: string
  outputSpecRevisionId: string
  specHash: string
  materializationId: string
  materializationHash: string
}

export function outputConsumptionSealV3(version: OutputConsumptionVersion, state: Readonly<ProjectOutputStateV3>, entry: OutputConsumptionEntry,
  purpose: OutputConsumptionPurpose): Readonly<OutputConsumptionSealV3> {
  if (entry.consumption.status !== 'materialized') throw new DomainError('PRECONDITION_REQUIRED', 'Only a materialized entry can be sealed for consumption')
  const materialization = entry.consumption.materialization
  return Object.freeze({
    schemaVersion: 'output-consumption-seal/v1', purpose,
    projectVersionId: version.id, projectVersionHash: version.baseHash,
    outputStateId: state.document.id, outputStateHash: state.stateHash,
    variantId: entry.variantId, outputSpecRevisionId: entry.outputSpecRevisionId, specHash: entry.specHash,
    materializationId: materialization.document.id, materializationHash: materialization.materializationHash,
  })
}

export function outputConsumptionSealHashV3(seal: Readonly<OutputConsumptionSealV3>): string {
  return calculateCanonicalHash(seal)
}

/**
 * The reasons a consumer publishes, mapped from the State's own: one stable code an operator can act on per cause. Anything the
 * State records that has no published name is `output-not-consumable`.
 */
export function publishedConsumptionReason(reasons: readonly string[]): string {
  const first = reasons[0]
  if (first === 'fork-target-materialization-required') return COPY_REQUIRES_EDITORIAL_CUT_REASON
  if (first !== undefined && (PUBLISHED_CONSUMPTION_REASONS as readonly string[]).includes(first)) return first
  return 'output-not-consumable'
}

/** The closed set of reasons a consumption refusal publishes (the presenter's allowlist includes exactly these). */
export const PUBLISHED_CONSUMPTION_REASONS = Object.freeze([
  COPY_REQUIRES_EDITORIAL_CUT_REASON, 'derived-source-perception-authority-required', 'empty-project', 'output-variant-required',
  'output-variant-unknown', 'output-variant-ambiguous', 'normalization-required', 'audio-authority-required', 'output-not-consumable',
  'output-version-missing',
] as const)
