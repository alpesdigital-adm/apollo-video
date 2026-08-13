import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { OUTPUT_ASPECT_RATIOS } from '../../src/v2/domain/output-spec.ts'
import {
  createReframeObservationSet,
  createReframePlan,
  parseReframeObservationSet,
  REFRAME_OBSERVATION_FIXTURES,
  validateReframePlan,
} from '../../src/v2/domain/reframe-plan.ts'
import { planProjectReframeService } from '../../src/v2/application/plan-project-reframe.ts'
import { parseReframePlanRequest } from '../../src/v2/public-api/reframe-plan-contract.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { readFile } from 'node:fs/promises'

function observationSet(observations = REFRAME_OBSERVATION_FIXTURES.onePerson) {
  return createReframeObservationSet({
    id: 'observations-reframe-1', sourceArtifactId: 'artifact-reframe-1', sourceManifestId: 'manifest-reframe-1',
    sourceSha256: 'a'.repeat(64), sourceWidth: 1920, sourceHeight: 1080, fps: 30, durationFrames: 90,
    observations,
  })
}

test('T-FR-164 binds every crop plan to versioned observations and the canonical five-format registry', () => {
  const set = observationSet()
  for (const format of OUTPUT_ASPECT_RATIOS) {
    const plan = createReframePlan({ format, observationSet: set })
    assert.equal(plan.format, format)
    assert.equal(plan.observationSetHash, set.contentHash)
    assert.match(plan.outputFormatRegistryHash, /^[a-f0-9]{64}$/)
    assert.match(plan.outputPresetHash, /^[a-f0-9]{64}$/)
    assert.match(plan.planHash, /^[a-f0-9]{64}$/)
    const { planHash, ...body } = plan
    assert.equal(planHash, calculateCanonicalHash(body))
    assert.deepEqual(plan.segments.map((segment) => [segment.startFrame, segment.endFrame]), [[0, 90]])
  }
})

test('T-FR-164 fixtures cover one person, two people, screen and smoothly moving object', () => {
  assert.deepEqual(Object.keys(REFRAME_OBSERVATION_FIXTURES), ['onePerson', 'twoPeople', 'screen', 'movingObject'])
  const people = createReframePlan({ format: '9:16', observationSet: observationSet(REFRAME_OBSERVATION_FIXTURES.twoPeople) })
  assert.equal(people.segments[0].source, 'multiple-subjects')
  assert.deepEqual(people.segments[0].subjectIds, ['person-left', 'person-right'])
  const screen = createReframePlan({ format: '9:16', observationSet: observationSet(REFRAME_OBSERVATION_FIXTURES.screen) })
  assert.equal(screen.segments[0].mode, 'contain')
  assert.equal(screen.issues[0].code, 'SUBJECTS_DO_NOT_FIT')
  const moving = createReframePlan({ format: '9:16', observationSet: observationSet(REFRAME_OBSERVATION_FIXTURES.movingObject), maxVelocityPerSecond: 0.2, maxAccelerationPerSecondSquared: 0.3 })
  assert.equal(moving.segments.length, 3)
  for (const segment of moving.segments) assert.ok(Math.hypot(segment.velocity.x, segment.velocity.y) <= 0.2 + 1e-9)
  for (let index = 1; index < moving.segments.length; index += 1) {
    const previous = moving.segments[index - 1].velocity; const current = moving.segments[index].velocity
    assert.ok(Math.hypot(current.x - previous.x, current.y - previous.y) <= 0.3 + 1e-9)
  }
})

test('T-FR-164 exact format/range manual override wins only in its interval', () => {
  const set = observationSet(REFRAME_OBSERVATION_FIXTURES.movingObject)
  const plan = createReframePlan({
    format: '9:16', observationSet: set,
    overrides: [{ id: 'override-reframe-1', format: '9:16', startFrame: 30, endFrame: 60, crop: { x: 0.4, y: 0, width: 81 / 256, height: 1 } }],
  })
  assert.deepEqual(plan.segments.map((segment) => segment.source), ['object', 'manual', 'object'])
  assert.deepEqual(plan.segments[1].crop, { x: 0.4, y: 0, width: 81 / 256, height: 1 })
  assert.throws(() => createReframePlan({
    format: '16:9', observationSet: set,
    overrides: [{ id: 'override-wrong-format', format: '9:16', startFrame: 0, endFrame: 30, crop: { x: 0.4, y: 0, width: 81 / 256, height: 1 } }],
  }), /format must match/)
})

