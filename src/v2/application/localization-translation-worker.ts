import { createHash, randomUUID } from 'node:crypto'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import { createLocalizationRun, failLocalizationTranslation, recordLocalizationTranslation } from '../domain/localization-run.ts'
import type { ApiAccessAuditContext } from '../domain/api-access-control.ts'
import type { LocalizationRepository } from './ports/localization-repository.ts'
import type { LocalizationRunRepository } from './ports/localization-run-repository.ts'
import type { LocalizationTranslationProvider } from './ports/localization-translation-provider.ts'
import { ProviderAdapterError } from '../domain/provider-contract.ts'
import { createLocalizationTranslationPreflight } from '../domain/localization-translation-preflight.ts'
import type { PreflightCommitTokenIssuer } from './ports/preflight-commit-token.ts'
import { requirePreflightForActionService } from './preflight-gate.ts'

export interface LocalizationTranslationPricing { currency: string; microsPerThousandInputCharacters: number; microsPerThousandOutputTokens: number; maximumCostMicros: number; confirmationTtlMs: number }

export function preflightLocalizationRunService(deps: { localization: LocalizationRepository; runs: LocalizationRunRepository; tokenIssuer: PreflightCommitTokenIssuer; provider: Readonly<{ providerId: string; adapterVersion: string; model: string; configHash: string; maxCompletionTokens: number }>; pricing: Readonly<LocalizationTranslationPricing>; clock?: () => Date; createId?: () => string }) {
  return async (input: { workspaceId: string; projectId: string; variantId: string; expectedRevision: number; expectedHash: string; actorClientId: string; idempotencyKey: string; authenticationAudit: Readonly<ApiAccessAuditContext> }) => {
    assertDomain(Boolean(input.idempotencyKey) && input.idempotencyKey.length <= 128, 'INVALID_ARGUMENT', 'A bounded Idempotency-Key header is required')
    const requestFingerprint = calculateCanonicalHash({ ...input, idempotencyKey: undefined, authenticationAudit: undefined, providerConfigHash: deps.provider.configHash, pricing: deps.pricing })
    const replay = await deps.runs.findPreflightReplay({ workspaceId: input.workspaceId, actorClientId: input.actorClientId, actorContextHash: input.authenticationAudit.contextHash, idempotencyKey: input.idempotencyKey, requestFingerprint })
    if (replay) return Object.freeze({ preflight: replay, commitToken: deps.tokenIssuer.issue({ clientId: input.actorClientId, workspaceId: input.workspaceId, fingerprint: replay.preflightHash, snapshot: replay.variantHash, costFingerprint: replay.costFingerprint, expiresAt: replay.expiresAt }), replayed: true })
    const variant = await deps.localization.readVariant(input)
    assertDomain(Boolean(variant) && variant!.status === 'draft' && variant!.revision === input.expectedRevision && variant!.variantHash === input.expectedHash, 'VERSION_CONFLICT', 'Localization variant is not the requested draft revision')
    const canonical = await deps.localization.readCanonical({ workspaceId: input.workspaceId, projectId: input.projectId, canonicalId: variant!.canonicalScriptVersionId })
    assertDomain(Boolean(canonical) && canonical!.contentHash === variant!.canonicalContentHash, 'VERSION_CONFLICT', 'Canonical localization authority changed before preflight')
    const count = canonical!.blocks.reduce((total, block) => total + block.text.length, 0)
    const pricing = deps.pricing
    assertDomain(/^[A-Z]{3}$/.test(pricing.currency) && Number.isSafeInteger(pricing.microsPerThousandInputCharacters) && pricing.microsPerThousandInputCharacters >= 0 && Number.isSafeInteger(pricing.microsPerThousandOutputTokens) && pricing.microsPerThousandOutputTokens >= 0 && Number.isSafeInteger(deps.provider.maxCompletionTokens) && deps.provider.maxCompletionTokens > 0 && Number.isSafeInteger(pricing.maximumCostMicros) && pricing.maximumCostMicros >= 0 && Number.isSafeInteger(pricing.confirmationTtlMs) && pricing.confirmationTtlMs >= 10_000 && pricing.confirmationTtlMs <= 15 * 60_000, 'PERSISTENCE_NOT_CONFIGURED', 'Localization translation pricing policy is not configured')
    const at = (deps.clock ?? (() => new Date()))(), estimatedCostMicros = Math.ceil(count * pricing.microsPerThousandInputCharacters / 1000) + Math.ceil(deps.provider.maxCompletionTokens * pricing.microsPerThousandOutputTokens / 1000)
    const preflight = createLocalizationTranslationPreflight({ id: `localization-preflight-${(deps.createId ?? randomUUID)()}`, workspaceId: input.workspaceId, projectId: input.projectId, variantId: variant!.id, variantRevision: variant!.revision, variantHash: variant!.variantHash, canonicalScriptVersionId: variant!.canonicalScriptVersionId, canonicalContentHash: variant!.canonicalContentHash, targetLocale: variant!.targetLocale, ...(variant!.market ? { market: variant!.market } : {}), mode: variant!.mode, providerId: deps.provider.providerId, adapterVersion: deps.provider.adapterVersion, model: deps.provider.model, providerConfigHash: deps.provider.configHash, inputCharacterCount: count, maximumOutputTokens: deps.provider.maxCompletionTokens, estimatedCostMicros, maximumCostMicros: pricing.maximumCostMicros, currency: pricing.currency, requestedByClientId: input.actorClientId, createdAt: at.toISOString(), expiresAt: new Date(at.getTime() + pricing.confirmationTtlMs).toISOString() })
    const persisted = await deps.runs.createPreflight({ preflight, requestFingerprint, idempotencyKey: input.idempotencyKey, authenticationAudit: input.authenticationAudit })
    return Object.freeze({ ...persisted, commitToken: deps.tokenIssuer.issue({ clientId: input.actorClientId, workspaceId: input.workspaceId, fingerprint: persisted.preflight.preflightHash, snapshot: persisted.preflight.variantHash, costFingerprint: persisted.preflight.costFingerprint, expiresAt: persisted.preflight.expiresAt }) })
  }
}

