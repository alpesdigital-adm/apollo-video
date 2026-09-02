import type { EnsureBlockGenerationOutcome } from '../application/synthetic-block-generations.ts'
import type { PersistedSyntheticBlockConcatenation } from '../application/ports/synthetic-block-concatenation-repository.ts'
import type { PersistedSyntheticScriptPlan } from '../application/ports/synthetic-script-plan-repository.ts'
import type { SyntheticBlockGeneration } from '../domain/synthetic-block-generation.ts'
import { assertDomain } from '../domain/errors.ts'

function record(value: unknown, field: string): Record<string, unknown> {
  assertDomain(typeof value === 'object' && value !== null && !Array.isArray(value), 'INVALID_ARGUMENT', `${field} must be an object`)
  return value as Record<string, unknown>
}

function string(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && value.trim().length > 0, 'INVALID_ARGUMENT', `${field} must be a non-empty string`)
  return value.trim()
}

function exact(value: Record<string, unknown>, keys: readonly string[], field: string, optional: readonly string[] = []) {
  assertDomain(
    Object.keys(value).every((key) => keys.includes(key) || optional.includes(key)) && keys.every((key) => key in value),
    'INVALID_ARGUMENT',
    `${field} contains missing or unsupported properties`,
  )
}

const context = (body: Record<string, unknown>) => Object.freeze({
  projectVersionId: string(body.projectVersionId, 'body.projectVersionId'),
  use: string(body.use, 'body.use'),
  market: string(body.market, 'body.market'),
})

export function parseCreateSyntheticScriptPlanBody(raw: unknown) {
  const body = record(raw, 'body')
  exact(body, ['projectVersionId', 'profileSnapshotId', 'locale', 'scriptText', 'use', 'market'], 'body')
  return Object.freeze({
    ...context(body),
    profileSnapshotId: string(body.profileSnapshotId, 'body.profileSnapshotId'),
    locale: string(body.locale, 'body.locale'),
    scriptText: string(body.scriptText, 'body.scriptText'),
  })
}

export function parseInsertBlockBody(raw: unknown) {
  const body = record(raw, 'body')
  exact(body, ['projectVersionId', 'baseVersionId', 'baseHash', 'position', 'text', 'use', 'market'], 'body')
  assertDomain(Number.isSafeInteger(body.position) && (body.position as number) >= 0, 'INVALID_ARGUMENT', 'body.position must be a non-negative integer')
  return Object.freeze({
    ...context(body),
    baseVersionId: string(body.baseVersionId, 'body.baseVersionId'),
    baseHash: string(body.baseHash, 'body.baseHash'),
    position: body.position as number,
    text: string(body.text, 'body.text'),
  })
}

export function parseUpdateBlockBody(raw: unknown) {
  const body = record(raw, 'body')
  exact(body, ['projectVersionId', 'baseVersionId', 'baseHash', 'text', 'use', 'market'], 'body')
  return Object.freeze({
    ...context(body),
    baseVersionId: string(body.baseVersionId, 'body.baseVersionId'),
    baseHash: string(body.baseHash, 'body.baseHash'),
    text: string(body.text, 'body.text'),
  })
}

export function parseRemoveBlockBody(raw: unknown) {
  const body = record(raw, 'body')
  exact(body, ['projectVersionId', 'baseVersionId', 'baseHash', 'use', 'market'], 'body')
  return Object.freeze({
    ...context(body),
    baseVersionId: string(body.baseVersionId, 'body.baseVersionId'),
    baseHash: string(body.baseHash, 'body.baseHash'),
  })
}

export function parseReorderBlocksBody(raw: unknown) {
  const body = record(raw, 'body')
  exact(body, ['projectVersionId', 'baseVersionId', 'baseHash', 'order', 'use', 'market'], 'body')
  assertDomain(Array.isArray(body.order) && body.order.length >= 1 && body.order.length <= 500, 'INVALID_ARGUMENT', 'body.order must be a bounded non-empty array')
  return Object.freeze({
    ...context(body),
    baseVersionId: string(body.baseVersionId, 'body.baseVersionId'),
    baseHash: string(body.baseHash, 'body.baseHash'),
    order: Object.freeze((body.order as unknown[]).map((value, index) => string(value, `body.order[${index}]`))),
  })
}

