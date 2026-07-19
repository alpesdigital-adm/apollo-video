import assert from 'node:assert/strict'
import test from 'node:test'

import { runProjectDirectorService } from '../../src/v2/application/run-project-director.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { createProjectVersion } from '../../src/v2/domain/project-version.ts'

const baseHash = 'a'.repeat(64)

function compiledEditorialPlan() {
  const words = [
    ['Seja', 0, 8], ['bem-vindo.', 8, 24],
    ['Comunicar', 34, 48], ['bem', 48, 56], ['muda', 56, 66], ['resultados.', 66, 88],
    ['Esta', 112, 120], ['imersão', 120, 136], ['desenvolve', 136, 154], ['clareza.', 154, 174],
    ['Você', 208, 220], ['vai', 220, 228], ['praticar', 228, 244], ['com', 244, 252], ['confiança.', 252, 276],
  ].map(([text, timelineStartFrame, timelineEndFrame], index) => ({
    text,
    sourceStartSeconds: index < 6 ? timelineStartFrame / 30 : (timelineStartFrame + 120) / 30,
    sourceEndSeconds: index < 6 ? timelineEndFrame / 30 : (timelineEndFrame + 120) / 30,
    timelineStartFrame,
    timelineEndFrame,
  }))
  return Object.freeze({
    schemaVersion: 2,
    state: 'compiled',
    id: 'edit-plan-base-1',
    projectVersionId: 'project-version-4',
    storyPlanId: null,
    fps: 30,
    durationFrames: 300,
    sources: Object.freeze([{ id: 'source-1', artifactId: 'artifact-master-1', kind: 'video', durationSeconds: 14 }]),
    videoTracks: Object.freeze([{ id: 'track-base', kind: 'base-video', clips: Object.freeze([
      Object.freeze({ id: 'clip-1', sourceArtifactId: 'artifact-master-1', sourceInFrame: 0, sourceOutFrame: 100, timelineInFrame: 0, timelineOutFrame: 100, rate: 1 }),
      Object.freeze({ id: 'clip-2', sourceArtifactId: 'artifact-master-1', sourceInFrame: 160, sourceOutFrame: 260, timelineInFrame: 100, timelineOutFrame: 200, rate: 1 }),
      Object.freeze({ id: 'clip-3', sourceArtifactId: 'artifact-master-1', sourceInFrame: 320, sourceOutFrame: 420, timelineInFrame: 200, timelineOutFrame: 300, rate: 1 }),
    ]) }]),
    overlayTracks: Object.freeze([]), subtitleTracks: Object.freeze([]), audioTracks: Object.freeze([]), effectTracks: Object.freeze([]),
    markers: Object.freeze([
      Object.freeze({ kind: 'editorial-cut', atFrame: 100, sourceStartSeconds: 3.333, sourceEndSeconds: 5.333, ruleIds: Object.freeze(['date-january-31', 'date-february-1']) }),
      Object.freeze({ kind: 'editorial-cut', atFrame: 200, sourceStartSeconds: 8.666, sourceEndSeconds: 10.666, ruleIds: Object.freeze(['duration-two-days']) }),
    ]),
    protectedElements: Object.freeze([]), localeVariantRefs: Object.freeze([]), formatVariantRefs: Object.freeze([]),
    lineageRefs: Object.freeze(['artifact-master-1']),
    editorial: Object.freeze({
      commandType: 'remove-spoken-content',
      exclusions: Object.freeze([
        Object.freeze({ sourceStartSeconds: 3.333, sourceEndSeconds: 5.333, ruleIds: Object.freeze(['date-january-31', 'date-february-1']), labels: Object.freeze(['31 de janeiro', '1 de fevereiro']), matchedText: '31 de janeiro e 1 de fevereiro' }),
        Object.freeze({ sourceStartSeconds: 8.666, sourceEndSeconds: 10.666, ruleIds: Object.freeze(['duration-two-days']), labels: Object.freeze(['dois dias']), matchedText: 'dois dias' }),
      ]),
      retainedSourceRanges: Object.freeze([
        Object.freeze({ sourceStartSeconds: 0, sourceEndSeconds: 3.333 }),
        Object.freeze({ sourceStartSeconds: 5.333, sourceEndSeconds: 8.666 }),
        Object.freeze({ sourceStartSeconds: 10.666, sourceEndSeconds: 14 }),
      ]),
    }),
    retimedTranscript: Object.freeze({ sourceTranscriptId: 'transcript-1', words: Object.freeze(words.map((word) => Object.freeze(word))) }),
    movementPolicy: Object.freeze({ automaticZoom: false, protectedOpeningFrames: 120 }),
    subtitlePolicy: Object.freeze({ faceProtection: true, anchor: 'bottom', maxCharactersPerBlock: 42 }),
    createdAt: '2026-07-18T20:00:00.000Z',
  })
}

class InMemoryDirectorRepository {
  constructor() {
    this.currentVersion = createProjectVersion({
      id: 'project-version-4', workspaceId: 'workspace-1', projectId: 'project-1', sequence: 4,
      parentVersionId: 'project-version-3',
      snapshotRefs: { brief: 'snapshot-brief-1', editPlan: 'snapshot-edit-4', policies: 'snapshot-policy-1' },
      baseHash, createdBy: 'client-1', createdAt: '2026-07-18T20:00:00.000Z',
    })
    this.records = new Map()
  }

