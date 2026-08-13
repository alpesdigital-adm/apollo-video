import assert from 'node:assert/strict'
import test from 'node:test'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { putPerceptionTimelineService, readPerceptionTimelineRangeService } from '../../src/v2/application/perception-timelines.ts'
import { createApiAccessAuditContext } from '../../src/v2/domain/api-access-control.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createPerceptionTimeline, PERCEPTION_GOLDEN_FIXTURES, PERCEPTION_KINDS, queryPerceptionRange } from '../../src/v2/domain/perception-timeline.ts'

const provenance = { source: 'source-fixture', model: 'model-v1', version: 'v1', confidence: 0.9 }
const allCoverage = (durationMs, values = {}) => PERCEPTION_KINDS.map((kind) => ({ kind, ranges: values[kind] ?? [] }))

function actor() {
  const auditContext = createExternalAuditContext({
    clientId: 'client-perception', credentialId: 'credential-perception', workspaceId: 'workspace-perception', environment: 'production',
  })
  return Object.freeze({
    ...auditContext, scopes: new Set(['projects:read', 'projects:write']), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
  })
}

test('T-FR-050 canonical timeline declares all nine kinds, stable ordering and mandatory provenance', () => {
  assert.deepEqual(PERCEPTION_KINDS, ['transcript-word', 'speaker', 'silence', 'face', 'object', 'shot', 'motion', 'ocr', 'image-insert'])
  const timeline = createPerceptionTimeline({
    durationMs: 1_000,
    observations: [
      { id: 'object-z', kind: 'object', startMs: 100, endMs: 300, value: { label: 'phone' }, provenance },
      { id: 'word-a', kind: 'transcript-word', startMs: 100, endMs: 200, value: { text: 'Olá' }, provenance },
      { id: 'face-a', kind: 'face', startMs: 100, endMs: 300, value: { track: 'a' }, provenance },
    ],
    coverage: allCoverage(1_000, { 'transcript-word': [[0, 500]], object: [[0, 1_000]], face: [[0, 1_000]] }),
  })
  assert.deepEqual(timeline.observations.map((item) => item.id), ['word-a', 'face-a', 'object-z'])
  assert.equal(timeline.coverage.length, 9)
  assert.deepEqual(timeline.coverage.map((item) => item.state), ['partial', 'absent', 'absent', 'complete', 'complete', 'absent', 'absent', 'absent', 'absent'])
  assert.equal(timeline.inventedValues, 0)
  assert.match(timeline.timelineHash, /^[a-f0-9]{64}$/)
  assert.throws(() => createPerceptionTimeline({ durationMs: 10, observations: [{ id: 'bad', kind: 'ocr', startMs: 0, endMs: 10, value: 'x', provenance: { ...provenance, source: '' } }] }), /provenance/i)
  assert.throws(() => createPerceptionTimeline({ durationMs: 10, observations: [{ id: 'bad', kind: 'ocr', startMs: 0, endMs: 10, value: 'x', provenance }], coverage: allCoverage(10) }), /outside declared coverage/i)
})

test('T-FR-050 coverage is detector execution coverage, not a sum of observations', () => {
  const timeline = createPerceptionTimeline({
    durationMs: 1_000,
    observations: [],
    coverage: allCoverage(1_000, { face: [[0, 1_000]], object: [[0, 400], [400, 800]] }),
  })
  const result = queryPerceptionRange(timeline, { startMs: 200, endMs: 700, kinds: ['face', 'object', 'ocr'] })
  assert.deepEqual(result.coverage.map((item) => [item.kind, item.state, item.observedMs]), [
    ['face', 'complete', 500], ['object', 'complete', 500], ['ocr', 'absent', 0],
  ])
  assert.deepEqual(result.observations, [])
  assert.equal(result.inventedValues, 0)
})

