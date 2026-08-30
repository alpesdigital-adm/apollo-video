import { createHash } from 'node:crypto'

import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import { SYNTHETIC_SCRIPT_SEGMENTATION_VERSION } from './synthetic-script-segmentation.ts'

export const SYNTHETIC_BLOCK_GENERATION_SCHEMA_VERSION = 'synthetic-block-generation/v1' as const
export const SYNTHETIC_BLOCK_CACHE_KEY_VERSION = 'synthetic-block-cache-key/v1' as const

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

/**
 * The voice-side identity that changes a TTS result. Presenter visual
 * attributes are deliberately absent: audio blocks depend on the voice, not
 * on wardrobe or framing, so a profile version that keeps the same voice
 * keeps every audio cache hit.
 */
export interface SyntheticBlockVoiceKey {
  adapterId: string
  adapterVersion: string
  voiceId: string
  voiceVersion: number
  modelRef: string | null
  outputFormat: 'mp3' | 'wav'
  /**
   * Canonical hash of only the synthesis-relevant adapter configuration.
   * Observational config (cost, timeouts, byte limits) must never reach this
   * hash: it does not change the audio and would fabricate cache misses.
   */
  synthesisConfigHash: string
}

export function createSyntheticBlockVoiceKey(input: Omit<SyntheticBlockVoiceKey, 'synthesisConfigHash'> & {
  synthesisConfig: Readonly<Record<string, unknown>>
}): Readonly<SyntheticBlockVoiceKey> {
  assertDomain(ID.test(input.adapterId) && ID.test(input.adapterVersion), 'INVALID_ARGUMENT', 'Voice adapter identity is invalid')
  assertDomain(ID.test(input.voiceId), 'INVALID_ARGUMENT', 'Voice id is invalid')
  assertDomain(Number.isSafeInteger(input.voiceVersion) && input.voiceVersion >= 1, 'INVALID_ARGUMENT', 'Voice version is invalid')
  assertDomain(input.modelRef === null || ID.test(input.modelRef), 'INVALID_ARGUMENT', 'Voice model reference is invalid')
  assertDomain(['mp3', 'wav'].includes(input.outputFormat), 'INVALID_ARGUMENT', 'Voice output format is invalid')
  return Object.freeze({
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    voiceId: input.voiceId,
    voiceVersion: input.voiceVersion,
    modelRef: input.modelRef,
    outputFormat: input.outputFormat,
    synthesisConfigHash: calculateCanonicalHash({
      schemaVersion: 'synthetic-block-synthesis-config/v1',
      config: input.synthesisConfig,
    }),
  })
}

/**
 * Versioned canonical cache identity of one block generation. Only fields
 * that change the audible result or its preparation belong here; position,
 * project, timestamps, cost and consent are excluded — eligibility is
 * re-validated on every hit instead of being baked into the key, so a consent
 * renewal never fabricates a paid regeneration.
 */
export function calculateSyntheticBlockCacheKey(input: {
  exactText: string
  locale: string
  voice: Readonly<SyntheticBlockVoiceKey>
  pronunciationDictionaryRef?: string | null
}): string {
  assertDomain(input.exactText.trim().length > 0, 'INVALID_ARGUMENT', 'Cache key text is empty')
  assertDomain(LOCALE.test(input.locale), 'INVALID_ARGUMENT', 'Cache key locale is invalid')
  assertDomain(HASH.test(input.voice.synthesisConfigHash), 'INVALID_ARGUMENT', 'Cache key synthesis config hash is invalid')
  return calculateCanonicalHash({
    schemaVersion: SYNTHETIC_BLOCK_CACHE_KEY_VERSION,
    segmentationVersion: SYNTHETIC_SCRIPT_SEGMENTATION_VERSION,
    scriptHash: createHash('sha256').update(input.exactText, 'utf8').digest('hex'),
    locale: input.locale,
    voice: {
      adapterId: input.voice.adapterId,
      adapterVersion: input.voice.adapterVersion,
      voiceId: input.voice.voiceId,
      voiceVersion: input.voice.voiceVersion,
      modelRef: input.voice.modelRef,
      outputFormat: input.voice.outputFormat,
      synthesisConfigHash: input.voice.synthesisConfigHash,
    },
    pronunciationDictionaryRef: input.pronunciationDictionaryRef ?? null,
  })
}

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
    assertDomain(
      Boolean(input.sourceGenerationId) && !input.providerJobId &&
        input.status === 'approved' && Boolean(input.audioArtifactId) && Boolean(input.alignmentArtifactId),
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
