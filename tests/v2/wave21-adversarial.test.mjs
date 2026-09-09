import assert from 'node:assert/strict'
import test from 'node:test'

import * as localization from '../../src/v2/domain/localization.ts'
import * as music from '../../src/v2/domain/music-led-montage.ts'
import { analyzeMusicForMontageService } from '../../src/v2/application/analyze-music-for-montage.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createCanonicalLocalizationService, mutateLocalizationVariantService } from '../../src/v2/application/localization-persistence.ts'
import { createLocalizationRun, beginLocalizationTranslation } from '../../src/v2/domain/localization-run.ts'
import { runNextLocalizationTranslationService } from '../../src/v2/application/localization-translation-worker.ts'
import { compileMusicLedMontageService } from '../../src/v2/application/compile-music-led-montage.ts'
import { createApiAccessAuditContext } from '../../src/v2/domain/api-access-control.ts'
import { fileURLToPath } from 'node:url'
import { ArtifactMusicSourceMaterializer } from '../../src/v2/infrastructure/music-analysis-runtime.ts'
import { runNextMusicAnalysisService } from '../../src/v2/application/music-analysis-worker.ts'

// Independent review cases: expected failures come from the business invariant,
// not from reproducing the implementation's calculations.
function canonical() {
  return localization.createCanonicalScriptVersion({
    id: 'canonical-review', workspaceId: 'workspace-review', projectId: 'project-review',
    projectVersionId: 'version-review', sourceLocale: 'pt-BR', revision: 1,
    approvedByClientId: 'reviewer-client', approvedAt: '2026-09-09T00:00:00.000Z',
    blocks: [{
      id: 'block-review', sourceScriptBlockId: 'script-block-review', role: 'body',
      sourceLocale: 'pt-BR', text: 'Nina tem 10 exemplos.', sourceRangeMs: [0, 1000],
      sourceAlignmentId: 'alignment-review', claims: [], qualifiers: [],
      protectedFacts: [{ id: 'quantity', text: '10' }, { id: 'person', text: 'Nina' }],
      dependencies: [], adaptationLevel: 'meaning-preserving',
    }],
  })
}

test('Wave21 review: a protected number cannot survive only as a substring of a different number', () => {
  const original = canonical()
  const valid = { blockId: 'block-review', text: 'Nina has 10 examples.', protectedValues: { quantity: '10', person: 'Nina' }, reviewStatus: 'human-approved' }
  assert.equal(localization.validateLocalizedBlocks(original, [valid])[0].text, valid.text)
  assert.throws(() => localization.validateLocalizedBlocks(original, [{ ...valid, text: 'Nina has 100 examples.' }]), { code: 'PRECONDITION_REQUIRED' })
  for (const changedQuantity of ['10.5', '-10', '10,000']) {
    assert.throws(() => localization.validateLocalizedBlocks(original, [{ ...valid, text: `Nina has ${changedQuantity} examples.` }]), { code: 'PRECONDITION_REQUIRED' })
  }
})

test('Wave21 review: unrelated and duplicated blocks cannot change duration accounting', () => {
  const original = canonical()
  assert.throws(() => localization.durationDeviation(original, [
    { blockId: 'block-review', durationMs: 1000 }, { blockId: 'unrelated', durationMs: 99999 },
  ]))
  assert.throws(() => localization.durationDeviation(original, [
    { blockId: 'block-review', durationMs: 1000 }, { blockId: 'block-review', durationMs: 900 },
  ]))
  for (const threshold of [NaN, Infinity, -1]) {
    assert.throws(() => localization.durationDeviation(original, [{ blockId: 'block-review', durationMs: 1000 }], threshold))
  }
  for (const durationMs of [850, 1150]) {
    assert.equal(localization.durationDeviation(original, [{ blockId: 'block-review', durationMs }]).thresholdExceeded, false, 'exactly fifteen percent is within the stated tolerance')
  }
  for (const durationMs of [849, 1151]) {
    assert.equal(localization.durationDeviation(original, [{ blockId: 'block-review', durationMs }]).thresholdExceeded, true)
  }
})

