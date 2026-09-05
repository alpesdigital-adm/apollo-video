import assert from 'node:assert/strict'
import test from 'node:test'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createColorPlan, resolveColorPlan } from '../../src/v2/domain/color-and-export.ts'
import {
  createCameraColorMeasurement,
} from '../../src/v2/domain/color-measurement.ts'
import {
  COLOR_CRITIC_MAX_CORRECTION_ITERATIONS,
  evaluateColorCritic,
} from '../../src/v2/domain/color-critic-report.ts'
import { createTickInterval } from '../../src/v2/domain/session-time.ts'
import {
  addMulticamMatchRangeOverrideService,
  deriveMulticamMatchPlanService,
} from '../../src/v2/application/multicam-color-match.ts'
import {
  colorCriticProxyIssues,
  colorCriticRenderInputs,
  evaluateColorCriticService,
  matchPlanCoversCameras,
  selectRenderMatchPlan,
} from '../../src/v2/application/color-critic.ts'
import { buildFfmpegColorPipelineFilter } from '../../src/v2/infrastructure/media/ffmpeg-color-pipeline-processor.ts'
import { pipelineWithoutOutputTransform } from '../../src/v2/infrastructure/media/ffmpeg-color-critic-evaluator.ts'

/**
 * F4.013/F4.014 — the wiring, with fakes that behave like the real
 * repositories where it matters: the plan chain fences on (version, hash), the
 * ColorPlan write refuses a stale base, and a re-read hands back exactly what
 * was written. What is proved here is the SERVICE's behaviour, not the domain's
 * arithmetic, which `multicam-color.test.mjs` already covers.
 */

const METADATA = Object.freeze({
  colorSpace: 'rec709',
  transfer: 'bt709',
  primaries: 'bt709',
  matrix: 'bt709',
  range: 'limited',
  bitDepth: 8,
})

const EVALUATOR = Object.freeze({ id: 'ffmpeg-rgb24-statistics', kind: 'measured', version: '1.0.0' })
const sha = (seed) => seed.repeat(64).slice(0, 64)
const SESSION_HASH = sha('5')
const PROJECT_BASE_HASH = sha('7')

function transform(id, kind, provider, parameters, enabled = false) {
  const sorted = Object.freeze(Object.fromEntries(Object.entries(parameters).sort(([a], [b]) => a.localeCompare(b))))
  return Object.freeze({
    id, kind, version: 'v1', enabled,
    input: METADATA, output: METADATA,
    implementation: Object.freeze({
      provider, version: 'v1', parameters: sorted, parametersHash: calculateCanonicalHash(sorted),
    }),
  })
}

const IDENTITY_GLOBAL = Object.freeze([
  transform('technical-identity', 'technical', 'ffmpeg-zscale', { mode: 'identity' }),
  transform('match-global', 'match', 'apollo-match', { mode: 'bypass' }),
  transform('creative-none', 'creative-lut', 'apollo-lut', { mode: 'none' }),
  transform('output-identity', 'output', 'ffmpeg-zscale', { mode: 'identity' }),
])

function currentColorPlan(extra = {}) {
  return createColorPlan({
    schemaVersion: 'color-plan/v1',
    metadata: METADATA,
    outputMetadata: METADATA,
    global: IDENTITY_GLOBAL,
    sourceMetadata: { 'artifact-a': METADATA, 'artifact-b': METADATA },
    sources: {},
    cameras: {},
    segments: {},
    ...extra,
  })
}

const TARGETS = Object.freeze([
  Object.freeze({ sourceId: 'artifact-a', cameraId: 'cam-a', segmentId: 'clip-1' }),
  Object.freeze({ sourceId: 'artifact-b', cameraId: 'cam-b', segmentId: 'clip-2' }),
  // Camera B is cut to twice, so a shot can be removed from the EditPlan
  // without removing the camera with it.
  Object.freeze({ sourceId: 'artifact-b', cameraId: 'cam-b', segmentId: 'clip-2b' }),
])

/** A capture session shaped exactly as the repository hands one back. */
function session(overrides = {}) {
  const timebase = { schemaVersion: 'session-time/v1', secondsPerTick: { num: 1n, den: 48_000n } }
  const part = (partId, sourceAssetId, artifactId) => Object.freeze({
    partId,
    ordinal: 1,
    sourceAssetId,
    timebase,
    coverage: createTickInterval(0n, 48_000n),
    streamIndex: 0,
    splitReason: 'single',
    evidence: Object.freeze({
      ingestArtifactId: artifactId,
      ingestSha256: sha(artifactId.slice(-1)),
      probeHash: sha('9'),
      probeSource: 'ffprobe',
      observedAt: '2029-06-01T10:00:00.000Z',
    }),
  })
  return Object.freeze({
    schemaVersion: 'capture-session/v1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    version: 3,
    previousVersionHash: sha('4'),
    status: 'ready',
    clock: Object.freeze({ timebase, rounding: 'nearest-half-even' }),
    referenceTrackId: 'cam-a',
    referenceEpoch: 1,
    tracks: Object.freeze([
      Object.freeze({
        trackId: 'cam-a', role: 'camera-main',
        device: { deviceId: 'd1', recorderId: 'r1', make: null, model: null, serial: null },
        sourceAssetId: 'artifact-a', timebase, streamIndex: 0,
        syncAudioPolicy: 'usable', includeInFinalMix: true,
        parts: Object.freeze([part('part-a', 'artifact-a', 'artifact-a')]),
      }),
      Object.freeze({
        trackId: 'cam-b', role: 'camera-alt',
        device: { deviceId: 'd2', recorderId: 'r2', make: null, model: null, serial: null },
        sourceAssetId: 'artifact-b', timebase, streamIndex: 0,
        syncAudioPolicy: 'usable', includeInFinalMix: true,
        parts: Object.freeze([part('part-b', 'artifact-b', 'artifact-b')]),
      }),
    ]),
    lineage: { commandId: 'cmd-1', operation: 'register-track', actorKind: 'human', actorId: 'user-1', occurredAt: '2029-06-01T10:00:00.000Z', note: null },
    staleDerivations: Object.freeze([]),
    createdAt: '2029-06-01T10:00:00.000Z',
    sessionHash: SESSION_HASH,
    ...overrides,
  })
}

function measurement(input) {
  const evidenceRef = `rawvideo-rgb24:${input.measurementId}`
  const measured = (value, unit, components) => ({
    status: 'measured', value, unit, evaluator: EVALUATOR, evidenceRef,
    ...(components ? { components } : {}),
  })
  return createCameraColorMeasurement({
    measurementId: input.measurementId,
    sessionId: 'session-1',
    sourceAssetId: input.sourceAssetId,
    sourceSha256: input.sourceSha256,
    cameraId: input.cameraId,
    range: input.range,
    sourceRange: { startFrame: 0, endFrame: 24 },
    sampledFrames: 8,
    technical: { metadata: METADATA, pixelFormat: 'yuv420p', hdrMode: 'sdr' },
    dimensions: {
      whiteBalance: measured(input.bOverG / input.rOverG, 'ratio', {
        rOverG: input.rOverG, bOverG: input.bOverG, bOverR: input.bOverG / input.rOverG,
      }),
      exposure: measured(input.exposure, 'normalized-luma'),
      contrast: measured(0.2, 'normalized-luma', { p5: 0.1, p95: 0.9, spread: 0.8 }),
      blacks: measured(input.blacks ?? 0.001, 'ratio', { threshold: 4 / 255 }),
      highlights: measured(input.highlights ?? 0.001, 'ratio', { threshold: 251 / 255 }),
      saturation: measured(0.1, 'normalized-chroma'),
      tonalResponse: measured(0.5, 'normalized-luma', { p1: 0.02, p5: 0.1, p25: 0.3, p50: 0.5, p75: 0.7, p95: 0.9, p99: 0.98 }),
      skin: { status: 'not-applicable', reason: 'fewer than 2% of sampled pixels fall in the skin band; no skin-band region to measure' },
    },
    confidence: 1,
    issues: [],
  })
}

