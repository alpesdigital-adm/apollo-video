import assert from 'node:assert/strict'
import test from 'node:test'

import { createLocalizationRun } from '../../src/v2/domain/localization-run.ts'
import { requestLocalizationRunService, runNextLocalizationTranslationService } from '../../src/v2/application/localization-translation-worker.ts'

const audit = { clientId: 'client-test', credentialId: 'credential-test', workspaceId: 'workspace-test', environment: 'test', authenticationKind: 'bearer', contextHash: 'a'.repeat(64) }

test('localization request replays before reading mutable variant state', async () => {
  const replay = createLocalizationRun({ id: 'run-replay', workspaceId: 'workspace-test', projectId: 'project-test', variantId: 'variant-test', variantRevision: 1, variantHash: 'b'.repeat(64), canonicalScriptVersionId: 'canonical-test', canonicalContentHash: 'c'.repeat(64), requestedByClientId: 'client-test', at: '2026-09-09T02:00:00.000Z' })
  let reads = 0
  const service = requestLocalizationRunService({
    tokenIssuer: { verify() { return { clientId: 'client-test', workspaceId: 'workspace-test', fingerprint: 'e'.repeat(64), snapshot: 'b'.repeat(64), costFingerprint: 'f'.repeat(64), expiresAt: '2026-09-09T03:00:00.000Z' } } },
    localization: { async readVariant() { reads += 1; throw new Error('must not read after a successful retry') } },
    clock: () => new Date('2026-09-09T02:00:00.000Z'),
    runs: { async readPreflight() { return { id: 'preflight-test', preflightHash: 'e'.repeat(64), costFingerprint: 'f'.repeat(64) } }, async findRequestReplay() { return replay } },
  })
  const result = await service({ workspaceId: 'workspace-test', projectId: 'project-test', variantId: 'variant-test', expectedRevision: 1, expectedHash: 'b'.repeat(64), preflightId: 'preflight-test', expectedPreflightHash: 'e'.repeat(64), commitToken: 'trusted-token', actorClientId: 'client-test', idempotencyKey: 'retry-key', authenticationAudit: audit })
  assert.equal(result.replayed, true)
  assert.equal(result.run.runHash, replay.runHash)
  assert.equal(reads, 0)
})

test('translation worker persists only machine draft awaiting human review', async () => {
  const requested = createLocalizationRun({ id: 'run-worker', workspaceId: 'workspace-test', projectId: 'project-test', variantId: 'variant-test', variantRevision: 1, variantHash: 'b'.repeat(64), canonicalScriptVersionId: 'canonical-test', canonicalContentHash: 'c'.repeat(64), requestedByClientId: 'client-test', at: '2026-09-09T02:00:00.000Z' })
  const { beginLocalizationTranslation } = await import('../../src/v2/domain/localization-run.ts')
  const translating = beginLocalizationTranslation(requested, '2026-09-09T02:00:01.000Z')
  let settled
  const service = runNextLocalizationTranslationService({
    workerId: 'worker-test', clock: () => new Date('2026-09-09T02:00:02.000Z'), createLeaseToken: () => 'lease-test',
    runs: {
      async claim() { return { run: translating, variant: { targetLocale: 'en-US' }, canonical: { id: 'canonical-test' }, preflight: { providerId: 'controlled-test', adapterVersion: '1', model: 'test-model', providerConfigHash: 'd'.repeat(64), maximumOutputTokens: 256 } } },
      async settle(input) { settled = input; return input.run },
    },
    provider: { providerId: 'controlled-test', adapterVersion: '1', model: 'test-model', configHash: 'd'.repeat(64), maxCompletionTokens: 256, async translate() { return [{ blockId: 'block-test', text: 'Hello', protectedValues: {}, reviewStatus: 'machine-translated' }] } },
  })
  const result = await service()
  assert.equal(result.status, 'awaiting-human-review')
  assert.equal(result.translation.blocks[0].reviewStatus, 'machine-translated')
  assert.equal(result.translation.providerId, 'controlled-test')
  assert.equal(settled.previousRunHash, translating.runHash)
  assert.equal('approval' in result, false)
})

test('translation worker forwards cancellation inside the lease and settles fail closed', async () => {
  const requested = createLocalizationRun({ id: 'run-abort', workspaceId: 'workspace-test', projectId: 'project-test', variantId: 'variant-test', variantRevision: 1, variantHash: 'b'.repeat(64), canonicalScriptVersionId: 'canonical-test', canonicalContentHash: 'c'.repeat(64), requestedByClientId: 'client-test', at: '2026-09-09T02:00:00.000Z' })
  const { beginLocalizationTranslation } = await import('../../src/v2/domain/localization-run.ts'), translating = beginLocalizationTranslation(requested, '2026-09-09T02:00:01.000Z')
  let failed
  const service = runNextLocalizationTranslationService({ workerId: 'worker-abort', clock: () => new Date('2026-09-09T02:00:02.000Z'), createLeaseToken: () => 'lease-abort', executionTimeoutMs: 5_000,
    runs: { async claim() { return { run: translating, variant: { targetLocale: 'en-US' }, canonical: { id: 'canonical-test' }, preflight: { providerId: 'controlled-test', adapterVersion: '1', model: 'test-model', providerConfigHash: 'd'.repeat(64), maximumOutputTokens: 256 } } }, async settle(input) { failed = input.run; return input.run } },
    provider: { providerId: 'controlled-test', adapterVersion: '1', model: 'test-model', configHash: 'd'.repeat(64), maxCompletionTokens: 256, async translate(input) { input.signal.throwIfAborted(); await new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })) } },
  })
  const controller = new AbortController(); setTimeout(() => controller.abort(new Error('supervisor deadline')), 0)
  await assert.rejects(service(controller.signal), /supervisor deadline/)
  assert.equal(failed.status, 'failed'); assert.equal(failed.failure.retryable, false)
})

test('translation worker never claims when supervisor signal is already aborted', async () => {
  let claims = 0
  const service = runNextLocalizationTranslationService({ workerId: 'worker-preaborted', runs: { async claim() { claims += 1; return null } }, provider: { providerId: 'controlled-test', adapterVersion: '1', model: 'test-model', configHash: 'd'.repeat(64), maxCompletionTokens: 256, async translate() { assert.fail('must not dispatch') } } })
  const controller = new AbortController(); controller.abort(new Error('already stopped'))
  await assert.rejects(service(controller.signal), /already stopped/)
  assert.equal(claims, 0)
})
