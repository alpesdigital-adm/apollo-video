import test from 'node:test'
import assert from 'node:assert/strict'
import { adjustEditorialBeat, createAlignedBeatWords, deriveEditorialBeats, EDITORIAL_BEAT_BOUNDARY_REASONS } from '../../src/v2/domain/editorial-beat.ts'
import { deriveEditorialBeatSetService, adjustEditorialBeatService } from '../../src/v2/application/editorial-beats.ts'
import { createApiAccessAuditContext } from '../../src/v2/domain/api-access-control.ts'
import { createMediaTranscript } from '../../src/v2/domain/media-transcript.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'

const transcriptHash = 'a'.repeat(64)
const words = [
  { word: 'Esta', start: 0, end: 0.4 }, { word: 'frase', start: 0.45, end: 1 },
  { word: 'atravessa', start: 1.7, end: 2.2 }, { word: 'chunks', start: 2.25, end: 3 },
  { word: 'sem', start: 3.05, end: 3.4 }, { word: 'obedecer.', start: 3.45, end: 4 },
  { word: 'Nova', start: 4.05, end: 4.4 }, { word: 'intenção', start: 4.45, end: 5 },
]
const aligned = createAlignedBeatWords(transcriptHash, words)
const signals = aligned.map((word, index) => ({ wordId: word.id, intent: index < 6 ? 'explain' : 'conclude', argumentId: index < 4 ? 'argument-a' : 'argument-b', visualContext: index < 3 ? 'speaker' : 'insert' }))

test('T-FR-051 derives versioned semantic boundaries independently from subtitle chunks', () => {
  const result = deriveEditorialBeats({ transcriptHash, words, signals, pauseBoundaryMs: 450, maxDurationMs: 8_000 })
  assert.equal(result.derivationVersion, 'editorial-beat-derivation/v1')
  assert.deepEqual(EDITORIAL_BEAT_BOUNDARY_REASONS, ['sentence-end', 'intent-change', 'pause', 'argument-change', 'visual-change', 'max-duration'])
  assert.ok(result.beats.some((beat) => beat.boundaryReasons.includes('pause')))
  assert.ok(result.beats.some((beat) => beat.boundaryReasons.includes('visual-change')))
  assert.ok(result.beats.some((beat) => beat.boundaryReasons.includes('argument-change')))
  assert.ok(result.beats.some((beat) => beat.boundaryReasons.includes('intent-change')))
  assert.ok(result.beats.some((beat) => beat.boundaryReasons.includes('sentence-end')))
  // Pretend subtitle chunks split after every two words: no beat boundary is derived from those IDs.
  const subtitleBoundary = aligned[4].endMs
  assert.ok(!result.beats.some((beat) => beat.endMs === subtitleBoundary))
})

test('T-FR-051 long phrases split deterministically by maximum duration', () => {
  const continuous = Array.from({ length: 10 }, (_, index) => ({ word: `word${index}`, start: index, end: index + 0.8 }))
  const ids = createAlignedBeatWords(transcriptHash, continuous)
  const result = deriveEditorialBeats({ transcriptHash, words: continuous, signals: ids.map((word) => ({ wordId: word.id, intent: 'explain', argumentId: 'same', visualContext: 'speaker' })), maxDurationMs: 3_000 })
  assert.deepEqual(result.beats.slice(0, 2).map((beat) => beat.boundaryReasons), [['max-duration'], ['max-duration']])
  assert.equal(result.beats.at(-1).boundaryReasons.length, 0)
})

test('T-FR-051 Director adjustment is word-bound and preserves immutable alignment evidence', () => {
  const derived = deriveEditorialBeats({ transcriptHash, words, signals })
  const before = structuredClone(derived.words)
  const adjusted = adjustEditorialBeat({ beat: derived.beats[0], allWords: derived.words, startWordId: derived.words[1].id, endWordId: derived.words[3].id, directorRunId: 'director-run-accepted', reason: 'Preserve a complete internal argument.' })
  assert.equal(adjusted.wordAlignmentUnchanged, true)
  assert.equal(adjusted.wordAlignmentHash, derived.wordsHash)
  assert.deepEqual(derived.words, before)
  assert.deepEqual(adjusted.adjustedBeat.wordIds, derived.words.slice(1, 4).map((word) => word.id))
  assert.equal(adjusted.adjustedBeat.startMs, derived.words[1].startMs)
  assert.equal(adjusted.adjustedBeat.endMs, derived.words[3].endMs)
})

