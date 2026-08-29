import { createHash } from 'node:crypto'

import { evaluateAssetUse } from '../domain/asset-rights.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  calculateSyntheticBlockCacheKey,
  createSyntheticBlockGeneration,
  createSyntheticBlockVoiceKey,
  type SyntheticBlockGeneration,
  type SyntheticBlockVoiceKey,
} from '../domain/synthetic-block-generation.ts'
import type { SyntheticPresenterProfileSnapshot } from '../domain/synthetic-production.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'
import type { AssetRightsRepository } from './ports/asset-rights-repository.ts'
import type { MediaArtifactQueryRepository } from './ports/media-artifact-query-repository.ts'
import type { ProviderJobRepository } from './ports/provider-job-repository.ts'
import type { ProviderResultArtifactRepository } from './ports/provider-result-artifact-repository.ts'
import type { SyntheticBlockGenerationRepository } from './ports/synthetic-block-generation-repository.ts'
import type { SyntheticProductionRepository } from './ports/synthetic-production-repository.ts'
import type { SyntheticScriptPlanRepository } from './ports/synthetic-script-plan-repository.ts'

const DEFAULT_ATTEMPT_BUDGET = 3
const DEFAULT_DEADLINE_MS = 24 * 60 * 60 * 1_000

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

/** Deterministic identity: a crashed ensure pass recreates the same rows. */
function generationId(blockId: string, attempt: number): string {
  return `sbg-${sha256(`${blockId}:${attempt}`).slice(0, 48)}`
}

/**
 * The identity- and voice-consent gate. It runs BEFORE any cache lookup and
 * before any cost reservation, and again before every reuse: a revoked,
 * expired or out-of-scope consent must produce zero cache hits and zero paid
 * calls, never a stale reuse.
 */
export function assertBlockGenerationConsent(
  snapshot: Readonly<SyntheticPresenterProfileSnapshot>,
  context: Readonly<{ use: string; market: string; locale: string; now: Date }>,
): void {
  const consent = snapshot.consent
  assertDomain(
    snapshot.status === 'active' && consent.granted &&
      (!consent.revokedAt || Date.parse(consent.revokedAt) > context.now.getTime()) &&
      Date.parse(consent.expiresAt) > context.now.getTime() &&
      consent.allowedUses.includes(context.use) &&
      consent.allowedMarkets.includes(context.market) &&
      consent.allowedLocales.includes(context.locale) &&
      consent.allowedOperations.includes('tts'),
    'ASSET_RIGHTS_BLOCKED',
    'Synthetic presenter consent does not authorize block generation',
  )
}

export function syntheticBlockVoiceKeyFromProfile(
  snapshot: Readonly<SyntheticPresenterProfileSnapshot>,
  outputFormat: 'mp3' | 'wav',
): Readonly<SyntheticBlockVoiceKey> {
  return createSyntheticBlockVoiceKey({
    adapterId: snapshot.voice.adapterId,
    adapterVersion: snapshot.voice.adapterVersion,
    voiceId: snapshot.voice.id,
    voiceVersion: snapshot.voice.version,
    modelRef: null,
    outputFormat,
    synthesisConfig: { outputFormat },
  })
}

export interface EnsureBlockGenerationOutcome {
  blockId: string
  generationId: string | null
  action: 'up-to-date' | 'failed-awaiting-retry' | 'reused' | 'enqueued' | 'deferred-duplicate' | 'budget-exhausted'
  reason: string
}

