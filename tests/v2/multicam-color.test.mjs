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
  calculateMulticamMatchPlanHash,
  compileMatchPlanToColorPlanLayers,
  deriveMulticamMatchPlan,
  MATCH_PROVIDER_VERSIONS,
} from '../../src/v2/domain/multicam-match-plan.ts'
import {
  assertColorCriticReportIntegrity,
  calculateColorCriticReportHash,
  COLOR_CRITIC_CAUSE_ACTIONS,
  COLOR_CRITIC_DIMENSIONS,
  DEFAULT_COLOR_CRITIC_POLICY,
  DEFAULT_COLOR_CRITIC_THRESHOLDS,
  evaluateColorCritic,
} from '../../src/v2/domain/color-critic-report.ts'
import { colorCameraIdForTrack } from '../../src/v2/domain/camera-identity.ts'
import { createTickInterval } from '../../src/v2/domain/session-time.ts'

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
    dimensionOverrides: undefined,
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
  // One dimension replaced wholesale, so a construction rule can be violated
  // on its own while the other seven stay valid — otherwise the constructor
  // throws on the missing dimensions and the rule under test never runs.
  for (const [dimension, result] of Object.entries(o.dimensionOverrides ?? {})) {
    dimensions[dimension] = result
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

function throwsCode(fn, code, message) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code, `expected ${code}, received ${error.code}: ${error.message}`)
    if (message) assert.match(error.message, message)
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
  // Each case leaves the other seven dimensions valid, so exactly one ADR-147
  // construction rule is violated and the assertion names which one fired.
  throwsCode(
    () => measurement({
      dimensionOverrides: {
        exposure: { status: 'unavailable', reason: 'the sensor stream stopped mid range', value: 0.5, unit: 'normalized-luma' },
      },
    }),
    'INVALID_ARGUMENT',
    /dimensions\.exposure is unavailable and must not carry a value/,
  )
  throwsCode(
    () => measurement({
      dimensionOverrides: {
        exposure: { status: 'measured', value: 0.5, unit: 'normalized-luma', evaluator: STATISTICS_EVALUATOR },
      },
    }),
    'INVALID_ARGUMENT',
    /dimensions\.exposure must reference its evidence/,
  )
  throwsCode(
    () => measurement({
      dimensionOverrides: {
        exposure: { status: 'measured', value: 0.5, unit: 'normalized-luma', evidenceRef: 'rawvideo-rgb24:ccm-a-1' },
      },
    }),
    'INVALID_ARGUMENT',
    /dimensions\.exposure\.evaluator must name its evaluator/,
  )
  throwsCode(
    () => measurement({ dimensionOverrides: { exposure: { status: 'measured', value: 0.5, unit: 'ev', evaluator: STATISTICS_EVALUATOR, evidenceRef: 'x' } } }),
    'INVALID_ARGUMENT',
    /dimensions\.exposure\.unit must be normalized-luma/,
  )
})

