import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createColorPlan, resolveColorPlan } from '../../src/v2/domain/color-and-export.ts'
import {
  assertCameraColorMeasurementIntegrity,
  createCameraColorMeasurement,
} from '../../src/v2/domain/color-measurement.ts'
import {
  addMulticamMatchRangeOverride,
  assertMatchStagePosition,
  assertMatchStageTransform,
  assertMulticamMatchPlanIntegrity,
  compileMatchPlanToColorPlanLayers,
  deriveMulticamMatchPlan,
  MATCH_PROVIDER_VERSIONS,
} from '../../src/v2/domain/multicam-match-plan.ts'
import {
  assertColorCriticReportIntegrity,
  COLOR_CRITIC_CAUSE_ACTIONS,
  COLOR_CRITIC_DIMENSIONS,
  evaluateColorCritic,
} from '../../src/v2/domain/color-critic-report.ts'
import { createTickInterval } from '../../src/v2/domain/session-time.ts'

/**
 * Mirror of `src/v2/domain/camera-identity.ts#colorCameraIdForTrack`, which
 * slice A of this wave creates: the ColorPlan camera key is the CaptureTrack
 * id sanitized to the ColorPlan TOKEN grammar. Kept here, and only here, until
 * the two branches merge; the domain under test never imports it.
 */
function colorCameraIdForTrack(track) {
  const sanitized = String(track.trackId).trim().toLowerCase().replace(/[^a-z0-9._/-]/g, '-')
  return /^[a-z0-9]/.test(sanitized) ? sanitized.slice(0, 128) : `c-${sanitized}`.slice(0, 128)
}

const METADATA = Object.freeze({
  colorSpace: 'rec709',
  transfer: 'bt709',
  primaries: 'bt709',
  matrix: 'bt709',
  range: 'limited',
  bitDepth: 8,
})

const REC2020 = Object.freeze({ ...METADATA, colorSpace: 'rec2020', primaries: 'bt2020' })

const STATISTICS_EVALUATOR = Object.freeze({ id: 'ffmpeg-rgb24-statistics', kind: 'measured', version: '1.0.0' })
const SKIN_EVALUATOR = Object.freeze({ id: 'ycbcr-skin-band-mask', kind: 'controlled', version: '1.0.0' })

const at = (second) => new Date(Date.parse('2029-06-01T10:00:00.000Z') + second * 1000).toISOString()
const sha = (seed) => seed.repeat(64).slice(0, 64)

/** BT.709-encoded luma that sits `ev` stops from `base` at gamma 2.2. */
function lumaAtEv(base, ev) {
  return base * 2 ** (ev / 2.2)
}

function measurement(overrides = {}) {
  const o = {
    measurementId: 'ccm-a-1',
    sessionId: 'session-1',
    sourceAssetId: 'artifact-a',
    sourceSha256: sha('a'),
    cameraId: 'camera-a',
    start: 0,
    end: 1_000,
    startFrame: 0,
    endFrame: 60,
    sampledFrames: 8,
    confidence: 1,
    hdrMode: 'sdr',
    metadata: METADATA,
    exposure: 0.5,
    rOverG: 1,
    bOverG: 0.9,
    contrast: 0.2,
    saturation: 0.1,
    blacks: 0.001,
    highlights: 0.001,
    tonal: 0.5,
    skinHue: null,
    unavailableDimensions: [],
    ...overrides,
  }
  const evidenceRef = `rawvideo-rgb24:${o.measurementId}`
  const measured = (value, unit, components, evaluator = STATISTICS_EVALUATOR) => ({
    status: 'measured',
    value,
    unit,
    evaluator,
    evidenceRef,
    ...(components ? { components } : {}),
  })
  const dimensions = {
    whiteBalance: measured(o.bOverG / o.rOverG, 'ratio', { rOverG: o.rOverG, bOverG: o.bOverG, bOverR: o.bOverG / o.rOverG }),
    exposure: measured(o.exposure, 'normalized-luma'),
    contrast: measured(o.contrast, 'normalized-luma', { p5: 0.1, p95: 0.9, spread: 0.8 }),
    blacks: measured(o.blacks, 'ratio', { threshold: 4 / 255 }),
    highlights: measured(o.highlights, 'ratio', { threshold: 251 / 255 }),
    saturation: measured(o.saturation, 'normalized-chroma'),
    tonalResponse: measured(o.tonal, 'normalized-luma', { p1: 0.02, p5: 0.1, p25: 0.3, p50: o.tonal, p75: 0.7, p95: 0.9, p99: 0.98 }),
    skin: o.skinHue === null
      ? { status: 'not-applicable', reason: 'fewer than 2% of sampled pixels fall in the skin band; no skin-band region to measure' }
      : measured(o.skinHue, 'degrees', { areaRatio: 0.2, meanY: 0.55, meanCb: 105, meanCr: 150 }, SKIN_EVALUATOR),
  }
  for (const dimension of o.unavailableDimensions) {
    dimensions[dimension] = { status: 'unavailable', reason: `the ${dimension} statistic could not be read from these frames` }
  }
  return createCameraColorMeasurement({
    measurementId: o.measurementId,
    sessionId: o.sessionId,
    sourceAssetId: o.sourceAssetId,
    sourceSha256: o.sourceSha256,
    cameraId: o.cameraId,
    range: createTickInterval(BigInt(o.start), BigInt(o.end)),
    sourceRange: { startFrame: o.startFrame, endFrame: o.endFrame },
    sampledFrames: o.sampledFrames,
    technical: { metadata: o.metadata, pixelFormat: 'yuv420p', hdrMode: o.hdrMode },
    dimensions,
    confidence: o.confidence,
  })
}

