import type { ApiAccessAuditContext } from './api-access-control.ts'
import { DomainError } from './errors.ts'
import type { EditCommand } from './edit-command.ts'
import type { EditCommandType } from './edit-command-registry.ts'
import type { SealedOutputNormalizationV3 } from './output-materialization.ts'

/**
 * Every Command that produces a ProjectVersion without owning a dedicated output
 * origin (variant creation, ingest, editorial cut, manual select and restore)
 * enters the output state machine through the one `child-command` origin. The
 * table below is the declared effect of each type; the bundle builder and the
 * database guard both refuse any effect it does not name.
 *
 * - `preserves-plan`: the new EditPlan snapshot is the parent's plan under a new
 *   identity (id, projectVersionId, createdAt); the semantic hash must be equal.
 * - `recompiles-plan`: the Command's own service produced a different plan. The
 *   state still re-materializes every entry from that plan and the parent's exact
 *   normalization observations, so geometry never survives by copying.
 * - `replaces`: non-output snapshots this Command legitimately replaces: new ones born with
 *   the Version, or the canonical earlier row an identical document resolves to (never
 *   newer than the Version). Anything else about brief/policies/treatment/story is
 *   inherited from the parent.
 */
export const CHILD_REPLACEABLE_SNAPSHOT_KINDS = ['brief', 'policies', 'story', 'treatment'] as const
export type ChildReplaceableSnapshotKind = (typeof CHILD_REPLACEABLE_SNAPSHOT_KINDS)[number]
export type ChildPlanEffect = 'preserves-plan' | 'recompiles-plan'
export interface ChildCommandTransition {
  readonly planEffect: ChildPlanEffect
  readonly replaces: readonly ChildReplaceableSnapshotKind[]
}

export const CHILD_COMMAND_TRANSITIONS: Readonly<Partial<Record<EditCommandType, ChildCommandTransition>>> = Object.freeze({
  'attach-media-library-reference': Object.freeze({ planEffect: 'preserves-plan', replaces: Object.freeze([]) }),
  'manual-edit': Object.freeze({ planEffect: 'recompiles-plan', replaces: Object.freeze([]) }),
  'apply-review-patch': Object.freeze({ planEffect: 'recompiles-plan', replaces: Object.freeze([]) }),
  'apply-review-patch-batch': Object.freeze({ planEffect: 'recompiles-plan', replaces: Object.freeze([]) }),
  'run-director': Object.freeze({ planEffect: 'recompiles-plan', replaces: Object.freeze(['brief', 'story', 'treatment'] as const) }),
  'set-project-lut-selection': Object.freeze({ planEffect: 'preserves-plan', replaces: Object.freeze([]) }),
  'set-project-color-plan': Object.freeze({ planEffect: 'preserves-plan', replaces: Object.freeze([]) }),
  'set-project-subtitle-mode': Object.freeze({ planEffect: 'preserves-plan', replaces: Object.freeze([]) }),
  'apply-subtitle-segment-override': Object.freeze({ planEffect: 'preserves-plan', replaces: Object.freeze([]) }),
  'apply-variant-reframe-override': Object.freeze({ planEffect: 'preserves-plan', replaces: Object.freeze([]) }),
  'replace-source-transcript': Object.freeze({ planEffect: 'recompiles-plan', replaces: Object.freeze([]) }),
  'direct-multicam-session': Object.freeze({ planEffect: 'recompiles-plan', replaces: Object.freeze([]) }),
  'set-project-policy-overrides': Object.freeze({ planEffect: 'preserves-plan', replaces: Object.freeze(['policies'] as const) }),
  'revise-editorial-request': Object.freeze({ planEffect: 'preserves-plan', replaces: Object.freeze(['brief'] as const) }),
})

/**
 * The Commands a copy (a Creation fork that carries content) accepts as children before it has any target authority.
 * Each one only configures the plan it was copied with (grade, LUT, subtitle look, a segment's text, policies): none of
 * them reads, changes or newly consumes a transcript, a perception result, a source recording or a geometry. The child
 * keeps the fork's posture: its entries stay blocked with FORK_TARGET_MATERIALIZATION_REASON until an editorial cut
 * binds the fork derivation's observations to the target. Anything else that moves a copy (a variant, a manual edit, a
 * review patch, a transcript replacement, a Director run, media) still needs that authority first.
 */
export const FORK_INHERITABLE_COMMAND_TYPES = Object.freeze([
  'set-project-lut-selection',
  'set-project-color-plan',
  'set-project-subtitle-mode',
  'apply-subtitle-segment-override',
  'set-project-policy-overrides',
] as const satisfies readonly EditCommandType[])
export const FORK_TARGET_MATERIALIZATION_REASON = 'fork-target-materialization-required' as const
/** The operator-facing reason a copy gives for refusing to render, review or patch before its editorial cut. */
export const COPY_REQUIRES_EDITORIAL_CUT_REASON = 'copy-requires-editorial-cut' as const
export function isForkInheritableCommandType(type: string): boolean {
  return (FORK_INHERITABLE_COMMAND_TYPES as readonly string[]).includes(type)
}
/**
 * Whether `error` is a copy's refusal to render, review or change before its editorial cut. A Command that configured the copy has
 * already committed when the render it would admit is refused this way: its caller answers the Command, with the render deferred.
 */
export function isCopyRequiresEditorialCutRefusal(error: unknown): boolean {
  return error instanceof DomainError && error.code === 'PRECONDITION_REQUIRED' && error.details?.reason === COPY_REQUIRES_EDITORIAL_CUT_REASON
}

/**
 * The rights a recording was adopted under: its current approved snapshot at seal time. The database guard and the
 * commit-time check require the very same snapshot, hash and revision to still be current.
 */
export interface AdoptedObservationRightsV3 {
  snapshotId: string
  snapshotHash: string
  revision: number
}

/**
 * One persisted, observed ingest receipt of the project's OTHER recordings that a child Version adopts. State3 holds
 * the observation of one ingest in its head, but every ingest persisted its own receipt; a Command whose plan
 * consumes several recordings (a multicam cut, a selected insert, music, a replaced asset) seals them all. The
 * adoption names the receipt (identity and seal), the exact source it observed and the rights it was adopted under,
 * and is part of the sealed origin and of the State's producer.
 */
export interface AdoptedObservationV3 {
  receiptId: string
  receiptHash: string
  sourceArtifactId: string
  sourceManifestId: string
  sourceManifestHash: string
  rights: AdoptedObservationRightsV3
}

/**
 * What a repository offers a child Command: a receipt it read from the project, verified against its persisted
 * facts, with the rights evidence of its source (null when the artifact has none). Offering grants nothing; the
 * transition adopts only what the new plan consumes and the parent does not already observe.
 */
export interface AdoptableObservationV3 {
  normalization: Readonly<SealedOutputNormalizationV3>
  rights: Readonly<AdoptedObservationRightsV3> | null
}

/** The origin carried by a Version whose Command is one of the table above. */
export interface ChildCommandOriginV3 {
  kind: 'child-command'
  command: EditCommand<unknown>
  /** Credential audit for an external (api-client) author; null for internal actors. */
  audit: ApiAccessAuditContext | null
  requestFingerprint: string
  /** Sorted non-output snapshot kinds this Command replaces (subset of its declared effect). */
  replaces: readonly ChildReplaceableSnapshotKind[]
  /**
   * The receipts adopted from outside the parent State, sorted and unique by receipt id. Exactly the observations the
   * Version's materializations hold that the parent's State did not (empty for a Command that adopts nothing).
   */
  adoptions: readonly AdoptedObservationV3[]
}
