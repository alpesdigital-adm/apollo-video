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
import { reframeTimelineOf } from '../../src/v2/application/project-reframe-facts.ts'
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

test('T-FR-164 public application boundary returns localized review without approved server-owned ROI evidence', async () => {
  // W66r: the request names the STABLE output variant (the aspect ratio is not a variant) and the store, not the caller, supplies the facts.
  const reads = []
  const source = { artifactId: 'artifact-reframe-1', manifestId: 'manifest-reframe-1', sha256: 'a'.repeat(64), width: 1920, height: 1080 }
  const context = (versionId = 'project-version-reframe-1') => ({
    workspaceId: 'workspace-reframe-1', projectId: 'project-reframe-1', version: { id: versionId, baseHash: 'b'.repeat(64) }, variantId: 'variant-reframe-vertical-1',
    spec: { outputSpecRevisionId: 'revision-reframe-1', specHash: 'c'.repeat(64), aspectRatio: '4:5', safeArea: { top: 0.07, right: 0.06, bottom: 0.06, left: 0.06 }, width: 1080, height: 1350, fps: 30 },
    timeline: { fps: 30, durationFrames: 90 }, source, overrideHeads: [],
    clips: [{ clipId: 'clip-reframe-1', sourceArtifactId: source.artifactId, sourceSha256: source.sha256, sourceWidth: 1920, sourceHeight: 1080,
      sourceInFrame: 0, sourceOutFrame: 90, timelineInFrame: 0, timelineOutFrame: 90, rate: 1, fps: 30, hasStaticCrop: false }],
  })
  const plans = (versionId) => ({ async readContext(input) { reads.push(input); return context(versionId) }, async readHead() { return null },
    async persistOrReplay() { throw new Error('nothing may be persisted without evidence') } })
  const request = { workspaceId: 'workspace-reframe-1', projectId: 'project-reframe-1', baseVersionId: 'project-version-reframe-1', variantId: 'variant-reframe-vertical-1' }
  const result = await planProjectReframeService({ plans: plans('project-version-reframe-1') })(request)
  assert.deepEqual(result, { schemaVersion: 'reframe-plan-request-result/v3', status: 'review-required', plan: null,
    reasonCode: 'FACE_PERCEPTION_UNAVAILABLE', baseVersionId: 'project-version-reframe-1', variantId: 'variant-reframe-vertical-1', format: '4:5',
    requiredFaceWindows: [{ sourceArtifactId: 'artifact-reframe-1', windows: [{ startSourceFrame: 0, endSourceFrame: 90 }] }], replayed: false })
  assert.deepEqual(reads, [{ workspaceId: 'workspace-reframe-1', projectId: 'project-reframe-1', variantId: 'variant-reframe-vertical-1' }])
  await assert.rejects(() => planProjectReframeService({ plans: plans('project-version-new') })({ ...request, baseVersionId: 'project-version-stale' }), /stale/)
  // a rights refusal is the store's (it reads the source rights while reading the context) and is not swallowed
  const denied = { async readContext() { throw Object.assign(new Error('Render source no longer has approved current rights'), { code: 'ASSET_RIGHTS_BLOCKED' }) } }
  await assert.rejects(() => planProjectReframeService({ plans: denied })(request), (error) => error.code === 'ASSET_RIGHTS_BLOCKED')
  // one video source only: the observations describe one source
  const twoSources = (extra) => reframeTimelineOf({ editPlan: { fps: 30, durationFrames: 90, videoTracks: [{ kind: 'base-video', clips: [
    { id: 'clip-1', sourceArtifactId: 'artifact-reframe-1', sourceInFrame: 0, sourceOutFrame: 45, timelineInFrame: 0, timelineOutFrame: 45, rate: 1 },
    { id: 'clip-2', sourceArtifactId: extra, sourceInFrame: 0, sourceOutFrame: 45, timelineInFrame: 45, timelineOutFrame: 90, rate: 1 },
  ] }] }, renderSources: [{ artifactId: 'artifact-reframe-1', mediaType: 'video', sha256: 'a'.repeat(64), manifestId: 'manifest-reframe-1', probe: { width: 1920, height: 1080 } }] })
  assert.throws(() => twoSources('artifact-reframe-2'), (error) => error.code === 'PRECONDITION_REQUIRED' && error.details.reason === 'reframe-single-source-required')
  assert.doesNotThrow(() => twoSources('artifact-reframe-1'))
})

test('T-FR-164 public request cannot inject observation or manual override as detector evidence', async () => {
  const parsed = parseReframePlanRequest({ baseVersionId: 'project-version-reframe-1', variantId: 'variant-reframe-vertical-1' })
  assert.equal(parsed.variantId, 'variant-reframe-vertical-1')
  // W66r: the aspect ratio spelling of a variant (`format`) is no longer a request field, and neither are the observations or overrides.
  assert.throws(() => parseReframePlanRequest({ baseVersionId: 'project-version-reframe-1', format: '9:16' }), /unsupported/)
  assert.throws(() => parseReframePlanRequest({ baseVersionId: 'project-version-reframe-1', variantId: 'variant-reframe-vertical-1', observationSet: observationSet() }), /unsupported/)
  assert.throws(() => parseReframePlanRequest({ baseVersionId: 'project-version-reframe-1', variantId: 'variant-reframe-vertical-1', overrides: [] }), /unsupported/)
  const capability = FOUNDATION_CAPABILITIES.find((entry) => entry.id === 'apollo.projects.reframe-plans.create')
  assert.equal(capability.version, '3.0.0')
  assert.equal(capability.endpoint.path, '/v1/projects/{projectId}/reframe-plans')
  // planning persists a record, so it takes the write scope (it was a read-scope query while it persisted nothing)
  assert.deepEqual(capability.requiredScopes, ['projects:write'])
  const route = await readFile(new URL('../../src/app/v1/projects/[projectId]/reframe-plans/route.ts', import.meta.url), 'utf8')
  assert.match(route, /authenticateExternalRequest/)
  assert.match(route, /requireScope\(actor, 'projects:write'\)/)
  assert.match(route, /requireScope\(actor, 'projects:read'\)/)
  assert.match(route, /createVariantReframePlanRepository/)
  assert.doesNotMatch(route, /detector|provider|legacy/i)
})