test('Wave21 review: validating measured alignment never freezes caller-owned objects', () => {
  const input = { word: 'Nina', startMs: 0, endMs: 100, confidence: 0.9 }
  const result = localization.validateMeasuredAlignment([input], 100)
  assert.equal(Object.isFrozen(input), false)
  input.word = 'changed later'
  assert.equal(result[0].word, 'Nina')
})

function variant() {
  const body = {
    id: 'variant-review', workspaceId: 'workspace-review', projectId: 'project-review',
    canonicalScriptVersionId: 'canonical-review', canonicalContentHash: canonical().contentHash,
    targetLocale: 'en-US', mode: 'subtitles-only', formats: ['16:9'],
    originalAudioAssetId: 'audio-review', status: 'draft', stage: 'draft', revision: 1,
    createdByClientId: 'reviewer-client', createdAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z',
  }
  return { ...body, variantHash: calculateCanonicalHash(body) }
}

test('Wave21 review: a stage patch cannot move a variant into another workspace', () => {
  const current = variant()
  const next = localization.transitionLocalizationVariant(current, 'translating', {
    stage: 'translating', updatedAt: '2026-09-09T00:00:01.000Z',
  })
  assert.equal(next.workspaceId, current.workspaceId)
  assert.throws(() => localization.transitionLocalizationVariant(current, 'translating', {
    stage: 'translating', updatedAt: '2026-09-09T00:00:01.000Z', workspaceId: 'other-workspace',
  }))
})

test('Wave21 review: a new revision owns its nested data and retains its content address', () => {
  const localizedBlocks = [{ blockId: 'block-review', text: 'Nina has 10 examples.' }]
  const next = localization.transitionLocalizationVariant(variant(), 'translating', {
    stage: 'translating', updatedAt: '2026-09-09T00:00:01.000Z', localizedBlocks,
  })
  assert.equal(Object.isFrozen(localizedBlocks[0]), false)
  localizedBlocks[0].text = 'Nina has 100 examples.'
  assert.equal(next.localizedBlocks[0].text, 'Nina has 10 examples.')
  assert.equal(calculateCanonicalHash({ ...next, variantHash: undefined }), next.variantHash)
})

test('Wave21 review: matching stored hash labels cannot authorize tampered variant content', () => {
  const original = variant()
  assert.equal(localization.assertLocalizationVariantIntegrity(original).variantHash, original.variantHash)
  for (const patch of [{ targetLocale: 'es-ES' }, { workspaceId: 'other-workspace' }, { status: 'approved' }]) {
    assert.throws(() => localization.assertLocalizationVariantIntegrity({ ...original, ...patch }), { code: 'PERSISTENCE_CONFLICT' })
  }
})

test('Wave21 review: another project canonical cannot stale an unrelated variant', () => {
  const original = canonical()
  const other = localization.createCanonicalScriptVersion({
    ...original, id: 'other-canonical', projectId: 'other-project',
    blocks: original.blocks.map(({ blockHash, ...block }) => block),
  })
  assert.throws(() => localization.markLocalizationStale(variant(), other, '2026-09-09T00:00:01.000Z'))
})

test('Wave21 review: retry identity excludes a fresh server ID and replay precedes current revision checks', async () => {
  const fingerprints = []
  const original = canonical()
  const authenticationAudit = { clientId: 'reviewer-client', contextHash: 'b'.repeat(64) }
  const create = createCanonicalLocalizationService({ repository: {
    async findCanonicalReplay(input) { fingerprints.push(input.requestFingerprint); return original },
    async loadCanonicalContext() { assert.fail('replay must not create a second canonical') },
  } })
  const intent = { workspaceId: original.workspaceId, projectId: original.projectId, projectVersionId: original.projectVersionId, alignmentId: 'alignment-review', actorClientId: 'reviewer-client', idempotencyKey: 'canonical-intent', authenticationAudit }
  assert.equal((await create({ ...intent, id: 'first-server-id' })).replayed, true)
  assert.equal((await create({ ...intent, id: 'retry-server-id' })).replayed, true)
  assert.equal(fingerprints[0], fingerprints[1])
  const recorded = variant()
  const mutate = mutateLocalizationVariantService({ repository: {
    async findMutationReplay() { return recorded },
    async readVariant() { assert.fail('a committed replay must not run a new CAS') },
  } })
  assert.equal((await mutate({ workspaceId: recorded.workspaceId, projectId: recorded.projectId, variantId: recorded.id, expectedRevision: 1, expectedHash: recorded.variantHash, action: 'cancel', actorClientId: 'reviewer-client', idempotencyKey: 'cancel-intent', authenticationAudit })).replayed, true)
})