function fakeProbe(byCamera) {
  const calls = []
  return {
    calls,
    async measureCameraColor(input) {
      calls.push({ cameraId: input.cameraId, mediaPath: input.mediaPath, ranges: input.ranges })
      const recipe = byCamera[input.cameraId]
      assert.ok(recipe, `the probe was asked about an unexpected camera ${input.cameraId}`)
      return input.ranges.map((range, index) => measurement({
        measurementId: `ccm-${input.cameraId}-${index + 1}`,
        sourceAssetId: input.sourceAssetId,
        sourceSha256: input.sourceSha256,
        cameraId: input.cameraId,
        range: recipe.range ?? range.sessionRange,
        ...recipe,
      }))
    },
  }
}

function fakeMedia() {
  const state = { resolved: 0, released: 0 }
  return {
    state,
    async resolve({ part }) {
      state.resolved += 1
      return {
        path: `/media/${part.partId}.mp4`,
        release: async () => { state.released += 1 },
      }
    },
  }
}

function fakePlans() {
  const chains = new Map()
  const key = (workspaceId, projectId, sessionId) => `${workspaceId}/${projectId}/${sessionId}`
  const state = { appends: 0 }
  return {
    state,
    chains,
    async appendVersion({ plan, base }) {
      state.appends += 1
      const chainKey = key(plan.workspaceId, plan.projectId, plan.sessionId)
      const chain = chains.get(chainKey) ?? []
      const head = chain.at(-1) ?? null
      // The same fence the Prisma head UPDATE applies: a writer that read an
      // older head loses, and is told what is current.
      if ((base === null) !== (head === null) ||
        (base !== null && (base.version !== head.version || base.planHash !== head.plan.planHash))) {
        const error = new Error('match plan head moved on')
        error.code = 'PERSISTENCE_CONFLICT'
        throw error
      }
      const stored = Object.freeze({
        plan,
        version: head === null ? 1 : head.version + 1,
        previousVersionHash: head === null ? null : head.plan.planHash,
      })
      chains.set(chainKey, [...chain, stored])
      return { stored, replayed: false }
    },
    async readHead({ workspaceId, projectId, sessionId }) {
      return chains.get(key(workspaceId, projectId, sessionId))?.at(-1) ?? null
    },
    async readVersion({ workspaceId, projectId, sessionId, version }) {
      return chains.get(key(workspaceId, projectId, sessionId))?.find((entry) => entry.version === version) ?? null
    },
    async listVersions({ workspaceId, projectId, sessionId }) {
      return [...(chains.get(key(workspaceId, projectId, sessionId)) ?? [])].reverse()
    },
    async findDependents({ referenceCameraId, sessionId }) {
      return [...chains.values()].flat()
        .filter((entry) => (!sessionId || entry.plan.sessionId === sessionId) &&
          (!referenceCameraId || entry.plan.referenceCameraId === referenceCameraId))
        .map((entry) => ({
          projectId: entry.plan.projectId,
          sessionId: entry.plan.sessionId,
          version: entry.version,
          planHash: entry.plan.planHash,
          referenceCameraId: entry.plan.referenceCameraId,
          humanReviewRequired: entry.plan.humanReviewRequired,
          isHead: false,
        }))
    },
  }
}

function fakeMeasurementRepository() {
  const rows = new Map()
  return {
    rows,
    async persist({ measurement: value }) {
      const held = rows.get(value.measurementId)
      if (held && held.measurementHash !== value.measurementHash) {
        throw new Error('measurement stored with different content')
      }
      rows.set(value.measurementId, value)
      return { measurement: value, replayed: Boolean(held) }
    },
    async read({ measurementId }) { return rows.get(measurementId) ?? null },
    async listForSession() { return [...rows.values()] },
    async listForCamera({ cameraId }) { return [...rows.values()].filter((row) => row.cameraId === cameraId) },
  }
}

/**
 * A ColorPlan writer that behaves like the real command where the test cares:
 * it refuses a stale project fence, it runs the plan through `createColorPlan`
 * so an unacceptable layer fails here rather than in production, it resolves
 * every EditPlan target so an unresolvable chain cannot pass unnoticed, and —
 * the behaviour whose absence hid a defect — it fingerprints every request and
 * refuses an idempotency key reused with a different payload, in the same order
 * the real command does (`project-color-plans.ts:118-141`): fingerprint, then
 * replay, then the fence.
 */
function requestFingerprintOf(request, canonicalPlan) {
  return calculateCanonicalHash({
    schemaVersion: 'set-project-color-plan-request/v1',
    workspaceId: request.workspaceId,
    projectId: request.projectId,
    baseVersionId: request.baseVersionId,
    baseHash: request.baseHash,
    colorPlanHash: canonicalPlan.planHash,
    reason: request.reason?.trim() ?? null,
    actorIdentity: { kind: 'internal', actor: request.actor },
  })
}

function fakeColorPlanWriter(options = {}) {
  const state = {
    current: options.current ?? currentColorPlan(),
    versionId: 'version-1',
    baseHash: PROJECT_BASE_HASH,
    // Mutable, because an EditPlan is: a shot removed from the timeline is a
    // target that stops existing while the ColorPlan still carries its layer.
    targets: options.targets ?? TARGETS,
    writes: [],
    idempotency: new Map(),
  }
  const readContext = async () => ({
    currentVersion: { id: state.versionId, baseHash: state.baseHash, sequence: 1, snapshotRefs: [] },
    targets: state.targets,
    trustedSourceMetadata: { 'artifact-a': METADATA, 'artifact-b': METADATA },
    currentDurationFrames: 240,
    proxyVariantId: '16:9',
    outputReferences: [],
  })
  const readCurrent = async () => ({
    command: { id: 'cmd-color-1' },
    version: { id: state.versionId },
    colorPlan: { id: 'color-plan-1', plan: state.current, compiled: { manifestHash: sha('c') } },
    impact: {},
    invalidations: [],
    replayed: false,
  })
  const setProjectColorPlan = async (request) => {
    if (typeof request.idempotencyKey !== 'string' || request.idempotencyKey.length < 8 || request.idempotencyKey.length > 128) {
      const error = new Error('Idempotency-Key is invalid')
      error.code = 'INVALID_ARGUMENT'
      throw error
    }
    const canonical = createColorPlan(request.plan)
    const fingerprint = requestFingerprintOf(request, canonical)
    const replay = state.idempotency.get(request.idempotencyKey)
    if (replay) {
      if (replay.fingerprint !== fingerprint) {
        const error = new Error('Idempotency key was used with another project ColorPlan')
        error.code = 'IDEMPOTENCY_PAYLOAD_MISMATCH'
        throw error
      }
      return { ...replay.result, replayed: true }
    }
    if (request.baseVersionId !== state.versionId || request.baseHash !== state.baseHash) {
      const error = new Error('Project ColorPlan base version is stale')
      error.code = 'VERSION_CONFLICT'
      throw error
    }
    for (const target of state.targets) resolveColorPlan(canonical, target)
    state.writes.push({ plan: canonical, request })
    state.current = canonical
    state.versionId = `version-${state.writes.length + 1}`
    state.baseHash = sha(String(state.writes.length + 1))
    const result = {
      command: { id: `cmd-${state.writes.length}`, type: 'set-project-color-plan', reason: request.reason },
      version: { id: state.versionId },
      colorPlan: { id: `color-plan-${state.writes.length}`, plan: canonical, compiled: { manifestHash: calculateCanonicalHash(canonical) } },
      impact: {},
      invalidations: [],
      replayed: false,
    }
    state.idempotency.set(request.idempotencyKey, { fingerprint, result })
    return result
  }
  return { state, colorPlans: { readContext, readCurrent }, setProjectColorPlan }
}