test('T-FR-183 comparability names every reason a measurement cannot be compared', () => {
  assert.deepEqual(measurement().comparability, { comparable: true, reasons: [] })
  assert.deepEqual(
    measurement({ measurementId: 'ccm-a-2', hdrMode: 'pq', sampledFrames: 2, unavailableDimensions: ['whiteBalance'] }).comparability,
    {
      comparable: false,
      reasons: ['hdr-transfer-without-tone-map', 'insufficient-sampled-frames', 'whiteBalance-not-measured'],
    },
  )
  assert.equal(measurement({ measurementId: 'ccm-a-3', sampledFrames: 2 }).comparability.comparable, false)
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
  assert.ok(parameters['blue-gain'] < 1, `a bluer camera loses blue, received ${parameters['blue-gain']}`)
  assert.ok(Math.abs(parameters['red-gain'] - 1) < 1e-6, 'the red channel already matched')
  assert.equal(entry.transform.implementation.version, MATCH_PROVIDER_VERSIONS.v2.version, 'a white balance needs apollo-match v2')
  assert.equal(entry.transform.kind, 'match')
  assert.equal(plan.pipelineStage, 'match')

  // The ColorPlan validates every parameter key against its own lowercase
  // TOKEN grammar (`color-and-export.ts:80,298`). A camelCase gain name makes
  // the entire compiled camera layer unacceptable to the authority, so the
  // spelling is an invariant of the wire shape, not a style choice.
  const colorPlanToken = /^[a-z0-9][a-z0-9._/-]{0,127}$/
  for (const key of MATCH_PROVIDER_VERSIONS.v2.parameters) {
    assert.ok(colorPlanToken.test(key), `apollo-match v2 parameter ${key} is not a ColorPlan parameter key`)
  }
  for (const key of Object.keys(parameters)) {
    assert.ok(colorPlanToken.test(key), `derived parameter ${key} is not a ColorPlan parameter key`)
  }

  // The magnitude is monotonic in the deviation, not merely signed.
  const bluer = derive([reference, measurement({
    measurementId: 'ccm-b-2', cameraId: 'camera-b', sourceAssetId: 'artifact-b', sourceSha256: sha('c'),
    exposure: lumaAtEv(0.5, 0.5), bOverG: 0.9 * 1.2,
  })])
  assert.ok(
    bluer.cameraTransforms[0].transform.implementation.parameters['blue-gain'] < parameters['blue-gain'],
    'twice the cast asks for more correction',
  )
})

test('T-FR-183 per-range deltas are weighted by how long the ranges actually overlapped', () => {
  // Camera B agrees with the reference for 900 ticks and disagrees for 100.
  // The duration-weighted brightness is 0.025; assuming equal durations gives
  // 0.125 — five times the correction, from the same measurements.
  const reference = [
    measurement({ measurementId: 'ccm-a-1', start: 0, end: 900, exposure: 0.5 }),
    measurement({ measurementId: 'ccm-a-2', start: 900, end: 1_000, exposure: 0.5 }),
  ]
  const camera = [
    measurement({ measurementId: 'ccm-b-1', cameraId: 'camera-b', sourceAssetId: 'artifact-b', sourceSha256: sha('c'), start: 0, end: 900, exposure: 0.5 }),
    measurement({ measurementId: 'ccm-b-2', cameraId: 'camera-b', sourceAssetId: 'artifact-b', sourceSha256: sha('c'), start: 900, end: 1_000, exposure: 0.25 }),
  ]
  const plan = derive([...reference, ...camera])
  const entry = plan.cameraTransforms[0]
  assert.equal(entry.rangePairs, 2)
  assert.ok(
    Math.abs(entry.transform.implementation.parameters.brightness - 0.025) < 1e-6,
    `expected the duration-weighted 0.025, received ${entry.transform.implementation.parameters.brightness}`,
  )
  assert.ok(
    Math.abs(entry.deltas.exposureEv + 0.22) < 1e-6,
    `expected the duration-weighted -0.22 EV, received ${entry.deltas.exposureEv}`,
  )
  assert.ok(entry.confidence < 0.5, 'ranges that disagree by a full stop cannot claim confidence')
})

