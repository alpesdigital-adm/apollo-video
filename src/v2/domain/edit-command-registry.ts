import { DomainError } from './errors.ts'

/**
 * Canonical registry of every EditCommand type the product can persist.
 *
 * A Command type only exists once it declares how it invalidates renders. The
 * registry is the single source of truth for that policy: `createEditCommand`
 * refuses unregistered types (fail-closed) and the proxy render repository
 * derives its partial-range reuse allowlist from here instead of duplicating a
 * hardcoded list.
 *
 * Every entry cites the code that proves its classification. When a Command type
 * changes how it invalidates renders, the evidence must change with it.
 */

export const EDIT_COMMAND_RENDER_POLICIES = [
  /** Impact ranges are scoped to the edited region; partial re-render is allowed. */
  'partial-range',
  /** Impact ranges always start at frame 0 and reach the compiled duration. */
  'full-timeline',
  /** No render may be enqueued from this Command; a later Command unblocks it. */
  'deferred',
  /** The Command changes no render semantics at all. */
  'no-render',
] as const
export type EditCommandRenderPolicy = (typeof EDIT_COMMAND_RENDER_POLICIES)[number]

export const EDIT_COMMAND_IMPACT_SCHEMAS = [
  'command-impact/v1',
  'editorial-cut-impact/v1',
  'director-run-impact/v1',
  'source-transcript-replacement-impact/v1',
  'project-lut-selection-impact/v1',
] as const
export type EditCommandImpactSchema = (typeof EDIT_COMMAND_IMPACT_SCHEMAS)[number]

/** Why a render cannot be enqueued yet, when the policy defers it. */
export type EditCommandDeferralReason = 'director-run' | 'timeline'

export interface EditCommandPolicy {
  /** How this Command invalidates renders. */
  renderPolicy: EditCommandRenderPolicy
  /** Schema of the impact document this Command persists, or null when it has none. */
  impactSchema: EditCommandImpactSchema | null
  /** Whether a persisted Command of this type carries an impact document. */
  requiresImpact: boolean
  /**
   * Whether the impact of this type may legitimately report
   * `renderSemanticsChanged: false` (no artifacts, no minimal renders).
   */
  supportsRenderFreeImpact: boolean
  /** What must happen before a render becomes possible, when it is deferred. */
  deferralReason: EditCommandDeferralReason | null
  /** Source location proving the classification above. */
  evidence: string
}

export const EDIT_COMMAND_POLICIES = Object.freeze({
  'manual-edit': Object.freeze({
    renderPolicy: 'partial-range',
    impactSchema: 'command-impact/v1',
    requiresImpact: true,
    supportsRenderFreeImpact: true,
    deferralReason: null,
    evidence: 'command-impact.ts:333 mergedRange/changedSubtitleTextRange scope ranges to the '
      + 'edited clip; classify() select yields renderSemanticsChanged false',
  }),
  'apply-review-patch': Object.freeze({
    renderPolicy: 'partial-range',
    impactSchema: 'command-impact/v1',
    requiresImpact: true,
    supportsRenderFreeImpact: false,
    deferralReason: null,
    evidence: 'command-impact.ts:457 reviewPatchFrameRanges converts invalidatedRangesMs into '
      + 'scoped frame ranges; renderSemanticsChanged is always true',
  }),
  'apply-review-patch-batch': Object.freeze({
    renderPolicy: 'partial-range',
    impactSchema: 'command-impact/v1',
    requiresImpact: true,
    supportsRenderFreeImpact: false,
    deferralReason: null,
    evidence: 'command-impact.ts:29 commandType union and :434 createReviewPatchCommandImpact '
      + 'share the scoped review-patch range derivation',
  }),
  'remove-spoken-content': Object.freeze({
    renderPolicy: 'full-timeline',
    impactSchema: 'editorial-cut-impact/v1',
    requiresImpact: true,
    supportsRenderFreeImpact: false,
    deferralReason: null,
    evidence: 'editorial-cut-impact.ts:71 affectedRanges and renderRanges are always '
      + '{ startFrame: 0, endFrame }; renderSemanticsChanged is the literal true',
  }),
  'run-director': Object.freeze({
    renderPolicy: 'full-timeline',
    impactSchema: 'director-run-impact/v1',
    requiresImpact: true,
    supportsRenderFreeImpact: false,
    deferralReason: null,
    evidence: 'director-run-impact.ts:76 affectedRanges and renderRanges are always '
      + '{ startFrame: 0, endFrame }; renderSemanticsChanged is the literal true',
  }),
  'set-project-lut-selection': Object.freeze({
    renderPolicy: 'full-timeline',
    impactSchema: 'project-lut-selection-impact/v1',
    requiresImpact: true,
    supportsRenderFreeImpact: false,
    deferralReason: 'timeline',
    evidence: 'project-lut-selection-impact.ts:85 range covers { startFrame: 0, endFrame: '
      + 'durationFrames }; :106 minimalRenders stay empty and renderDeferredUntilTimeline is true '
      + 'while durationFrames is 0',
  }),
  'replace-source-transcript': Object.freeze({
    renderPolicy: 'deferred',
    impactSchema: 'source-transcript-replacement-impact/v1',
    requiresImpact: true,
    supportsRenderFreeImpact: false,
    deferralReason: 'director-run',
    evidence: 'source-transcript-replacement.ts:31 renderBlockedUntilDirectorRun is the literal '
      + 'true and the impact declares no minimalRenders field at all',
  }),
  'compare-action': Object.freeze({
    renderPolicy: 'no-render',
    impactSchema: null,
    requiresImpact: false,
    supportsRenderFreeImpact: false,
    deferralReason: null,
    evidence: 'version-compare.ts:198 persists only PersistedVersionCompareDecision — no impact '
      + 'document and no render invalidation exists for this Command type',
  }),
} as const satisfies Record<string, EditCommandPolicy>)

export type EditCommandType = keyof typeof EDIT_COMMAND_POLICIES

export const EDIT_COMMAND_TYPES: readonly EditCommandType[] = Object.freeze(
  (Object.keys(EDIT_COMMAND_POLICIES) as EditCommandType[]).toSorted(),
)

export function isEditCommandType(value: unknown): value is EditCommandType {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(EDIT_COMMAND_POLICIES, value)
}

export function editCommandPolicy(type: EditCommandType): Readonly<EditCommandPolicy> {
  return EDIT_COMMAND_POLICIES[type]
}

/**
 * Fail-closed narrowing for values that arrive as plain strings (persisted rows,
 * external payloads). An unregistered type is a defect, never a pass-through.
 */
export function requireEditCommandType(value: unknown): EditCommandType {
  if (!isEditCommandType(value)) {
    throw new DomainError(
      'INVALID_COMMAND',
      'EditCommand type is not registered in the command invalidation policy registry',
      { type: typeof value === 'string' ? value : typeof value, registered: EDIT_COMMAND_TYPES },
    )
  }
  return value
}

/** Render policy of an arbitrary value, or null when it is not a registered type. */
export function editCommandRenderPolicy(value: unknown): EditCommandRenderPolicy | null {
  return isEditCommandType(value) ? EDIT_COMMAND_POLICIES[value].renderPolicy : null
}

/** Registered types under a given render policy, sorted, used to derive allowlists. */
export function editCommandTypesByRenderPolicy(
  policy: EditCommandRenderPolicy,
): readonly EditCommandType[] {
  return Object.freeze(
    EDIT_COMMAND_TYPES.filter((type) => EDIT_COMMAND_POLICIES[type].renderPolicy === policy),
  )
}