function actorFrom(delegation, authenticationKind) {
  const auditContext = createExternalAuditContext({
    workspaceId: 'workspace-1',
    clientId: 'client-1',
    credentialId: 'credential-1',
    environment: 'sandbox',
    ...delegation,
  })
  return Object.freeze({
    ...auditContext,
    scopes: new Set(['projects:write']),
    authenticationKind,
    clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active',
    workspaceAccessStatus: 'active',
    auditContext,
  })
}

/** A person: a browser session with a delegated identity behind it. */
function humanActor() {
  return actorFrom(
    { delegatedUserId: 'user-1', delegatedIdentityId: 'identity-1', workspaceRole: 'director' },
    'ui-session',
  )
}

/** An agent's bearer credential with nobody behind it. */
function machineActor() {
  return actorFrom({}, 'bearer')
}

function wire(options = {}) {
  const writer = fakeColorPlanWriter(options)
  const plans = fakePlans()
  const media = fakeMedia()
  const measurements = fakeMeasurementRepository()
  const probe = options.probe ?? fakeProbe(options.cameras ?? {
    'cam-a': { rOverG: 1, bOverG: 0.9, exposure: 0.5 },
    // Two thirds of the reference's blue: a real white-balance divergence.
    'cam-b': { rOverG: 1.1, bOverG: 0.6, exposure: 0.42 },
  })
  const derive = deriveMulticamMatchPlanService({
    sessions: { async readHead() { return options.session ?? session() } },
    media, probe, measurements, plans,
    colorPlans: writer.colorPlans,
    setProjectColorPlan: writer.setProjectColorPlan,
    clock: () => new Date('2029-06-01T11:00:00.000Z'),
    ...(options.windowSeconds !== undefined ? { windowSeconds: options.windowSeconds } : {}),
    ...(options.maxRangesPerCamera !== undefined ? { maxRangesPerCamera: options.maxRangesPerCamera } : {}),
  })
  const override = addMulticamMatchRangeOverrideService({
    plans,
    colorPlans: writer.colorPlans,
    setProjectColorPlan: writer.setProjectColorPlan,
    clock: () => new Date('2029-06-01T12:00:00.000Z'),
  })
  return { writer, plans, media, measurements, probe, derive, override }
}

function deriveRequest(overrides = {}) {
  return {
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    referenceCameraId: 'cam-a',
    baseVersionId: 'session-1:v3',
    baseHash: SESSION_HASH,
    projectBaseVersionId: 'version-1',
    projectBaseHash: PROJECT_BASE_HASH,
    actor: humanActor(),
    ...overrides,
  }
}

test('T-F4.013 an unattended credential cannot choose the reference camera', async () => {
  const { derive } = wire()
  await assert.rejects(
    () => derive(deriveRequest({ actor: machineActor() })),
    (error) => error.code === 'AUTH_INVALID' && /human decision/.test(error.message),
  )
})

test('T-F4.013 a stale capture-session fence refuses and names what is current', async () => {
  const { derive } = wire()
  await assert.rejects(
    () => derive(deriveRequest({ baseVersionId: 'session-1:v2' })),
    (error) => error.code === 'CAPTURE_SESSION_VERSION_STALE' &&
      error.details.currentVersion === 3 && error.details.currentHash === SESSION_HASH,
  )
  await assert.rejects(
    () => derive(deriveRequest({ baseHash: sha('e') })),
    (error) => error.code === 'CAPTURE_SESSION_VERSION_STALE',
  )
})

test('T-F4.013 a stale project fence refuses the ColorPlan write', async () => {
  const { derive } = wire()
  await assert.rejects(
    () => derive(deriveRequest({ projectBaseVersionId: 'version-0' })),
    (error) => error.code === 'VERSION_CONFLICT',
  )
})

test('T-F4.013 the derivation measures, plans and writes only the cameras layer', async () => {
  const { derive, writer, media, measurements, plans } = wire()
  const result = await derive(deriveRequest())

  assert.equal(result.replayed, false)
  assert.equal(result.version, 1)
  assert.equal(result.plan.referenceCameraId, 'cam-a')
  assert.equal(result.plan.referenceCameraSelection.selectedBy.kind, 'human')
  assert.equal(result.plan.referenceCameraSelection.selectedBy.id, 'user-1')
  assert.equal(result.plan.referenceCameraSelection.baseVersionId, 'session-1:v3')
  // Every camera but the reference is corrected, and the numbers came from the
  // measurements: nothing in the request could have named them.
  assert.deepEqual(result.plan.cameraTransforms.map((entry) => entry.cameraId), ['cam-b'])
  assert.equal(result.plan.cameraTransforms[0].transform.implementation.version, 'v2')
  assert.ok(result.plan.cameraTransforms[0].deltas.whiteBalance.blueGain > 1)

  // Both measurements were persisted as their own aggregate, and every file was
  // released, once per resolve.
  assert.equal(measurements.rows.size, 2)
  assert.equal(media.state.resolved, 2)
  assert.equal(media.state.released, 2)
  assert.equal(plans.state.appends, 1)

  const written = writer.state.writes.at(-1).plan
  assert.deepEqual(Object.keys(written.cameras).sort(), ['cam-a', 'cam-b'])
  assert.equal(written.cameras['cam-a'][0].enabled, false, 'the reference camera is an explicit bypass')
  assert.equal(written.cameras['cam-b'][0].enabled, true)
  assert.equal(written.cameras['cam-b'][0].kind, 'match')
  // The global layer is the object that was read, not a rebuilt copy of it.
  assert.deepEqual(written.global, IDENTITY_GLOBAL.map((entry) => ({ ...entry })))
  assert.deepEqual(written.segments, {})
  // The audit trail records the service that moved the colour AND the person
  // who chose the reference — never one instead of the other.
  const reason = writer.state.writes.at(-1).request.reason
  assert.match(reason, /apollo-multicam-color-match/)
  assert.match(reason, /chosen by user-1/)
})

test('T-F4.013 a retry over the same bytes replays the stored plan and mints no second version', async () => {
  const { derive, plans, writer } = wire()
  const first = await derive(deriveRequest())
  const second = await derive(deriveRequest({
    projectBaseVersionId: writer.state.versionId,
    projectBaseHash: writer.state.baseHash,
  }))
  assert.equal(second.replayed, true)
  assert.equal(second.plan.planHash, first.plan.planHash)
  assert.equal(second.version, 1)
  assert.equal(plans.state.appends, 1, 'a retry must not append a version that differs only in its timestamp')
  assert.equal(writer.state.writes.length, 1, 'the ColorPlan idempotency key replays instead of writing again')
})

