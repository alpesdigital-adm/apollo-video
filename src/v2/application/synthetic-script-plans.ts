import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  createSyntheticScriptBlock,
  createSyntheticScriptPlanHead,
  createSyntheticScriptPlanImpact,
  createSyntheticScriptPlanVersion,
  type SyntheticScriptBlock,
  type SyntheticScriptPlanCacheDecision,
  type SyntheticScriptPlanCommandType,
} from '../domain/synthetic-script-plan.ts'
import {
  segmentSyntheticScript,
  type ScriptSegmentationConstraints,
  type SegmentedScriptBlock,
} from '../domain/synthetic-script-segmentation.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'
import type { ProjectWorkspaceQueryRepository } from './ports/project-workspace-query-repository.ts'
import type { SyntheticProductionRepository } from './ports/synthetic-production-repository.ts'
import type { SyntheticScriptPlanRepository } from './ports/synthetic-script-plan-repository.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/

/**
 * Proportional to the initial TTS provider: ElevenLabs accepts thousands of
 * characters per call, but blocks stay close to natural sentences. These are
 * part of the preparation algorithm; changing them changes block boundaries,
 * never silently — segmentation is versioned inside every cache key.
 */
export const SYNTHETIC_SCRIPT_SEGMENTATION_CONSTRAINTS: Readonly<ScriptSegmentationConstraints> = Object.freeze({
  minCharacters: 4,
  maxCharacters: 2_400,
})

const PENDING_REASON = 'new block without an approved generation for its cache key'

function identity(value: string, field: string): string {
  assertDomain(ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

export type SyntheticScriptPlanMutation =
  | Readonly<{ kind: 'insert-block'; position: number; text: string }>
  | Readonly<{ kind: 'update-block'; blockId: string; text: string }>
  | Readonly<{ kind: 'remove-block'; blockId: string }>
  | Readonly<{ kind: 'reorder-blocks'; order: readonly string[] }>
  | Readonly<{ kind: 'set-profile'; profileSnapshotId: string }>
  | Readonly<{ kind: 'regenerate-block'; blockId: string }>
  | Readonly<{ kind: 'compile-audio'; settingsHash: string }>

interface PlanServiceDependencies {
  plans: SyntheticScriptPlanRepository
  projects: ProjectWorkspaceQueryRepository
  profiles: SyntheticProductionRepository
  clock: () => Date
  createId: (kind: 'script-plan' | 'script-plan-version' | 'script-block') => string
}

function occurrenceOrdinals(
  sequenceHashes: readonly string[],
): number[] {
  const seen = new Map<string, number>()
  return sequenceHashes.map((hash) => {
    const occurrence = (seen.get(hash) ?? 0) + 1
    seen.set(hash, occurrence)
    return occurrence
  })
}

async function requireCurrentProjectVersion(
  projects: ProjectWorkspaceQueryRepository,
  input: { workspaceId: string; projectId: string; projectVersionId: string },
): Promise<void> {
  const project = await projects.read({ workspaceId: input.workspaceId, projectId: input.projectId })
  assertDomain(
    project?.project.currentVersionId === input.projectVersionId && project.version?.id === input.projectVersionId,
    'VERSION_CONFLICT',
    'Synthetic script plan commands must target the current project version',
  )
}

export function createSyntheticScriptPlanService(dependencies: PlanServiceDependencies) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    profileSnapshotId: string
    locale: string
    scriptText: string
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }) {
    requireScope(request.actor, 'projects:write')
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const projectVersionId = identity(request.projectVersionId, 'projectVersionId')
    const audit = materializeActorAuditContext(request.actor)
    assertDomain(audit.workspaceId === workspaceId, 'AUTH_INVALID', 'Synthetic script plan actor does not belong to workspace')
    const now = dependencies.clock()
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'create-synthetic-script-plan-request/v1',
      workspaceId,
      projectId,
      projectVersionId,
      profileSnapshotId: request.profileSnapshotId,
      locale: request.locale,
      scriptText: request.scriptText,
      actorContextHash: audit.contextHash,
    })
    const replay = await dependencies.plans.findPlanReplay({
      workspaceId,
      actorClientId: audit.clientId,
      actorContextHash: audit.contextHash,
      idempotencyKey: request.idempotencyKey,
    })
    if (replay) {
      assertDomain(
        replay.requestFingerprint === requestFingerprint,
        'IDEMPOTENCY_PAYLOAD_MISMATCH',
        'Idempotency key was used with a different synthetic script plan',
      )
      return Object.freeze({ plan: replay, replayed: true })
    }
    await requireCurrentProjectVersion(dependencies.projects, { workspaceId, projectId, projectVersionId })
    const profile = await dependencies.profiles.readProfile({
      workspaceId,
      snapshotId: identity(request.profileSnapshotId, 'profileSnapshotId'),
    })
    if (!profile) throw new DomainError('PRECONDITION_REQUIRED', 'Synthetic presenter profile was not found')

    const segments = segmentSyntheticScript({
      text: request.scriptText,
      constraints: SYNTHETIC_SCRIPT_SEGMENTATION_CONSTRAINTS,
    })
    const planId = identity(dependencies.createId('script-plan'), 'createId(script-plan)')
    const versionId = identity(dependencies.createId('script-plan-version'), 'createId(script-plan-version)')
    const createdAt = now.toISOString()
    const blocks = segments.map((segment) => createSyntheticScriptBlock({
      id: identity(dependencies.createId('script-block'), 'createId(script-block)'),
      workspaceId,
      projectId,
      planId,
      exactText: segment.exactText,
      locale: request.locale,
      occurrence: segment.occurrence,
      createdInVersionId: versionId,
      origin: { kind: 'initial-segmentation' },
      createdAt,
    }))
    const impact = createSyntheticScriptPlanImpact({
      commandType: 'create-plan',
      baseVersionId: null,
      resultVersionId: versionId,
      createdBlockIds: blocks.map(({ id }) => id),
      reusedBlockIds: [],
      retiredBlockIds: [],
      invalidatedArtifactIds: [],
      renderSemantics: 'deferred-to-compile',
      cacheDecisions: blocks.map(({ id }) => ({ blockId: id, decision: 'pending' as const, reason: PENDING_REASON })),
    })
    const version = createSyntheticScriptPlanVersion({
      id: versionId,
      planId,
      workspaceId,
      projectId,
      sequence: 1,
      projectVersionId,
      profileSnapshotId: profile.profileSnapshotId,
      locale: request.locale,
      commandType: 'create-plan',
      blockSequence: blocks.map(({ id }) => id),
      orderedNormalizedTextHashes: blocks.map(({ normalizedTextHash }) => normalizedTextHash),
      impact,
      createdAt,
    })
    const head = createSyntheticScriptPlanHead({
      id: planId,
      workspaceId,
      projectId,
      currentVersionId: versionId,
      createdAt,
    })
    return dependencies.plans.createPlan({
      head,
      version,
      blocks,
      requestFingerprint,
      idempotencyKey: request.idempotencyKey,
      authenticationAudit: audit,
    })
  }
}