test('T-FR-183 assertMatchStageTransform refuses every transform the ColorPlan would not run', () => {
  const build = ({ version = 'v1', enabled = true, parameters, hash, output = METADATA }) => {
    const sorted = Object.fromEntries(Object.entries(parameters).sort(([left], [right]) => left.localeCompare(right)))
    return {
      id: 'match-camera-b',
      kind: 'match',
      version: 'v1',
      enabled,
      input: METADATA,
      output,
      implementation: {
        provider: 'apollo-match',
        version,
        parameters: sorted,
        parametersHash: hash ?? calculateCanonicalHash(sorted),
      },
    }
  }
  const adjust = { mode: 'adjust', brightness: -0.05, contrast: 1, saturation: 1 }

  assert.doesNotThrow(() => assertMatchStageTransform(build({ parameters: adjust })))
  throwsCode(
    () => assertMatchStageTransform(build({ parameters: adjust, hash: sha('f') })),
    'INVALID_ARGUMENT',
    /parametersHash does not match its parameters/,
  )
  throwsCode(
    () => assertMatchStageTransform(build({ parameters: adjust, output: REC2020 })),
    'INVALID_ARGUMENT',
    /must not change colorimetry/,
  )
  throwsCode(
    () => assertMatchStageTransform(build({ version: 'v2', parameters: { ...adjust, 'red-gain': 1, 'green-gain': 1, 'blue-gain': 3 } })),
    'INVALID_ARGUMENT',
    /blue-gain is outside safe bounds/,
  )
  throwsCode(
    () => assertMatchStageTransform(build({ enabled: false, parameters: adjust })),
    'INVALID_ARGUMENT',
    /must be an explicit bypass/,
  )
  // The camelCase spelling the ColorPlan grammar rejects is not in the v2
  // whitelist either, so it never reaches a compiled layer.
  throwsCode(
    () => assertMatchStageTransform(build({ version: 'v2', parameters: { ...adjust, redGain: 1, greenGain: 1, blueGain: 1 } })),
    'INVALID_ARGUMENT',
    /outside apollo-match v2/,
  )
  // An adjust that names no adjustment. This used to be read as the identity
  // (brightness 0, contrast 1, saturation 1), which is a bypass with an
  // adjust's label — and, stored, a row camera_match_transforms_mode_check
  // refuses with a raw 23514 because the projected columns are NULL.
  for (const missing of ['brightness', 'contrast', 'saturation']) {
    const partial = { ...adjust }
    delete partial[missing]
    throwsCode(
      () => assertMatchStageTransform(build({ parameters: partial })),
      'INVALID_ARGUMENT',
      new RegExp(`must state its ${missing}`),
    )
  }
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
  // The authority folds the separator too: ColorPlan's TOKEN grammar
  // (color-and-export.ts:80) would accept a '/', but camera-identity.ts:36
  // replaces every character outside [a-z0-9._-], so a track id that reads
  // like a path becomes one flat key. This test asserted the '/' back when it
  // carried a local mirror of that function; it now imports the real one.
  const cameraId = colorCameraIdForTrack({ trackId: 'Camera/B Main' })
  assert.equal(cameraId, 'camera-b-main')
  // The camera needs a white balance, so the transform is apollo-match v2 and
  // the compiled layer carries the gain parameters. That is the case the slice
  // exists for, and the case createColorPlan used to refuse outright.
  const plan = derive([
    measurement(),
    measurement({
      measurementId: 'ccm-b-1', cameraId, sourceAssetId: 'artifact-b', sourceSha256: sha('c'),
      exposure: lumaAtEv(0.5, 0.3), bOverG: 0.9 * 1.1,
    }),
  ])
  // A range override that also carries gains, so the `segments` layer is a v2
  // transform too rather than the exposure-only shape.
  const amended = addMulticamMatchRangeOverride(plan, {
    planId: 'mmp-2',
    createdAt: at(20),
    override: {
      overrideId: 'ovr-1',
      cameraId,
      segmentId: 'clip-2',
      parameters: { brightness: -0.03, contrast: 1, saturation: 1, gains: { redGain: 1.02, greenGain: 1, blueGain: 0.95 } },
      reason: 'the window light shifts in this clip',
      actor: { kind: 'human', id: 'editor-1' },
    },
  })
  const layers = compileMatchPlanToColorPlanLayers(amended, {
    editPlanClipsByCameraId: {
      'camera-a': [{ clipId: 'clip-1', sessionRange: createTickInterval(BigInt(0), BigInt(500)) }],
      [cameraId]: [{ clipId: 'clip-2', sessionRange: createTickInterval(BigInt(500), BigInt(1_000)) }],
    },
  })
  assert.equal(layers.cameras['camera-a'][0].enabled, false, 'the reference is an explicit bypass')
  assert.equal(layers.cameras[cameraId][0].enabled, true)
  assert.equal(layers.cameras[cameraId][0].implementation.version, MATCH_PROVIDER_VERSIONS.v2.version)
  assert.equal(layers.segments['clip-2'][0].implementation.version, MATCH_PROVIDER_VERSIONS.v2.version)
  assert.equal(layers.segments['clip-2'][0].implementation.parameters['blue-gain'], 0.95)
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
  assert.equal(resolved.stages[1].implementation.version, MATCH_PROVIDER_VERSIONS.v2.version)
  assert.ok(resolved.stages[1].implementation.parameters['blue-gain'] < 1, 'the white balance survived the round trip')
  assert.equal(resolved.stages[1].enabled, true, 'the camera layer overrode the global bypass')

  const segmentResolved = resolveColorPlan(colorPlan, { sourceId: 'artifact-b', cameraId, segmentId: 'clip-2' })
  assert.equal(segmentResolved.stages[1].implementation.parameters['blue-gain'], 0.95, 'the segment layer wins over the camera one')

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

test('T-FR-183 a policy rate that disables a named limit is refused, not obeyed', () => {
  const measurements = [
    measurement({ exposure: 0.1 }),
    measurement({
      measurementId: 'ccm-b-1', cameraId: 'camera-b', sourceAssetId: 'artifact-b', sourceSha256: sha('c'),
      exposure: lumaAtEv(0.1, 1.2),
    }),
  ]
  // The honest reading first: 1.2 EV is beyond the 1 EV limit, so the plan says
  // a human must decide.
  const honest = derive(measurements)
  assert.ok(Math.abs(honest.cameraTransforms[0].deltas.exposureEv - 1.2) < 1e-3)
  assert.equal(honest.humanReviewRequired, true)

  // gamma 0 made every exposure delta come out as exactly 0 EV, so the issue
  // disappeared and humanReviewRequired flipped to false while the brightness
  // correction was still applied at full strength.
  throwsCode(() => derive(measurements, { policy: { exposureGamma: 0 } }), 'INVALID_ARGUMENT', /policy\.exposureGamma/)
  throwsCode(() => derive(measurements, { policy: { exposureGamma: -2.2 } }), 'INVALID_ARGUMENT', /policy\.exposureGamma/)
  throwsCode(() => derive(measurements, { policy: { maxBrightnessOffset: Number.NaN } }), 'INVALID_ARGUMENT', /policy\.maxBrightnessOffset/)
  throwsCode(() => derive(measurements, { policy: { maxWhiteBalanceGain: 1 } }), 'INVALID_ARGUMENT', /policy\.maxWhiteBalanceGain must exceed 1/)
  throwsCode(() => derive(measurements, { policy: { minimumSampledFrames: 1 } }), 'INVALID_ARGUMENT', /policy\.minimumSampledFrames/)
  throwsCode(() => derive(measurements, { policy: { contrastRange: [1.5, 0.67] } }), 'INVALID_ARGUMENT', /policy\.contrastRange/)
})

test('T-FR-183 an override that names no target, or a parameter that is not a number, is a domain refusal', () => {
  const plan = derive([
    measurement(),
    measurement({ measurementId: 'ccm-b-1', cameraId: 'camera-b', sourceAssetId: 'artifact-b', sourceSha256: sha('c'), exposure: lumaAtEv(0.5, 0.3) }),
  ])
  const amend = (override) => addMulticamMatchRangeOverride(plan, { planId: 'mmp-2', createdAt: at(20), override })
  const base = {
    overrideId: 'ovr-1',
    cameraId: 'camera-b',
    parameters: { brightness: -0.05, contrast: 1, saturation: 1 },
    reason: 'the practical lamp enters frame here',
    actor: { kind: 'human', id: 'editor-1' },
  }
  throwsCode(() => amend({ ...base }), 'INVALID_ARGUMENT', /exactly one of segmentId or range/)
  throwsCode(
    () => amend({ ...base, segmentId: 'clip-3', range: createTickInterval(BigInt(0), BigInt(10)) }),
    'INVALID_ARGUMENT',
    /exactly one of segmentId or range/,
  )
  throwsCode(
    () => amend({ ...base, segmentId: 'clip-3', parameters: { brightness: Number.NaN, contrast: 1, saturation: 1 } }),
    'INVALID_ARGUMENT',
    /brightness must be a finite number/,
  )
  throwsCode(
    () => amend({ ...base, segmentId: 'clip-3', parameters: { brightness: -0.05, contrast: 1, saturation: 1, gains: { redGain: 1, greenGain: 1, blueGain: Number.POSITIVE_INFINITY } } }),
    'INVALID_ARGUMENT',
    /blue-gain must be a finite number/,
  )
  throwsCode(
    () => amend({ ...base, segmentId: 'clip-3', cameraId: 'camera-z' }),
    'INVALID_ARGUMENT',
    /camera-z, which the plan does not know/,
  )
})

test('T-FR-183 a stored plan without its reference measurement is refused at the door, not dereferenced', () => {
  const plan = derive([
    measurement(),
    measurement({ measurementId: 'ccm-b-1', cameraId: 'camera-b', sourceAssetId: 'artifact-b', sourceSha256: sha('c'), exposure: lumaAtEv(0.5, 0.3) }),
  ])
  const { planHash: _planHash, ...content } = plan
  const stripped = { ...content, measurements: content.measurements.filter((entry) => entry.cameraId !== 'camera-a') }
  // Re-hashed, so the hash check passes and only the invariant can refuse it.
  const rehashed = { ...stripped, planHash: calculateMulticamMatchPlanHash(stripped) }
  throwsCode(() => assertMulticamMatchPlanIntegrity(rehashed), 'COLOR_REFERENCE_UNAVAILABLE')
  throwsCode(
    () => compileMatchPlanToColorPlanLayers(rehashed, { editPlanClipsByCameraId: { 'camera-a': [{ clipId: 'clip-1' }] } }),
    'COLOR_REFERENCE_UNAVAILABLE',
  )
  throwsCode(
    () => addMulticamMatchRangeOverride(rehashed, {
      planId: 'mmp-2',
      createdAt: at(20),
      override: {
        overrideId: 'ovr-1', cameraId: 'camera-b', segmentId: 'clip-3',
        parameters: { brightness: -0.05, contrast: 1, saturation: 1 },
        reason: 'because', actor: { kind: 'human', id: 'editor-1' },
      },
    }),
    'COLOR_REFERENCE_UNAVAILABLE',
  )

  // The same door refuses a plan that corrects its own reference camera.
  const selfCorrecting = { ...content, referenceCameraId: 'camera-b', dependsOn: { ...content.dependsOn, referenceCameraId: 'camera-b' } }
  throwsCode(
    () => assertMulticamMatchPlanIntegrity({ ...selfCorrecting, planHash: calculateMulticamMatchPlanHash(selfCorrecting) }),
    'PERSISTENCE_CONFLICT',
    /must not correct the reference camera/,
  )
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

/**
 * The plan that says which camera the others were corrected towards.
 *
 * Passed by default because the reference camera is an approval, and a report
 * that compared cameras without one would be comparing them against whichever
 * camera sorts first. `matchPlan: undefined` in a test is therefore a
 * deliberate statement — "nobody approved a reference here" — and the critic
 * answers it with an unavailable cross-camera dimension.
 */
const REFERENCE_PLAN = (() => {
  const before = [
    measurement({ ...INTERMEDIATE, measurementId: 'ccm-reference-a', cameraId: 'camera-a' }),
    measurement({ ...INTERMEDIATE, measurementId: 'ccm-reference-b', cameraId: 'camera-b' }),
  ]
  return derive(before, { planId: 'mmp-reference' })
})()

function critique(before, after, overrides = {}) {
  return evaluateColorCritic({
    reportId: 'ccr-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    projectVersionId: 'version-1',
    subject: { kind: 'output', artifactId: 'artifact-output' },
    before,
    after,
    matchPlan: REFERENCE_PLAN,
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
    creativeIntent: { declared: true, castAllowedDelta: 0.2, lutId: 'lut-1', note: 'high-key commercial look' },
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
    creativeIntent: { declared: true, castAllowedDelta: 0.2, brandColorsDeclared: true },
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

  // The cause table catches these two without ever comparing the hash.
  throwsCode(() => assertColorCriticReportIntegrity({ ...report, action: 'reject' }), 'PERSISTENCE_CONFLICT')
  throwsCode(
    () => assertColorCriticReportIntegrity({ ...report, cause: 'no-defect', action: 'reject' }),
    'PERSISTENCE_CONFLICT',
  )

  // So tamper with a number no rule cross-checks: only the hash can refuse it.
  // Proof that it is the hash doing the work — re-hashed, the same edit is
  // accepted, because nothing else in the report contradicts it.
  const { reportHash: _hash, ...content } = report
  const edited = { ...content, confidence: 0.1 }
  assert.equal(assertColorCriticReportIntegrity({ ...edited, reportHash: calculateColorCriticReportHash(edited) }).confidence, 0.1)
  throwsCode(() => assertColorCriticReportIntegrity({ ...report, confidence: 0.1 }), 'PERSISTENCE_CONFLICT', /hash does not match/)
  const withDimension = {
    ...content,
    dimensions: content.dimensions.map((entry) => entry.dimension === 'clipping' ? { ...entry, value: 0.9 } : entry),
  }
  throwsCode(() => assertColorCriticReportIntegrity({ ...withDimension, reportHash: report.reportHash }), 'PERSISTENCE_CONFLICT', /hash does not match/)
})

test('T-FR-184 the integrity door re-runs the ADR-147 shape rules, not only the hash', () => {
  const { before, after } = stagePair()
  const report = critique(before, after)
  assert.equal(report.action, 'approve')
  const { reportHash: _hash, ...content } = report
  const blocking = {
    code: 'color-clipping',
    dimension: 'clipping',
    severity: 'hard',
    classification: 'technical-defect',
    cause: 'irreversible-technical-defect',
    stage: 'after-output-transform',
    cameraId: 'camera-a',
    range: null,
    measured: 0.9,
    threshold: 0.02,
    thresholdVersion: report.thresholds.calibrationVersion,
    confidence: 1,
    evidenceRefs: ['rawvideo-rgb24:ccm-after-a'],
  }
  const tampered = { ...content, issues: [...content.issues, blocking] }
  // Re-hashed, so the hash agrees and only the invariant can refuse it.
  throwsCode(
    () => assertColorCriticReportIntegrity({ ...tampered, reportHash: calculateColorCriticReportHash(tampered) }),
    'PERSISTENCE_CONFLICT',
    /approved report cannot carry a blocking issue/,
  )
})

test('T-FR-184 the cross-stage comparison is bound to the camera it belongs to', () => {
  // Both cameras keep their own white balance across the output transform, so
  // the true cast is zero for each of them. camera-b is 30% redder than
  // camera-a on BOTH sides: pairing across cameras would invent a 0.3 cast
  // that no transform produced.
  const before = [
    measurement({ ...INTERMEDIATE, measurementId: 'ccm-before-a', cameraId: 'camera-a', rOverG: 1 }),
    measurement({ ...INTERMEDIATE, measurementId: 'ccm-before-b', cameraId: 'camera-b', rOverG: 1.3 }),
  ]
  const after = [
    measurement({ ...OUTPUT, measurementId: 'ccm-after-a', cameraId: 'camera-a', rOverG: 1 }),
    measurement({ ...OUTPUT, measurementId: 'ccm-after-b', cameraId: 'camera-b', rOverG: 1.3 }),
  ]
  const report = critique(before, after)
  assert.equal(dimensionOf(report, 'cast').value, 0, 'the output transform changed no camera, so there is no cast')
  assert.deepEqual(
    [...report.stagePairs].sort((left, right) => left.cameraId.localeCompare(right.cameraId)),
    [
      { cameraId: 'camera-a', beforeMeasurementId: 'ccm-before-a', afterMeasurementId: 'ccm-after-a' },
      { cameraId: 'camera-b', beforeMeasurementId: 'ccm-before-b', afterMeasurementId: 'ccm-after-b' },
    ],
    'each stage pair reads one camera against itself',
  )
  // The real defect is between the cameras, and it is attributed to the one
  // that drifted from the reference, not to the reference.
  const mismatch = report.issues.find((entry) => entry.dimension === 'whiteBalanceMismatch')
  assert.equal(mismatch.cameraId, 'camera-b')
  assert.equal(report.cause, 'correctable-technical-defect')
  assert.equal(report.action, 'bounded-correction')
})

test('T-FR-184 two cameras that never overlap are an evidence gap, never an approval', () => {
  const before = [
    measurement({ ...INTERMEDIATE, measurementId: 'ccm-before-a', cameraId: 'camera-a', start: 0, end: 1_000, exposure: 0.5 }),
    measurement({ ...INTERMEDIATE, measurementId: 'ccm-before-b', cameraId: 'camera-b', start: 2_000, end: 3_000, exposure: lumaAtEv(0.5, 1) }),
  ]
  const after = [
    measurement({ ...OUTPUT, measurementId: 'ccm-after-a', cameraId: 'camera-a', start: 0, end: 1_000, exposure: 0.5 }),
    measurement({ ...OUTPUT, measurementId: 'ccm-after-b', cameraId: 'camera-b', start: 2_000, end: 3_000, exposure: lumaAtEv(0.5, 1) }),
  ]
  const report = critique(before, after)
  for (const dimension of ['whiteBalanceMismatch', 'exposureMismatch', 'localizedMismatch']) {
    assert.equal(dimensionOf(report, dimension).status, 'unavailable', dimension)
    const raised = report.issues.find((entry) => entry.dimension === dimension)
    assert.equal(raised.classification, 'insufficient-evidence', dimension)
    assert.equal(raised.severity, 'hard', `${dimension} is required as soon as a second camera exists`)
  }
  assert.equal(report.cause, 'evidence-unavailable')
  assert.equal(report.action, 'human-review')
  assert.notEqual(report.action, 'approve')
})

test('T-FR-184 without an approved reference camera the cross-camera comparison is unavailable, not measured against whichever camera sorts first', () => {
  // Two cameras that differ by a whole stop and no plan naming the reference.
  // The alphabetically first camera is not an approval, so nothing here is
  // measured against it — and a report that could not read a dimension cannot
  // approve.
  const shared = { start: 0, end: 1_000 }
  const before = [
    measurement({ ...INTERMEDIATE, ...shared, measurementId: 'ccm-before-a', cameraId: 'camera-a', exposure: 0.5 }),
    measurement({ ...INTERMEDIATE, ...shared, measurementId: 'ccm-before-b', cameraId: 'camera-b', exposure: lumaAtEv(0.5, 1) }),
  ]
  const after = [
    measurement({ ...OUTPUT, ...shared, measurementId: 'ccm-after-a', cameraId: 'camera-a', exposure: 0.5 }),
    measurement({ ...OUTPUT, ...shared, measurementId: 'ccm-after-b', cameraId: 'camera-b', exposure: lumaAtEv(0.5, 1) }),
  ]
  const approved = critique(before, after)
  assert.equal(dimensionOf(approved, 'exposureMismatch').status, 'measured',
    'with a reference the comparison is a measurement')
  assert.equal(approved.matchPlanId, REFERENCE_PLAN.planId)

  const unapproved = critique(before, after, { matchPlan: undefined })
  assert.equal(unapproved.matchPlanId, null)
  for (const dimension of ['whiteBalanceMismatch', 'exposureMismatch', 'localizedMismatch']) {
    const result = dimensionOf(unapproved, dimension)
    assert.equal(result.status, 'unavailable', dimension)
    assert.match(result.reason, /reference camera/, dimension)
  }
  assert.equal(unapproved.cause, 'evidence-unavailable')
  assert.notEqual(unapproved.action, 'approve')
})

test('T-FR-184 even a dimension nobody needed still refuses to be silent', () => {
  // Saturation is not in the required set — the verdict can be reached without
  // it — but "nobody could read it" is still not "nothing was wrong with it".
  const before = [measurement({ ...INTERMEDIATE, measurementId: 'ccm-before-a', cameraId: 'camera-a' })]
  const after = [measurement({ ...OUTPUT, measurementId: 'ccm-after-a', cameraId: 'camera-a', unavailableDimensions: ['saturation'] })]
  const report = critique(before, after)
  for (const dimension of ['saturationExcess', 'saturationDeficit']) {
    assert.equal(dimensionOf(report, dimension).status, 'unavailable', dimension)
    const raised = report.issues.find((entry) => entry.dimension === dimension)
    assert.equal(raised.classification, 'insufficient-evidence', dimension)
    assert.equal(raised.severity, 'warning', `${dimension} is not required, so it does not block on its own`)
  }
  assert.equal(dimensionOf(report, 'clipping').status, 'measured', 'the required dimensions were all readable')
  assert.equal(report.cause, 'evidence-unavailable')
  assert.equal(report.action, 'human-review')
})

test('T-FR-184 a declared allowance cannot be large enough to write the verdict', () => {
  const before = [measurement({ ...INTERMEDIATE, measurementId: 'ccm-before-a', cameraId: 'camera-a', rOverG: 1 })]
  const after = [measurement({ ...OUTPUT, measurementId: 'ccm-after-a', cameraId: 'camera-a', rOverG: 5.55 })]
  // A cast 57 times the hard threshold, declared away, used to come back
  // approve/documented-intent.
  throwsCode(
    () => critique(before, after, { creativeIntent: { declared: true, castAllowedDelta: 1e6 } }),
    'INVALID_ARGUMENT',
    /castAllowedDelta must be within/,
  )
  throwsCode(
    () => critique(before, after, { creativeIntent: { declared: true, castAllowedDelta: -1 } }),
    'INVALID_ARGUMENT',
    /castAllowedDelta must be within/,
  )
  throwsCode(
    () => critique(before, after, { creativeIntent: { declared: true, castAllowedDelta: Number.POSITIVE_INFINITY } }),
    'INVALID_ARGUMENT',
    /castAllowedDelta must be within/,
  )
  const bounded = critique(before, after, {
    creativeIntent: { declared: true, castAllowedDelta: DEFAULT_COLOR_CRITIC_POLICY.maxDeclaredCastAllowance },
  })
  assert.equal(bounded.intentBounds.castAllowedDelta, DEFAULT_COLOR_CRITIC_POLICY.maxDeclaredCastAllowance)
  assert.equal(bounded.intentBounds.maxDeclaredCastAllowance, DEFAULT_COLOR_CRITIC_POLICY.maxDeclaredCastAllowance)
  assert.equal(dimensionOf(bounded, 'cast').classification, 'technical-defect', 'the largest declarable look still does not cover a 4.55 cast')
  assert.notEqual(bounded.action, 'approve')
})

test('T-FR-184 thresholds and policy rates are refused when they are not a calibration', () => {
  const { before, after } = stagePair()
  throwsCode(
    () => critique(before, after, { thresholds: { calibrationVersion: 'x/v1', values: {} } }),
    'INVALID_ARGUMENT',
    /thresholds\.values\.clipping/,
  )
  throwsCode(
    () => critique(before, after, { thresholds: { calibrationVersion: 'x/v1', values: { ...DEFAULT_COLOR_CRITIC_THRESHOLDS.values, cast: { warn: 0.03 } } } }),
    'INVALID_ARGUMENT',
    /thresholds\.values\.cast/,
  )
  throwsCode(() => critique(before, after, { policy: { exposureGamma: 0 } }), 'INVALID_ARGUMENT', /policy\.exposureGamma/)
  throwsCode(() => critique(before, after, { policy: { contrastRegressionRatio: -1 } }), 'INVALID_ARGUMENT', /policy\.contrastRegressionRatio/)
})

test('T-FR-184 a subject range must be built of ticks, not of milliseconds', () => {
  const { before, after } = stagePair()
  const report = critique(before, after, {
    subject: { kind: 'range', cameraId: 'camera-a', range: createTickInterval(BigInt(0), BigInt(1_000)) },
  })
  assert.equal(typeof report.subject.range.start, 'bigint')
  throwsCode(
    () => critique(before, after, { subject: { kind: 'range', cameraId: 'camera-a', range: { start: 1000.5, end: 2000.5 } } }),
    'INVALID_ARGUMENT',
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
