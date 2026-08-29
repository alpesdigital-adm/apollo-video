import { createHash } from 'node:crypto'

import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain, DomainError } from './errors.ts'
import { SYNTHETIC_SCRIPT_SEGMENTATION_VERSION } from './synthetic-script-segmentation.ts'

export const SYNTHETIC_SCRIPT_PLAN_SCHEMA_VERSION = 'synthetic-script-plan/v1' as const
export const SYNTHETIC_SCRIPT_PLAN_VERSION_SCHEMA_VERSION = 'synthetic-script-plan-version/v1' as const
export const SYNTHETIC_SCRIPT_BLOCK_SCHEMA_VERSION = 'synthetic-script-block/v1' as const
export const SYNTHETIC_SCRIPT_PLAN_IMPACT_SCHEMA_VERSION = 'synthetic-script-plan-impact/v1' as const

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/
const MAX_BLOCK_CHARACTERS = 10_000
const MAX_BLOCKS = 500

export const SYNTHETIC_SCRIPT_PLAN_COMMAND_TYPES = Object.freeze([
  'create-plan',
  'insert-block',
  'update-block',
  'remove-block',
  'reorder-blocks',
  'set-profile',
  'regenerate-block',
  'compile-audio',
] as const)
export type SyntheticScriptPlanCommandType = (typeof SYNTHETIC_SCRIPT_PLAN_COMMAND_TYPES)[number]

export const SYNTHETIC_SCRIPT_BLOCK_ORIGIN_KINDS = Object.freeze([
  'initial-segmentation',
  'inserted',
  'edited',
] as const)
export type SyntheticScriptBlockOriginKind = (typeof SYNTHETIC_SCRIPT_BLOCK_ORIGIN_KINDS)[number]

function id(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

function hash(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && HASH.test(value), 'INVALID_ARGUMENT', `${field} must be a lowercase SHA-256`)
  return value
}