test('Wave21 review: the worker consumes the already-claimed state instead of beginning the same attempt twice', async () => {
  const current = variant(), at = '2026-09-09T00:00:01.000Z'
  const requested = createLocalizationRun({ id: 'run-review', workspaceId: current.workspaceId, projectId: current.projectId, variantId: current.id, variantRevision: current.revision, variantHash: current.variantHash, canonicalScriptVersionId: current.canonicalScriptVersionId, canonicalContentHash: current.canonicalContentHash, requestedByClientId: current.createdByClientId, at })
  const claimed = beginLocalizationTranslation(requested, at)
  let calls = 0
  const worker = runNextLocalizationTranslationService({ workerId: 'review-worker', clock: () => new Date(at),
    runs: {
      async claim() { return { run: claimed, canonical: canonical(), variant: current, preflight: { providerId: 'review-provider', adapterVersion: '1', model: 'controlled', providerConfigHash: 'c'.repeat(64), maximumOutputTokens: 256 } } },
      async settle(input) { assert.equal(input.previousRunHash, claimed.runHash); assert.equal(input.run.attempt, 1); return input.run },
    },
    provider: { providerId: 'review-provider', adapterVersion: '1', model: 'controlled', configHash: 'c'.repeat(64), maxCompletionTokens: 256, async translate() { calls++; return [{ blockId: 'block-review', text: 'Nina has 10 examples.', protectedValues: { quantity: '10', person: 'Nina' }, reviewStatus: 'machine-translated' }] } },
  })
  const result = await worker()
  assert.equal(result.status, 'awaiting-human-review')
  assert.equal(calls, 1)
})

test('Wave21 review: revoked music rights still reject a cached analysis', async () => {
  let rightsChecks = 0
  let materializations = 0
  const run = analyzeMusicForMontageService({
    clock: () => new Date('2026-09-09T00:00:00.000Z'),
    rights: { async authorizeCurrent() { rightsChecks += 1; throw new Error('rights revoked') } },
    analyses: { async findBySourceFingerprint() { return { id: 'cached-analysis' } } },
    sources: { async materialize() { materializations += 1; throw new Error('must not read bytes') } },
    analyzer: {},
  })
  await assert.rejects(run({
    workspaceId: 'workspace-review', projectVersionId: 'version-review', artifactId: 'music-review',
    artifactKey: 'music/review.wav', expectedByteSize: 100, expectedSha256: 'a'.repeat(64),
    rightsSnapshotId: 'rights-review',
  }), /rights revoked/)
  assert.equal(rightsChecks, 1)
  assert.equal(materializations, 0)
})

function musicInput() {
  return {
    id: 'analysis-review', sourceArtifactId: 'music-review', sourceSha256: 'a'.repeat(64), sourceByteSize: 100,
    analyzer: { id: 'review-analyzer', version: '1', sampleRate: 22050, windowSize: 1024, hopSize: 512 },
    durationMs: 2000, tempo: { bpm: 120, confidence: 0.9 },
    beats: [{ atMs: 500, strength: 1, confidence: 0.9, kind: 'beat' }],
    sections: [{ id: 'section-review', rangeMs: [0, 2000], energy: 0.5, confidence: 0.5, role: 'unknown' }],
    energyCurve: [{ atMs: 0, value: 0.5 }], confidence: 0.9, limitations: [],
  }
}

test('Wave21 review: a music content address cannot hide NaN or change after caller mutation', () => {
  for (const field of ['confidence', 'atMs', 'strength']) {
    const input = musicInput()
    input.beats[0][field] = NaN
    assert.throws(() => music.createMusicAnalysis(input))
  }
  const input = musicInput()
  const result = music.createMusicAnalysis(input)
  assert.equal(Object.isFrozen(input.beats[0]), false)
  input.beats[0].atMs = 1500
  input.sections[0].rangeMs[1] = 20
  assert.equal(result.beats[0].atMs, 500)
  assert.equal(result.sections[0].rangeMs[1], 2000)
})

