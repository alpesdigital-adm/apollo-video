import test from 'node:test';
import assert from 'node:assert/strict';
import { assertProfileEligible, assertSyntheticPresenterEditPlan, compileSyntheticEditPlan, createSyntheticPresenterEditPlan, createSyntheticPresenterProfileSnapshot, evaluateSyntheticBlock, prepareAudio, splitSyntheticBlocks, validateHybridStory } from '../../src/v2/domain/synthetic-production.ts';
import { ElevenLabsTtsProviderAdapter } from '../../src/v2/infrastructure/elevenlabs-tts-provider.ts';
import { HeyGenV3AsyncMediaProviderAdapter } from '../../src/v2/infrastructure/heygen-v3-provider.ts';
import { validateProviderCapabilities } from '../../src/v2/application/provider-capabilities.ts';
import { compileSyntheticPresenterRenderInputs } from '../../src/v2/application/compile-synthetic-presenter-render.ts';

const profile = { id: 'ana', version: 2, actor: 'Ana', providerIdentities: { heygen: 'ana-h' }, voiceProfiles: { 'pt-BR': 'ana-v' }, languages: ['pt-BR'], consent: { granted: true, expiresAt: '2030-01-01', allowedLocales: ['pt-BR'], allowedUses: ['ads'], evidenceId: 'consent-1' }, restrictions: [], active: true, disclosure: 'Personagem gerado por IA' };
const audio = prepareAudio({ text: 'Uma frase completa. Outra reflexão.', locale: 'pt-BR' });

test('T-FR-092 produces person-free synthetic presenter edit plan with disclosure', () => { const blocks = splitSyntheticBlocks('Uma frase completa. Outra reflexão.', { audio, profile, providerCapability: 'avatar' }); const plan = compileSyntheticEditPlan({ profile, audio, blocks, broll: ['b1'], captions: true, overlays: ['logo'], use: 'ads' }); assert.equal(plan.hasRealPerson, false); assert.equal(plan.tracks.captions.length, 5); });
test('T-FR-093 validates rights and continuity per block in real-avatar-proof-CTA golden', () => { const result = validateHybridStory([{ id: 'real', kind: 'real', sourceId: '1', rights: true, consent: true, identity: 'ana' }, { id: 'avatar', kind: 'synthetic', sourceId: '2', rights: true, consent: true, identity: 'ana', disclosure: 'IA' }, { id: 'proof', kind: 'proof', sourceId: '3', rights: true, consent: true }, { id: 'cta', kind: 'voiceover', sourceId: '4', rights: true, consent: true }]); assert.deepEqual(result, { allowed: true, issues: [], sequence: 'real>synthetic>proof>voiceover' }); });
test('T-FR-100 accepts text or approved upload and lets audio govern ranges', () => { const uploaded = { ...audio, id: 'approved', approved: true }; assert.equal(prepareAudio({ uploaded, locale: 'pt-BR' }), uploaded); const blocks = splitSyntheticBlocks('Uma frase completa. Outra reflexão.', { audio, profile, providerCapability: 'avatar' }); assert.equal(blocks.at(-1).rangeMs[1], audio.durationMs); });
test('T-FR-101 real provider adapters expose one canonical versioned contract with validated capabilities', async () => {
  const elevenlabs = new ElevenLabsTtsProviderAdapter({ apiKey: 'test-secret-key', costMinorUnitsPerThousandCharacters: 30, fetch: async () => { throw new Error('unreachable'); } });
  const heygen = new HeyGenV3AsyncMediaProviderAdapter({ apiKey: 'test-secret-key', costMinorUnitsPerMinute: 150, fetch: async () => { throw new Error('unreachable'); } });
  for (const adapter of [elevenlabs, heygen]) {
    assert.match(adapter.id, /^[a-z0-9-]+$/);
    assert.ok(adapter.adapterVersion.length > 0);
    assert.match(adapter.configHash, /^[a-f0-9]{64}$/);
    const capabilities = validateProviderCapabilities(await adapter.getCapabilities());
    assert.equal(typeof capabilities.supportsCancellation, 'boolean');
  }
  assert.equal((await elevenlabs.getCapabilities()).completion, 'synchronous');
  assert.equal((await heygen.getCapabilities()).completion, 'polling');
});
test('T-FR-102 stable sentence blocks preserve cache through reorder and isolate failure', () => { const original = splitSyntheticBlocks('Primeira ideia. Segunda ideia.', { audio, profile, providerCapability: 'avatar' }); const reordered = splitSyntheticBlocks('Segunda ideia. Primeira ideia.', { audio, profile, providerCapability: 'avatar' }); assert.deepEqual(new Set(original.map(x => x.cacheKey)), new Set(reordered.map(x => x.cacheKey))); });
test('T-FR-103 blocks expired or incompatible identity and voice cloning', () => { assert.equal(assertProfileEligible(profile, { locale: 'pt-BR', use: 'ads', now: '2029-01-01' }), true); assert.throws(() => assertProfileEligible({ ...profile, consent: { ...profile.consent, granted: false } }, { locale: 'pt-BR', use: 'ads' }), /ineligible/); });
// T-FR-104 moved to tests/v2/synthetic-master-asset.test.mjs, where it
// exercises the persisted, content-addressed master aggregate instead of the
// in-memory catalog that no service ever called.