test('T-FR-164 fails closed on hash drift, malformed aspect and critical manual crop', () => {
  const set = observationSet()
  assert.throws(() => parseReframeObservationSet({ ...set, sourceWidth: 1280 }), /content hash/)
  assert.throws(() => createReframePlan({
    format: '9:16', observationSet: set,
    overrides: [{ id: 'override-bad-aspect', format: '9:16', startFrame: 0, endFrame: 90, crop: { x: 0, y: 0, width: 0.5, height: 0.5 } }],
  }), /aspect ratio/)
  assert.throws(() => createReframePlan({
    format: '9:16', observationSet: set,
    overrides: [{ id: 'override-crops-face', format: '9:16', startFrame: 0, endFrame: 90, crop: { x: 0, y: 0, width: 81 / 256, height: 1 } }],
  }), /critical subject/)
  const plan = createReframePlan({ format: '9:16', observationSet: set })
  assert.throws(() => validateReframePlan({ ...plan, planHash: 'f'.repeat(64) }, set), /plan hash/)
  assert.throws(() => validateReframePlan({ ...plan, segments: [{ ...plan.segments[0], crop: { ...plan.segments[0].crop, x: 0 } }], planHash: calculateCanonicalHash({ ...plan, planHash: undefined, segments: [{ ...plan.segments[0], crop: { ...plan.segments[0].crop, x: 0 } }] }) }, set), /critical subject|safe area|plan hash/)
})

test('T-FR-164 localizes uncertain perception and deterministic no-observation fallback', () => {
  const set = observationSet([
    { id: 'roi-uncertain-1', subjectId: 'object-uncertain', kind: 'region-of-interest', startFrame: 30, endFrame: 60, bounds: { x: 0.45, y: 0.4, width: 0.1, height: 0.1 }, confidence: 0.4, priority: 50, critical: false },
  ])
  const plan = createReframePlan({ format: '1:1', observationSet: set })
  assert.deepEqual(plan.issues.map((issue) => [issue.code, issue.startFrame, issue.endFrame]), [
    ['NO_SUBJECT_OBSERVATION', 0, 30], ['PERCEPTION_UNCERTAIN', 30, 60], ['NO_SUBJECT_OBSERVATION', 60, 90],
  ])
  assert.deepEqual(plan.segments.map((segment) => segment.mode), ['contain', 'crop', 'contain'])
})

test('T-FR-164 public application boundary binds workspace, immutable version and source artifact before planning', async () => {
  const set = observationSet()
  const reads = []
  const plan = await planProjectReframeService({ projects: { async readContext(input) {
    reads.push(input)
    return {
      currentVersion: { id: 'project-version-reframe-1' },
      editPlan: { videoTracks: [{ clips: [{ sourceArtifactId: 'artifact-reframe-1' }] }] },
    }
  } } })({ workspaceId: 'workspace-reframe-1', projectId: 'project-reframe-1', baseVersionId: 'project-version-reframe-1', format: '4:5', observationSet: set })
  assert.equal(plan.format, '4:5')
  assert.deepEqual(reads, [{ workspaceId: 'workspace-reframe-1', projectId: 'project-reframe-1' }])
  await assert.rejects(() => planProjectReframeService({ projects: { async readContext() { return { currentVersion: { id: 'project-version-new' }, editPlan: { videoTracks: [] } } } } })({ workspaceId: 'workspace-reframe-1', projectId: 'project-reframe-1', baseVersionId: 'project-version-stale', format: '4:5', observationSet: set }), /stale/)
})

test('T-FR-164 publishes an authenticated fail-closed API without claiming a detector', async () => {
  const parsed = parseReframePlanRequest({ baseVersionId: 'project-version-reframe-1', format: '9:16', observationSet: observationSet() })
  assert.equal(parsed.format, '9:16')
  assert.throws(() => parseReframePlanRequest({ baseVersionId: 'project-version-reframe-1', format: '9:16', observationSet: observationSet(), detector: 'fake' }), /unsupported/)
  const capability = FOUNDATION_CAPABILITIES.find((entry) => entry.id === 'apollo.projects.reframe-plans.create')
  assert.equal(capability.endpoint.path, '/v1/projects/{projectId}/reframe-plans')
  assert.deepEqual(capability.requiredScopes, ['projects:read'])
  const route = await readFile(new URL('../../src/app/v1/projects/[projectId]/reframe-plans/route.ts', import.meta.url), 'utf8')
  assert.match(route, /authenticateExternalRequest/)
  assert.match(route, /requireScope\(actor, 'projects:read'\)/)
  assert.match(route, /createDirectorRunRepository/)
  assert.doesNotMatch(route, /detector|provider|legacy/i)
})