  async findIdempotentResult({ workspaceId, projectId, idempotencyKey }) {
    return this.records.get(`${workspaceId}:${projectId}:${idempotencyKey}`) ?? null
  }

  async readContext({ workspaceId, projectId }) {
    if (workspaceId !== 'workspace-1' || projectId !== 'project-1') return null
    return {
      workspaceId,
      project: { id: projectId, objective: 'discovery', format: '9:16', locale: 'pt-BR' },
      currentVersion: this.currentVersion,
      brief: { productionBrief: { ownerInput: { text: 'Tom direto, natural e sem efeitos gratuitos.' } } },
      policies: { automaticZoom: false, faceProtection: true },
      editPlan: compiledEditorialPlan(),
      transcript: {
        id: 'transcript-1', sourceArtifactId: 'artifact-master-1', language: 'pt-BR',
        provider: 'groq', model: 'whisper-large-v3', transcriptHash: 'b'.repeat(64),
      },
    }
  }

  async commitOrReplay(bundle) {
    this.lastBundle = bundle
    const result = Object.freeze({ run: bundle.run, command: bundle.command, version: bundle.version, replayed: false })
    this.records.set(`${bundle.command.workspaceId}:${bundle.command.projectId}:${bundle.command.idempotencyKey}`, {
      requestFingerprint: bundle.requestFingerprint,
      result,
    })
    this.currentVersion = bundle.version
    return result
  }
}

function fixture() {
  const repository = new InMemoryDirectorRepository()
  const counters = new Map()
  let event = 0
  const service = runProjectDirectorService({
    repository,
    clock: () => new Date('2026-07-18T22:00:00.000Z'),
    createId: (kind) => {
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      return `${kind}-${next}`
    },
    createEventId: () => `00000000-0000-4000-8000-${String(++event).padStart(12, '0')}`,
  })
  return { repository, service }
}

function request(overrides = {}) {
  return {
    workspaceId: 'workspace-1', projectId: 'project-1', baseVersionId: 'project-version-4', baseHash,
    actor: { type: 'api-client', id: 'client-1' }, idempotency: { key: 'director-first-pass' },
    reason: 'Planejar e criticar a composição completa.',
    ...overrides,
  }
}

test('Director V2 persists perception, treatment, story, edit plan and critic as one immutable version', async () => {
  const { repository, service } = fixture()
  const result = await service(request())
  const plan = result.run.editPlan

  assert.equal(result.replayed, false)
  assert.equal(result.command.type, 'run-director')
  assert.equal(result.version.sequence, 5)
  assert.equal(result.version.parentVersionId, 'project-version-4')
  assert.equal(result.run.status, 'planned')
  assert.deepEqual(repository.lastBundle.snapshots.map((snapshot) => snapshot.kind), ['perception', 'treatment', 'story', 'edit-plan', 'quality-report'])
  assert.equal(result.run.perception.timeline.observations.length, compiledEditorialPlan().retimedTranscript.words.length)
  assert.equal(result.run.treatmentPlan.patternBreaks.allowed.includes('zoom'), false)
  assert.equal(result.run.storyPlan.blocks.length, 3)
  assert.equal(plan.videoTracks[0].clips.length, 3)
  assert.equal(plan.movementPolicy.automaticZoom, false)
  assert.equal(plan.movementPolicy.protectedOpeningFrames, 120)
  assert.equal(plan.effectTracks.length, 0)
  assert.equal(plan.transitions.length, 2)
  assert.equal(plan.transitions.every((transition) => transition.type === 'straight-cut' && transition.audioFadeMs === 24), true)
  const cues = plan.subtitleTracks.flatMap((track) => track.cues)
  assert.ok(cues.length > 0)
  assert.equal(cues.every((cue) => cue.anchor === 'bottom' && cue.text.length <= 32), true)
  assert.equal(cues.every((cue, index) => index === 0 || cue.startFrame >= cues[index - 1].endFrame), true)
  const captionText = cues.map((cue) => cue.text).join(' ').toLowerCase()
  assert.equal(captionText.includes('31 de janeiro'), false)
  assert.equal(captionText.includes('1 de fevereiro'), false)
  assert.equal(captionText.includes('dois dias'), false)
  assert.equal(result.run.decisions.some((decision) => decision.choice === 'no_effect'), true)
  assert.equal(result.run.decisions.some((decision) => decision.choice === 'no_insert'), true)
  assert.equal(result.run.qualityReport.status, 'approved-with-warnings')
  assert.equal(Object.values(result.run.qualityReport.hardChecks).every(Boolean), true)
  assert.equal(repository.lastBundle.event.type, 'project.version.created')
})

test('Director V2 replays exactly and rejects payload or version drift', async () => {
  const { service } = fixture()
  const first = await service(request())
  const replay = await service(request())
  assert.equal(replay.replayed, true)
  assert.equal(replay.run.id, first.run.id)
  assert.equal(replay.version.id, first.version.id)

  await assert.rejects(
    () => service(request({ reason: 'Outra intenção para a mesma chave.' })),
    (error) => error instanceof DomainError && error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )

  const stale = fixture()
  await assert.rejects(
    () => stale.service(request({ baseHash: 'c'.repeat(64), idempotency: { key: 'director-stale' } })),
    (error) => error instanceof DomainError && error.code === 'VERSION_CONFLICT',
  )
})
