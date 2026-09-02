import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import {
  calculateSyntheticBlockCacheKey,
  createSyntheticVoiceIdentity,
  SYNTHETIC_BLOCK_CACHE_KEY_VERSION,
  type SyntheticVoiceIdentity,
} from './synthetic-cache-identity.ts'

/**
 * Block generations address their work through the one canonical synthetic
 * cache identity (`synthetic-cache-identity.ts`). The names below are kept so
 * call sites and persisted rows stay readable; the digests are unchanged.
 */
export { calculateSyntheticBlockCacheKey, SYNTHETIC_BLOCK_CACHE_KEY_VERSION }
export const createSyntheticBlockVoiceKey = createSyntheticVoiceIdentity
export type SyntheticBlockVoiceKey = SyntheticVoiceIdentity

export const SYNTHETIC_BLOCK_GENERATION_SCHEMA_VERSION = 'synthetic-block-generation/v1' as const

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/

export const SYNTHETIC_BLOCK_GENERATION_STATUSES = Object.freeze([
  'pending',
  'approved',
  'failed',
  'superseded',
] as const)
export type SyntheticBlockGenerationStatus = (typeof SYNTHETIC_BLOCK_GENERATION_STATUSES)[number]

export const SYNTHETIC_BLOCK_CACHE_DECISIONS = Object.freeze([
  'miss-generate',
  'hit-reuse',
  'forced-regenerate',
] as const)
export type SyntheticBlockCacheDecisionKind = (typeof SYNTHETIC_BLOCK_CACHE_DECISIONS)[number]

export interface SyntheticBlockGeneration {
  schemaVersion: typeof SYNTHETIC_BLOCK_GENERATION_SCHEMA_VERSION
  id: string
  workspaceId: string
  projectId: string
  planId: string
  blockId: string
  attempt: number
  status: SyntheticBlockGenerationStatus
  cacheKey: string
  cacheDecision: SyntheticBlockCacheDecisionKind
  decisionReason: string
  providerJobId?: string
  sourceGenerationId?: string
  profileSnapshotId: string
  voice: Readonly<SyntheticBlockVoiceKey>
  scriptHash: string
  audioArtifactId?: string
  alignmentArtifactId?: string
  supersededByGenerationId?: string
  failureReason?: string
  attemptBudget: number
  deadlineAt: string
  createdAt: string
  updatedAt: string
}

function instant(value: string, field: string): string {
  assertDomain(
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} must be a canonical ISO instant`,
  )
  return value
}

export function createSyntheticBlockGeneration(input: Omit<SyntheticBlockGeneration, 'schemaVersion' | 'updatedAt'> & {
  updatedAt?: string
}): Readonly<SyntheticBlockGeneration> {
  for (const [field, value] of Object.entries({
    id: input.id, workspaceId: input.workspaceId, projectId: input.projectId,
    planId: input.planId, blockId: input.blockId, profileSnapshotId: input.profileSnapshotId,
  })) assertDomain(ID.test(value), 'INVALID_ARGUMENT', `generation.${field} is invalid`)
  assertDomain(Number.isSafeInteger(input.attempt) && input.attempt >= 1, 'INVALID_ARGUMENT', 'generation.attempt is invalid')
  assertDomain(SYNTHETIC_BLOCK_GENERATION_STATUSES.includes(input.status), 'INVALID_ARGUMENT', 'generation.status is invalid')
  assertDomain(SYNTHETIC_BLOCK_CACHE_DECISIONS.includes(input.cacheDecision), 'INVALID_ARGUMENT', 'generation.cacheDecision is invalid')
  assertDomain(HASH.test(input.cacheKey) && HASH.test(input.scriptHash), 'INVALID_ARGUMENT', 'generation hashes are invalid')
  const decisionReason = input.decisionReason.trim()
  assertDomain(decisionReason.length >= 3 && decisionReason.length <= 500, 'INVALID_ARGUMENT', 'generation.decisionReason is required')
  assertDomain(
    Number.isSafeInteger(input.attemptBudget) && input.attemptBudget >= 1 && input.attemptBudget <= 10,
    'INVALID_ARGUMENT',
    'generation.attemptBudget is invalid',
  )
  if (input.cacheDecision === 'hit-reuse') {
    // A hit never owns a provider job and always reuses its source artifacts.
    // Its status may later become `superseded` — a regeneration replacing the
    // reuse does not retroactively make it a different kind of decision — so
    // pinning it to `approved` would make the row unreadable forever once
    // superseded, taking the whole plan with it.
    assertDomain(
      Boolean(input.sourceGenerationId) && !input.providerJobId &&
        (input.status === 'approved' || input.status === 'superseded') &&
        Boolean(input.audioArtifactId) && Boolean(input.alignmentArtifactId),
      'INVALID_ARGUMENT',
      'A cache hit must reference its source generation and reuse its artifacts without a provider job',
    )
  } else {
    assertDomain(
      Boolean(input.providerJobId) && !input.sourceGenerationId,
      'INVALID_ARGUMENT',
      'A generated attempt must reference exactly its own provider job',
    )
  }
  if (input.status === 'approved') {
    assertDomain(
      Boolean(input.audioArtifactId) && Boolean(input.alignmentArtifactId),
      'INVALID_ARGUMENT',
      'An approved generation must reference its audio and alignment artifacts',
    )
  }
  return Object.freeze({
    schemaVersion: SYNTHETIC_BLOCK_GENERATION_SCHEMA_VERSION,
    id: input.id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    planId: input.planId,
    blockId: input.blockId,
    attempt: input.attempt,
    status: input.status,
    cacheKey: input.cacheKey,
    cacheDecision: input.cacheDecision,
    decisionReason,
    ...(input.providerJobId ? { providerJobId: input.providerJobId } : {}),
    ...(input.sourceGenerationId ? { sourceGenerationId: input.sourceGenerationId } : {}),
    profileSnapshotId: input.profileSnapshotId,
    voice: Object.freeze({ ...input.voice }),
    scriptHash: input.scriptHash,
    ...(input.audioArtifactId ? { audioArtifactId: input.audioArtifactId } : {}),
    ...(input.alignmentArtifactId ? { alignmentArtifactId: input.alignmentArtifactId } : {}),
    ...(input.supersededByGenerationId ? { supersededByGenerationId: input.supersededByGenerationId } : {}),
    ...(input.failureReason ? { failureReason: input.failureReason.trim().slice(0, 500) } : {}),
    attemptBudget: input.attemptBudget,
    deadlineAt: instant(input.deadlineAt, 'generation.deadlineAt'),
    createdAt: instant(input.createdAt, 'generation.createdAt'),
    updatedAt: instant(input.updatedAt ?? input.createdAt, 'generation.updatedAt'),
  })
}