function instant(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} must be a canonical ISO instant`,
  )
  return value
}

/**
 * A block owns an immutable identity and an immutable exact text. Its
 * position in the plan lives only in the plan version sequence, never here:
 * reordering must not touch block identity, and editing text retires the
 * block in favour of a new one that records its lineage.
 */
export interface SyntheticScriptBlock {
  schemaVersion: typeof SYNTHETIC_SCRIPT_BLOCK_SCHEMA_VERSION
  id: string
  workspaceId: string
  projectId: string
  planId: string
  exactText: string
  normalizedText: string
  normalizedTextHash: string
  locale: string
  occurrence: number
  createdInVersionId: string
  origin: Readonly<{ kind: SyntheticScriptBlockOriginKind; originBlockId?: string }>
  blockHash: string
  createdAt: string
}

export function createSyntheticScriptBlock(input: {
  id: string
  workspaceId: string
  projectId: string
  planId: string
  exactText: string
  locale: string
  occurrence: number
  createdInVersionId: string
  origin: { kind: SyntheticScriptBlockOriginKind; originBlockId?: string }
  createdAt: string
}): Readonly<SyntheticScriptBlock> {
  const exactText = input.exactText.normalize('NFC')
  assertDomain(
    exactText.trim().length > 0 && exactText.length <= MAX_BLOCK_CHARACTERS && exactText === exactText.trim(),
    'INVALID_ARGUMENT',
    'Block exact text must be trimmed, non-empty and within limits',
  )
  assertDomain(LOCALE.test(input.locale), 'INVALID_ARGUMENT', 'Block locale is invalid')
  assertDomain(
    Number.isSafeInteger(input.occurrence) && input.occurrence >= 1,
    'INVALID_ARGUMENT',
    'Block occurrence must be a positive ordinal',
  )
  assertDomain(
    SYNTHETIC_SCRIPT_BLOCK_ORIGIN_KINDS.includes(input.origin.kind),
    'INVALID_ARGUMENT',
    'Block origin kind is invalid',
  )
  assertDomain(
    input.origin.kind === 'edited' ? Boolean(input.origin.originBlockId) : true,
    'INVALID_ARGUMENT',
    'Edited blocks must record the block they replace',
  )
  assertDomain(
    input.origin.kind === 'initial-segmentation' ? !input.origin.originBlockId : true,
    'INVALID_ARGUMENT',
    'Initial segmentation blocks cannot claim an origin block',
  )
  const normalizedText = exactText.replace(/\s+/g, ' ').trim()
  const body = Object.freeze({
    schemaVersion: SYNTHETIC_SCRIPT_BLOCK_SCHEMA_VERSION,
    id: id(input.id, 'block.id'),
    workspaceId: id(input.workspaceId, 'block.workspaceId'),
    projectId: id(input.projectId, 'block.projectId'),
    planId: id(input.planId, 'block.planId'),
    exactText,
    normalizedText,
    normalizedTextHash: createHash('sha256').update(normalizedText, 'utf8').digest('hex'),
    locale: input.locale,
    occurrence: input.occurrence,
    createdInVersionId: id(input.createdInVersionId, 'block.createdInVersionId'),
    origin: Object.freeze({
      kind: input.origin.kind,
      ...(input.origin.originBlockId ? { originBlockId: id(input.origin.originBlockId, 'block.origin.originBlockId') } : {}),
    }),
    createdAt: instant(input.createdAt, 'block.createdAt'),
  })
  return Object.freeze({ ...body, blockHash: calculateCanonicalHash(body) })
}

export function assertSyntheticScriptBlock(value: Readonly<SyntheticScriptBlock>): void {
  const recreated = createSyntheticScriptBlock({
    id: value.id,
    workspaceId: value.workspaceId,
    projectId: value.projectId,
    planId: value.planId,
    exactText: value.exactText,
    locale: value.locale,
    occurrence: value.occurrence,
    createdInVersionId: value.createdInVersionId,
    origin: value.origin,
    createdAt: value.createdAt,
  })
  if (
    recreated.blockHash !== value.blockHash ||
    recreated.normalizedTextHash !== value.normalizedTextHash ||
    recreated.normalizedText !== value.normalizedText
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic script block hash is invalid')
  }
}

export interface SyntheticScriptPlanCacheDecision {
  blockId: string
  decision: 'reuse' | 'regenerate' | 'pending'
  reason: string
}

/**
 * Every plan command records what it kept, created, retired and invalidated,
 * plus its render semantics: block work is audio-domain and never triggers a
 * timeline render by itself — rendering follows only from a later compile.
 */
export interface SyntheticScriptPlanImpact {
  schemaVersion: typeof SYNTHETIC_SCRIPT_PLAN_IMPACT_SCHEMA_VERSION
  commandType: SyntheticScriptPlanCommandType
  baseVersionId: string | null
  resultVersionId: string
  createdBlockIds: readonly string[]
  reusedBlockIds: readonly string[]
  retiredBlockIds: readonly string[]
  invalidatedArtifactIds: readonly string[]
  renderSemantics: 'no-render' | 'deferred-to-compile'
  cacheDecisions: readonly Readonly<SyntheticScriptPlanCacheDecision>[]
  impactHash: string
}

export function createSyntheticScriptPlanImpact(input: Omit<SyntheticScriptPlanImpact, 'schemaVersion' | 'impactHash'>): Readonly<SyntheticScriptPlanImpact> {
  assertDomain(
    SYNTHETIC_SCRIPT_PLAN_COMMAND_TYPES.includes(input.commandType),
    'INVALID_ARGUMENT',
    'Plan command type is invalid',
  )
  assertDomain(
    ['no-render', 'deferred-to-compile'].includes(input.renderSemantics),
    'INVALID_ARGUMENT',
    'Plan command render semantics are invalid',
  )
  const created = input.createdBlockIds.map((value, index) => id(value, `impact.createdBlockIds[${index}]`))
  const reused = input.reusedBlockIds.map((value, index) => id(value, `impact.reusedBlockIds[${index}]`))
  const retired = input.retiredBlockIds.map((value, index) => id(value, `impact.retiredBlockIds[${index}]`))
  const combined = [...created, ...reused, ...retired]
  assertDomain(
    new Set(combined).size === combined.length,
    'INVALID_ARGUMENT',
    'A block cannot be created, reused and retired by the same command',
  )
  const knownBlocks = new Set([...created, ...reused])
  const decisionBlocks = new Set<string>()
  const cacheDecisions = Object.freeze(input.cacheDecisions.map((decision, index) => {
    const blockId = id(decision.blockId, `impact.cacheDecisions[${index}].blockId`)
    assertDomain(!decisionBlocks.has(blockId), 'INVALID_ARGUMENT', 'Cache decisions must be unique per block')
    decisionBlocks.add(blockId)
    assertDomain(knownBlocks.has(blockId), 'INVALID_ARGUMENT', 'Cache decision references a block outside this command')
    assertDomain(
      ['reuse', 'regenerate', 'pending'].includes(decision.decision),
      'INVALID_ARGUMENT',
      'Cache decision is invalid',
    )
    const reason = decision.reason.trim()
    assertDomain(reason.length >= 3 && reason.length <= 500, 'INVALID_ARGUMENT', 'Cache decision reason is required')
    return Object.freeze({ blockId, decision: decision.decision, reason })
  }))
  const body = Object.freeze({
    schemaVersion: SYNTHETIC_SCRIPT_PLAN_IMPACT_SCHEMA_VERSION,
    commandType: input.commandType,
    baseVersionId: input.baseVersionId === null ? null : id(input.baseVersionId, 'impact.baseVersionId'),
    resultVersionId: id(input.resultVersionId, 'impact.resultVersionId'),
    createdBlockIds: Object.freeze(created),
    reusedBlockIds: Object.freeze(reused),
    retiredBlockIds: Object.freeze(retired),
    invalidatedArtifactIds: Object.freeze(input.invalidatedArtifactIds.map((value, index) => id(value, `impact.invalidatedArtifactIds[${index}]`))),
    renderSemantics: input.renderSemantics,
    cacheDecisions,
  })
  return Object.freeze({ ...body, impactHash: calculateCanonicalHash(body) })
}

/**
 * One immutable row per command: the command and the plan version it produced
 * are the same append-only record, mirroring how ProjectVersion binds its
 * originating command. Order lives in `blockSequence`; block identity never
 * moves between versions.
 */
export interface SyntheticScriptPlanVersion {
  schemaVersion: typeof SYNTHETIC_SCRIPT_PLAN_VERSION_SCHEMA_VERSION
  id: string
  planId: string
  workspaceId: string
  projectId: string
  sequence: number
  parentVersionId?: string
  projectVersionId: string
  profileSnapshotId: string
  locale: string
  segmentationVersion: typeof SYNTHETIC_SCRIPT_SEGMENTATION_VERSION
  scriptHash: string
  commandType: SyntheticScriptPlanCommandType
  blockSequence: readonly string[]
  impact: Readonly<SyntheticScriptPlanImpact>
  planVersionHash: string
  createdAt: string
}

export function createSyntheticScriptPlanVersion(input: {
  id: string
  planId: string
  workspaceId: string
  projectId: string
  sequence: number
  parentVersionId?: string
  projectVersionId: string
  profileSnapshotId: string
  locale: string
  commandType: SyntheticScriptPlanCommandType
  blockSequence: readonly string[]
  orderedNormalizedTextHashes: readonly string[]
  impact: Readonly<SyntheticScriptPlanImpact>
  createdAt: string
}): Readonly<SyntheticScriptPlanVersion> {
  assertDomain(
    Number.isSafeInteger(input.sequence) && input.sequence >= 1,
    'INVALID_ARGUMENT',
    'Plan version sequence must be a positive ordinal',
  )
  assertDomain(
    input.sequence === 1 ? input.parentVersionId === undefined : Boolean(input.parentVersionId),
    'INVALID_ARGUMENT',
    'Only the first plan version may omit its parent',
  )
  assertDomain(
    input.sequence === 1 ? input.commandType === 'create-plan' : input.commandType !== 'create-plan',
    'INVALID_ARGUMENT',
    'create-plan produces exactly the first version',
  )
  assertDomain(LOCALE.test(input.locale), 'INVALID_ARGUMENT', 'Plan locale is invalid')
  assertDomain(
    input.blockSequence.length >= 1 && input.blockSequence.length <= MAX_BLOCKS,
    'INVALID_ARGUMENT',
    'Plan version must sequence between one and five hundred blocks',
  )
  const blockSequence = input.blockSequence.map((value, index) => id(value, `blockSequence[${index}]`))
  assertDomain(
    new Set(blockSequence).size === blockSequence.length,
    'INVALID_ARGUMENT',
    'Plan version block sequence cannot repeat a block identity',
  )
  assertDomain(
    input.orderedNormalizedTextHashes.length === blockSequence.length,
    'INVALID_ARGUMENT',
    'Plan version text hashes must align with the block sequence',
  )
  const orderedHashes = input.orderedNormalizedTextHashes.map((value, index) => hash(value, `orderedNormalizedTextHashes[${index}]`))
  assertDomain(
    input.impact.resultVersionId === input.id &&
      input.impact.commandType === input.commandType &&
      input.impact.baseVersionId === (input.parentVersionId ?? null),
    'INVALID_ARGUMENT',
    'Plan command impact does not describe this version',
  )
  const scriptHash = calculateCanonicalHash({
    schemaVersion: 'synthetic-script/v1',
    locale: input.locale,
    segmentationVersion: SYNTHETIC_SCRIPT_SEGMENTATION_VERSION,
    blocks: orderedHashes,
  })
  const body = Object.freeze({
    schemaVersion: SYNTHETIC_SCRIPT_PLAN_VERSION_SCHEMA_VERSION,
    id: id(input.id, 'version.id'),
    planId: id(input.planId, 'version.planId'),
    workspaceId: id(input.workspaceId, 'version.workspaceId'),
    projectId: id(input.projectId, 'version.projectId'),
    sequence: input.sequence,
    ...(input.parentVersionId ? { parentVersionId: id(input.parentVersionId, 'version.parentVersionId') } : {}),
    projectVersionId: id(input.projectVersionId, 'version.projectVersionId'),
    profileSnapshotId: id(input.profileSnapshotId, 'version.profileSnapshotId'),
    locale: input.locale,
    segmentationVersion: SYNTHETIC_SCRIPT_SEGMENTATION_VERSION,
    scriptHash,
    commandType: input.commandType,
    blockSequence: Object.freeze(blockSequence),
    impact: input.impact,
    createdAt: instant(input.createdAt, 'version.createdAt'),
  })
  return Object.freeze({ ...body, planVersionHash: calculateCanonicalHash(body) })
}

export function assertSyntheticScriptPlanVersion(
  value: Readonly<SyntheticScriptPlanVersion>,
  orderedNormalizedTextHashes: readonly string[],
): void {
  const impact = createSyntheticScriptPlanImpact({
    commandType: value.impact.commandType,
    baseVersionId: value.impact.baseVersionId,
    resultVersionId: value.impact.resultVersionId,
    createdBlockIds: value.impact.createdBlockIds,
    reusedBlockIds: value.impact.reusedBlockIds,
    retiredBlockIds: value.impact.retiredBlockIds,
    invalidatedArtifactIds: value.impact.invalidatedArtifactIds,
    renderSemantics: value.impact.renderSemantics,
    cacheDecisions: value.impact.cacheDecisions,
  })
  if (impact.impactHash !== value.impact.impactHash) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic script plan impact hash is invalid')
  }
  const recreated = createSyntheticScriptPlanVersion({
    id: value.id,
    planId: value.planId,
    workspaceId: value.workspaceId,
    projectId: value.projectId,
    sequence: value.sequence,
    ...(value.parentVersionId ? { parentVersionId: value.parentVersionId } : {}),
    projectVersionId: value.projectVersionId,
    profileSnapshotId: value.profileSnapshotId,
    locale: value.locale,
    commandType: value.commandType,
    blockSequence: value.blockSequence,
    orderedNormalizedTextHashes,
    impact,
    createdAt: value.createdAt,
  })
  if (recreated.planVersionHash !== value.planVersionHash || recreated.scriptHash !== value.scriptHash) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic script plan version hash is invalid')
  }
}

/**
 * Mutable head of a plan. Optimistic concurrency compare-and-swaps directly
 * on `currentVersionId`, exactly like the project head does.
 */
export interface SyntheticScriptPlanHead {
  schemaVersion: typeof SYNTHETIC_SCRIPT_PLAN_SCHEMA_VERSION
  id: string
  workspaceId: string
  projectId: string
  currentVersionId: string
  createdAt: string
}

export function createSyntheticScriptPlanHead(input: Omit<SyntheticScriptPlanHead, 'schemaVersion'>): Readonly<SyntheticScriptPlanHead> {
  return Object.freeze({
    schemaVersion: SYNTHETIC_SCRIPT_PLAN_SCHEMA_VERSION,
    id: id(input.id, 'plan.id'),
    workspaceId: id(input.workspaceId, 'plan.workspaceId'),
    projectId: id(input.projectId, 'plan.projectId'),
    currentVersionId: id(input.currentVersionId, 'plan.currentVersionId'),
    createdAt: instant(input.createdAt, 'plan.createdAt'),
  })
}