export function requestLocalizationRunService(deps: { localization: LocalizationRepository; runs: LocalizationRunRepository; tokenIssuer: PreflightCommitTokenIssuer; clock?: () => Date; createId?: () => string }) {
  return async (input: { workspaceId: string; projectId: string; variantId: string; expectedRevision: number; expectedHash: string; preflightId: string; expectedPreflightHash: string; commitToken: string; actorClientId: string; idempotencyKey: string; authenticationAudit: Readonly<ApiAccessAuditContext> }) => {
    const requestFingerprint = calculateCanonicalHash({ ...input, idempotencyKey: undefined, authenticationAudit: undefined, commitToken: undefined })
    const preflight = await deps.runs.readPreflight({ workspaceId: input.workspaceId, projectId: input.projectId, variantId: input.variantId, preflightId: input.preflightId })
    assertDomain(Boolean(preflight) && preflight!.id === input.preflightId && preflight!.preflightHash === input.expectedPreflightHash, 'PREFLIGHT_TOKEN_STALE', 'Localization translation preflight was not found or changed')
    requirePreflightForActionService({ issuer: deps.tokenIssuer, clock: deps.clock })({ actionId: 'localization-translation.enqueue', token: input.commitToken, clientId: input.actorClientId, workspaceId: input.workspaceId, fingerprint: preflight!.preflightHash, snapshot: input.expectedHash, costFingerprint: preflight!.costFingerprint })
    const replay = await deps.runs.findRequestReplay({ workspaceId: input.workspaceId, actorClientId: input.actorClientId, actorContextHash: input.authenticationAudit.contextHash, idempotencyKey: input.idempotencyKey, requestFingerprint })
    if (replay) return Object.freeze({ run: replay, replayed: true })
    const variant = await deps.localization.readVariant(input)
    assertDomain(Boolean(variant), 'LOCALIZATION_VARIANT_NOT_FOUND', 'Localization variant was not found')
    assertDomain(variant!.status === 'draft' && variant!.revision === input.expectedRevision && variant!.variantHash === input.expectedHash, 'VERSION_CONFLICT', 'Localization variant is not the requested draft revision')
    assertDomain(preflight!.variantRevision === variant!.revision && preflight!.canonicalContentHash === variant!.canonicalContentHash, 'PREFLIGHT_TOKEN_STALE', 'Localization source changed after preflight')
    const at = (deps.clock ?? (() => new Date()))().toISOString()
    const run = createLocalizationRun({ id: (deps.createId ?? randomUUID)(), workspaceId: input.workspaceId, projectId: input.projectId, variantId: variant!.id, variantRevision: variant!.revision, variantHash: variant!.variantHash, canonicalScriptVersionId: variant!.canonicalScriptVersionId, canonicalContentHash: variant!.canonicalContentHash, requestedByClientId: input.actorClientId, at })
    return deps.runs.create({ run, preflightId: input.preflightId, expectedPreflightHash: input.expectedPreflightHash, requestFingerprint, idempotencyKey: input.idempotencyKey, authenticationAudit: input.authenticationAudit, consumedAt: at })
  }
}