export function ensureSyntheticBlockGenerationsService(dependencies: {
  plans: SyntheticScriptPlanRepository
  generations: SyntheticBlockGenerationRepository
  profiles: SyntheticProductionRepository
  artifacts: MediaArtifactQueryRepository
  rights: AssetRightsRepository
  enqueueProviderJob: (request: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    profileSnapshotId: string
    operation: 'tts'
    adapterId: string
    adapterVersion: string
    providerInput: Readonly<Record<string, unknown>>
    sourceArtifactIds: readonly string[]
    use: string
    market: string
    locale: string
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }) => Promise<Readonly<{ persisted: Readonly<{ job: Readonly<{ id: string }> }>; replayed: boolean }>>
  clock: () => Date
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    planId: string
    use: string
    market: string
    outputFormat?: 'mp3' | 'wav'
    /** Blocks to regenerate even when cached or approved (explicit command). */
    forceBlockIds?: readonly string[]
    actor: Readonly<AuthenticatedExternalActor>
  }): Promise<readonly Readonly<EnsureBlockGenerationOutcome>[]> {
    requireScope(request.actor, 'projects:write')
    const audit = materializeActorAuditContext(request.actor)
    assertDomain(audit.workspaceId === request.workspaceId, 'AUTH_INVALID', 'Block generation actor does not belong to workspace')
    const now = dependencies.clock()
    const plan = await dependencies.plans.readPlan({
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      planId: request.planId,
    })
    if (!plan) throw new DomainError('PROJECT_NOT_FOUND', 'Synthetic script plan was not found')
    const profile = await dependencies.profiles.readProfile({
      workspaceId: request.workspaceId,
      snapshotId: plan.version.profileSnapshotId,
    })
    if (!profile) throw new DomainError('PRECONDITION_REQUIRED', 'Synthetic presenter profile was not found')
    const locale = plan.version.locale
    // Gate order is binding: consent first, then cache, then cost.
    assertBlockGenerationConsent(profile.snapshot, { use: request.use, market: request.market, locale, now })
    const outputFormat = request.outputFormat ?? 'mp3'
    const voice = syntheticBlockVoiceKeyFromProfile(profile.snapshot, outputFormat)
    const force = new Set(request.forceBlockIds ?? [])
    for (const forced of force) {
      assertDomain(
        plan.version.blockSequence.includes(forced),
        'INVALID_ARGUMENT',
        'Forced regeneration references a block outside the current plan version',
      )
    }

    const outcomes: EnsureBlockGenerationOutcome[] = []
    const inFlightKeys = new Set<string>()
    for (const block of plan.blocks) {
      const cacheKey = calculateSyntheticBlockCacheKey({ exactText: block.exactText, locale, voice })
      const effective = await dependencies.generations.findEffective({
        workspaceId: request.workspaceId,
        blockId: block.id,
      })
      const forced = force.has(block.id)
      if (effective && !forced) {
        if (effective.cacheKey === cacheKey && ['pending', 'approved'].includes(effective.status)) {
          outcomes.push({ blockId: block.id, generationId: effective.id, action: 'up-to-date', reason: 'an attempt with this exact cache key is already pending or approved' })
          continue
        }
        if (effective.cacheKey === cacheKey && effective.status === 'failed') {
          outcomes.push({ blockId: block.id, generationId: effective.id, action: 'failed-awaiting-retry', reason: 'the last attempt failed; retry only through an explicit regenerate command' })
          continue
        }
      }
      const attempt = (effective?.attempt ?? 0) + 1
      const attemptBudget = effective?.attemptBudget ?? DEFAULT_ATTEMPT_BUDGET
      if (attempt > attemptBudget || (effective && Date.parse(effective.deadlineAt) <= now.getTime())) {
        outcomes.push({ blockId: block.id, generationId: null, action: 'budget-exhausted', reason: 'the persisted retry budget or deadline for this block is exhausted' })
        continue
      }
      const id = generationId(block.id, attempt)
      const base = {
        id,
        workspaceId: request.workspaceId,
        projectId: request.projectId,
        planId: request.planId,
        blockId: block.id,
        attempt,
        cacheKey,
        profileSnapshotId: profile.profileSnapshotId,
        voice,
        scriptHash: sha256(block.exactText),
        attemptBudget,
        deadlineAt: new Date(now.getTime() + DEFAULT_DEADLINE_MS).toISOString(),
        createdAt: now.toISOString(),
      }

      let reused: Readonly<SyntheticBlockGeneration> | null = null
      if (!forced) {
        // Cache lookup happens only after the consent gate above and before
        // any cost is reserved; a hit must still prove its blob and rights.
        for (const candidate of await dependencies.generations.findByCacheKey({ workspaceId: request.workspaceId, cacheKey, statuses: ['approved'] })) {
          if (!candidate.audioArtifactId || !candidate.alignmentArtifactId) continue
          const [audio, alignment] = await Promise.all([
            dependencies.artifacts.findById(request.workspaceId, candidate.audioArtifactId),
            dependencies.artifacts.findById(request.workspaceId, candidate.alignmentArtifactId),
          ])
          if (audio?.status !== 'available' || alignment?.status !== 'available') continue
          const currentRights = await dependencies.rights.findCurrentForArtifacts(request.workspaceId, [candidate.audioArtifactId])
          const decision = evaluateAssetUse(currentRights.get(candidate.audioArtifactId) ?? null, {
            workspaceId: request.workspaceId,
            use: request.use,
            market: request.market,
            locale,
            syntheticOperations: ['tts'],
          }, now)
          if (decision.outcome !== 'allow') continue
          reused = candidate
          break
        }
      }

      if (!reused && !forced) {
        // A duplicate must never pay while its twin is in flight: defer until
        // the sibling generation settles, then reuse it through the cache.
        const pendingTwin = inFlightKeys.has(cacheKey) ||
          (await dependencies.generations.findByCacheKey({ workspaceId: request.workspaceId, cacheKey, statuses: ['pending'] }))
            .some((candidate) => candidate.blockId !== block.id)
        if (pendingTwin) {
          outcomes.push({ blockId: block.id, generationId: null, action: 'deferred-duplicate', reason: 'an in-flight generation already carries this exact cache key; waiting to reuse it instead of paying twice' })
          continue
        }
      }

      if (reused) {
        const generation = createSyntheticBlockGeneration({
          ...base,
          status: 'approved',
          cacheDecision: 'hit-reuse',
          decisionReason: `cache hit: approved generation ${reused.id} shares this exact cache key with valid blob, rights and consent`,
          sourceGenerationId: reused.id,
          audioArtifactId: reused.audioArtifactId!,
          alignmentArtifactId: reused.alignmentArtifactId!,
        })
        await dependencies.generations.create({ generation, ...(effective ? { supersedes: effective.id } : {}) })
        outcomes.push({ blockId: block.id, generationId: id, action: 'reused', reason: generation.decisionReason })
        continue
      }

      const enqueued = await dependencies.enqueueProviderJob({
        workspaceId: request.workspaceId,
        projectId: request.projectId,
        projectVersionId: request.projectVersionId,
        profileSnapshotId: profile.profileSnapshotId,
        operation: 'tts',
        adapterId: voice.adapterId,
        adapterVersion: voice.adapterVersion,
        providerInput: {
          text: block.exactText,
          scriptHash: base.scriptHash,
          locale,
          outputFormat,
        },
        sourceArtifactIds: [],
        use: request.use,
        market: request.market,
        locale,
        actor: request.actor,
        idempotencyKey: `bg-${id}`,
      })
      const decisionReason = forced
        ? 'explicit regenerate command: the cache was deliberately bypassed for this block'
        : 'cache miss: no approved generation carries this exact cache key'
      const generation = createSyntheticBlockGeneration({
        ...base,
        status: 'pending',
        cacheDecision: forced ? 'forced-regenerate' : 'miss-generate',
        decisionReason,
        providerJobId: enqueued.persisted.job.id,
      })
      await dependencies.generations.create({ generation, ...(effective ? { supersedes: effective.id } : {}) })
      inFlightKeys.add(cacheKey)
      outcomes.push({ blockId: block.id, generationId: id, action: 'enqueued', reason: decisionReason })
    }
    return Object.freeze(outcomes)
  }
}

