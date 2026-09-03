import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { compileSyntheticPresenterRenderInputs } from '../../src/v2/application/compile-synthetic-presenter-render.ts'
import { validateProviderCapabilities } from '../../src/v2/application/provider-capabilities.ts'
import { createSyntheticPresenterEditPlan, createSyntheticPresenterProfileSnapshot } from '../../src/v2/domain/synthetic-production.ts'
import { HeyGenV3AsyncMediaProviderAdapter } from '../../src/v2/infrastructure/heygen-v3-provider.ts'

const digest = (value) => value.repeat(64)

function planFor(adapterId, adapterVersion) {
  const audio = {
    id: 'audio-master', artifactId: 'artifact-audio', artifactKey: 'synthetic/audio.wav',
    kind: 'audio', sha256: digest('a'), byteSize: 1_024, durationMs: 2_000,
    locale: 'pt-BR', scriptHash: digest('b'),
    alignment: [{ text: 'Olá', startMs: 0, endMs: 1_000 }, { text: 'mundo', startMs: 1_000, endMs: 2_000 }],
  }
  const profile = createSyntheticPresenterProfileSnapshot({
    id: 'presenter-swap', version: 1, actorIdentityId: 'identity-swap',
    avatar: { adapterId, adapterVersion, identityRef: 'avatar-swap' },
    voice: { id: 'voice-swap', version: 1, adapterId: 'tts-registry-slot', adapterVersion: '1.0.0' },
    defaultLocale: 'pt-BR', status: 'active', disclosure: 'Conteúdo gerado com IA',
    consent: {
      id: 'consent-swap', evidenceArtifactId: 'artifact-consent', evidenceSha256: digest('c'), granted: true,
      allowedUses: ['ads'], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'],
      allowedOperations: ['tts', 'audio-avatar'], expiresAt: '2030-01-01T00:00:00.000Z',
    },
  })
  const video = {
    id: 'block-swap', artifactId: 'artifact-avatar', artifactKey: 'synthetic/avatar.mp4',
    kind: 'video', sha256: digest('d'), byteSize: 4_096,
  }
  return createSyntheticPresenterEditPlan({
    id: 'plan-swap', workspaceId: 'workspace-swap', projectId: 'project-swap', projectVersionId: 'version-swap',
    profile, audio,
    blocks: [{
      id: 'block-swap', text: 'Olá mundo', rangeMs: [0, 2_000], cacheKey: digest('e'),
      providerJobId: 'provider-job-swap', audioSha256: audio.sha256, artifact: video,
      critic: { id: 'critic-swap', resultHash: digest('f'), status: 'approved' },
    }],
    bRoll: [], overlays: [], captions: true, use: 'ads', market: 'BRA',
    authorization: {
      id: 'authorization-swap', authorizationHash: digest('1'), outcome: 'allowed', use: 'ads', market: 'BRA',
      locale: 'pt-BR', syntheticOperations: ['tts', 'audio-avatar'],
      artifactIds: [audio.artifactId, video.artifactId],
      decisions: [audio.artifactId, video.artifactId].map((artifactId, index) => ({
        artifactId, rightsSnapshotId: `rights-swap-${index}`, rightsSnapshotHash: digest(String(index + 2)),
        validUntil: '2029-01-01T00:15:00.000Z',
      })),
      evaluatedAt: '2029-01-01T00:00:00.000Z', expiresAt: '2029-01-01T00:15:00.000Z',
    },
    createdAt: '2029-01-01T00:01:00.000Z',
  })
}

test('T-F3-GATE fake and live-provider slots compile through one vendor-neutral EditPlan and renderer', async () => {
  const fakeCapabilities = validateProviderCapabilities({
    operations: ['audio-avatar'], inputFormats: ['mp3', 'wav'], outputFormats: ['mp4'], aspectRatios: ['9:16', '16:9'],
    duration: { minSeconds: 1, maxSeconds: 1_800 }, identityReference: 'profile-id',
    supportsSeed: false, supportsIdempotency: true, supportsCancellation: false, completion: 'polling',
    fetchedAt: '2029-01-01T00:00:00.000Z', expiresAt: '2029-01-01T01:00:00.000Z',
  })
  const liveAdapter = new HeyGenV3AsyncMediaProviderAdapter({
    apiKey: 'test-only-secret', costMinorUnitsPerMinute: 1,
    fetch: async () => { throw new Error('provider traffic is outside this structural gate') },
  })
  const liveCapabilities = validateProviderCapabilities(await liveAdapter.getCapabilities())
  assert.deepEqual(fakeCapabilities.operations, liveCapabilities.operations)

  const renderer = { id: 'remotion', version: '1.0.0', digest: digest('9') }
  const controlled = compileSyntheticPresenterRenderInputs({ plan: planFor('controlled-avatar', '1.0.0'), renderer })
  const live = compileSyntheticPresenterRenderInputs({ plan: planFor(liveAdapter.id, liveAdapter.adapterVersion), renderer })

  assert.deepEqual(controlled.final.assets, live.final.assets)
  assert.deepEqual(controlled.final.props, live.final.props)
  assert.equal(controlled.final.composition.propsHash, live.final.composition.propsHash)
  assert.notEqual(controlled.final.plan.hash, live.final.plan.hash, 'provider lineage must remain auditable')

  const guardedSources = [
    'src/v2/domain/synthetic-production.ts',
    'src/v2/application/compile-synthetic-presenter-render.ts',
    'remotion/src/VideoComposition.tsx',
  ]
  for (const path of guardedSources) {
    const source = await readFile(path, 'utf8')
    assert.doesNotMatch(source, /heygen|elevenlabs/i, `${path} must not branch on a provider identity`)
  }
})
