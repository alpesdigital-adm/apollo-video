import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type {
  SyntheticScriptBlock,
  SyntheticScriptPlanHead,
  SyntheticScriptPlanVersion,
} from '../../domain/synthetic-script-plan.ts'

/**
 * The state a plan command returns: the head as persisted, the version the
 * command produced, and the blocks that version sequences, in order. On a
 * replay the head may already be newer than the returned version.
 */
export interface PersistedSyntheticScriptPlan {
  head: Readonly<SyntheticScriptPlanHead>
  version: Readonly<SyntheticScriptPlanVersion>
  blocks: readonly Readonly<SyntheticScriptBlock>[]
  requestFingerprint: string
  idempotencyKey: string
}

export interface SyntheticScriptPlanRepository {
  findPlanReplay(input: {
    workspaceId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<PersistedSyntheticScriptPlan> | null>
  createPlan(input: {
    head: Readonly<SyntheticScriptPlanHead>
    version: Readonly<SyntheticScriptPlanVersion>
    blocks: readonly Readonly<SyntheticScriptBlock>[]
    requestFingerprint: string
    idempotencyKey: string
    authenticationAudit: Readonly<ApiAccessAuditContext>
  }): Promise<Readonly<{ plan: Readonly<PersistedSyntheticScriptPlan>; replayed: boolean }>>
  findCommandReplay(input: {
    workspaceId: string
    planId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<PersistedSyntheticScriptPlan> | null>
  applyCommand(input: {
    workspaceId: string
    projectId: string
    planId: string
    /** Optimistic concurrency: the head must still point at this version. */
    baseVersionId: string
    version: Readonly<SyntheticScriptPlanVersion>
    createdBlocks: readonly Readonly<SyntheticScriptBlock>[]
    retiredBlockIds: readonly string[]
    requestFingerprint: string
    idempotencyKey: string
    authenticationAudit: Readonly<ApiAccessAuditContext>
  }): Promise<Readonly<{ plan: Readonly<PersistedSyntheticScriptPlan>; replayed: boolean }>>
  readPlan(input: {
    workspaceId: string
    projectId: string
    planId: string
  }): Promise<Readonly<PersistedSyntheticScriptPlan> | null>
  readVersion(input: {
    workspaceId: string
    planId: string
    versionId: string
  }): Promise<Readonly<{
    version: Readonly<SyntheticScriptPlanVersion>
    blocks: readonly Readonly<SyntheticScriptBlock>[]
  }> | null>
}