test('T-F4.013 a retry with a refreshed fence, a new note or a second person still writes nothing', async () => {
  // Each of these is a legitimate retry the caller cannot avoid: the fence moved
  // because the first attempt succeeded, the note is what the operator typed the
  // second time, and the second person is whoever picked the work up. All three
  // change the fingerprint the ColorPlan command computes, so a key derived from
  // the match plan alone would collide with itself and fail the retry.
  const second = () => actorFrom(
    { delegatedUserId: 'user-2', delegatedIdentityId: 'identity-2', workspaceRole: 'director' },
    'ui-session',
  )
  for (const [name, overrides] of [
    ['refreshed fence', {}],
    ['a new note', { note: 'retried after the upload stalled' }],
    ['a second person', { actor: second() }],
  ]) {
    const { derive, plans, writer } = wire()
    const first = await derive(deriveRequest())
    const retry = await derive(deriveRequest({
      projectBaseVersionId: writer.state.versionId,
      projectBaseHash: writer.state.baseHash,
      ...overrides,
    }))
    assert.equal(retry.replayed, true, name)
    assert.equal(retry.plan.planHash, first.plan.planHash, name)
    assert.equal(retry.colorPlan.replayed, true, name)
    assert.equal(retry.colorPlan.colorPlanHash, first.colorPlan.colorPlanHash, name)
    assert.equal(plans.state.appends, 1, name)
    assert.equal(writer.state.writes.length, 1, `${name}: a retry that changes nothing must write nothing`)
  }
})

test('T-F4.013 a ColorPlan key is never reused with a different payload', async () => {
  const { derive, writer } = wire()
  const first = await derive(deriveRequest())
  // Somebody else moved the ColorPlan in between: the camera this plan corrects
  // was reset to a bypass. The same match plan now compiles to a DIFFERENT
  // ColorPlan against a DIFFERENT project fence, which is exactly the payload a
  // key derived from the plan hash alone would reuse.
  writer.state.current = createColorPlan({
    ...writer.state.current,
    cameras: {
      ...writer.state.current.cameras,
      'cam-b': [transform('match-cam-b', 'match', 'apollo-match', { mode: 'bypass' })],
    },
  })
  const second = await derive(deriveRequest({
    projectBaseVersionId: writer.state.versionId,
    projectBaseHash: writer.state.baseHash,
  }))
  assert.equal(second.replayed, true, 'the match plan itself is unchanged, so no second version is minted')
  assert.equal(second.colorPlan.replayed, false, 'the ColorPlan really had to be rewritten')
  assert.equal(writer.state.writes.length, 2)
  const keys = writer.state.writes.map((write) => write.request.idempotencyKey)
  assert.equal(new Set(keys).size, 2, 'two different payloads must not share one idempotency key')
  assert.ok(keys.every((key) => key.startsWith('mcm-') && key.length >= 8))
  assert.equal(second.colorPlan.colorPlanHash, first.colorPlan.colorPlanHash,
    'the rewritten plan restores exactly the layers the match plan compiles to')
})

test('T-F4.013 a match needs two cameras and says which the EditPlan cuts to when it has one', async () => {
  const { derive, media } = wire({
    targets: [Object.freeze({ sourceId: 'artifact-a', cameraId: 'cam-a', segmentId: 'clip-1' })],
  })
  await assert.rejects(
    () => derive(deriveRequest()),
    (error) => error.code === 'COLOR_RANGES_NOT_COMPARABLE' &&
      error.details.referenceCameraId === 'cam-a' &&
      error.details.editPlanCameras.join(',') === 'cam-a',
  )
  assert.equal(media.state.resolved, 0, 'nothing is decoded for a sweep that cannot compare anything')
})

test('T-F4.013 fresh evidence that disagrees with the head appends a version instead of replaying it', async () => {
  // The bytes were re-measured and came back different — a re-ingest, a repaired
  // file. The stored plan rests on evidence that no longer exists, so replaying
  // it would write a correction nobody can reproduce.
  let call = 0
  const drifting = fakeProbe({
    'cam-a': { rOverG: 1, bOverG: 0.9, exposure: 0.5 },
    'cam-b': { rOverG: 1.1, bOverG: 0.6, exposure: 0.42 },
  })
  const probe = {
    calls: drifting.calls,
    async measureCameraColor(input) {
      call += 1
      const produced = await drifting.measureCameraColor(input)
      // The second sweep reads the same cameras through a different exposure.
      return call > 2
        ? produced.map((entry) => measurement({
            // A content-addressed instrument names different bytes differently.
            measurementId: `${entry.measurementId}-remeasured`,
            sourceAssetId: entry.sourceAssetId,
            sourceSha256: entry.sourceSha256,
            cameraId: entry.cameraId,
            range: entry.range,
            rOverG: entry.cameraId === 'cam-a' ? 1 : 1.1,
            bOverG: entry.cameraId === 'cam-a' ? 0.9 : 0.55,
            exposure: entry.cameraId === 'cam-a' ? 0.5 : 0.4,
          }))
        : produced
    },
  }
  const { derive, plans, writer } = wire({ probe })
  const first = await derive(deriveRequest())
  const second = await derive(deriveRequest({
    projectBaseVersionId: writer.state.versionId,
    projectBaseHash: writer.state.baseHash,
  }))
  assert.equal(second.replayed, false, 'evidence that changed is a new derivation, not a replay')
  assert.equal(second.version, 2)
  assert.notEqual(second.plan.planHash, first.plan.planHash)
  assert.equal(second.plan.supersedes, first.plan.planId)
  assert.equal(plans.state.appends, 2)
})

test('T-F4.013 a camera measured on fewer parts than it has says so in the plan', async () => {
  const many = session({
    tracks: session().tracks.map((track, index) => index === 1
      ? Object.freeze({
          ...track,
          parts: Object.freeze([1, 2, 3].map((ordinal) => Object.freeze({
            ...track.parts[0],
            partId: `part-b-${ordinal}`,
            ordinal,
          }))),
        })
      : track),
  })
  const { derive } = wire({ session: many, maxRangesPerCamera: 1 })
  const result = await derive(deriveRequest())
  const narrowed = result.plan.issues.find((issue) => issue.code === 'evidence-narrowed')
  assert.ok(narrowed, `the plan says nothing about the parts it skipped: ${JSON.stringify(result.plan.issues)}`)
  assert.equal(narrowed.cameraId, 'cam-b')
  assert.match(narrowed.message, /only the first 1 of 3 parts/)
})

test('T-F4.013 the measured range names the stretch of file that was decoded, not the whole part', async () => {
  // A part far longer than the window: production's normal case, and the only
  // shape in which the window arithmetic does anything at all.
  const TICKS = 48_000n
  const longPart = session({
    tracks: session().tracks.map((track) => Object.freeze({
      ...track,
      parts: Object.freeze(track.parts.map((part) => Object.freeze({
        ...part,
        coverage: createTickInterval(0n, TICKS * 100n),
      }))),
    })),
  })
  const { derive, probe } = wire({ session: longPart, windowSeconds: 5 })
  const result = await derive(deriveRequest())
  for (const call of probe.calls) {
    assert.equal(call.ranges.length, 1)
    assert.equal(call.ranges[0].sourceStartSeconds, 0)
    assert.equal(call.ranges[0].sourceEndSeconds, 5,
      'the probe must be asked for the window, never for the whole part')
    // 5 s of a 100 s part is 5 % of the part's session ticks.
    assert.equal(call.ranges[0].sessionRange.start, 0n)
    assert.equal(call.ranges[0].sessionRange.end, TICKS * 5n)
  }
  assert.equal(result.plan.measurements.length, 2)
  for (const entry of result.plan.measurements) {
    assert.equal(entry.range.end - entry.range.start, TICKS * 5n,
      'a measurement that claims 100 s of session time from 5 s of decoded frames weights every pair wrong')
  }
})