const SELECTION = Object.freeze({
  selectedBy: { kind: 'director', id: 'director-1' },
  selectedAt: at(0),
  baseVersionId: 'session-1:v3',
  baseHash: sha('b'),
})

function derive(measurements, overrides = {}) {
  return deriveMulticamMatchPlan({
    planId: 'mmp-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    sessionVersion: 3,
    referenceEpoch: 1,
    referenceCameraId: 'camera-a',
    referenceCameraSelection: SELECTION,
    measurements,
    lineage: { colorProbeIds: ['probe-a', 'probe-b'] },
    createdAt: at(10),
    ...overrides,
  })
}

function throwsCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code, `expected ${code}, received ${error.code}: ${error.message}`)
    return true
  })
}

function transform(kind, id, parameters, { enabled = false, lut } = {}) {
  const sorted = Object.fromEntries(Object.entries(parameters).sort(([left], [right]) => left.localeCompare(right)))
  return {
    id,
    kind,
    version: 'v1',
    enabled,
    input: METADATA,
    output: METADATA,
    implementation: {
      provider: 'apollo-test',
      version: 'v1',
      parameters: sorted,
      parametersHash: calculateCanonicalHash(sorted),
    },
    ...(lut ? { lut } : {}),
  }
}

// ---------------------------------------------------------------------------
// F4.013 — multicamera match
// ---------------------------------------------------------------------------

test('T-FR-183 a measurement refuses to look measured when it was not', () => {
  throwsCode(() => measurement({ exposure: 0.5, unavailableDimensions: ['exposure'], sampledFrames: 0 }), 'INVALID_ARGUMENT')
  // A dimension that carries a value must carry its evaluator and evidence.
  throwsCode(
    () => createCameraColorMeasurement({
      measurementId: 'ccm-bad-1',
      sourceAssetId: 'artifact-a',
      sourceSha256: sha('a'),
      cameraId: 'camera-a',
      range: createTickInterval(BigInt(0), BigInt(10)),
      sourceRange: { startFrame: 0, endFrame: 1 },
      sampledFrames: 4,
      technical: { metadata: METADATA, pixelFormat: 'yuv420p', hdrMode: 'sdr' },
      dimensions: { exposure: { status: 'unavailable', reason: 'not decoded at all', value: 0 } },
      confidence: 1,
    }),
    'INVALID_ARGUMENT',
  )
})

test('T-FR-183 a measured range with no sampled frames is refused outright', () => {
  throwsCode(() => measurement({ sampledFrames: 0 }), 'INVALID_ARGUMENT')
})

test('T-FR-183 the measurement hash refuses a value edited underneath it', () => {
  const original = measurement()
  const tampered = { ...original, dimensions: { ...original.dimensions, exposure: { ...original.dimensions.exposure, value: 0.9 } } }
  assert.equal(assertCameraColorMeasurementIntegrity(original), original)
  throwsCode(() => assertCameraColorMeasurementIntegrity(tampered), 'PERSISTENCE_CONFLICT')
})

