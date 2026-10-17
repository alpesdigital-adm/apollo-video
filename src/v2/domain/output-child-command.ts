import type { ApiAccessAuditContext } from './api-access-control.ts'
import type { EditCommand } from './edit-command.ts'
import type { EditCommandType } from './edit-command-registry.ts'

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
  'replace-source-transcript': Object.freeze({ planEffect: 'recompiles-plan', replaces: Object.freeze([]) }),
  'direct-multicam-session': Object.freeze({ planEffect: 'recompiles-plan', replaces: Object.freeze([]) }),
  'set-project-policy-overrides': Object.freeze({ planEffect: 'preserves-plan', replaces: Object.freeze(['policies'] as const) }),
})

/** The origin carried by a Version whose Command is one of the table above. */
export interface ChildCommandOriginV3 {
  kind: 'child-command'
  command: EditCommand<unknown>
  /** Credential audit for an external (api-client) author; null for internal actors. */
  audit: ApiAccessAuditContext | null
  requestFingerprint: string
  /** Sorted non-output snapshot kinds this Command replaces (subset of its declared effect). */
  replaces: readonly ChildReplaceableSnapshotKind[]
}