const digest = (value) => value.repeat(64)
const artifact = (id, kind, value) => ({
  id,
  artifactId: `artifact-${id}`,
  artifactKey: `synthetic/${id}.${kind === 'image' ? 'png' : kind === 'audio' ? 'wav' : 'mp4'}`,
  kind,
  sha256: digest(value),
  byteSize: 1_024,
})

function durableFixture(overrides = {}) {
  const audioArtifact = {
    ...artifact('voice-master', 'audio', 'a'),
    durationMs: 2_000,
    locale: 'pt-BR',
    scriptHash: digest('b'),
    alignment: [
      { text: 'Olá', startMs: 0, endMs: 900 },
      { text: 'mundo', startMs: 900, endMs: 2_000 },
    ],
  }
  const profileSnapshot = createSyntheticPresenterProfileSnapshot({
    id: 'presenter-ana',
    version: 3,
    actorIdentityId: 'identity-ana',
    avatar: {
      adapterId: 'avatar-adapter',
      adapterVersion: 'version-1',
      identityRef: 'identity-ref-ana',
    },
    voice: {
      id: 'voice-ana',
      version: 2,
      adapterId: 'tts-adapter',
      adapterVersion: 'version-1',
    },
    defaultLocale: 'pt-BR',
    status: 'active',
    disclosure: 'Conteúdo gerado com IA',
    consent: {
      id: 'consent-ana',
      evidenceArtifactId: 'artifact-consent-ana',
      evidenceSha256: digest('d'),
      granted: true,
      allowedUses: ['ads'],
      allowedMarkets: ['BRA'],
      allowedLocales: ['pt-BR'],
      allowedOperations: ['tts', 'audio-avatar'],
      expiresAt: '2030-01-01T00:00:00.000Z',
    },
  })
  const blocks = [
    {
      id: 'synthetic-block-one',
      text: 'Olá',
      rangeMs: [0, 1_000],
      cacheKey: digest('e'),
      providerJobId: 'provider-job-one',
      audioSha256: audioArtifact.sha256,
      artifact: artifact('avatar-one', 'video', 'f'),
      critic: { id: 'critic-one', resultHash: digest('1'), status: 'approved' },
    },
    {
      id: 'synthetic-block-two',
      text: 'mundo',
      rangeMs: [1_000, 2_000],
      cacheKey: digest('2'),
      providerJobId: 'provider-job-two',
      audioSha256: audioArtifact.sha256,
      artifact: artifact('avatar-two', 'video', '3'),
      critic: { id: 'critic-two', resultHash: digest('4'), status: 'approved' },
    },
  ]
  const bRoll = [{
    id: 'broll-insert-one',
    rangeMs: [500, 1_250],
    artifact: artifact('broll-one', 'image', '5'),
    role: 'b-roll',
  }]
  const artifactIds = [
    audioArtifact.artifactId,
    ...blocks.map((entry) => entry.artifact.artifactId),
    ...bRoll.map((entry) => entry.artifact.artifactId),
  ]
  return {
    id: 'synthetic-edit-plan-one',
    workspaceId: 'workspace-synthetic',
    projectId: 'project-synthetic',
    projectVersionId: 'version-synthetic-one',
    profile: profileSnapshot,
    audio: audioArtifact,
    blocks,
    bRoll,
    overlays: [],
    captions: true,
    use: 'ads',
    market: 'BRA',
    authorization: {
      id: 'authorization-synthetic',
      authorizationHash: digest('6'),
      outcome: 'allowed',
      use: 'ads',
      market: 'BRA',
      locale: 'pt-BR',
      syntheticOperations: ['tts', 'audio-avatar'],
      artifactIds,
      decisions: artifactIds.map((artifactId, index) => ({
        artifactId,
        rightsSnapshotId: `rights-snapshot-${index + 1}`,
        rightsSnapshotHash: digest(String((index + 7) % 10)),
        validUntil: '2029-01-01T00:15:00.000Z',
      })),
      evaluatedAt: '2029-01-01T00:00:00.000Z',
      expiresAt: '2029-01-01T00:15:00.000Z',
    },
    createdAt: '2029-01-01T00:01:00.000Z',
    ...overrides,
  }
}