test('T-FR-183 a camera half a stop brighter and ten percent bluer is corrected towards the reference', () => {
  const reference = measurement()
  const brighterBluer = measurement({
    measurementId: 'ccm-b-1',
    cameraId: 'camera-b',
    sourceAssetId: 'artifact-b',
    sourceSha256: sha('c'),
    exposure: lumaAtEv(0.5, 0.5),
    bOverG: 0.9 * 1.1,
  })
  const plan = derive([reference, brighterBluer])
  const entry = plan.cameraTransforms.find((item) => item.cameraId === 'camera-b')

  assert.equal(plan.cameraTransforms.length, 1, 'the reference is never corrected')
  assert.ok(Math.abs(entry.deltas.exposureEv - 0.5) < 1e-3, `exposure delta ${entry.deltas.exposureEv}`)
  const parameters = entry.transform.implementation.parameters
  assert.ok(parameters.brightness < 0, `a brighter camera is darkened, received ${parameters.brightness}`)
  assert.ok(parameters.blueGain < 1, `a bluer camera loses blue, received ${parameters.blueGain}`)
  assert.ok(Math.abs(parameters.redGain - 1) < 1e-6, 'the red channel already matched')
  assert.equal(entry.transform.implementation.version, MATCH_PROVIDER_VERSIONS.v2.version, 'a white balance needs apollo-match v2')
  assert.equal(entry.transform.kind, 'match')
  assert.equal(plan.pipelineStage, 'match')

  // The magnitude is monotonic in the deviation, not merely signed.
  const bluer = derive([reference, measurement({
    measurementId: 'ccm-b-2', cameraId: 'camera-b', sourceAssetId: 'artifact-b', sourceSha256: sha('c'),
    exposure: lumaAtEv(0.5, 0.5), bOverG: 0.9 * 1.2,
  })])
  assert.ok(
    bluer.cameraTransforms[0].transform.implementation.parameters.blueGain < parameters.blueGain,
    'twice the cast asks for more correction',
  )
})

test('T-FR-183 a camera that only needs exposure stays on apollo-match v1', () => {
  const plan = derive([
    measurement(),
    measurement({ measurementId: 'ccm-b-1', cameraId: 'camera-b', sourceAssetId: 'artifact-b', sourceSha256: sha('c'), exposure: lumaAtEv(0.5, 0.2) }),
  ])
  const entry = plan.cameraTransforms[0]
  assert.equal(entry.transform.implementation.version, MATCH_PROVIDER_VERSIONS.v1.version)
  assert.deepEqual(
    Object.keys(entry.transform.implementation.parameters).sort(),
    ['brightness', 'contrast', 'mode', 'saturation'],
    'v1 carries exactly the parameters the FFmpeg processor whitelists today',
  )
})

test('T-FR-183 the compiled layers are accepted by the real ColorPlan and resolve per camera', () => {
  const cameraId = colorCameraIdForTrack({ trackId: 'Camera/B Main' })
  assert.equal(cameraId, 'camera/b-main')
  const plan = derive([
    measurement(),
    measurement({
      measurementId: 'ccm-b-1', cameraId, sourceAssetId: 'artifact-b', sourceSha256: sha('c'),
      exposure: lumaAtEv(0.5, 0.3),
    }),
  ])
  const layers = compileMatchPlanToColorPlanLayers(plan, {
    editPlanClipsByCameraId: {
      'camera-a': [{ clipId: 'clip-1', sessionRange: createTickInterval(BigInt(0), BigInt(500)) }],
      [cameraId]: [{ clipId: 'clip-2', sessionRange: createTickInterval(BigInt(500), BigInt(1_000)) }],
    },
  })
  assert.equal(layers.cameras['camera-a'][0].enabled, false, 'the reference is an explicit bypass')
  assert.equal(layers.cameras[cameraId][0].enabled, true)
  assert.deepEqual(layers.omittedCameraIds, [])

  const colorPlan = createColorPlan({
    schemaVersion: 'color-plan/v1',
    metadata: METADATA,
    outputMetadata: METADATA,
    global: [
      transform('technical', 'global-technical', { mode: 'identity' }),
      transform('match', 'global-match', { mode: 'bypass' }),
      transform('creative-lut', 'global-creative', { mode: 'none' }),
      transform('output', 'global-output', { mode: 'identity' }),
    ],
    cameras: layers.cameras,
    segments: layers.segments,
  })
  const resolved = resolveColorPlan(colorPlan, { sourceId: 'artifact-b', cameraId })
  assert.deepEqual(resolved.stages.map((stage) => stage.kind), ['technical', 'match', 'creative-lut', 'output'])
  assert.equal(resolved.stages[1].implementation.provider, 'apollo-match')
  assert.equal(resolved.stages[1].enabled, true, 'the camera layer overrode the global bypass')

  const referenceResolved = resolveColorPlan(colorPlan, { sourceId: 'artifact-a', cameraId: 'camera-a' })
  assert.equal(referenceResolved.stages[1].enabled, false)
})

