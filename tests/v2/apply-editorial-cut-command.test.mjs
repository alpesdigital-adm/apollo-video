import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyEditorialCutCommandService,
  compileInitialSourceEditPlan,
} from '../../src/v2/application/apply-editorial-cut-command.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { createMediaTranscript } from '../../src/v2/domain/media-transcript.ts'
import { createProjectVersion } from '../../src/v2/domain/project-version.ts'
import { createEditorialCutInvalidations, parseEditorialCutImpact } from '../../src/v2/domain/editorial-cut-impact.ts'

const baseHash = 'a'.repeat(64)

test('ingest compiles one full-source plan with transcript evidence and no fabricated cut', () => {
  const transcript = createMediaTranscript({
    language: 'pt-BR', text: 'fonte íntegra', provider: 'controlled', model: 'ingest/v1',
    words: [{ word: 'fonte', start: 0.2, end: 0.6 }, { word: 'íntegra', start: 0.7, end: 1.2 }],
    segments: [{ id: 0, text: 'fonte íntegra', start: 0.2, end: 1.2 }],
  })
  const plan = compileInitialSourceEditPlan({
    id: 'edit-plan-ingest-test', projectVersionId: 'version-ingest-test',
    transcriptId: 'transcript-ingest-test', transcript,
    sourceArtifactId: 'artifact-ingest-test', sourceDurationSeconds: 2, fps: 30,
    createdAt: '2026-08-02T18:00:00.000Z',
  })

  assert.equal(plan.editorial.commandType, 'source-ingest')
  assert.deepEqual(plan.editorial.exclusions, [])
  assert.deepEqual(plan.editorial.retainedSourceRanges, [{ sourceStartSeconds: 0, sourceEndSeconds: 2 }])
  assert.equal(plan.videoTracks[0].clips.length, 1)
  assert.equal(plan.videoTracks[0].clips[0].sourceInFrame, 0)
  assert.equal(plan.videoTracks[0].clips[0].sourceOutFrame, 60)
  assert.equal(plan.durationFrames, 60)
  assert.equal(plan.retimedTranscript.sourceTranscriptHash, transcript.transcriptHash)
})

function alignedTranscript() {
  return createMediaTranscript({
    language: 'pt-BR',
    text: 'abertura 31 de janeiro e 1 de fevereiro conteúdo 31 de janeiro e 1 de fevereiro final dois dias encerramento',
    words: [
      { word: 'abertura', start: 0, end: .6 },
      { word: '31', start: 39.2, end: 39.4 }, { word: 'de', start: 39.4, end: 39.55 }, { word: 'janeiro', start: 39.55, end: 39.9 },
      { word: 'e', start: 40, end: 40.1 }, { word: '1', start: 40.1, end: 40.25 }, { word: 'de', start: 40.25, end: 40.4 }, { word: 'fevereiro', start: 40.4, end: 40.8 },
      { word: 'conteúdo', start: 43, end: 43.5 },
      { word: '31', start: 55, end: 55.2 }, { word: 'de', start: 55.2, end: 55.35 }, { word: 'janeiro', start: 55.35, end: 55.7 },
      { word: 'e', start: 55.8, end: 55.9 }, { word: '1º', start: 55.9, end: 56.1 }, { word: 'de', start: 56.1, end: 56.25 }, { word: 'fevereiro', start: 56.25, end: 56.7 },
      { word: 'final', start: 58, end: 58.3 }, { word: 'dois', start: 84, end: 84.2 }, { word: 'dias', start: 84.2, end: 84.5 },
      { word: 'encerramento', start: 90.2, end: 90.8 },
    ],
    segments: [
      { id: 0, start: 0, end: .7, text: 'abertura' },
      { id: 1, start: 39.02, end: 42.68, text: '31 de janeiro e 1 de fevereiro' },
      { id: 2, start: 43, end: 43.6, text: 'conteúdo' },
      { id: 3, start: 54.82, end: 57.72, text: '31 de janeiro e 1 de fevereiro' },
      { id: 4, start: 58, end: 58.4, text: 'final' },
      { id: 5, start: 83.24, end: 89.979996, text: 'em apenas dois dias' },
      { id: 6, start: 90.2, end: 90.9, text: 'encerramento' },
    ],
    provider: 'groq',
    model: 'whisper-large-v3',
  })
}

class InMemoryEditorialCommandRepository {
  constructor() {
    this.currentVersion = createProjectVersion({
      id: 'project-version-1', workspaceId: 'workspace-1', projectId: 'project-1', sequence: 1,
      snapshotRefs: { brief: 'snapshot-brief-1', editPlan: 'snapshot-edit-1', policies: 'snapshot-policy-1' },
      baseHash, createdBy: 'client-1', createdAt: '2026-07-18T20:00:00.000Z',
    })
    this.transcript = alignedTranscript()
    this.records = new Map()
    this.lastBundle = undefined
    this.outputReferences = [
      { artifactId: 'artifact-proxy-1', kind: 'proxy', sourceVersionId: 'project-version-1', variantId: '9:16' },
      { artifactId: 'artifact-final-1', kind: 'final', sourceVersionId: 'project-version-1', variantId: '16:9' },
    ]
  }