test('Wave21 review: approved source handles must not rescale a protected spoken word away from a cut', async () => {
  const persisted = music.createMusicAnalysis({ ...musicInput(), durationMs: 4000,
    beats: [{ atMs: 2000, strength: 1, confidence: .9, kind: 'beat' }],
    sections: [{ id: 'section-review', rangeMs: [0, 4000], energy: .5, confidence: .5, role: 'unknown' }],
  })
  const sources = [{ id: 'source-review', artifactId: 'video-review', durationSeconds: 8 }]
  let publications = 0
  let protections = []
  const compile = compileMusicLedMontageService({
    authority: { async resolveCurrent() { return { analysis: persisted, musicArtifactId: persisted.sourceArtifactId, rightsSnapshotId: 'rights-review', visualSources: sources, protectedSpeechRanges: protections } } },
    runs: { async findRequestReplay() { return null }, async saveWithRenderablePlan(input) { publications++; return { run: input.run, replayed: false } } },
    clock: () => new Date('2026-09-09T00:00:00.000Z'),
  })
  const authenticationAudit = createApiAccessAuditContext({ clientId: 'review-client', credentialId: 'review-credential', workspaceId: 'workspace-review', environment: 'sandbox', authenticationKind: 'bearer' })
  const request = { workspaceId: 'workspace-review', projectId: 'project-review', projectVersionId: 'version-review', runId: 'run-review', planId: 'plan-review', analysisId: persisted.id, fps: 25, objective: 'awareness', locale: 'pt-BR', sources,
    visualSegments: [{ id: 'clip-a', sourceId: 'source-review', sourceArtifactId: 'video-review', sourceRangeMs: [0, 2100], preferredDurationMs: 1920 }, { id: 'clip-b', sourceId: 'source-review', sourceArtifactId: 'video-review', sourceRangeMs: [3000, 6100], preferredDurationMs: 2080 }],
    actorClientId: 'review-client', authenticationAudit, idempotencyKey: 'review-key',
  }
  const control = await compile(request)
  assert.equal(control.run.editPlan.videoTracks[0].clips[0].sourceOutFrame, 50)
  publications = 0
  // This word is actually spoken from 1.90 to 2.04 seconds of the source.
  // Both the proposed 1.92 cut and its snapped 2.00 cut cut the word in half.
  protections = [{ id: 'measured-word', sourceArtifactId: 'video-review', rangeMs: [1900, 2040], reason: 'word' }]
  await assert.rejects(compile(request), (error) => error.code === 'INVALID_RENDER_INPUT')
  assert.equal(publications, 0)
})

test('Wave21 review: two music readers of the same artifact own separate cleanup namespaces', async () => {
  const operations = [], cleanups = []
  const reader = new ArtifactMusicSourceMaterializer({
    async materialize(input) { operations.push(input.operationId); return { path: fileURLToPath(new URL('../../package.json', import.meta.url)), sha256: 'a'.repeat(64) } },
    async cleanup(operationId) { cleanups.push(operationId) },
  })
  const input = { workspaceId: 'workspace-review', artifactId: 'music-review', artifactKey: 'music.wav', expectedByteSize: 100, expectedSha256: 'a'.repeat(64), rightsSnapshotId: 'rights-review' }
  const [first, second] = await Promise.all([reader.materialize(input), reader.materialize(input)])
  assert.equal(operations.length, 2)
  try { assert.notEqual(operations[0], operations[1], 'one concurrent reader must not clean up the other reader files') }
  finally { await first.release(); await second.release() }
  assert.deepEqual(cleanups, operations)
})

test('Wave21 review: a previously canceled music worker must not claim a fresh job', async () => {
  let claims = 0
  const controller = new AbortController()
  controller.abort(new Error('owner stopped'))
  const worker = runNextMusicAnalysisService({ workerId: 'worker-stopped', runs: { async claim() { claims++; return null } }, rights: {}, sources: {}, analyzer: {}, analyses: {} })
  try { await worker(controller.signal) } catch (error) { assert.match(error.message, /owner stopped|abort|cancel/i) }
  assert.equal(claims, 0)
})