test('T-F4.013 changing the reference camera supersedes and names only the dependents', async () => {
  const { derive, writer, plans } = wire()
  const first = await derive(deriveRequest())
  const second = await derive(deriveRequest({
    referenceCameraId: 'cam-b',
    projectBaseVersionId: writer.state.versionId,
    projectBaseHash: writer.state.baseHash,
  }))
  assert.equal(second.version, 2)
  assert.equal(second.plan.supersedes, first.plan.planId)
  assert.equal(second.plan.referenceCameraId, 'cam-b')
  assert.deepEqual(second.plan.cameraTransforms.map((entry) => entry.cameraId), ['cam-a'])
  // Only what depended on the camera that was replaced.
  assert.deepEqual(second.invalidated.matchPlanIds, ['session-1:v1'])
  assert.deepEqual(second.invalidated.colorCriticReportIds, [])
  // A plan of the same session against the NEW reference is not a dependent of
  // the old one, so re-deriving on cam-b again reports nothing invalidated.
  assert.equal(plans.state.appends, 2)
  const written = writer.state.writes.at(-1).plan
  assert.equal(written.cameras['cam-b'][0].enabled, false, 'the new reference becomes the bypass')
  assert.equal(written.cameras['cam-a'][0].enabled, true)
})

test('T-F4.013 cameras measured over ranges that never overlap refuse fail-closed', async () => {
  const { derive } = wire({
    cameras: {
      'cam-a': { rOverG: 1, bOverG: 0.9, exposure: 0.5, range: createTickInterval(0n, 24_000n) },
      'cam-b': { rOverG: 1.1, bOverG: 0.6, exposure: 0.42, range: createTickInterval(96_000n, 120_000n) },
    },
  })
  await assert.rejects(
    () => derive(deriveRequest()),
    (error) => error.code === 'COLOR_RANGES_NOT_COMPARABLE' && error.details.cameraId === 'cam-b',
  )
})

test('T-F4.013 a reference camera no track carries refuses before anything is measured', async () => {
  const { derive, media } = wire()
  await assert.rejects(
    () => derive(deriveRequest({ referenceCameraId: 'cam-z' })),
    (error) => error.code === 'COLOR_REFERENCE_UNAVAILABLE' && error.details.cameras.includes('cam-a'),
  )
  assert.equal(media.state.resolved, 0)
})

test('T-F4.013 a range override changes one segment and leaves the sibling camera identical', async () => {
  const { derive, override, writer } = wire()
  const derived = await derive(deriveRequest())
  const beforePlan = writer.state.current
  assert.equal(beforePlan.segments['clip-2'], undefined, 'the derivation itself wrote no segment layer')
  const applied = await override({
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    basePlanVersion: derived.version,
    basePlanHash: derived.plan.planHash,
    projectBaseVersionId: writer.state.versionId,
    projectBaseHash: writer.state.baseHash,
    override: {
      overrideId: 'ovr-1',
      cameraId: 'cam-b',
      segmentId: 'clip-2',
      parameters: { brightness: 0.05, contrast: 1.1, saturation: 1.05 },
      reason: 'the practical lamp drifts warm in this shot',
    },
    actor: humanActor(),
  })
  assert.equal(applied.version, 2)
  assert.equal(applied.plan.rangeOverrides.length, 1)
  assert.equal(applied.plan.rangeOverrides[0].actor.kind, 'human')
  assert.equal(applied.plan.rangeOverrides[0].actor.id, 'user-1')
  const written = writer.state.writes.at(-1).plan
  const submitted = writer.state.writes.at(-1).request.plan
  assert.notEqual(written, beforePlan)
  // The override landed on exactly the clip it named.
  assert.deepEqual(Object.keys(written.segments), ['clip-2'])
  assert.equal(written.segments['clip-2'][0].kind, 'match')
  assert.equal(written.segments['clip-2'][0].enabled, true)
  // What the service submitted carries the very objects it read for every
  // layer it did not change: the sibling cameras and the global layer are the
  // same references, so an override cannot become a grade even by accident.
  assert.equal(submitted.global, beforePlan.global)
  assert.equal(submitted.sourceMetadata, beforePlan.sourceMetadata)
  assert.equal(submitted.cameras['cam-a'][0], beforePlan.cameras['cam-a'][0])
  assert.equal(submitted.cameras['cam-b'][0], beforePlan.cameras['cam-b'][0])
  // And after canonicalization they are byte-identical, which is the property
  // that actually reaches the renderer.
  assert.deepEqual(written.global, beforePlan.global)
  assert.deepEqual(written.sources, beforePlan.sources)
  assert.deepEqual(written.cameras['cam-a'], beforePlan.cameras['cam-a'])
  assert.deepEqual(written.cameras['cam-b'], beforePlan.cameras['cam-b'])
  // The caller's note is appended to the audit reason, never substituted for
  // the actor who moved the colour.
  const reason = writer.state.writes.at(-1).request.reason
  assert.match(reason, /range override ovr-1 on camera cam-b by human user-1/)
  assert.match(reason, /practical lamp drifts warm/)
})

test('T-F4.013 a layer whose camera left the EditPlan is reported as pruned, not deleted in silence', async () => {
  // Three cameras, then the editor re-cuts and stops using one of them.
  const third = session({
    tracks: [...session().tracks, Object.freeze({
      ...session().tracks[1],
      trackId: 'cam-c',
      parts: Object.freeze([Object.freeze({ ...session().tracks[1].parts[0], partId: 'part-c' })]),
    })],
  })
  const targets = [
    ...TARGETS.filter((target) => target.segmentId !== 'clip-2b'),
    Object.freeze({ sourceId: 'artifact-b', cameraId: 'cam-c', segmentId: 'clip-3' }),
  ]
  const { derive, writer } = wire({
    session: third,
    targets,
    cameras: {
      'cam-a': { rOverG: 1, bOverG: 0.9, exposure: 0.5 },
      'cam-b': { rOverG: 1.1, bOverG: 0.6, exposure: 0.42 },
      'cam-c': { rOverG: 1.05, bOverG: 0.75, exposure: 0.46 },
    },
  })
  await derive(deriveRequest())
  assert.deepEqual(Object.keys(writer.state.current.cameras).sort(), ['cam-a', 'cam-b', 'cam-c'])

  // `assertPlanTargets` refuses a ColorPlan carrying a key outside the current
  // EditPlan, so the stale layer has to go — but the write names what it took,
  // because that key can carry a transform of another kind with it.
  writer.state.targets = targets.filter((target) => target.cameraId !== 'cam-c')
  const rederived = await derive(deriveRequest({
    projectBaseVersionId: writer.state.versionId,
    projectBaseHash: writer.state.baseHash,
  }))
  assert.deepEqual(rederived.colorPlan.prunedCameraIds, ['cam-c'])
  assert.deepEqual(rederived.colorPlan.prunedSegmentIds, [])
  assert.deepEqual(Object.keys(writer.state.current.cameras).sort(), ['cam-a', 'cam-b'])
})

test('T-F4.013 an override fenced on a stale plan version loses and is told what is current', async () => {
  const { derive, override, writer } = wire()
  const derived = await derive(deriveRequest())
  await assert.rejects(
    () => override({
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      basePlanVersion: 1,
      basePlanHash: sha('b'),
      projectBaseVersionId: writer.state.versionId,
      projectBaseHash: writer.state.baseHash,
      override: {
        overrideId: 'ovr-2',
        cameraId: 'cam-b',
        segmentId: 'clip-2',
        parameters: { brightness: 0.05, contrast: 1.1, saturation: 1.05 },
        reason: 'stale fence',
      },
      actor: humanActor(),
    }),
    (error) => error.code === 'PERSISTENCE_CONFLICT' &&
      error.details.currentVersion === 1 && error.details.currentHash === derived.plan.planHash,
  )
})

// ---------------------------------------------------------------------------
// apollo-match v2 in the processor
// ---------------------------------------------------------------------------