  async findIdempotentResult({ workspaceId, projectId, idempotencyKey }) {
    return this.records.get(`${workspaceId}:${projectId}:${idempotencyKey}`) ?? null
  }

  async readContext({ workspaceId, projectId, transcriptId }) {
    if (workspaceId !== 'workspace-1' || projectId !== 'project-1' || transcriptId !== 'transcript-1') return null
    return {
      projectId, workspaceId, currentVersion: this.currentVersion, transcriptId,
      transcript: this.transcript, sourceArtifactId: 'artifact-master-1',
      sourceDurationSeconds: 102.166, sourceFps: 30.000000097,
      currentDurationFrames: 3065,
      proxyVariantId: '9:16',
      outputReferences: this.outputReferences,
    }
  }

  async commitOrReplay(bundle) {
    this.lastBundle = bundle
    const editPlan = JSON.parse(bundle.snapshot.contentJson)
    const result = {
      command: bundle.command,
      version: bundle.version,
      editPlan,
      exclusions: editPlan.editorial.exclusions,
      retainedSourceRanges: editPlan.editorial.retainedSourceRanges,
      impact: bundle.command.payload.impact,
      invalidations: createEditorialCutInvalidations({ impact: bundle.command.payload.impact, createdAt: bundle.command.createdAt }),
      replayed: false,
    }
    this.records.set(`${bundle.command.workspaceId}:${bundle.command.projectId}:${bundle.command.idempotencyKey}`, {
      requestFingerprint: bundle.requestFingerprint,
      result,
    })
    this.currentVersion = bundle.version
    return result
  }
}

function recoveryRules() {
  return [
    { id: 'date-january-31', label: '31 de janeiro', alternatives: ['31 de janeiro', 'trinta e um de janeiro'] },
    { id: 'date-february-1', label: '1 de fevereiro', alternatives: ['1 de fevereiro', 'primeiro de fevereiro'] },
    { id: 'duration-two-days', label: 'dois dias', alternatives: ['dois dias', '2 dias'] },
  ]
}