test('T-FR-051 rejects missing signals and arbitrary non-word adjustment boundaries', () => {
  assert.throws(() => deriveEditorialBeats({ transcriptHash, words, signals: signals.slice(1) }), /cover every aligned word/)
  const derived = deriveEditorialBeats({ transcriptHash, words, signals })
  assert.throws(() => adjustEditorialBeat({ beat: derived.beats[0], allWords: derived.words, startWordId: 'missing', endWordId: derived.words[1].id, directorRunId: 'director-run-accepted', reason: 'Invalid boundary.' }), /word range is invalid/)
})

test('T-FR-051 normalizes semantic signals before hashing and persistence', () => {
  const result = deriveEditorialBeats({ transcriptHash, words, signals: signals.map((signal) => ({ ...signal, intent: `  ${signal.intent.toUpperCase()} ` })) })
  assert.ok(result.signals.every((signal) => signal.intent === signal.intent.trim().toLowerCase()))
  assert.equal(result.signalsHash, calculateCanonicalHash(result.signals))
})

test('T-FR-051 application persists idempotent set and requires matching completed DirectorRun for adjustment', async () => {
  const actor = createApiAccessAuditContext({ clientId: 'client-editorial-beat', credentialId: 'credential-editorial-beat', workspaceId: 'workspace-editorial-beat', environment: 'production', authenticationKind: 'bearer' })
  const transcript = createMediaTranscript({ language: 'pt-BR', text: words.map((word) => word.word).join(' '), words, segments: [{ id: 0, start: 0, end: 5, text: words.map((word) => word.word).join(' ') }], provider: 'test-provider', model: 'test-model' })
  const stableWords = createAlignedBeatWords(transcript.transcriptHash, transcript.words)
  const stableSignals = stableWords.map((word) => ({ wordId: word.id, intent: 'explain', argumentId: 'argument-a', visualContext: 'speaker' }))
  let storedSet; let storedAdjustment
  const repository = {
    async readSource() { return { workspaceId: actor.workspaceId, projectId: 'project-editorial-beat', projectVersionId: 'version-editorial-beat', transcriptId: 'transcript-editorial-beat', transcript } },
    async findSetByIdempotency() { return storedSet ?? null }, async persistSet(set) { storedSet = set; return { set, replayed: false } },
    async findSet() { return storedSet ?? null }, async assertDirectorRun(input) { return input.directorRunId === 'director-run-editorial-beat' },
    async findAdjustmentByIdempotency() { return storedAdjustment ?? null }, async persistAdjustment(adjustment) { storedAdjustment = adjustment; return { adjustment, replayed: false } },
  }
  const derive = deriveEditorialBeatSetService({ repository, createId: () => 'beat-set-editorial-beat', clock: () => new Date('2026-08-13T10:00:00Z') })
  const request = { workspaceId: actor.workspaceId, projectId: 'project-editorial-beat', projectVersionId: 'version-editorial-beat', transcriptId: 'transcript-editorial-beat', expectedTranscriptHash: transcript.transcriptHash, signals: stableSignals, actor, idempotencyKey: 'editorial-beat-idempotency-1' }
  assert.equal((await derive(request)).replayed, false)
  assert.equal((await derive(request)).replayed, true)
  const adjust = adjustEditorialBeatService({ repository, createId: () => 'beat-adjustment-editorial-beat', clock: () => new Date('2026-08-13T10:01:00Z') })
  await assert.rejects(() => adjust({ workspaceId: actor.workspaceId, projectId: request.projectId, beatSetId: storedSet.id, beatId: storedSet.beats[0].id, directorRunId: 'director-run-wrong', startWordId: storedSet.words[0].id, endWordId: storedSet.words[1].id, reason: 'Preserve complete phrase.', actor, idempotencyKey: 'editorial-adjust-idempotency-1' }), /DirectorRun is not valid/)
  const result = await adjust({ workspaceId: actor.workspaceId, projectId: request.projectId, beatSetId: storedSet.id, beatId: storedSet.beats[0].id, directorRunId: 'director-run-editorial-beat', startWordId: storedSet.words[0].id, endWordId: storedSet.words[1].id, reason: 'Preserve complete phrase.', actor, idempotencyKey: 'editorial-adjust-idempotency-2' })
  assert.equal(result.adjustment.wordAlignmentHash, storedSet.wordsHash)
  assert.equal(result.adjustment.wordAlignmentUnchanged, true)
})