test('T-FR-183 a camera the EditPlan never cuts to is named, not silently written', () => {
  const plan = derive([
    measurement(),
    measurement({ measurementId: 'ccm-b-1', cameraId: 'camera-b', sourceAssetId: 'artifact-b', sourceSha256: sha('c'), exposure: lumaAtEv(0.5, 0.3) }),
  ])
  const layers = compileMatchPlanToColorPlanLayers(plan, {
    editPlanClipsByCameraId: { 'camera-a': [{ clipId: 'clip-1' }] },
  })
  assert.deepEqual(layers.omittedCameraIds, ['camera-b'])
  assert.equal(layers.cameras['camera-b'], undefined)
})

test('T-FR-183 incomparable colourimetry is refused instead of matched', () => {
  throwsCode(() => derive([
    measurement(),
    measurement({ measurementId: 'ccm-b-1', cameraId: 'camera-b', sourceAssetId: 'artifact-b', sourceSha256: sha('c'), metadata: REC2020 }),
  ]), 'COLOR_SOURCES_INCOMPARABLE')
})

test('T-FR-183 an HDR source fails closed because no tone-map exists', () => {
  throwsCode(() => derive([
    measurement(),
    measurement({ measurementId: 'ccm-b-1', cameraId: 'camera-b', sourceAssetId: 'artifact-b', sourceSha256: sha('c'), hdrMode: 'pq' }),
  ]), 'COLOR_HDR_SDR_UNSUPPORTED')
})

test('T-FR-183 ranges that never overlap describe different moments and are refused', () => {
  throwsCode(() => derive([
    measurement(),
    measurement({
      measurementId: 'ccm-b-1', cameraId: 'camera-b', sourceAssetId: 'artifact-b', sourceSha256: sha('c'),
      start: 5_000, end: 6_000,
    }),
  ]), 'COLOR_RANGES_NOT_COMPARABLE')
})

test('T-FR-183 too few frames, or a dimension nobody read, is insufficient measurement', () => {
  throwsCode(() => derive([
    measurement(),
    measurement({ measurementId: 'ccm-b-1', cameraId: 'camera-b', sourceAssetId: 'artifact-b', sourceSha256: sha('c'), sampledFrames: 2 }),
  ]), 'COLOR_MEASUREMENT_INSUFFICIENT')
  throwsCode(() => derive([
    measurement(),
    measurement({
      measurementId: 'ccm-b-1', cameraId: 'camera-b', sourceAssetId: 'artifact-b', sourceSha256: sha('c'),
      unavailableDimensions: ['whiteBalance'],
    }),
  ]), 'COLOR_MEASUREMENT_INSUFFICIENT')
})

test('T-FR-183 a reference camera without a measurement anchors nothing', () => {
  throwsCode(() => derive([
    measurement({ cameraId: 'camera-b', measurementId: 'ccm-b-1' }),
    measurement({ cameraId: 'camera-c', measurementId: 'ccm-c-1', sourceAssetId: 'artifact-b', sourceSha256: sha('c') }),
  ]), 'COLOR_REFERENCE_UNAVAILABLE')
})

test('T-FR-183 a transform of any other kind, or a match placed after the LUT, is a stage violation', () => {
  throwsCode(() => assertMatchStageTransform(transform('creative-lut', 'creative-1', { mode: 'none' })), 'COLOR_STAGE_VIOLATION')
  // Falsification: the same match transform, applied after the creative LUT.
  const match = transform('match', 'match-camera-b', { brightness: -0.1, contrast: 1, mode: 'adjust', saturation: 1 }, { enabled: true })
  const creative = transform('creative-lut', 'creative-1', { mode: 'none' })
  assert.doesNotThrow(() => assertMatchStagePosition([creative, match].reverse()))
  throwsCode(() => assertMatchStagePosition([creative, match]), 'COLOR_STAGE_VIOLATION')
})