function fixture() {
  const repository = new InMemoryEditorialCommandRepository()
  const counters = new Map()
  let event = 0
  const service = applyEditorialCutCommandService({
    repository,
    clock: () => new Date('2026-07-18T21:00:00.000Z'),
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
    workspaceId: 'workspace-1', projectId: 'project-1', baseVersionId: 'project-version-1', baseHash,
    sourceTranscriptId: 'transcript-1', rules: recoveryRules(),
    reason: 'Remover datas e duração que não pertencem à nova composição.',
    actor: { type: 'api-client', id: 'client-1' },
    idempotency: { clientId: 'client-1', key: 'remove-dates-v1' },
    ...overrides,
  }
}

test('typed editorial Command creates an immutable retimed EditPlan without automatic zoom', async () => {
  const { repository, service } = fixture()
  const result = await service(request())

  assert.equal(result.replayed, false)
  assert.equal(result.command.type, 'remove-spoken-content')
  assert.equal(result.version.sequence, 2)
  assert.equal(result.version.parentVersionId, 'project-version-1')
  assert.equal(result.version.commandId, result.command.id)
  assert.equal(result.editPlan.videoTracks[0].clips.length, 4)
  assert.equal(result.editPlan.durationFrames, 2662)
  assert.equal(result.editPlan.movementPolicy.automaticZoom, false)
  assert.equal(result.editPlan.movementPolicy.protectedOpeningFrames, 120)
  assert.equal(Number.isInteger(result.editPlan.movementPolicy.protectedOpeningFrames), true)
  assert.equal(result.editPlan.subtitlePolicy.faceProtection, true)
  assert.deepEqual(result.exclusions.map(({ sourceStartSeconds, sourceEndSeconds }) => ({ sourceStartSeconds, sourceEndSeconds })), [
    { sourceStartSeconds: 39.02, sourceEndSeconds: 42.68 },
    { sourceStartSeconds: 54.82, sourceEndSeconds: 57.72 },
    { sourceStartSeconds: 83.24, sourceEndSeconds: 89.979996 },
  ])
  const retimedText = result.editPlan.retimedTranscript.words.map((word) => word.text).join(' ').toLowerCase()
  assert.equal(retimedText.includes('janeiro'), false)
  assert.equal(retimedText.includes('fevereiro'), false)
  assert.equal(retimedText.includes('dois dias'), false)
  assert.equal(repository.lastBundle.snapshot.kind, 'edit-plan')
  assert.equal(repository.lastBundle.event.type, 'project.version.created')
  assert.equal(result.command.payload.schemaVersion, 2)
  assert.equal(result.impact.schemaVersion, 'editorial-cut-impact/v1')
  assert.deepEqual(result.impact.affectedRanges, [{ startFrame: 0, endFrame: 3065 }])
  assert.deepEqual(result.impact.affectedVariantIds, ['16:9', '9:16'])
  assert.deepEqual(result.impact.dependencyTypes, ['audio', 'content', 'timing', 'visual'])
  assert.equal(result.impact.minimalRenders.length, 1)
  assert.equal(result.invalidations.length, 2)
  assert.equal(result.invalidations.every((item) => item.status === 'stale'), true)
  assert.equal(repository.lastBundle.event.data.commandImpactHash, result.impact.impactHash)
  const tampered = structuredClone(result.impact)
  tampered.affectedRanges[0].endFrame -= 1
  assert.throws(
    () => parseEditorialCutImpact(tampered),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
})

test('editorial Command still declares the required full proxy when the base has no completed output', async () => {
  const { repository, service } = fixture()
  repository.outputReferences = []
  const result = await service(request())
  assert.deepEqual(result.impact.affectedArtifacts, [])
  assert.deepEqual(result.impact.affectedVariantIds, [])
  assert.deepEqual(result.impact.minimalRenders, [{
    kind: 'proxy', variantId: '9:16', ranges: [{ startFrame: 0, endFrame: 2662 }],
  }])
  assert.deepEqual(result.invalidations, [])
})

test('editorial Command replays exactly and rejects reuse with a different payload', async () => {
  const { service } = fixture()
  const first = await service(request())
  const replay = await service(request())
  assert.equal(replay.replayed, true)
  assert.equal(replay.command.id, first.command.id)
  assert.equal(replay.version.id, first.version.id)

  await assert.rejects(
    () => service(request({ rules: recoveryRules().slice(0, 2) })),
    (error) => error instanceof DomainError && error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )
})

test('editorial Command rejects stale versions and rules absent from aligned source', async () => {
  const { service } = fixture()
  await assert.rejects(
    () => service(request({ baseHash: 'b'.repeat(64) })),
    (error) => error instanceof DomainError && error.code === 'VERSION_CONFLICT',
  )
  await assert.rejects(
    () => service(request({
      idempotency: { clientId: 'client-1', key: 'missing-phrase' },
      rules: [{ id: 'date-march-2', label: '2 de março', alternatives: ['2 de março'] }],
    })),
    (error) => error instanceof DomainError && error.code === 'INVALID_COMMAND' && error.details.missingRuleIds.includes('date-march-2'),
  )
})

test('editorial Command compiles exact reviewed exclusion overrides instead of whole transcript segments', async () => {
  const { service } = fixture()
  const result = await service(request({
    idempotency: { clientId: 'client-1', key: 'reviewed-exclusions-v1' },
    exclusionOverrides: [
      {
        sourceStartSeconds: 38.5,
        sourceEndSeconds: 58,
        ruleIds: ['date-january-31', 'date-february-1'],
        reason: 'Reviewed boundary preserves the sentence before and after both date mentions.',
      },
      {
        sourceStartSeconds: 83,
        sourceEndSeconds: 85,
        ruleIds: ['duration-two-days'],
        reason: 'Reviewed boundary removes only the duration claim.',
      },
    ],
  }))

  assert.deepEqual(result.retainedSourceRanges, [
    { sourceStartSeconds: 0, sourceEndSeconds: 38.5 },
    { sourceStartSeconds: 58, sourceEndSeconds: 83 },
    { sourceStartSeconds: 85, sourceEndSeconds: 102.166 },
  ])
  assert.equal(result.editPlan.videoTracks[0].clips.length, 3)
  assert.equal(result.editPlan.durationFrames, 2417)
  assert.equal(result.editPlan.movementPolicy.automaticZoom, false)
  assert.deepEqual(result.command.payload.exclusionOverrides, [
    {
      sourceStartSeconds: 38.5,
      sourceEndSeconds: 58,
      ruleIds: ['date-january-31', 'date-february-1'],
      reason: 'Reviewed boundary preserves the sentence before and after both date mentions.',
    },
    {
      sourceStartSeconds: 83,
      sourceEndSeconds: 85,
      ruleIds: ['duration-two-days'],
      reason: 'Reviewed boundary removes only the duration claim.',
    },
  ])
})

test('editorial Command rejects reviewed overrides that leave a detected occurrence behind', async () => {
  const { service } = fixture()
  await assert.rejects(
    () => service(request({
      idempotency: { clientId: 'client-1', key: 'incomplete-reviewed-exclusions-v1' },
      exclusionOverrides: [
        {
          sourceStartSeconds: 38.5,
          sourceEndSeconds: 43,
          ruleIds: ['date-january-31', 'date-february-1'],
          reason: 'This deliberately misses the second date occurrence.',
        },
        {
          sourceStartSeconds: 83,
          sourceEndSeconds: 85,
          ruleIds: ['duration-two-days'],
          reason: 'Duration claim.',
        },
      ],
    })),
    (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT' &&
      error.message === 'Editorial exclusion overrides must cover every detected phrase',
  )
})
