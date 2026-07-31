import assert from 'node:assert/strict'
import test from 'node:test'

import { replaceSourceTranscriptService } from '../../src/v2/application/replace-source-transcript.ts'
import { createMediaTranscript } from '../../src/v2/domain/media-transcript.ts'
import { createProjectVersion } from '../../src/v2/domain/project-version.ts'
import { createSourceTranscriptArtifactInvalidations } from '../../src/v2/domain/source-transcript-replacement.ts'

const currentTranscript = createMediaTranscript({
  language: 'pt-BR', text: 'texto antigo', provider: 'groq', model: 'whisper-large-v3',
  words: [{ word: 'texto', start: 0.2, end: 0.5 }, { word: 'antigo', start: 1.2, end: 1.7 }],
  segments: [{ id: 0, start: 0.2, end: 1.7, text: 'texto antigo' }],
})
const replacementTranscript = createMediaTranscript({
  language: 'pt-BR', text: 'texto corrigido depois', provider: 'groq', model: 'whisper-large-v3',
  words: [
    { word: 'texto', start: 0.2, end: 0.5 },
    { word: 'corrigido', start: 1.2, end: 1.7 },
    { word: 'depois', start: 2.2, end: 2.6 },
  ],
  segments: [{ id: 0, start: 0.2, end: 2.6, text: 'texto corrigido depois' }],
})

function plan() {
  return {
    schemaVersion: 2, state: 'compiled', id: 'edit-plan-base', projectVersionId: 'version-base',
    fps: 30, durationFrames: 60,
    videoTracks: [{ id: 'base-video', kind: 'base-video', clips: [
      { id: 'clip-a', sourceArtifactId: 'artifact-master', sourceInFrame: 0, sourceOutFrame: 30, timelineInFrame: 0, timelineOutFrame: 30, rate: 1 },
      { id: 'clip-broll', sourceArtifactId: 'artifact-broll', audioSourceArtifactId: 'artifact-master', audioSourceInFrame: 30, audioSourceOutFrame: 60, sourceInFrame: 0, sourceOutFrame: 30, timelineInFrame: 30, timelineOutFrame: 60, rate: 1 },
    ] }],
    subtitleTracks: [],
    retimedTranscript: {
      sourceTranscriptId: 'transcript-current',
      sourceTranscriptHash: currentTranscript.transcriptHash,
      words: [],
    },
    createdAt: '2026-07-31T22:00:00.000Z',
  }
}

function version() {
  return createProjectVersion({
    id: 'version-base', workspaceId: 'workspace-transcript', projectId: 'project-transcript',
    sequence: 4, parentVersionId: 'version-parent',
    snapshotRefs: { brief: 'snapshot-brief', editPlan: 'snapshot-edit-plan', policies: 'snapshot-policies' },
    baseHash: 'a'.repeat(64), createdBy: 'client-transcript', createdAt: '2026-07-31T22:00:00.000Z',
  })
}

class Repository {
  committed
  async findIdempotentResult() { return this.committed ?? null }
  async readContext() {
    return {
      currentVersion: version(), editPlan: plan(), editPlanHash: 'b'.repeat(64),
      currentTranscript: { id: 'transcript-current', transcriptHash: currentTranscript.transcriptHash, sourceArtifactId: 'artifact-master' },
      replacementTranscript: { id: 'transcript-replacement', transcriptHash: replacementTranscript.transcriptHash, sourceArtifactId: 'artifact-master', transcript: replacementTranscript },
      outputReferences: [
        { artifactId: 'proxy-9x16', kind: 'proxy', sourceVersionId: 'version-base', variantId: '9:16' },
        { artifactId: 'final-16x9', kind: 'final', sourceVersionId: 'version-base', variantId: '16:9' },
      ],
    }
  }
  async commitOrReplay(bundle) {
    const invalidations = createSourceTranscriptArtifactInvalidations({ impact: bundle.command.payload.impact, createdAt: bundle.command.createdAt })
    const result = {
      command: bundle.command, version: bundle.version,
      editPlan: JSON.parse(bundle.snapshot.contentJson), impact: bundle.command.payload.impact,
      invalidations, replayed: false,
    }
    this.committed = { requestFingerprint: bundle.requestFingerprint, result }
    return result
  }
}