test('T-FR-050 range query is half-open, merges overlap and reports partial without invention', () => {
  const timeline = createPerceptionTimeline({
    durationMs: 2_000,
    observations: [
      { id: 'left', kind: 'motion', startMs: 0, endMs: 500, value: { level: 'low' }, provenance },
      { id: 'boundary', kind: 'motion', startMs: 1_000, endMs: 1_200, value: { level: 'high' }, provenance },
    ],
    coverage: allCoverage(2_000, { motion: [[0, 500], [400, 800], [1_000, 1_200]] }),
  })
  const result = queryPerceptionRange(timeline, { startMs: 500, endMs: 1_000, kinds: ['motion', 'face'] })
  assert.deepEqual(result.observations, [])
  assert.deepEqual(result.coverage.map((item) => [item.kind, item.state, item.observedMs]), [['motion', 'partial', 300], ['face', 'absent', 0]])
  assert.throws(() => queryPerceptionRange(timeline, { startMs: 0, endMs: 1_000, kinds: ['face', 'face'] }), /kinds/i)
})

test('T-FR-050 golden talking-head, audio-only and inserted-image fixtures are deterministic and modality-honest', () => {
  assert.deepEqual(Object.keys(PERCEPTION_GOLDEN_FIXTURES), ['talkingHead', 'audioOnly', 'insertedImage'])
  assert.equal(PERCEPTION_GOLDEN_FIXTURES.talkingHead.coverage.find((item) => item.kind === 'face').state, 'complete')
  assert.equal(PERCEPTION_GOLDEN_FIXTURES.audioOnly.coverage.find((item) => item.kind === 'face').state, 'absent')
  assert.equal(PERCEPTION_GOLDEN_FIXTURES.insertedImage.coverage.find((item) => item.kind === 'image-insert').state, 'complete')
  assert.deepEqual(
    Object.values(PERCEPTION_GOLDEN_FIXTURES).map((timeline) => timeline.timelineHash),
    Object.values(PERCEPTION_GOLDEN_FIXTURES).map((timeline) => createPerceptionTimeline({
      durationMs: timeline.durationMs,
      observations: timeline.observations,
      coverage: timeline.coverage.map((entry) => ({ kind: entry.kind, ranges: entry.ranges })),
    }).timelineHash),
  )
})

test('T-FR-050 application put is credential-bound, idempotent and range-readable', async () => {
  let stored = null
  const repository = {
    async findIdempotent(input) {
      if (!stored || stored.idempotencyKey !== input.idempotencyKey) return null
      if (stored.authenticationAudit.contextHash !== input.actorContextHash) throw new Error('audit mismatch')
      return stored
    },
    async findLatest() { return stored },
    async persist(value) { stored = value; return { timeline: value, replayed: false } },
  }
  const put = putPerceptionTimelineService({ repository, clock: () => new Date('2026-08-12T20:00:00.000Z'), createId: () => 'perception-timeline-1' })
  const request = {
    workspaceId: 'workspace-perception', projectId: 'project-perception', projectVersionId: 'version-perception', baseRevision: null,
    durationMs: 2_000, observations: PERCEPTION_GOLDEN_FIXTURES.audioOnly.observations,
    coverage: PERCEPTION_GOLDEN_FIXTURES.audioOnly.coverage.map((entry) => ({ kind: entry.kind, ranges: entry.ranges })),
    idempotencyKey: 'perception-put-0001', actor: actor(),
  }
  const created = await put(request)
  assert.equal(created.replayed, false)
  assert.equal(created.timeline.authenticationAudit.contextHash, createApiAccessAuditContext({ clientId: 'client-perception', credentialId: 'credential-perception', workspaceId: 'workspace-perception', environment: 'production', authenticationKind: 'bearer' }).contextHash)
  assert.equal(created.timeline.recordHash, calculateCanonicalHash(Object.fromEntries(Object.entries(created.timeline).filter(([key]) => key !== 'recordHash'))))
  assert.equal((await put(request)).replayed, true)
  await assert.rejects(put({ ...request, durationMs: 2_001 }), (error) => error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH')
  const read = await readPerceptionTimelineRangeService({ repository })({ workspaceId: request.workspaceId, projectId: request.projectId, startMs: 0, endMs: 1_500, kinds: ['speaker', 'face'] })
  assert.deepEqual(read.result.coverage.map((item) => item.state), ['complete', 'absent'])
})