function execution(matchParameters, providerVersion) {
  const stages = [
    transform('technical-identity', 'technical', 'ffmpeg-zscale', { mode: 'identity' }),
    Object.freeze({
      ...transform('match-cam-b', 'match', 'apollo-match', matchParameters, true),
      implementation: Object.freeze({
        provider: 'apollo-match',
        version: providerVersion,
        parameters: Object.freeze(Object.fromEntries(Object.entries(matchParameters).sort(([a], [b]) => a.localeCompare(b)))),
        parametersHash: calculateCanonicalHash(Object.freeze(Object.fromEntries(Object.entries(matchParameters).sort(([a], [b]) => a.localeCompare(b))))),
      }),
    }),
    transform('creative-none', 'creative-lut', 'apollo-lut', { mode: 'none' }),
    transform('output-identity', 'output', 'ffmpeg-zscale', { mode: 'identity' }),
  ]
  const content = {
    schemaVersion: 'resolved-color-pipeline/v1',
    sourceMetadata: METADATA,
    outputMetadata: METADATA,
    stages,
    target: { sourceId: 'artifact-b', cameraId: 'cam-b', segmentId: 'clip-2' },
  }
  return {
    pipeline: {
      ...content,
      manifestKey: stages.map((s) => `${s.kind}:${s.id}@${s.version}:${s.implementation.parametersHash}`).join('>'),
      pipelineHash: calculateCanonicalHash(content),
    },
    executionHash: sha('d'),
  }
}

test('T-F4.013 apollo-match v2 renders a colorchannelmixer before the eq', () => {
  const built = buildFfmpegColorPipelineFilter({
    execution: execution({
      mode: 'adjust', brightness: 0.08, contrast: 1, saturation: 1,
      'red-gain': 0.95, 'green-gain': 1, 'blue-gain': 1.4,
    }, 'v2'),
  })
  const filters = built.filter.split(',')
  const mixer = filters.findIndex((entry) => entry.startsWith('colorchannelmixer='))
  const eq = filters.findIndex((entry) => entry.startsWith('eq='))
  assert.ok(mixer >= 0 && eq >= 0, built.filter)
  assert.ok(mixer < eq, 'a channel gain applied after the contrast curve balances the wrong picture')
  assert.match(filters[mixer], /rr=0\.950000:gg=1\.000000:bb=1\.400000/)
})

test('T-F4.013 the chain the processor builds puts the match before the creative look', () => {
  // The integration suite measures what this order costs in pixels
  // (`color-match.integration.mjs`: 14.61% off the reference when the two are
  // swapped). This is the same claim at unit speed, so moving the stages inside
  // `buildFfmpegColorPipelineFilter` cannot pass `npm test` and wait for a
  // machine with FFmpeg on it to notice.
  const lutParameters = Object.freeze({ intensity: 1, mode: 'lut3d' })
  const base = execution({
    mode: 'adjust', brightness: 0.08, contrast: 1, saturation: 1,
    'red-gain': 0.95, 'green-gain': 1, 'blue-gain': 1.4,
  }, 'v2')
  const stages = [
    base.pipeline.stages[0],
    base.pipeline.stages[1],
    Object.freeze({
      ...base.pipeline.stages[2],
      enabled: true,
      implementation: Object.freeze({
        provider: 'apollo-lut', version: 'v1',
        parameters: lutParameters, parametersHash: calculateCanonicalHash(lutParameters),
      }),
      lut: Object.freeze({ artifactId: 'lut-look-1', sha256: sha('a') }),
    }),
    base.pipeline.stages[3],
  ]
  const content = {
    schemaVersion: base.pipeline.schemaVersion,
    sourceMetadata: base.pipeline.sourceMetadata,
    outputMetadata: base.pipeline.outputMetadata,
    stages,
    target: base.pipeline.target,
  }
  const withLook = {
    ...base,
    pipeline: {
      ...content,
      manifestKey: stages.map((s) => `${s.kind}:${s.id}@${s.version}:${s.implementation.parametersHash}`).join('>'),
      pipelineHash: calculateCanonicalHash(content),
    },
  }
  const built = buildFfmpegColorPipelineFilter({
    execution: withLook,
    lutPaths: { 'lut-look-1': '/luts/look.cube' },
  })
  const links = built.filter.split(',')
  const mixer = links.findIndex((link) => link.startsWith('colorchannelmixer='))
  const eq = links.findIndex((link) => link.startsWith('eq='))
  const lut = links.findIndex((link) => link.startsWith('lut3d='))
  assert.ok(mixer >= 0 && eq >= 0 && lut >= 0, built.filter)
  assert.ok(mixer < lut && eq < lut,
    `a correction applied after the look corrects a picture the look already reshaped: ${built.filter}`)
})

test('T-F4.013 a v1 match carrying a gain is refused instead of silently upgraded', () => {
  assert.throws(
    () => buildFfmpegColorPipelineFilter({
      execution: execution({
        mode: 'adjust', brightness: 0, contrast: 1, saturation: 1, 'blue-gain': 1.4,
      }, 'v1'),
    }),
    (error) => error.code === 'INVALID_RENDER_INPUT' && /unsupported parameters/.test(error.message),
  )
})

test('T-F4.013 a v2 match with no gain and a gain outside bounds are both refused', () => {
  assert.throws(
    () => buildFfmpegColorPipelineFilter({
      execution: execution({ mode: 'adjust', brightness: 0, contrast: 1, saturation: 1 }, 'v2'),
    }),
    (error) => error.code === 'INVALID_RENDER_INPUT' && /missing or outside safe bounds/.test(error.message),
  )
  assert.throws(
    () => buildFfmpegColorPipelineFilter({
      execution: execution({
        mode: 'adjust', brightness: 0, contrast: 1, saturation: 1,
        'red-gain': 1, 'green-gain': 1, 'blue-gain': 2.01,
      }, 'v2'),
    }),
    (error) => error.code === 'INVALID_RENDER_INPUT' && /blue-gain is missing or outside safe bounds/.test(error.message),
  )
})

/** A pipeline whose output transform really converts: limited → full range. */
function convertingExecution() {
  const full = Object.freeze({ ...METADATA, range: 'full' })
  const zscaleParameters = Object.freeze({ mode: 'convert' })
  const stages = [
    transform('technical-identity', 'technical', 'ffmpeg-zscale', { mode: 'identity' }),
    transform('match-global', 'match', 'apollo-match', { mode: 'bypass' }),
    transform('creative-none', 'creative-lut', 'apollo-lut', { mode: 'none' }),
    Object.freeze({
      id: 'output-convert', kind: 'output', version: 'v1', enabled: true,
      input: METADATA, output: full,
      implementation: Object.freeze({
        provider: 'ffmpeg-zscale', version: 'v1',
        parameters: zscaleParameters, parametersHash: calculateCanonicalHash(zscaleParameters),
      }),
    }),
  ]
  const content = {
    schemaVersion: 'resolved-color-pipeline/v1',
    sourceMetadata: METADATA,
    outputMetadata: full,
    stages,
    target: { sourceId: 'artifact-b', cameraId: 'cam-b', segmentId: 'clip-2' },
  }
  return {
    ...content,
    manifestKey: stages.map((s) => `${s.kind}:${s.id}@${s.version}:${s.implementation.parametersHash}`).join('>'),
    pipelineHash: calculateCanonicalHash(content),
  }
}