export function settleSyntheticBlockGenerationsService(dependencies: {
  generations: SyntheticBlockGenerationRepository
  providerJobs: ProviderJobRepository
  resultArtifacts: ProviderResultArtifactRepository
  clock: () => Date
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    planId: string
    actor: Readonly<AuthenticatedExternalActor>
  }) {
    requireScope(request.actor, 'projects:read')
    assertDomain(request.actor.workspaceId === request.workspaceId, 'AUTH_INVALID', 'Block generation actor does not belong to workspace')
    const now = dependencies.clock()
    const pending = await dependencies.generations.listByPlan({
      workspaceId: request.workspaceId,
      planId: request.planId,
      statuses: ['pending'],
    })
    const settled: { generationId: string; outcome: 'approved' | 'failed' | 'running' | 'discarded' }[] = []
    for (const generation of pending) {
      if (!generation.providerJobId) throw new DomainError('PERSISTENCE_CONFLICT', 'Pending generation lost its provider job reference')
      const persisted = await dependencies.providerJobs.read({
        workspaceId: request.workspaceId,
        projectId: request.projectId,
        jobId: generation.providerJobId,
      })
      if (!persisted) throw new DomainError('PERSISTENCE_CONFLICT', 'Pending generation references a missing provider job')
      const job = persisted.job
      if (job.status === 'approved') {
        const ledger = await dependencies.resultArtifacts.listByJob({
          workspaceId: request.workspaceId,
          projectId: request.projectId,
          jobId: job.id,
        })
        const audio = ledger.find(({ role }) => role === 'primary-audio')
        const alignment = ledger.find(({ role }) => role === 'alignment-evidence')
        assertDomain(Boolean(audio && alignment), 'PERSISTENCE_CONFLICT', 'Approved TTS job is missing its result artifact ledger entries')
        const row = await dependencies.generations.settle({
          workspaceId: request.workspaceId,
          generationId: generation.id,
          status: 'approved',
          audioArtifactId: audio!.artifactId,
          alignmentArtifactId: alignment!.artifactId,
          updatedAt: now.toISOString(),
        })
        settled.push({ generationId: generation.id, outcome: row ? 'approved' : 'discarded' })
      } else if (['rejected', 'failed', 'canceled'].includes(job.status)) {
        const row = await dependencies.generations.settle({
          workspaceId: request.workspaceId,
          generationId: generation.id,
          status: 'failed',
          failureReason: job.normalizedError?.code ?? `provider job ended ${job.status}`,
          updatedAt: now.toISOString(),
        })
        settled.push({ generationId: generation.id, outcome: row ? 'failed' : 'discarded' })
      } else {
        settled.push({ generationId: generation.id, outcome: 'running' })
      }
    }
    return Object.freeze(settled)
  }
}