export function parseSetPresenterProfileBody(raw: unknown) {
  const body = record(raw, 'body')
  exact(body, ['projectVersionId', 'baseVersionId', 'baseHash', 'profileSnapshotId', 'use', 'market'], 'body')
  return Object.freeze({
    ...context(body),
    baseVersionId: string(body.baseVersionId, 'body.baseVersionId'),
    baseHash: string(body.baseHash, 'body.baseHash'),
    profileSnapshotId: string(body.profileSnapshotId, 'body.profileSnapshotId'),
  })
}

/**
 * Regenerating on purpose spends money a valid cache entry had already saved,
 * so the caller may state why. The field is optional on the wire — existing
 * clients keep working — but the motive itself is not optional downstream: the
 * route always hands the application one, and the ledger always records it.
 */
export function parseRegenerateBlockBody(raw: unknown) {
  const body = record(raw, 'body')
  exact(body, ['projectVersionId', 'baseVersionId', 'baseHash', 'use', 'market'], 'body', ['reason'])
  return Object.freeze({
    ...context(body),
    baseVersionId: string(body.baseVersionId, 'body.baseVersionId'),
    baseHash: string(body.baseHash, 'body.baseHash'),
    ...(body.reason === undefined ? {} : { reason: string(body.reason, 'body.reason') }),
  })
}

export function parseCompileBlockAudioBody(raw: unknown) {
  const body = record(raw, 'body')
  exact(body, ['projectVersionId', 'baseVersionId', 'baseHash', 'settings', 'use', 'market'], 'body')
  const settings = record(body.settings, 'body.settings')
  exact(settings, ['gapMs', 'outputFormat'], 'body.settings')
  assertDomain(Number.isSafeInteger(settings.gapMs) && (settings.gapMs as number) >= 0 && (settings.gapMs as number) <= 10_000, 'INVALID_ARGUMENT', 'body.settings.gapMs must be between 0 and 10000')
  assertDomain(settings.outputFormat === 'mp3' || settings.outputFormat === 'wav', 'INVALID_ARGUMENT', 'body.settings.outputFormat must be mp3 or wav')
  return Object.freeze({
    ...context(body),
    baseVersionId: string(body.baseVersionId, 'body.baseVersionId'),
    baseHash: string(body.baseHash, 'body.baseHash'),
    settings: Object.freeze({ gapMs: settings.gapMs as number, outputFormat: settings.outputFormat as 'mp3' | 'wav' }),
  })
}

export function presentSyntheticScriptPlan(plan: Readonly<PersistedSyntheticScriptPlan>) {
  return Object.freeze({
    head: Object.freeze({ ...plan.head }),
    version: Object.freeze({ ...plan.version }),
    blocks: Object.freeze(plan.blocks.map((block) => Object.freeze({ ...block }))),
  })
}

export function presentBlockGenerationOutcomes(outcomes: readonly Readonly<EnsureBlockGenerationOutcome>[]) {
  return Object.freeze(outcomes.map((outcome) => Object.freeze({ ...outcome })))
}

export function presentBlockGenerations(generations: readonly Readonly<SyntheticBlockGeneration>[]) {
  return Object.freeze(generations.map((generation) => Object.freeze({
    id: generation.id,
    blockId: generation.blockId,
    attempt: generation.attempt,
    status: generation.status,
    cacheDecision: generation.cacheDecision,
    decisionReason: generation.decisionReason,
    cacheKey: generation.cacheKey,
    ...(generation.providerJobId ? { providerJobId: generation.providerJobId } : {}),
    ...(generation.sourceGenerationId ? { sourceGenerationId: generation.sourceGenerationId } : {}),
    ...(generation.audioArtifactId ? { audioArtifactId: generation.audioArtifactId } : {}),
    ...(generation.alignmentArtifactId ? { alignmentArtifactId: generation.alignmentArtifactId } : {}),
    ...(generation.failureReason ? { failureReason: generation.failureReason } : {}),
    updatedAt: generation.updatedAt,
  })))
}

export function presentBlockConcatenation(value: Readonly<PersistedSyntheticBlockConcatenation>) {
  return Object.freeze({
    id: value.id,
    planId: value.planId,
    planVersionId: value.planVersionId,
    container: value.container,
    codec: value.codec,
    sampleRate: value.sampleRate,
    channels: value.channels,
    gapMs: value.gapMs,
    durationMs: value.durationMs,
    entries: value.entries,
    concatHash: value.concatHash,
    audioArtifactId: value.audioArtifactId,
    alignmentArtifactId: value.alignmentArtifactId,
    finalAudioSha256: value.finalAudioSha256,
    audioMasterId: value.audioMasterId,
    createdAt: value.createdAt,
  })
}
