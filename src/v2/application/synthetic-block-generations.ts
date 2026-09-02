import { createHash } from 'node:crypto'

import { evaluateAssetUse } from '../domain/asset-rights.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  assertSyntheticPresenterPolicy,
  SYNTHETIC_PRESENTER_ELIGIBILITY_POLICY_VERSION,
} from '../domain/synthetic-presenter-policy-engine.ts'
import {
  calculateSyntheticBlockCacheKey,
  createSyntheticBlockGeneration,
  createSyntheticBlockVoiceKey,
  type SyntheticBlockGeneration,
  type SyntheticBlockVoiceKey,
} from '../domain/synthetic-block-generation.ts'
import {
  createSyntheticCacheDecision,
  type SyntheticCacheDecisionOutcome,
  type SyntheticCacheDecisionReasonCode,
} from '../domain/synthetic-cache-decision.ts'
import type { SyntheticTtsCacheSubject } from '../domain/synthetic-cache-identity.ts'
import {
  isSyntheticCriticApproval,
  type SyntheticCriticReport,
} from '../domain/synthetic-critic-report.ts'
import type { SyntheticPresenterProfileSnapshot } from '../domain/synthetic-production.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'
import type { AssetRightsRepository } from './ports/asset-rights-repository.ts'
import type { MediaArtifactQueryRepository } from './ports/media-artifact-query-repository.ts'
import type { ProviderJobRepository } from './ports/provider-job-repository.ts'
import type {
  ProviderResultArtifactRecord,
  ProviderResultArtifactRepository,
} from './ports/provider-result-artifact-repository.ts'
import type { SyntheticBlockGenerationRepository } from './ports/synthetic-block-generation-repository.ts'
import type { SyntheticCacheDecisionRepository } from './ports/synthetic-cache-decision-repository.ts'
import type { SyntheticCacheSubmissionClaimRepository } from './ports/synthetic-cache-submission-claim-repository.ts'
import type { SyntheticProductionRepository } from './ports/synthetic-production-repository.ts'
import type { SyntheticScriptPlanRepository } from './ports/synthetic-script-plan-repository.ts'

const DEFAULT_ATTEMPT_BUDGET = 3
const DEFAULT_DEADLINE_MS = 24 * 60 * 60 * 1_000

/**
 * Bounds of the motive a forced regeneration must state. The upper bound is
 * short of the ledger's own limit so the audited entry can name the block and
 * still carry the operator's words untruncated.
 */
export const SYNTHETIC_MUST_REGENERATE_REASON_MIN_LENGTH = 8
export const SYNTHETIC_MUST_REGENERATE_REASON_MAX_LENGTH = 300

/**
 * How long a submission claim is honoured before another request may take the
 * cache address over. It only has to outlast the gap between reserving cost and
 * creating the pending generation — a few database round trips — so a window
 * this wide is generous, and it exists purely so a process that dies inside
 * that gap cannot wedge the address forever.
 */
export const SYNTHETIC_CACHE_SUBMISSION_CLAIM_STALE_MS = 5 * 60 * 1_000

/**
 * Accounting unit for ledger entries that record no money at all. A zero
 * amount still needs a currency, and every entry that does carry money always
 * carries the currency of the real provider estimate it was drawn from — this
 * default never prices anything.
 */
export const SYNTHETIC_CACHE_LEDGER_ZERO_AMOUNT_CURRENCY = 'USD'

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

/** Deterministic identity: a crashed ensure pass recreates the same rows. */
function generationId(blockId: string, attempt: number): string {
  return `sbg-${sha256(`${blockId}:${attempt}`).slice(0, 48)}`
}

/**
 * The identity- and voice-consent gate, delegated to the deterministic
 * presenter policy engine. It runs BEFORE any cache lookup and before any
 * cost reservation, and again before every reuse: a revoked, expired or
 * out-of-scope consent — on the snapshot in use OR on the profile's current
 * head version, which expresses the actor's latest will — must produce zero
 * cache hits and zero paid calls, never a stale reuse.
 */
