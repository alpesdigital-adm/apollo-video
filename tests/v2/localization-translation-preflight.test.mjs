import assert from 'node:assert/strict'
import test from 'node:test'
import { preflightLocalizationRunService } from '../../src/v2/application/localization-translation-worker.ts'
import { HmacPreflightCommitTokenIssuer } from '../../src/v2/infrastructure/security/preflight-commit-token.ts'
import { createLocalizationTranslationPricingFromEnvironment, createLocalizationTranslationProviderFromEnvironment } from '../../src/v2/infrastructure/localization-translation-runtime.ts'

const audit = { clientId: 'client-test', credentialId: 'credential-test', workspaceId: 'workspace-test', environment: 'test', authenticationKind: 'bearer', contextHash: 'a'.repeat(64) }
const variant = { id: 'variant-test', workspaceId: 'workspace-test', projectId: 'project-test', revision: 2, variantHash: 'b'.repeat(64), canonicalScriptVersionId: 'canonical-test', canonicalContentHash: 'c'.repeat(64), targetLocale: 'en-US', market: 'US', mode: 'subtitles-only', status: 'draft' }
const canonical = { id: 'canonical-test', contentHash: 'c'.repeat(64), blocks: [{ id: 'block-1', text: 'ten characters' }] }

test('translation preflight binds immutable source, provider configuration, actor, cost ceiling and expiry', async () => {
  let persisted
  const issuer = new HmacPreflightCommitTokenIssuer('localization-preflight-test-secret-more-than-32-bytes')
  const service = preflightLocalizationRunService({ localization: { async readVariant() { return variant }, async readCanonical() { return canonical } }, runs: { async findPreflightReplay() { return null }, async createPreflight(input) { persisted = input; return { preflight: input.preflight, replayed: false } } }, tokenIssuer: issuer, provider: { providerId: 'provider-test', adapterVersion: '1', model: 'model-test', configHash: 'd'.repeat(64), maxCompletionTokens: 20 }, pricing: { currency: 'USD', microsPerThousandInputCharacters: 1000, microsPerThousandOutputTokens: 2000, maximumCostMicros: 100, confirmationTtlMs: 60_000 }, clock: () => new Date('2026-09-09T02:00:00.000Z'), createId: () => 'preflight-test' })
  const result = await service({ workspaceId: variant.workspaceId, projectId: variant.projectId, variantId: variant.id, expectedRevision: variant.revision, expectedHash: variant.variantHash, actorClientId: audit.clientId, idempotencyKey: 'preflight-intent', authenticationAudit: audit })
  assert.equal(result.preflight.variantHash, variant.variantHash); assert.equal(result.preflight.canonicalContentHash, canonical.contentHash)
  assert.equal(result.preflight.providerConfigHash, 'd'.repeat(64)); assert.equal(result.preflight.maximumCostMicros, 100); assert.equal(result.preflight.maximumOutputTokens, 20); assert.equal(result.preflight.estimatedCostMicros, 54)
  assert.equal(issuer.verify(result.commitToken).clientId, audit.clientId); assert.equal(persisted.authenticationAudit.contextHash, audit.contextHash)
})

test('translation preflight rejects an estimate above the configured ceiling before persistence', async () => {
  const service = preflightLocalizationRunService({ localization: { async readVariant() { return variant }, async readCanonical() { return { ...canonical, blocks: [{ id: 'block-1', text: 'x'.repeat(2000) }] } } }, runs: { async findPreflightReplay() { return null }, async createPreflight() { assert.fail('must not persist') } }, tokenIssuer: new HmacPreflightCommitTokenIssuer('localization-preflight-test-secret-more-than-32-bytes'), provider: { providerId: 'provider-test', adapterVersion: '1', model: 'model-test', configHash: 'd'.repeat(64), maxCompletionTokens: 20 }, pricing: { currency: 'USD', microsPerThousandInputCharacters: 1000, microsPerThousandOutputTokens: 2000, maximumCostMicros: 100, confirmationTtlMs: 60_000 } })
  await assert.rejects(service({ workspaceId: variant.workspaceId, projectId: variant.projectId, variantId: variant.id, expectedRevision: variant.revision, expectedHash: variant.variantHash, actorClientId: audit.clientId, idempotencyKey: 'over-budget', authenticationAudit: audit }), /cost bound/)
})

test('translation runtime and pricing fail closed when credentials or server price are absent', () => {
  assert.throws(() => createLocalizationTranslationProviderFromEnvironment({}), /not configured/)
  assert.throws(() => createLocalizationTranslationPricingFromEnvironment({}), /not configured/)
  assert.throws(() => createLocalizationTranslationProviderFromEnvironment({ APOLLO_LOCALIZATION_PROVIDER_BASE_URL: 'https://provider.example', APOLLO_LOCALIZATION_PROVIDER_API_KEY: 'credential-long-enough', APOLLO_LOCALIZATION_PROVIDER_MODEL: 'model', APOLLO_LOCALIZATION_PROVIDER_TIMEOUT_MS: '30000', APOLLO_LOCALIZATION_PROVIDER_MAX_RESPONSE_BYTES: '2048' }), /MAX_COMPLETION_TOKENS/)
  assert.throws(() => createLocalizationTranslationPricingFromEnvironment({ APOLLO_LOCALIZATION_PRICE_CURRENCY: 'USD', APOLLO_LOCALIZATION_PRICE_MICROS_PER_1K_INPUT_CHARS: '1000', APOLLO_LOCALIZATION_MAX_COST_MICROS: '100000', APOLLO_LOCALIZATION_PREFLIGHT_TTL_MS: '60000' }), /OUTPUT_TOKENS/)
})