export function mutateSyntheticScriptPlanService(dependencies: PlanServiceDependencies) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    planId: string
    baseVersionId: string
    /** Immutable hash of the base plan version — a stale hash fails closed. */
    baseHash: string
    mutation: SyntheticScriptPlanMutation
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }) {
    requireScope(request.actor, 'projects:write')
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const projectVersionId = identity(request.projectVersionId, 'projectVersionId')
    const planId = identity(request.planId, 'planId')
    const baseVersionId = identity(request.baseVersionId, 'baseVersionId')
    assertDomain(/^[a-f0-9]{64}$/.test(request.baseHash), 'INVALID_ARGUMENT', 'baseHash must be a lowercase SHA-256')
    const audit = materializeActorAuditContext(request.actor)
    assertDomain(audit.workspaceId === workspaceId, 'AUTH_INVALID', 'Synthetic script plan actor does not belong to workspace')
    const now = dependencies.clock()
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'mutate-synthetic-script-plan-request/v1',
      workspaceId,
      projectId,
      projectVersionId,
      planId,
      baseVersionId,
      baseHash: request.baseHash,
      mutation: request.mutation,
      actorContextHash: audit.contextHash,
    })
    const replay = await dependencies.plans.findCommandReplay({
      workspaceId,
      planId,
      actorClientId: audit.clientId,
      actorContextHash: audit.contextHash,
      idempotencyKey: request.idempotencyKey,
    })
    if (replay) {
      assertDomain(
        replay.requestFingerprint === requestFingerprint,
        'IDEMPOTENCY_PAYLOAD_MISMATCH',
        'Idempotency key was used with a different synthetic script plan command',
      )
      return Object.freeze({ plan: replay, replayed: true })
    }
    const current = await dependencies.plans.readPlan({ workspaceId, projectId, planId })
    if (!current) throw new DomainError('PROJECT_NOT_FOUND', 'Synthetic script plan was not found')
    assertDomain(
      current.head.currentVersionId === baseVersionId && current.version.id === baseVersionId,
      'VERSION_CONFLICT',
      'Synthetic script plan command must target the current plan version',
    )
    assertDomain(
      current.version.planVersionHash === request.baseHash,
      'VERSION_CONFLICT',
      'Synthetic script plan base hash is stale',
    )
    await requireCurrentProjectVersion(dependencies.projects, { workspaceId, projectId, projectVersionId })

    const createdAt = now.toISOString()
    const versionId = identity(dependencies.createId('script-plan-version'), 'createId(script-plan-version)')
    const byId = new Map(current.blocks.map((block) => [block.id, block]))
    const currentSequence = current.version.blockSequence

    let commandType: SyntheticScriptPlanCommandType
    let profileSnapshotId = current.version.profileSnapshotId
    let createdBlocks: Readonly<SyntheticScriptBlock>[] = []
    let retiredBlockIds: string[] = []
    let sequence: string[]

    const segmentInto = (
      text: string,
      origin: { kind: 'inserted' } | { kind: 'edited'; originBlockId: string },
    ): { blocks: Readonly<SyntheticScriptBlock>[]; segments: readonly Readonly<SegmentedScriptBlock>[] } => {
      const segments = segmentSyntheticScript({ text, constraints: SYNTHETIC_SCRIPT_SEGMENTATION_CONSTRAINTS })
      return {
        segments,
        blocks: segments.map((segment) => createSyntheticScriptBlock({
          id: identity(dependencies.createId('script-block'), 'createId(script-block)'),
          workspaceId,
          projectId,
          planId,
          exactText: segment.exactText,
          locale: current.version.locale,
          // The stored ordinal is provisional; it is recomputed against the
          // final sequence below so duplicates stay deterministic.
          occurrence: segment.occurrence,
          createdInVersionId: versionId,
          origin,
          createdAt,
        })),
      }
    }

    const mutation = request.mutation
    if (mutation.kind === 'insert-block') {
      assertDomain(
        Number.isSafeInteger(mutation.position) && mutation.position >= 0 && mutation.position <= currentSequence.length,
        'INVALID_ARGUMENT',
        'Block insertion position is outside the plan sequence',
      )
      commandType = 'insert-block'
      createdBlocks = segmentInto(mutation.text, { kind: 'inserted' }).blocks
      sequence = [
        ...currentSequence.slice(0, mutation.position),
        ...createdBlocks.map(({ id }) => id),
        ...currentSequence.slice(mutation.position),
      ]
    } else if (mutation.kind === 'update-block') {
      const target = identity(mutation.blockId, 'mutation.blockId')
      const position = currentSequence.indexOf(target)
      assertDomain(position >= 0, 'INVALID_ARGUMENT', 'Edited block is not part of the current plan version')
      commandType = 'update-block'
      createdBlocks = segmentInto(mutation.text, { kind: 'edited', originBlockId: target }).blocks
      retiredBlockIds = [target]
      sequence = [
        ...currentSequence.slice(0, position),
        ...createdBlocks.map(({ id }) => id),
        ...currentSequence.slice(position + 1),
      ]
    } else if (mutation.kind === 'remove-block') {
      const target = identity(mutation.blockId, 'mutation.blockId')
      assertDomain(currentSequence.includes(target), 'INVALID_ARGUMENT', 'Removed block is not part of the current plan version')
      assertDomain(currentSequence.length > 1, 'INVALID_ARGUMENT', 'A synthetic script plan cannot become empty')
      commandType = 'remove-block'
      retiredBlockIds = [target]
      sequence = currentSequence.filter((blockId) => blockId !== target)
    } else if (mutation.kind === 'reorder-blocks') {
      assertDomain(
        mutation.order.length === currentSequence.length &&
          new Set(mutation.order).size === mutation.order.length &&
          mutation.order.every((blockId) => currentSequence.includes(blockId)),
        'INVALID_ARGUMENT',
        'Reorder must be an exact permutation of the current block sequence',
      )
      assertDomain(
        mutation.order.some((blockId, index) => blockId !== currentSequence[index]),
        'INVALID_ARGUMENT',
        'Reorder must change the block sequence',
      )
      commandType = 'reorder-blocks'
      sequence = [...mutation.order]
    } else if (mutation.kind === 'regenerate-block') {
      const target = identity(mutation.blockId, 'mutation.blockId')
      assertDomain(currentSequence.includes(target), 'INVALID_ARGUMENT', 'Regenerated block is not part of the current plan version')
      commandType = 'regenerate-block'
      sequence = [...currentSequence]
    } else if (mutation.kind === 'compile-audio') {
      assertDomain(/^[a-f0-9]{64}$/.test(mutation.settingsHash), 'INVALID_ARGUMENT', 'Compilation settings hash is invalid')
      commandType = 'compile-audio'
      sequence = [...currentSequence]
    } else if (mutation.kind === 'set-profile') {
      const profile = await dependencies.profiles.readProfile({
        workspaceId,
        snapshotId: identity(mutation.profileSnapshotId, 'mutation.profileSnapshotId'),
      })
      if (!profile) throw new DomainError('PRECONDITION_REQUIRED', 'Synthetic presenter profile was not found')
      assertDomain(
        profile.profileSnapshotId !== current.version.profileSnapshotId,
        'INVALID_ARGUMENT',
        'set-profile must change the presenter profile snapshot',
      )
      commandType = 'set-profile'
      profileSnapshotId = profile.profileSnapshotId
      sequence = [...currentSequence]
    } else {
      throw new DomainError('INVALID_ARGUMENT', 'Synthetic script plan mutation kind is unsupported')
    }

    // Deterministic duplicate handling: recompute created-block ordinals from
    // the final sequence so the nth identical sentence is always the nth
    // occurrence, regardless of which command introduced it.
    const createdById = new Map(createdBlocks.map((block) => [block.id, block]))
    const sequenceHashes = sequence.map((blockId) => {
      const block = createdById.get(blockId) ?? byId.get(blockId)
      assertDomain(Boolean(block), 'PERSISTENCE_CONFLICT', 'Plan sequence references an unknown block')
      return block!.normalizedTextHash
    })
    const ordinals = occurrenceOrdinals(sequenceHashes)
    createdBlocks = sequence.flatMap((blockId, index) => {
      const block = createdById.get(blockId)
      if (!block) return []
      return [block.occurrence === ordinals[index]
        ? block
        : createSyntheticScriptBlock({
            id: block.id,
            workspaceId,
            projectId,
            planId,
            exactText: block.exactText,
            locale: block.locale,
            occurrence: ordinals[index]!,
            createdInVersionId: versionId,
            origin: block.origin,
            createdAt,
          })]
    })

    const reusedBlockIds = sequence.filter((blockId) => byId.has(blockId))
    const cacheDecisions: SyntheticScriptPlanCacheDecision[] =
      createdBlocks.map(({ id }) => ({ blockId: id, decision: 'pending' as const, reason: PENDING_REASON }))
    if (mutation.kind === 'regenerate-block') {
      cacheDecisions.push({
        blockId: mutation.blockId,
        decision: 'regenerate',
        reason: 'explicit regenerate command: the cache must be bypassed for this block',
      })
    }
    const impact = createSyntheticScriptPlanImpact({
      commandType,
      baseVersionId,
      resultVersionId: versionId,
      createdBlockIds: createdBlocks.map(({ id }) => id),
      reusedBlockIds,
      retiredBlockIds,
      invalidatedArtifactIds: [],
      // Compiling consolidates audio without rendering a timeline; every
      // other mutation defers its render impact to a later compile.
      renderSemantics: commandType === 'compile-audio' ? 'no-render' : 'deferred-to-compile',
      cacheDecisions,
    })
    const version = createSyntheticScriptPlanVersion({
      id: versionId,
      planId,
      workspaceId,
      projectId,
      sequence: current.version.sequence + 1,
      parentVersionId: baseVersionId,
      projectVersionId,
      profileSnapshotId,
      locale: current.version.locale,
      commandType,
      blockSequence: sequence,
      orderedNormalizedTextHashes: sequenceHashes,
      impact,
      createdAt,
    })
    return dependencies.plans.applyCommand({
      workspaceId,
      projectId,
      planId,
      baseVersionId,
      version,
      createdBlocks,
      retiredBlockIds,
      requestFingerprint,
      idempotencyKey: request.idempotencyKey,
      authenticationAudit: audit,
    })
  }
}

export function readSyntheticScriptPlanService(dependencies: { plans: SyntheticScriptPlanRepository }) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    planId: string
    actor: Readonly<AuthenticatedExternalActor>
  }) {
    requireScope(request.actor, 'projects:read')
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    assertDomain(request.actor.workspaceId === workspaceId, 'AUTH_INVALID', 'Synthetic script plan actor does not belong to workspace')
    const plan = await dependencies.plans.readPlan({
      workspaceId,
      projectId: identity(request.projectId, 'projectId'),
      planId: identity(request.planId, 'planId'),
    })
    if (!plan) throw new DomainError('PROJECT_NOT_FOUND', 'Synthetic script plan was not found')
    return plan
  }
}