export async function assertBlockGenerationConsent(
  profiles: SyntheticProductionRepository,
  snapshot: Readonly<SyntheticPresenterProfileSnapshot>,
  context: Readonly<{ workspaceId: string; operation: 'tts' | 'audio-avatar'; use: string; market: string; locale: string; now: Date }>,
): Promise<void> {
  const head = await profiles.readProfileHead({ workspaceId: context.workspaceId, profileId: snapshot.id })
  assertSyntheticPresenterPolicy({
    snapshot,
    snapshotWorkspaceId: context.workspaceId,
    ...(head ? { head: { currentVersion: head.head.currentVersion, current: head.current.snapshot } } : {}),
    context: {
      operation: context.operation,
      use: context.use,
      market: context.market,
      locale: context.locale,
      workspaceId: context.workspaceId,
      now: context.now,
    },
  })
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

/**
 * The critic's durable verdicts on one set of bytes, newest first. The cache
 * only ever reads them: a reuse candidate is not the place to decide anything
 * about quality, only the place to obey what was already decided.
 */
export interface CacheCandidateCriticReportReader {
  readByArtifact(input: {
    workspaceId: string
    artifactId: string
    limit?: number
  }): Promise<readonly Readonly<SyntheticCriticReport>[]>
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
  /** Durable ledger of every cache decision, including the ones that pay nothing. */
  cacheDecisions: SyntheticCacheDecisionRepository
  /**
   * Read-only access to the job that already paid for a reuse candidate. It is
   * the only honest source of "what this reuse avoided": the estimate the
   * provider adapter recorded when that work was priced.
   */
  providerJobs: ProviderJobRepository
  /**
   * The ledger of what the paying job actually produced. It carries the
   * checksum and byte size observed at ingestion, which is the only persisted
   * record of what the generation registered — without it a reuse could only
   * check that *some* blob is still there, never that it is still the same
   * blob.
   */
  resultArtifacts: ProviderResultArtifactRepository
  /**
   * The critic's durable verdicts (F3.009). When a candidate's bytes carry one,
   * it — not the paying job's status — says whether they may be reused.
   */
  criticReports: CacheCandidateCriticReportReader
  /**
   * Mutual exclusion over a cache address for the window between deciding to
   * pay and the pending generation becoming visible. Without it the in-flight
   * twin check is a read followed by a write, and two simultaneous requests
   * both read "no twin" and both pay.
   */
  submissionClaims: SyntheticCacheSubmissionClaimRepository
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
    /**
     * An audited order to bypass the cache and pay again.
     *
     * It is deliberately not a bare list of ids: forcing regeneration spends
     * money that a valid cached result had already saved, so it carries the
     * operator's own textual motive and is gated by an approval scope. A force
     * with no motive, or from an actor without that scope, fails closed —
     * nothing is regenerated and nothing is charged.
     */
    mustRegenerate?: Readonly<{ blockIds: readonly string[]; reason: string }>
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
    const outputFormat = request.outputFormat ?? 'mp3'
    const decidedAt = now.toISOString()
    const subjectOf = (exactText: string): Readonly<SyntheticTtsCacheSubject> => Object.freeze({
      operation: 'tts' as const,
      exactText,
      locale,
      voice: syntheticBlockVoiceKeyFromProfile(profile.snapshot, outputFormat),
    })
    /**
     * Appends one ledger entry. The id is derived from the decision's own
     * material, so replaying an ensure pass at the same instant lands on the
     * same content address and the repository refuses to book its economy
     * twice.
     */
    const recordDecision = async (entry: {
      blockId: string
      attempt: number
      exactText: string
      outcome: SyntheticCacheDecisionOutcome
      reasonCode: SyntheticCacheDecisionReasonCode
      reason: string
      candidateGenerationId?: string | null
      criticReportHash?: string | null
      estimatedSavingMinorUnits?: number
      avoidedCostMinorUnits?: number
      currency?: string
    }) => {
      const subject = subjectOf(entry.exactText)
      const material = [
        request.workspaceId, request.projectId, entry.blockId, String(entry.attempt),
        calculateSyntheticBlockCacheKey({ exactText: entry.exactText, locale, voice: subject.voice }),
        entry.outcome, entry.reasonCode, decidedAt,
      ].join(':')
      await dependencies.cacheDecisions.record(createSyntheticCacheDecision({
        id: `scd-${sha256(material).slice(0, 48)}`,
        workspaceId: request.workspaceId,
        projectId: request.projectId,
        subject,
        outcome: entry.outcome,
        reasonCode: entry.reasonCode,
        reason: entry.reason,
        candidateGenerationId: entry.candidateGenerationId ?? null,
        candidateMasterId: null,
        policyVersion: SYNTHETIC_PRESENTER_ELIGIBILITY_POLICY_VERSION,
        criticReportHash: entry.criticReportHash ?? null,
        estimatedSavingMinorUnits: entry.estimatedSavingMinorUnits ?? 0,
        avoidedCostMinorUnits: entry.avoidedCostMinorUnits ?? 0,
        currency: entry.currency ?? SYNTHETIC_CACHE_LEDGER_ZERO_AMOUNT_CURRENCY,
        decidedAt,
      }))
    }

    // Gate order is binding: policy (identity, voice, consent) first, then
    // cache, then cost.
    try {
      await assertBlockGenerationConsent(dependencies.profiles, profile.snapshot, {
        workspaceId: request.workspaceId, operation: 'tts', use: request.use, market: request.market, locale, now,
      })
    } catch (error) {
      // The stop itself is the outcome the operator must see, so it is always
      // the error that propagates; the ledger entries are written afterwards
      // and a ledger failure here can never turn a refusal into a paid call.
      try {
          for (const block of plan.blocks) {
            await recordDecision({
              blockId: block.id,
              attempt: 0,
              exactText: block.exactText,
              outcome: 'blocked',
              reasonCode: 'CONSENT_REVOKED',
              reason: `presenter policy refused this operation before any cache lookup: ${error instanceof Error ? error.message : 'consent is not valid'}`,
            })
          }
        } catch {
          // Subordinate to the refusal above.
        }
        throw error
      }
      const voice = syntheticBlockVoiceKeyFromProfile(profile.snapshot, outputFormat)
      const force = new Set(request.mustRegenerate?.blockIds ?? [])
      // A forced regeneration is a spending decision, so the whole order is
      // authorized before anything it could cause: the motive is validated and
      // every named block is checked against the current plan version up front,
      // and a malformed order regenerates nothing at all instead of half the
      // plan. The presenter policy gate above has already run for these blocks
      // too — forcing bypasses the cache, never consent.
      let mustRegenerateReason = ''
      if (force.size > 0) {
        mustRegenerateReason = (request.mustRegenerate?.reason ?? '').trim()
        assertDomain(
          mustRegenerateReason.length >= SYNTHETIC_MUST_REGENERATE_REASON_MIN_LENGTH &&
            mustRegenerateReason.length <= SYNTHETIC_MUST_REGENERATE_REASON_MAX_LENGTH,
          'INVALID_ARGUMENT',
          'A forced regeneration must state why the cache is being bypassed',
        )
        for (const forced of force) {
          assertDomain(
            plan.version.blockSequence.includes(forced),
            'INVALID_ARGUMENT',
            'Forced regeneration references a block outside the current plan version',
          )
        }
      } else {
        // An order that names nothing is not a no-op, it is a malformed order:
        // accepting it silently would let a caller believe it forced something.
        assertDomain(
          request.mustRegenerate === undefined,
          'INVALID_ARGUMENT',
          'A forced regeneration must name at least one block',
        )
      }

      /**
       * The persisted price of the work a generation embodies. A reused row
       * carries no job of its own, so the chain is walked back to the generation
       * that actually paid, and the estimate that job recorded is the only cost
       * evidence this flow has. When there is none, this returns null — the
       * ledger then refuses to claim a saving instead of inventing one.
       */
      const paidJobEvidence = async (
        candidate: Readonly<SyntheticBlockGeneration>,
        pool: readonly Readonly<SyntheticBlockGeneration>[],
      ): Promise<Readonly<{
        jobStatus: string
        currency: string
        costMinorUnits: number
        criticReportHash: string | null
        produced: readonly Readonly<ProviderResultArtifactRecord>[]
      }> | null> => {
        const byId = new Map(pool.map((entry) => [entry.id, entry]))
        const seen = new Set<string>()
        let current: Readonly<SyntheticBlockGeneration> | undefined = candidate
        while (current && !current.providerJobId) {
          if (seen.has(current.id) || !current.sourceGenerationId) return null
          seen.add(current.id)
          current = byId.get(current.sourceGenerationId)
        }
        if (!current?.providerJobId) return null
        const paying = current
        const persisted = await dependencies.providerJobs.read({
          workspaceId: request.workspaceId,
          projectId: paying.projectId,
          jobId: paying.providerJobId!,
        })
        const estimate = persisted?.job.estimate
        if (!persisted || !estimate) return null
        const produced = await dependencies.resultArtifacts.listByJob({
          workspaceId: request.workspaceId,
          projectId: paying.projectId,
          jobId: paying.providerJobId!,
        })
        return Object.freeze({
          jobStatus: persisted.job.status,
          currency: estimate.currency,
          costMinorUnits: estimate.costMinorUnits,
          criticReportHash: persisted.job.criticResultHash ?? null,
          produced,
        })
      }

      /**
       * Does the blob still hold the bytes the paying job registered?
       *
       * `status === 'available'` only says a row exists; it says nothing about
       * the content. The provider result ledger recorded the sha256 and the byte
       * size observed at ingestion, so comparing the artifact against that row is
       * the only check that can tell a healthy reuse from a silently rewritten
       * blob. No ledger row means no evidence, and no evidence means no reuse.
       */
      const checksumHolds = (
        produced: readonly Readonly<ProviderResultArtifactRecord>[],
        role: ProviderResultArtifactRecord['role'],
        artifact: Readonly<{ id: string; sha256: string; byteSize: bigint }>,
      ): boolean => {
        const registered = produced.find((entry) => entry.role === role && entry.artifactId === artifact.id)
        if (!registered) return false
        return registered.artifactSha256 === artifact.sha256 && BigInt(registered.byteSize) === artifact.byteSize
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
        let reusedEvidence: Awaited<ReturnType<typeof paidJobEvidence>> = null
        /** The critic report that approved the reused bytes, when one exists. */
        let reusedVerdict: Readonly<SyntheticCriticReport> | null = null
        let approvedCandidates: readonly Readonly<SyntheticBlockGeneration>[] = []
        let missReasonCode: SyntheticCacheDecisionReasonCode = 'CACHE_MISS_NO_CANDIDATE'
        let rejectedCandidateId: string | null = null
        if (!forced) {
          // Cache lookup happens only after the consent gate above and before any
          // cost is reserved. Sharing the cache address is where eligibility
          // starts, not where it ends: the candidate still has to prove, in this
          // order, that the work behind it was approved, that its blobs are still
          // the exact bytes that were registered, that those bytes satisfy the
          // output being asked for now, and that the rights still allow this use.
          approvedCandidates = await dependencies.generations.findByCacheKey({ workspaceId: request.workspaceId, cacheKey, statuses: ['approved'] })
          for (const candidate of approvedCandidates) {
            if (!candidate.audioArtifactId || !candidate.alignmentArtifactId) {
              missReasonCode = 'CANDIDATE_BLOB_UNAVAILABLE'
              rejectedCandidateId = candidate.id
              continue
            }
            // The critic runs inside the provider job: a job that reached
            // `approved` is a job whose result the critic accepted. A candidate
            // whose paying job cannot be read back, carries no estimate or never
            // reached that state has not been shown to pass, so it is not reused.
            const evidence = await paidJobEvidence(candidate, approvedCandidates)
            if (!evidence || evidence.jobStatus !== 'approved') {
              missReasonCode = 'CANDIDATE_CRITIC_REJECTED'
              rejectedCandidateId = candidate.id
              continue
            }
            // And when the critic wrote down what it thought of these exact
            // bytes, that verdict overrules the job status: a job can be
            // `approved` while the report on its output says rejected,
            // needs-review or evidence-unavailable, and none of those three is
            // approval. A block with no report yet falls back to the structural
            // check above rather than blocking every pre-F3.009 candidate.
            const [verdict] = await dependencies.criticReports.readByArtifact({
              workspaceId: request.workspaceId,
              artifactId: candidate.audioArtifactId,
              limit: 1,
            })
            if (verdict && !isSyntheticCriticApproval(verdict.decision)) {
              missReasonCode = 'CANDIDATE_CRITIC_REJECTED'
              rejectedCandidateId = candidate.id
              continue
            }
            // Reading a corrupted artifact is itself a fail-closed signal: the
            // repository refuses a row whose metadata no longer matches its
            // immutable manifest. That is one candidate being unusable, not the
            // whole pass being unusable — it must degrade into a paid miss for
            // this block, with the artifact left exactly where it is.
            let audio = null
            let alignment = null
            try {
              ;[audio, alignment] = await Promise.all([
                dependencies.artifacts.findById(request.workspaceId, candidate.audioArtifactId),
                dependencies.artifacts.findById(request.workspaceId, candidate.alignmentArtifactId),
              ])
            } catch (error) {
              if (!(error instanceof DomainError) || error.code !== 'PERSISTENCE_CONFLICT') throw error
              missReasonCode = 'CANDIDATE_CHECKSUM_DRIFT'
              rejectedCandidateId = candidate.id
              continue
            }
            if (audio?.status !== 'available' || alignment?.status !== 'available') {
              missReasonCode = 'CANDIDATE_BLOB_UNAVAILABLE'
              rejectedCandidateId = candidate.id
              continue
            }
            if (
              !checksumHolds(evidence.produced, 'primary-audio', audio) ||
              !checksumHolds(evidence.produced, 'alignment-evidence', alignment)
            ) {
              missReasonCode = 'CANDIDATE_CHECKSUM_DRIFT'
              rejectedCandidateId = candidate.id
              continue
            }
            // What was cached must satisfy what is being asked for now. The
            // format lives in the cache key, so a divergence here means a stored
            // row drifted from its own address — reusing it anyway would hand the
            // caller a container it never requested.
            if (
              candidate.voice.outputFormat !== outputFormat ||
              audio.mediaType !== 'audio' || audio.container !== outputFormat ||
              alignment.mediaType !== 'data'
            ) {
              missReasonCode = 'CANDIDATE_OUTPUT_MISMATCH'
              rejectedCandidateId = candidate.id
              continue
            }
            const currentRights = await dependencies.rights.findCurrentForArtifacts(request.workspaceId, [candidate.audioArtifactId])
            const decision = evaluateAssetUse(currentRights.get(candidate.audioArtifactId) ?? null, {
              workspaceId: request.workspaceId,
              use: request.use,
              market: request.market,
              locale,
              syntheticOperations: ['tts'],
            }, now)
            if (decision.outcome !== 'allow') {
              missReasonCode = 'CANDIDATE_RIGHTS_BLOCKED'
              rejectedCandidateId = candidate.id
              continue
            }
            reused = candidate
            reusedEvidence = evidence
            reusedVerdict = verdict ?? null
            break
          }
        }

        // The right to submit paid work for this address, held from here until
        // the pending row that supersedes it is visible. Claiming BEFORE reading
        // the pending twins is what makes the check honest: the winner only lets
        // go once its row exists, so a loser either fails to claim or sees that
        // row — it can never observe the gap between the two.
        let claimed = false
        if (!reused && !forced) {
          claimed = await dependencies.submissionClaims.claim({
            workspaceId: request.workspaceId,
            cacheKey,
            blockId: block.id,
            now,
            staleBefore: new Date(now.getTime() - SYNTHETIC_CACHE_SUBMISSION_CLAIM_STALE_MS),
          })
        }
        try {
        if (!reused && !forced) {
          // A duplicate must never pay while its twin is in flight: defer until
          // the sibling generation settles, then reuse it through the cache.
          const twinInThisPass = inFlightKeys.has(cacheKey)
          const persistedTwins = twinInThisPass || !claimed
            ? []
            : (await dependencies.generations.findByCacheKey({ workspaceId: request.workspaceId, cacheKey, statuses: ['pending'] }))
              .filter((candidate) => candidate.blockId !== block.id)
          if (twinInThisPass || !claimed || persistedTwins.length > 0) {
            const reason = 'an in-flight generation already carries this exact cache key; waiting to reuse it instead of paying twice'
            // The twin has not settled, so nothing is avoided yet — only the
            // price it was quoted, when the provider already quoted one.
            const quoted = persistedTwins[0] ? await paidJobEvidence(persistedTwins[0], persistedTwins) : null
            await recordDecision({
              blockId: block.id,
              attempt,
              exactText: block.exactText,
              outcome: 'blocked',
              reasonCode: 'IN_FLIGHT_TWIN',
              reason,
              ...(quoted ? { estimatedSavingMinorUnits: quoted.costMinorUnits, currency: quoted.currency } : {}),
            })
            outcomes.push({ blockId: block.id, generationId: null, action: 'deferred-duplicate', reason })
            continue
          }
        }

        if (reused) {
          // Cost is read only now, after the cache already decided: the reuse is
          // priced by the estimate the paying job persisted, never by a number
          // this pass makes up.
          const evidence = reusedEvidence
          assertDomain(
            evidence !== null && evidence.costMinorUnits > 0,
            'PRECONDITION_REQUIRED',
            'Cache reuse cannot be booked: the reused generation carries no persisted provider estimate proving what it avoided',
          )
          const decisionReason = `cache hit: approved generation ${reused.id} shares this exact cache key with valid blob, rights and consent`
          await recordDecision({
            blockId: block.id,
            attempt,
            exactText: block.exactText,
            outcome: 'hit',
            reasonCode: 'CACHE_HIT_ELIGIBLE',
            reason: decisionReason,
            candidateGenerationId: reused.id,
            // The real report's content address when the critic wrote one;
            // otherwise the paying job's critic result hash, which is all the
            // evidence a pre-F3.009 reuse has.
            criticReportHash: reusedVerdict?.reportHash ?? evidence!.criticReportHash,
            estimatedSavingMinorUnits: evidence!.costMinorUnits,
            avoidedCostMinorUnits: evidence!.costMinorUnits,
            currency: evidence!.currency,
          })
          const generation = createSyntheticBlockGeneration({
            ...base,
            status: 'approved',
            cacheDecision: 'hit-reuse',
            decisionReason,
            sourceGenerationId: reused.id,
            audioArtifactId: reused.audioArtifactId!,
            alignmentArtifactId: reused.alignmentArtifactId!,
          })
          await dependencies.generations.create({ generation, ...(effective ? { supersedes: effective.id } : {}) })
          outcomes.push({ blockId: block.id, generationId: id, action: 'reused', reason: generation.decisionReason })
          continue
        }

        // A forced regeneration is audited in the operator's own words: the
        // ledger must say who decided to pay again and why, not merely that
        // somebody did.
        const decisionReason = forced
          ? `must-regenerate authorized by ${audit.clientId}: ${mustRegenerateReason}`.slice(0, 500)
          : 'cache miss: no approved generation carries this exact cache key'
        // The ledger entry is written before the paid call, so a ledger failure
        // can never leave an orphan provider job nobody decided to pay for.
        await recordDecision({
          blockId: block.id,
          attempt,
          exactText: block.exactText,
          outcome: forced ? 'forced-regenerate' : 'miss',
          reasonCode: forced ? 'MUST_REGENERATE' : missReasonCode,
          reason: forced || missReasonCode === 'CACHE_MISS_NO_CANDIDATE'
            ? decisionReason
            : `cache miss: every approved generation sharing this cache key was rejected (${missReasonCode})`,
          ...(forced ? {} : { candidateGenerationId: rejectedCandidateId }),
        })
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
      } finally {
        // Released only here: from this point the pending row itself is the
        // in-flight marker every other request can see.
        if (claimed) {
          await dependencies.submissionClaims.release({
            workspaceId: request.workspaceId,
            cacheKey,
            blockId: block.id,
          })
        }
      }
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