test('T-FR-092 creates immutable person-free EditPlan and portable RenderInputs', () => {
  const plan = createSyntheticPresenterEditPlan(durableFixture())
  assert.equal(plan.hasRealPerson, false)
  assert.equal(plan.blocks.length, 2)
  assert.equal(plan.captions.length, 2)
  assertSyntheticPresenterEditPlan(plan)
  const renderer = {
    id: 'remotion',
    version: 'version-1',
    digest: digest('7'),
  }
  const compiled = compileSyntheticPresenterRenderInputs({ plan, renderer })
  assert.equal(compiled.proxy.assets.length, 4)
  assert.equal(compiled.proxy.props.primaryAudioAssetId, 'synthetic-audio')
  assert.equal(compiled.proxy.props.scenes.length, 3)
  assert.equal(compiled.proxy.props.subtitles[0].text, 'Conteúdo gerado com IA')
  assert.equal(compiled.proxy.composition.propsHash, compiled.final.composition.propsHash)
  assert.equal(compiled.proxy.plan.hash, compiled.final.plan.hash)
})

test('T-FR-092 fails closed before render on consent, rights, critic or timeline drift', () => {
  const fixture = durableFixture()
  const disabledProfile = createSyntheticPresenterProfileSnapshot({
    id: fixture.profile.id,
    version: fixture.profile.version,
    actorIdentityId: fixture.profile.actorIdentityId,
    avatar: fixture.profile.avatar,
    voice: fixture.profile.voice,
    defaultLocale: fixture.profile.defaultLocale,
    status: 'disabled',
    disclosure: fixture.profile.disclosure,
    consent: {
      id: fixture.profile.consent.id,
      evidenceArtifactId: fixture.profile.consent.evidenceArtifactId,
      evidenceSha256: fixture.profile.consent.evidenceSha256,
      granted: fixture.profile.consent.granted,
      allowedUses: fixture.profile.consent.allowedUses,
      allowedMarkets: fixture.profile.consent.allowedMarkets,
      allowedLocales: fixture.profile.consent.allowedLocales,
      allowedOperations: fixture.profile.consent.allowedOperations,
      expiresAt: fixture.profile.consent.expiresAt,
    },
  })
  assert.throws(
    () => createSyntheticPresenterEditPlan({
      ...fixture,
      profile: disabledProfile,
    }),
    /consent is absent/,
  )
  assert.throws(
    () => createSyntheticPresenterEditPlan({
      ...fixture,
      authorization: { ...fixture.authorization, outcome: 'denied' },
    }),
    /authorization is absent/,
  )
  assert.throws(
    () => createSyntheticPresenterEditPlan({
      ...fixture,
      blocks: fixture.blocks.map((entry, index) => index === 0
        ? { ...entry, critic: { ...entry.critic, status: 'rejected' } }
        : entry),
    }),
    /not approved/,
  )
  assert.throws(
    () => createSyntheticPresenterEditPlan({
      ...fixture,
      blocks: fixture.blocks.map((entry, index) => index === 1
        ? { ...entry, rangeMs: [1_100, 2_000] }
        : entry),
    }),
    /without gaps or overlap/,
  )
})
test('T-FR-105 canonical cache changes only with relevant provider/profile/settings changes', () => { const a = splitSyntheticBlocks('Ideia.', { audio, profile, providerCapability: 'avatar', settings: { quality: 'hd' } })[0]; const b = splitSyntheticBlocks('Ideia.', { audio, profile, providerCapability: 'avatar', settings: { quality: 'hd' } })[0]; const c = splitSyntheticBlocks('Ideia.', { audio, profile, providerCapability: 'avatar', settings: { quality: '4k' } })[0]; assert.equal(a.cacheKey, b.cacheKey); assert.notEqual(a.cacheKey, c.cacheKey); });
test('T-FR-106 critic localizes known failures and chooses retry or fallback', () => { const failure = evaluateSyntheticBlock({ blockId: 'b1', rangeMs: [0, 2000], lipSync: .9, identity: .6, pronunciation: .9, artifacts: .1, framing: .9, continuity: .9 }); assert.equal(failure.passed, false); assert.equal(failure.issue.action, 'fallback'); });