test('T-F4.014 the before-output pipeline disables the output stage and re-hashes itself', () => {
  const pipeline = convertingExecution()
  const built = buildFfmpegColorPipelineFilter({ execution: { pipeline, executionHash: sha('d') } })
  assert.match(built.filter, /zscale=.*r=full/, 'the delivered chain really converts the range')

  const before = pipelineWithoutOutputTransform(pipeline)
  assert.equal(before.stages.length, 4)
  assert.equal(before.stages[3].enabled, false)
  assert.equal(before.stages[3].implementation.parameters.mode, 'identity')
  assert.equal(before.outputMetadata.range, 'limited', 'the before side ends where the creative LUT left it')
  assert.notEqual(before.pipelineHash, pipeline.pipelineHash)
  // The processor recomputes the hash over the content, so a pipeline whose
  // hash did not cover its own stages would be refused there.
  const { pipelineHash, manifestKey, ...content } = before
  void manifestKey
  assert.equal(calculateCanonicalHash(content), pipelineHash)
  const beforeFilter = buildFfmpegColorPipelineFilter({ execution: { pipeline: before, executionHash: sha('d') } })
  assert.equal(beforeFilter.filter.split(',').filter((entry) => entry === 'null').length, 4)
  assert.doesNotMatch(beforeFilter.filter, /zscale=/)
})

// ---------------------------------------------------------------------------
// The critic at the gate
// ---------------------------------------------------------------------------

function criticMeasurement(input) {
  return measurement({
    measurementId: input.measurementId,
    sourceAssetId: input.sourceAssetId,
    sourceSha256: input.sourceSha256,
    cameraId: input.cameraId,
    range: createTickInterval(0n, 120n),
    rOverG: input.rOverG ?? 1,
    bOverG: input.bOverG ?? 0.9,
    exposure: input.exposure ?? 0.5,
    ...(input.highlights !== undefined ? { highlights: input.highlights } : {}),
  })
}

function fakeReportRepository() {
  const rows = new Map()
  const byVersion = new Map()
  return {
    rows,
    async persist({ report }) {
      const held = rows.get(report.reportHash)
      if (held) return { report: held, replayed: true }
      rows.set(report.reportHash, report)
      byVersion.set(report.projectVersionId, [...(byVersion.get(report.projectVersionId) ?? []), report])
      return { report, replayed: false }
    },
    async read({ reportId }) { return [...rows.values()].find((row) => row.reportId === reportId) ?? null },
    async readByHash({ reportHash }) { return rows.get(reportHash) ?? null },
    async listForProjectVersion({ projectVersionId }) { return byVersion.get(projectVersionId) ?? [] },
    async findDependentsOfMatchPlan() { return [] },
    async findDependentsOfMeasurement() { return [] },
  }
}

function fakeEvaluator(measurements) {
  return {
    calls: [],
    async measureStages(input) {
      this.calls.push(input)
      return {
        before: measurements.before,
        after: measurements.after,
        evidence: [Object.freeze({
          stage: 'after-output-transform', cameraId: 'cam-b', clipId: 'clip-2',
          artifactKey: 'color-critic-evidence/aa.png', sha256: sha('f'), byteSize: 1_024,
          width: 320, height: null,
        })],
      }
    },
    async cleanup() {},
  }
}

const CRITIC_CLIPS = Object.freeze([Object.freeze({
  clipId: 'clip-2', cameraId: 'cam-b', sourceArtifactId: 'artifact-b',
  sourceInFrame: 0, sourceOutFrame: 120, timelineInFrame: 0, timelineOutFrame: 120,
})])

function criticRequest(overrides = {}) {
  return {
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    projectVersionId: 'version-1',
    deliveredArtifactId: 'artifact-proxy',
    deliveredPath: '/media/proxy.mp4',
    deliveredSha256: sha('1'),
    operationId: 'operation-1',
    fps: 30,
    clips: CRITIC_CLIPS,
    sources: [{ artifactId: 'artifact-b', path: '/media/b.mp4', sha256: sha('b'), pipeline: execution({ mode: 'bypass' }, 'v1').pipeline }],
    ...overrides,
  }
}

test('T-F4.014 a rejection becomes a hard proxy issue that names the report', async () => {
  const evaluator = fakeEvaluator({
    before: [criticMeasurement({ measurementId: 'ccm-before-1', sourceAssetId: 'artifact-b', sourceSha256: sha('b'), cameraId: 'cam-b' })],
    // The delivered frames clip 6% of their pixels: irreversible, so no
    // declared intent and no confidence band can turn it into an approval.
    after: [criticMeasurement({ measurementId: 'ccm-after-1', sourceAssetId: 'artifact-proxy', sourceSha256: sha('1'), cameraId: 'cam-b', highlights: 0.06 })],
  })
  const reports = fakeReportRepository()
  const evaluate = evaluateColorCriticService({ evaluator, reports, clock: () => new Date('2029-06-01T13:00:00.000Z') })
  const result = await evaluate(criticRequest())
  assert.equal(result.report.action, 'reject')
  assert.equal(result.report.cause, 'irreversible-technical-defect')
  const hard = result.proxyIssues.filter((issue) => issue.severity === 'hard')
  assert.ok(hard.length >= 1, 'a rejection must localize at least one blocking issue on the review')
  assert.equal(hard[0].code, 'COLOR_CRITIC_REJECTED')
  assert.ok(hard[0].evidenceIds.some((ref) => ref.startsWith(`color-critic-report:${result.report.reportId}@`)))
  assert.ok(hard[0].evidenceIds.some((ref) => ref.startsWith('color-crop:color-critic-evidence/')))
  assert.deepEqual(hard[0].rangeMs, [0, 4_000])
})

test('T-F4.014 declaring clipping as creative intent does not make it an approval', async () => {
  const evaluator = fakeEvaluator({
    before: [criticMeasurement({ measurementId: 'ccm-before-2', sourceAssetId: 'artifact-b', sourceSha256: sha('b'), cameraId: 'cam-b' })],
    after: [criticMeasurement({ measurementId: 'ccm-after-2', sourceAssetId: 'artifact-proxy', sourceSha256: sha('1'), cameraId: 'cam-b', highlights: 0.06 })],
  })
  const reports = fakeReportRepository()
  const evaluate = evaluateColorCriticService({ evaluator, reports, clock: () => new Date('2029-06-01T13:00:00.000Z') })
  // A LUT is applied AND the maximum cast allowance the policy permits is
  // declared: the largest excuse the system accepts.
  const lutStage = execution({ mode: 'bypass' }, 'v1').pipeline
  const withLut = {
    ...lutStage,
    stages: [
      lutStage.stages[0],
      lutStage.stages[1],
      Object.freeze({
        ...lutStage.stages[2],
        enabled: true,
        implementation: Object.freeze({
          provider: 'apollo-lut', version: 'v1',
          parameters: Object.freeze({ intensity: 1, mode: 'lut3d' }),
          parametersHash: calculateCanonicalHash(Object.freeze({ intensity: 1, mode: 'lut3d' })),
        }),
        lut: Object.freeze({ artifactId: 'lut-1', sha256: sha('a') }),
      }),
      lutStage.stages[3],
    ],
  }
  const result = await evaluate(criticRequest({
    sources: [{ artifactId: 'artifact-b', path: '/media/b.mp4', sha256: sha('b'), pipeline: withLut }],
    castAllowedDelta: 0.25,
  }))
  assert.equal(result.report.creativeIntent.declared, true)
  assert.equal(result.report.creativeIntent.castAllowedDelta, 0.25)
  assert.equal(result.report.action, 'reject', 'an intent bounds a colour shift, never a destroyed sample')
})