test('T-FR-233 source transcript replacement retimes immutable evidence and blocks render until DirectorRun', async () => {
  const repository = new Repository()
  let id = 0
  const execute = replaceSourceTranscriptService({
    repository,
    clock: () => new Date('2026-07-31T22:10:00.000Z'),
    createId: (kind) => `${kind}-transcript-${++id}`,
    createEventId: () => '123e4567-e89b-42d3-a456-426614174000',
  })
  const request = {
    workspaceId: 'workspace-transcript', projectId: 'project-transcript',
    baseVersionId: 'version-base', baseHash: 'a'.repeat(64),
    replacementTranscriptId: 'transcript-replacement',
    expectedTranscriptHash: replacementTranscript.transcriptHash,
    actor: { type: 'api-client', id: 'client-transcript' },
    idempotencyKey: 'source-transcript-replacement-1',
  }
  const result = await execute(request)
  assert.equal(result.command.type, 'replace-source-transcript')
  assert.equal(result.version.sequence, 5)
  assert.equal(result.editPlan.retimedTranscript.sourceTranscriptId, 'transcript-replacement')
  assert.equal(result.editPlan.retimedTranscript.sourceTranscriptHash, replacementTranscript.transcriptHash)
  assert.deepEqual(
    result.editPlan.retimedTranscript.words.map((word) => [word.text, word.timelineStartFrame, word.timelineEndFrame]),
    [['texto', 6, 15], ['corrigido', 36, 51]],
  )
  assert.equal(result.editPlan.retimedTranscript.words.some((word) => word.text === 'depois'), false)
  assert.deepEqual(result.impact.affectedRanges, [{ startFrame: 0, endFrame: 60 }])
  assert.deepEqual(result.impact.affectedVariantIds, ['16:9', '9:16'])
  assert.equal(result.impact.renderBlockedUntilDirectorRun, true)
  assert.equal(result.invalidations.length, 2)
  assert.ok(result.invalidations.every((item) => item.status === 'stale'))
  assert.equal(result.command.payload.nextRequiredCapability, 'apollo.projects.commands.apply:run-director')
  const replay = await execute(request)
  assert.equal(replay.replayed, true)
  assert.equal(replay.version.id, result.version.id)
})

test('T-FR-233 source transcript replacement fails closed on cross-source and hash drift', async () => {
  const repository = new Repository()
  const execute = replaceSourceTranscriptService({
    repository,
    clock: () => new Date('2026-07-31T22:10:00.000Z'),
    createId: (kind) => `${kind}-transcript-test`,
    createEventId: () => '123e4567-e89b-42d3-a456-426614174001',
  })
  const base = {
    workspaceId: 'workspace-transcript', projectId: 'project-transcript',
    baseVersionId: 'version-base', baseHash: 'a'.repeat(64),
    replacementTranscriptId: 'transcript-replacement', actor: { type: 'api-client', id: 'client-transcript' },
    idempotencyKey: 'source-transcript-replacement-2',
  }
  await assert.rejects(() => execute({ ...base, expectedTranscriptHash: 'f'.repeat(64) }), (error) => error.code === 'VERSION_CONFLICT')
  repository.readContext = async () => ({
    currentVersion: version(), editPlan: plan(), editPlanHash: 'b'.repeat(64),
    currentTranscript: { id: 'transcript-current', transcriptHash: currentTranscript.transcriptHash, sourceArtifactId: 'artifact-master' },
    replacementTranscript: { id: 'transcript-replacement', transcriptHash: replacementTranscript.transcriptHash, sourceArtifactId: 'artifact-other', transcript: replacementTranscript },
    outputReferences: [],
  })
  await assert.rejects(() => execute({ ...base, expectedTranscriptHash: replacementTranscript.transcriptHash, idempotencyKey: 'source-transcript-replacement-3' }), (error) => error.code === 'INVALID_ARGUMENT')
})