test('T-FR-183 a range override leaves its siblings and the global correction alone', () => {
  const plan = derive([
    measurement(),
    measurement({ measurementId: 'ccm-b-1', cameraId: 'camera-b', sourceAssetId: 'artifact-b', sourceSha256: sha('c'), exposure: lumaAtEv(0.5, 0.3) }),
  ])
  const amended = addMulticamMatchRangeOverride(plan, {
    planId: 'mmp-2',
    createdAt: at(20),
    override: {
      overrideId: 'ovr-1',
      cameraId: 'camera-b',
      segmentId: 'clip-3',
      parameters: { brightness: -0.05, contrast: 1, saturation: 1 },
      reason: 'the practical lamp enters frame here',
      actor: { kind: 'human', id: 'editor-1' },
    },
  })
  assert.equal(amended.supersedes, 'mmp-1')
  assert.deepEqual(
    amended.cameraTransforms[0].transform.implementation.parameters,
    plan.cameraTransforms[0].transform.implementation.parameters,
    'the camera-wide correction is untouched by a local one',
  )
  assert.equal(assertMulticamMatchPlanIntegrity(plan).planHash, plan.planHash, 'the superseded plan stays intact')

  const layers = compileMatchPlanToColorPlanLayers(amended, {
    editPlanClipsByCameraId: {
      'camera-a': [{ clipId: 'clip-1' }],
      'camera-b': [{ clipId: 'clip-2' }, { clipId: 'clip-3' }],
    },
  })
  assert.deepEqual(Object.keys(layers.segments), ['clip-3'])
  assert.equal(layers.segments['clip-3'][0].implementation.parameters.brightness, -0.05)
  assert.equal(layers.cameras['camera-b'][0].implementation.parameters.brightness, plan.cameraTransforms[0].transform.implementation.parameters.brightness)
})

test('T-FR-183 changing the reference produces a new plan that supersedes the old and keeps it readable', () => {
  const a = measurement()
  const b = measurement({ measurementId: 'ccm-b-1', cameraId: 'camera-b', sourceAssetId: 'artifact-b', sourceSha256: sha('c'), exposure: lumaAtEv(0.5, 0.4) })
  const first = derive([a, b])
  const second = derive([a, b], {
    planId: 'mmp-2',
    referenceCameraId: 'camera-b',
    referenceEpoch: 2,
    supersedes: first,
    createdAt: at(30),
  })
  assert.equal(second.supersedes, 'mmp-1')
  assert.equal(second.referenceCameraId, 'camera-b')
  assert.equal(second.dependsOn.referenceCameraId, 'camera-b')
  assert.equal(second.cameraTransforms[0].cameraId, 'camera-a')
  assert.ok(
    second.cameraTransforms[0].transform.implementation.parameters.brightness > 0,
    'with the brighter camera as reference the other one is lifted',
  )
  assert.notEqual(second.planHash, first.planHash)
  assert.equal(assertMulticamMatchPlanIntegrity(first).planHash, first.planHash)
})

test('T-FR-183 the plan hash refuses a transform edited underneath it', () => {
  const plan = derive([
    measurement(),
    measurement({ measurementId: 'ccm-b-1', cameraId: 'camera-b', sourceAssetId: 'artifact-b', sourceSha256: sha('c'), exposure: lumaAtEv(0.5, 0.3) }),
  ])
  const tampered = { ...plan, confidence: 1 }
  throwsCode(() => assertMulticamMatchPlanIntegrity(tampered), 'PERSISTENCE_CONFLICT')
})

test('T-FR-183 a correction beyond the policy limit is clamped and says a human must decide', () => {
  const plan = derive([
    measurement(),
    measurement({ measurementId: 'ccm-b-1', cameraId: 'camera-b', sourceAssetId: 'artifact-b', sourceSha256: sha('c'), exposure: lumaAtEv(0.5, 2.5) }),
  ])
  assert.equal(plan.humanReviewRequired, true)
  assert.ok(plan.issues.some((issue) => issue.code === 'exposure-delta-exceeds-policy'))
  assert.ok(plan.cameraTransforms[0].transform.implementation.parameters.brightness >= -0.2, 'clamped to the policy limit')
})

// ---------------------------------------------------------------------------
// F4.014 — colour critic
// ---------------------------------------------------------------------------

const INTERMEDIATE = { sourceAssetId: 'artifact-intermediate', sourceSha256: sha('d') }
const OUTPUT = { sourceAssetId: 'artifact-output', sourceSha256: sha('e') }

function critique(before, after, overrides = {}) {
  return evaluateColorCritic({
    reportId: 'ccr-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    projectVersionId: 'version-1',
    subject: { kind: 'output', artifactId: 'artifact-output' },
    before,
    after,
    creativeIntent: { declared: false },
    evaluatedAt: at(100),
    ...overrides,
  })
}

function stagePair(overrides = {}) {
  const { afterOverrides = {}, ...shared } = overrides
  const before = [
    measurement({ ...INTERMEDIATE, measurementId: 'ccm-before-a', cameraId: 'camera-a', ...shared }),
    measurement({ ...INTERMEDIATE, measurementId: 'ccm-before-b', cameraId: 'camera-b', ...shared }),
  ]
  const after = [
    measurement({ ...OUTPUT, measurementId: 'ccm-after-a', cameraId: 'camera-a', ...shared, ...afterOverrides }),
    measurement({ ...OUTPUT, measurementId: 'ccm-after-b', cameraId: 'camera-b', ...shared, ...afterOverrides }),
  ]
  return { before, after }
}