test('T-F4.014 an allowance declared without a look is dropped rather than honoured', async () => {
  const evaluator = fakeEvaluator({
    before: [criticMeasurement({ measurementId: 'ccm-before-3', sourceAssetId: 'artifact-b', sourceSha256: sha('b'), cameraId: 'cam-b' })],
    after: [criticMeasurement({ measurementId: 'ccm-after-3', sourceAssetId: 'artifact-proxy', sourceSha256: sha('1'), cameraId: 'cam-b' })],
  })
  const reports = fakeReportRepository()
  const evaluate = evaluateColorCriticService({ evaluator, reports, clock: () => new Date('2029-06-01T13:00:00.000Z') })
  const result = await evaluate(criticRequest({ castAllowedDelta: 0.25 }))
  assert.equal(result.report.creativeIntent.declared, false)
  assert.equal(result.report.intentBounds.castAllowedDelta, null)
})

test('T-F4.014 the correction budget is counted from the stored reports, not from the request', async () => {
  const evaluator = fakeEvaluator({
    before: [criticMeasurement({ measurementId: 'ccm-before-4', sourceAssetId: 'artifact-b', sourceSha256: sha('b'), cameraId: 'cam-b' })],
    after: [criticMeasurement({ measurementId: 'ccm-after-4', sourceAssetId: 'artifact-proxy', sourceSha256: sha('1'), cameraId: 'cam-b' })],
  })
  const reports = fakeReportRepository()
  // Two bounded corrections already spent on this project version.
  for (const ordinal of [1, 2]) {
    const report = evaluateColorCritic({
      reportId: `ccr-spent-${ordinal}`,
      workspaceId: 'workspace-1', projectId: 'project-1', projectVersionId: 'version-1',
      subject: { kind: 'output', artifactId: 'artifact-proxy' },
      before: [criticMeasurement({ measurementId: `ccm-b-${ordinal}`, sourceAssetId: 'artifact-b', sourceSha256: sha('b'), cameraId: 'cam-b' })],
      after: [criticMeasurement({ measurementId: `ccm-a-${ordinal}`, sourceAssetId: 'artifact-proxy', sourceSha256: sha('1'), cameraId: 'cam-b' })],
      creativeIntent: { declared: false },
      correctionsApplied: 0,
      evaluatedAt: `2029-06-01T1${ordinal}:00:00.000Z`,
    })
    await reports.persist({ report: { ...report, action: 'bounded-correction' }, createdAt: report.evaluatedAt })
  }
  const evaluate = evaluateColorCriticService({ evaluator, reports, clock: () => new Date('2029-06-01T13:00:00.000Z') })
  const result = await evaluate(criticRequest())
  assert.equal(result.correctionsApplied, 2)
  assert.equal(result.correctionBudgetExhausted, true)
  assert.equal(COLOR_CRITIC_MAX_CORRECTION_ITERATIONS, 2)
})

test('T-F4.014 an approved verdict adds no issue to the review at all', () => {
  const report = evaluateColorCritic({
    reportId: 'ccr-clean-1',
    workspaceId: 'workspace-1', projectId: 'project-1', projectVersionId: 'version-1',
    subject: { kind: 'output', artifactId: 'artifact-proxy' },
    before: [criticMeasurement({ measurementId: 'ccm-b-clean', sourceAssetId: 'artifact-b', sourceSha256: sha('b'), cameraId: 'cam-b' })],
    after: [criticMeasurement({ measurementId: 'ccm-a-clean', sourceAssetId: 'artifact-proxy', sourceSha256: sha('1'), cameraId: 'cam-b' })],
    creativeIntent: { declared: false },
    evaluatedAt: '2029-06-01T13:00:00.000Z',
  })
  assert.equal(report.action, 'approve')
  assert.deepEqual(colorCriticProxyIssues({ report, fps: 30 }), [])
})

test('T-F4.014 the session a verdict reads its reference from is the one that knows these cameras', () => {
  // A project holds several capture sessions. "The most recently updated head"
  // is not the question — an unrelated session touched last would hand the
  // critic a reference camera nobody approved for these frames.
  const plan = (sessionId, referenceCameraId, corrected) => ({
    sessionId,
    plan: { referenceCameraId, cameraTransforms: corrected.map((cameraId) => ({ cameraId })) },
  })
  const interview = plan('session-interview', 'cam-a', ['cam-b'])
  const brollShoot = plan('session-broll', 'cam-x', ['cam-y'])

  assert.equal(
    selectRenderMatchPlan({ cameraIds: ['cam-a', 'cam-b'], candidates: [brollShoot, interview] })?.sessionId,
    'session-interview',
    'the plan that knows these cameras wins, whatever order the heads came back in',
  )
  assert.equal(
    selectRenderMatchPlan({ cameraIds: ['cam-a', 'cam-b', 'cam-z'], candidates: [interview, brollShoot] }),
    null,
    'a plan that does not know every camera the render cut to is not a plan about these frames',
  )
  assert.equal(
    selectRenderMatchPlan({ cameraIds: ['cam-a'], candidates: [interview, plan('session-reshoot', 'cam-a', ['cam-c'])] }),
    null,
    'two sessions that both know the cameras cannot say which shaped this render',
  )
  assert.equal(selectRenderMatchPlan({ cameraIds: [], candidates: [interview] }), null)
  assert.equal(matchPlanCoversCameras(interview.plan, ['cam-b']), true)
  assert.equal(matchPlanCoversCameras(interview.plan, ['cam-b', 'cam-x']), false)
})

test('T-F4.014 a head that does not know these cameras is not used as the reference', async () => {
  const evaluator = fakeEvaluator({
    before: [criticMeasurement({ measurementId: 'ccm-before-9', sourceAssetId: 'artifact-b', sourceSha256: sha('b'), cameraId: 'cam-b' })],
    after: [criticMeasurement({ measurementId: 'ccm-after-9', sourceAssetId: 'artifact-proxy', sourceSha256: sha('1'), cameraId: 'cam-b' })],
  })
  const reports = fakeReportRepository()
  const heads = new Map()
  const evaluate = evaluateColorCriticService({
    evaluator,
    reports,
    matchPlans: { async readHead({ sessionId }) { return heads.get(sessionId) ?? null } },
    clock: () => new Date('2029-06-01T13:00:00.000Z'),
  })

  // A plan about another session's cameras: it names neither cam-b nor a
  // correction for it.
  heads.set('session-other', {
    version: 1,
    plan: {
      planId: 'mmp-other', planHash: sha('3'),
      referenceCameraId: 'cam-x', cameraTransforms: [{ cameraId: 'cam-y' }],
    },
  })
  const foreign = await evaluate(criticRequest({ sessionId: 'session-other' }))
  assert.equal(foreign.report.matchPlanId, null,
    'a plan from an unrelated session must not become the reference camera of this verdict')
  assert.equal(foreign.report.referenceCameraId, null)
})

test('T-F4.014 a clip with no camera is dropped rather than attributed to one', () => {
  const pipeline = execution({ mode: 'bypass' }, 'v1').pipeline
  const joined = colorCriticRenderInputs({
    clips: [
      { id: 'clip-2', sourceArtifactId: 'artifact-b', cameraId: 'cam-b', sourceInFrame: 0, sourceOutFrame: 30, timelineInFrame: 0, timelineOutFrame: 30 },
      { id: 'clip-3', sourceArtifactId: 'artifact-b', sourceInFrame: 30, sourceOutFrame: 60, timelineInFrame: 30, timelineOutFrame: 60 },
    ],
    sources: [{ artifactId: 'artifact-b', path: '/media/b.mp4', sha256: sha('b'), mediaType: 'video' }],
    compilationPipelines: new Map([['artifact-b', pipeline]]),
  })
  assert.deepEqual(joined.clips.map((clip) => clip.clipId), ['clip-2'])
  assert.equal(joined.sources.length, 1)
})