export function runNextLocalizationTranslationService(deps: { runs: LocalizationRunRepository; provider: LocalizationTranslationProvider; authorizeClaim?: (claim: Awaited<ReturnType<LocalizationRunRepository['claim']>> & {}) => Promise<void>; clock?: () => Date; createLeaseToken?: () => string; workerId: string; leaseMs?: number; executionTimeoutMs?: number }) {
  return async (signal?: AbortSignal) => {
    signal?.throwIfAborted()
    const clock = deps.clock ?? (() => new Date()), now = clock(), leaseMs = deps.leaseMs ?? 60_000
    assertDomain(Number.isSafeInteger(leaseMs) && leaseMs >= 10_000 && leaseMs <= 10 * 60_000, 'INVALID_ARGUMENT', 'Localization lease duration is invalid')
    const leaseToken = (deps.createLeaseToken ?? randomUUID)(), leaseTokenHash = createHash('sha256').update(leaseToken).digest('hex')
    const claim = await deps.runs.claim({ workerId: deps.workerId, leaseTokenHash, now: now.toISOString(), leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString() })
    if (!claim) return null
    const translating = claim.run
    const controller = new AbortController(), timeoutMs = Math.min(deps.executionTimeoutMs ?? Math.max(10_000, leaseMs - 2_000), leaseMs - 1_000)
    assertDomain(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1_000, 'INVALID_ARGUMENT', 'Localization execution deadline is invalid')
    const timeout = setTimeout(() => controller.abort(new Error('localization translation deadline exceeded')), timeoutMs)
    const forwardAbort = () => controller.abort(signal?.reason); signal?.addEventListener('abort', forwardAbort, { once: true }); if (signal?.aborted) forwardAbort()
    try {
      if (deps.authorizeClaim) await deps.authorizeClaim(claim)
      assertDomain(claim.preflight.providerId === deps.provider.providerId && claim.preflight.adapterVersion === deps.provider.adapterVersion && claim.preflight.model === deps.provider.model && claim.preflight.providerConfigHash === deps.provider.configHash && claim.preflight.maximumOutputTokens === deps.provider.maxCompletionTokens, 'PREFLIGHT_TOKEN_STALE', 'Configured localization provider changed after confirmation')
      const blocks = await deps.provider.translate({ canonical: claim.canonical, targetLocale: claim.variant.targetLocale, market: claim.variant.market, signal: controller.signal })
      if (deps.authorizeClaim) await deps.authorizeClaim(claim)
      const completed = recordLocalizationTranslation(translating, { providerId: deps.provider.providerId, adapterVersion: deps.provider.adapterVersion, model: deps.provider.model, configHash: deps.provider.configHash }, blocks, clock().toISOString())
      return deps.runs.settle({ previousRunHash: translating.runHash, run: completed, leaseTokenHash, settledAt: completed.updatedAt })
    } catch (error) {
      const adapter = error instanceof ProviderAdapterError ? error : null
      const domain = error instanceof DomainError ? error : null, ambiguousAbort = controller.signal.aborted
      const failed = failLocalizationTranslation(translating, { code: domain?.code ?? adapter?.code ?? (ambiguousAbort ? 'PROVIDER_DEADLINE_EXCEEDED' : 'PROVIDER_UNAVAILABLE'), message: domain?.message ?? adapter?.message ?? (ambiguousAbort ? 'Localization translation deadline elapsed after possible provider dispatch' : 'Localization translation failed'), retryable: domain ? false : adapter?.retryable ?? !ambiguousAbort }, clock().toISOString())
      await deps.runs.settle({ previousRunHash: translating.runHash, run: failed, leaseTokenHash, settledAt: failed.updatedAt })
      throw error
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', forwardAbort) }
  }
}