function dimensionOf(report, name) {
  return report.dimensions.find((entry) => entry.dimension === name)
}

test('T-FR-184 every dimension answers and the action always follows the cause table', () => {
  const { before, after } = stagePair()
  const report = critique(before, after)
  assert.deepEqual(
    report.dimensions.map((entry) => entry.dimension).sort(),
    [...COLOR_CRITIC_DIMENSIONS].sort(),
    'silence about a dimension is not an answer',
  )
  for (const entry of report.dimensions) {
    assert.ok(['measured', 'not-applicable', 'unavailable'].includes(entry.status))
    if (entry.status !== 'measured') {
      assert.equal(entry.value, undefined)
      assert.ok(entry.reason.length >= 10)
    } else {
      assert.ok(entry.evaluatorIds.every((id) => report.evaluators.some((evaluator) => evaluator.id === id)))
      assert.ok(entry.evidenceRefs.length > 0)
    }
  }
  assert.equal(report.action, COLOR_CRITIC_CAUSE_ACTIONS[report.cause])
  assert.equal(report.action, 'approve')
  assert.equal(report.cause, 'no-defect')
  assert.deepEqual(report.bytesEvaluated.map((bytes) => bytes.artifactId), ['artifact-intermediate', 'artifact-output'])
})

test('T-FR-184 a creative LUT does not excuse clipping', () => {
  const { before, after } = stagePair({ afterOverrides: { highlights: 0.5 } })
  const report = critique(before, after, {
    creativeIntent: { declared: true, castAllowedDelta: 0.4, lutId: 'lut-1', note: 'high-key commercial look' },
  })
  const clipping = dimensionOf(report, 'clipping')
  assert.equal(clipping.status, 'measured')
  assert.equal(clipping.value, 0.5)
  assert.equal(clipping.classification, 'technical-defect')
  const issue = report.issues.find((entry) => entry.dimension === 'clipping')
  assert.equal(issue.severity, 'hard')
  assert.equal(issue.classification, 'technical-defect')
  assert.equal(issue.thresholdVersion, report.thresholds.calibrationVersion)
  assert.equal(report.cause, 'irreversible-technical-defect')
  assert.equal(report.action, 'reject')
})

test('T-FR-184 a documented cast is intent, and removing the declaration changes the verdict', () => {
  const shared = { rOverG: 1 }
  const before = [measurement({ ...INTERMEDIATE, measurementId: 'ccm-before-a', cameraId: 'camera-a', ...shared })]
  const after = [measurement({ ...OUTPUT, measurementId: 'ccm-after-a', cameraId: 'camera-a', rOverG: 1.2 })]

  const declared = critique(before, after, {
    creativeIntent: { declared: true, castAllowedDelta: 0.25, lutId: 'lut-warm-1', note: 'warm teal-orange look' },
  })
  const declaredCast = dimensionOf(declared, 'cast')
  assert.equal(declaredCast.status, 'measured')
  assert.ok(Math.abs(declaredCast.value - 0.2) < 1e-6, `cast ${declaredCast.value}`)
  assert.equal(declaredCast.classification, 'documented-intent')
  assert.equal(report0Issues(declared, 'cast'), 0, 'a declared look inside its budget raises no issue')
  assert.equal(declared.action, 'approve')

  // Falsification: identical bytes, identical numbers, declaration removed.
  const undeclared = critique(before, after, { creativeIntent: { declared: false } })
  const undeclaredCast = dimensionOf(undeclared, 'cast')
  assert.equal(undeclaredCast.value, declaredCast.value, 'the measurement did not change')
  assert.equal(undeclaredCast.classification, 'technical-defect')
  assert.equal(report0Issues(undeclared, 'cast'), 1)
  assert.notEqual(undeclared.action, 'approve')
  assert.equal(undeclared.action, 'bounded-correction')

  // A cast beyond the declared budget is a defect again.
  const beyond = critique(before, after, { creativeIntent: { declared: true, castAllowedDelta: 0.05 } })
  assert.equal(dimensionOf(beyond, 'cast').classification, 'technical-defect')
  assert.notEqual(beyond.action, 'approve')
})

function report0Issues(report, dimension) {
  return report.issues.filter((entry) => entry.dimension === dimension).length
}

test('T-FR-184 skin with no skin-band evidence is not-applicable and is never approved by absence', () => {
  const { before, after } = stagePair()
  const report = critique(before, after)
  const skin = dimensionOf(report, 'skinToneOffTarget')
  assert.equal(skin.status, 'not-applicable')
  assert.equal(skin.value, undefined)
  assert.match(skin.reason, /no skin tone was judged/)
  assert.equal(report0Issues(report, 'skinToneOffTarget'), 0)

  // With band evidence the dimension is measured, and by a controlled evaluator.
  const withSkin = stagePair({ skinHue: 136 })
  const measuredReport = critique(withSkin.before, withSkin.after)
  const measuredSkin = dimensionOf(measuredReport, 'skinToneOffTarget')
  assert.equal(measuredSkin.status, 'measured')
  const evaluator = measuredReport.evaluators.find((entry) => measuredSkin.evaluatorIds.includes(entry.id) && entry.id === 'ycbcr-skin-band-mask')
  assert.equal(evaluator.kind, 'controlled', 'a band mask is a stand-in, never verified skin')
  assert.match(evaluator.scope, /never a perceptual judgement/)
})

test('T-FR-184 a required dimension nobody could read sends the report to a human', () => {
  const { before } = stagePair()
  const after = [
    measurement({ ...OUTPUT, measurementId: 'ccm-after-a', cameraId: 'camera-a', unavailableDimensions: ['highlights'] }),
    measurement({ ...OUTPUT, measurementId: 'ccm-after-b', cameraId: 'camera-b', unavailableDimensions: ['highlights'] }),
  ]
  const report = critique(before, after)
  assert.equal(dimensionOf(report, 'clipping').status, 'unavailable')
  assert.equal(report.cause, 'evidence-unavailable')
  assert.equal(report.action, 'human-review')
  const issue = report.issues.find((entry) => entry.dimension === 'clipping')
  assert.equal(issue.classification, 'insufficient-evidence')
  assert.equal(issue.measured, null)
  assert.equal(issue.threshold, null)
  assert.ok(report.confidence < 1, 'unread evidence lowers the confidence it reports')
})

test('T-FR-184 a declared brand colour with no evaluator is unavailable, not assumed clean', () => {
  const { before, after } = stagePair()
  const silent = critique(before, after)
  assert.equal(dimensionOf(silent, 'brandColorDrift').status, 'not-applicable')
  assert.equal(silent.action, 'approve')

  const declared = critique(before, after, {
    creativeIntent: { declared: true, castAllowedDelta: 0.3, brandColorsDeclared: true },
  })
  assert.equal(dimensionOf(declared, 'brandColorDrift').status, 'unavailable')
  assert.equal(declared.cause, 'evidence-unavailable')
  assert.equal(declared.action, 'human-review')
})

test('T-FR-184 a mismatch in one range is localized and in every range is global', () => {
  const build = (secondRangeOnly) => {
    const ranges = [
      { start: 0, end: 1_000, suffix: '1' },
      { start: 1_000, end: 2_000, suffix: '2' },
    ]
    const before = []
    const after = []
    for (const range of ranges) {
      const offending = secondRangeOnly ? range.suffix === '2' : true
      for (const cameraId of ['camera-a', 'camera-b']) {
        const exposure = cameraId === 'camera-b' && offending ? lumaAtEv(0.5, 0.5) : 0.5
        before.push(measurement({
          ...INTERMEDIATE, measurementId: `ccm-before-${cameraId}-${range.suffix}`, cameraId,
          start: range.start, end: range.end, exposure,
        }))
        after.push(measurement({
          ...OUTPUT, measurementId: `ccm-after-${cameraId}-${range.suffix}`, cameraId,
          start: range.start, end: range.end, exposure,
        }))
      }
    }
    return { before, after }
  }

  const localized = build(true)
  const localizedReport = critique(localized.before, localized.after)
  const localizedDimension = dimensionOf(localizedReport, 'localizedMismatch')
  assert.equal(localizedDimension.classification, 'localized')
  assert.equal(localizedDimension.value, 0.5, 'one range out of two')
  const localizedIssues = localizedReport.issues.filter((entry) => entry.dimension === 'localizedMismatch')
  assert.equal(localizedIssues.length, 1)
  assert.equal(localizedIssues[0].range.start, 1_000n)
  assert.equal(localizedIssues[0].range.end, 2_000n)
  assert.equal(localizedIssues[0].cameraId, 'camera-b')

  const global = build(false)
  const globalReport = critique(global.before, global.after)
  assert.equal(dimensionOf(globalReport, 'localizedMismatch').classification, 'global')
  assert.equal(dimensionOf(globalReport, 'localizedMismatch').value, 1)
})

test('T-FR-184 a stage that flattened the image after the match is a regression', () => {
  const { before } = stagePair()
  const after = [
    measurement({ ...OUTPUT, measurementId: 'ccm-after-a', cameraId: 'camera-a', contrast: 0.1 }),
    measurement({ ...OUTPUT, measurementId: 'ccm-after-b', cameraId: 'camera-b', contrast: 0.1 }),
  ]
  const report = critique(before, after)
  const regression = dimensionOf(report, 'matchRegression')
  assert.equal(regression.status, 'measured')
  assert.equal(regression.value, 2, 'both cameras lost more than a third of their contrast')
  assert.equal(regression.classification, 'technical-defect')
  // Nothing the match stage can be asked to do fixes a flattened image, so the
  // critic says so instead of inventing a delta.
  assert.equal(report.cause, 'correction-not-derivable')
  assert.equal(report.action, 'human-review')
  assert.equal(report.boundedCorrection, null)
})

test('T-FR-184 a bounded correction needs high confidence, deltas in bounds and an iteration left', () => {
  const before = [measurement({ ...INTERMEDIATE, measurementId: 'ccm-before-a', cameraId: 'camera-a' })]
  const after = [measurement({ ...OUTPUT, measurementId: 'ccm-after-a', cameraId: 'camera-a', rOverG: 1.2 })]

  const first = critique(before, after)
  assert.equal(first.action, 'bounded-correction')
  assert.equal(first.confidenceBand, 'high')
  assert.equal(first.boundedCorrection.iteration, 1)
  assert.equal(first.boundedCorrection.maxIterations, 2)
  assert.equal(first.boundedCorrection.proposedDeltas.length, 1)
  assert.ok(first.boundedCorrection.proposedDeltas[0].whiteBalance.redGain < 1, 'the proposal pulls the red back')

  const second = critique(before, after, { correctionsApplied: 1 })
  assert.equal(second.action, 'bounded-correction')
  assert.equal(second.boundedCorrection.iteration, 2)

  const third = critique(before, after, { correctionsApplied: 2 })
  assert.equal(third.cause, 'correction-budget-exhausted')
  assert.equal(third.action, 'human-review')
  assert.equal(third.boundedCorrection, null)

  // The same defect measured with less certainty is not auto-corrected.
  const unsure = critique(
    [measurement({ ...INTERMEDIATE, measurementId: 'ccm-before-a', cameraId: 'camera-a', confidence: 0.5 })],
    after,
  )
  assert.equal(unsure.cause, 'correction-confidence-insufficient')
  assert.equal(unsure.action, 'human-review')

  // A cast far beyond what a match-stage gain may do is refused, not clamped.
  const extreme = critique(before, [measurement({ ...OUTPUT, measurementId: 'ccm-after-a', cameraId: 'camera-a', rOverG: 2.2 })])
  assert.equal(extreme.cause, 'correction-out-of-bounds')
  assert.equal(extreme.action, 'human-review')
})

test('T-FR-184 the report hash refuses a verdict edited underneath it', () => {
  const { before, after } = stagePair()
  const report = critique(before, after)
  assert.equal(assertColorCriticReportIntegrity(report).reportHash, report.reportHash)
  throwsCode(() => assertColorCriticReportIntegrity({ ...report, action: 'reject' }), 'PERSISTENCE_CONFLICT')
  throwsCode(
    () => assertColorCriticReportIntegrity({ ...report, cause: 'no-defect', action: 'reject' }),
    'PERSISTENCE_CONFLICT',
  )
})

test('T-FR-184 an HDR source on either side of the output transform is an inconsistency, not a number', () => {
  const before = [measurement({ ...INTERMEDIATE, measurementId: 'ccm-before-a', cameraId: 'camera-a' })]
  const after = [measurement({ ...OUTPUT, measurementId: 'ccm-after-a', cameraId: 'camera-a', hdrMode: 'pq' })]
  const report = critique(before, after)
  const dimension = dimensionOf(report, 'hdrSdrInconsistency')
  assert.equal(dimension.status, 'measured')
  assert.ok(dimension.value >= 1)
  assert.equal(report.cause, 'irreversible-technical-defect')
  assert.equal(report.action, 'reject')
})

test('T-FR-184 a report needs both stages; one of them alone cannot show what the transform did', () => {
  const { before } = stagePair()
  throwsCode(() => critique(before, []), 'INVALID_ARGUMENT')
})
