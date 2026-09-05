import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, before } from 'node:test'
import { promisify } from 'node:util'

import { DEFAULT_COLOR_CRITIC_POLICY, evaluateColorCritic } from '../../src/v2/domain/color-critic-report.ts'
import { deriveMulticamMatchPlan } from '../../src/v2/domain/multicam-match-plan.ts'
import { createTickInterval } from '../../src/v2/domain/session-time.ts'
import { FfmpegColorMeasurement } from '../../src/v2/infrastructure/media/ffmpeg-color-measurement.ts'

const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static')
const run = promisify(execFile)

const WIDTH = 320
const HEIGHT = 180
const RATE = 30
const SECONDS = 2
const FRAMES = RATE * SECONDS
const SAMPLE_EVERY_MS = 100

/** Camera A: a deterministic colour pattern with real chroma and detail. */
const BASE = `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${RATE}:duration=${SECONDS}`
/** A flat mid grey the half-frame overlays are drawn onto. */
const FLAT = `color=c=gray:size=${WIDTH}x${HEIGHT}:rate=${RATE}:duration=${SECONDS}`
/** A light skin-tone patch: RGB 230,180,150 lands inside the Cb/Cr skin band. */
const SKIN = `color=c=0xE6B496:size=${WIDTH}x${HEIGHT}:rate=${RATE}:duration=${SECONDS}`

const FIXTURES = Object.freeze({
  cameraA: { source: BASE, filter: 'null' },
  // `eq=brightness` pulls every channel ratio towards 1, so a shadows-only
  // `colorbalance=bs` is cancelled by it and the frame does not read bluer.
  // The cast is therefore applied across shadows, midtones and highlights.
  cameraB: { source: BASE, filter: 'eq=brightness=0.1,colorbalance=bs=0.2:bm=0.2:bh=0.2' },
  cameraBStrong: { source: BASE, filter: 'eq=brightness=0.1,colorbalance=bs=0.4:bm=0.4:bh=0.4' },
  clipped: { source: FLAT, filter: `drawbox=x=0:y=0:w=${WIDTH}:h=${HEIGHT / 2}:color=white:t=fill` },
  crushed: { source: FLAT, filter: `drawbox=x=0:y=0:w=${WIDTH}:h=${HEIGHT / 2}:color=black:t=fill` },
  castRed: { source: BASE, filter: 'colorbalance=rs=0.3:rm=0.3:rh=0.3' },
  lateBrighter: { source: BASE, filter: "eq=brightness=0.2:enable='between(t,1,2)'" },
  skinPatch: { source: SKIN, filter: 'null' },
})

let root = null
const files = new Map()
const measurer = new FfmpegColorMeasurement({ timeoutMs: 120_000 })

async function encode(name, { source, filter }, extra = []) {
  const path = join(root, `${name}.mp4`)
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', source,
    '-vf', `${filter},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
    ...extra, path,
  ], { windowsHide: true, timeout: 120_000 })
  const sha256 = createHash('sha256').update(await readFile(path)).digest('hex')
  files.set(name, { path, sha256 })
  return files.get(name)
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'apollo-color-measurement-'))
  for (const [name, fixture] of Object.entries(FIXTURES)) await encode(name, fixture)
  // An HDR-tagged source: the transfer says PQ, and nothing in the pipeline
  // can bring it to SDR, so the measurement must refuse it.
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', BASE,
    '-vf', 'format=yuv420p10le',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p10le',
    '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-color_range', 'tv',
    join(root, 'hdr.mp4'),
  ], { windowsHide: true, timeout: 120_000 })
  files.set('hdr', {
    path: join(root, 'hdr.mp4'),
    sha256: createHash('sha256').update(await readFile(join(root, 'hdr.mp4'))).digest('hex'),
  })
})

after(async () => {
  if (!root) return
  try {
    await rm(root, { recursive: true, force: true })
  } catch (error) {
    console.log(`fixture cleanup left ${root} behind: ${error.message}`)
  }
})

function wholeClip(measurementId) {
  return {
    sessionRange: createTickInterval(BigInt(0), BigInt(SECONDS * 1_000)),
    sourceStartFrame: 0,
    sourceEndFrame: FRAMES,
    measurementId,
  }
}

async function measure(name, cameraId, ranges) {
  const file = files.get(name)
  const [first] = await measurer.measureCameraColor({
    mediaPath: file.path,
    cameraId,
    sourceAssetId: `artifact-${name.toLowerCase()}`,
    sourceSha256: file.sha256,
    ranges: ranges ?? [wholeClip(`ccm-${cameraId}-${name.toLowerCase()}`)],
    sampleEveryMs: SAMPLE_EVERY_MS,
  })
  return first
}

async function measureAll(name, cameraId, ranges) {
  const file = files.get(name)
  return measurer.measureCameraColor({
    mediaPath: file.path,
    cameraId,
    sourceAssetId: `artifact-${name.toLowerCase()}`,
    sourceSha256: file.sha256,
    ranges,
    sampleEveryMs: SAMPLE_EVERY_MS,
  })
}

const value = (measurement, dimension) => measurement.dimensions[dimension].value
const component = (measurement, dimension, key) => measurement.dimensions[dimension].components[key]

function critique(before_, after_, overrides = {}) {
  return evaluateColorCritic({
    reportId: 'ccr-integration-1',
    workspaceId: 'workspace-color',
    projectId: 'project-color',
    projectVersionId: 'version-color',
    subject: { kind: 'output', artifactId: 'artifact-output' },
    before: before_,
    after: after_,
    creativeIntent: { declared: false },
    evaluatedAt: '2029-06-01T10:00:00.000Z',
    ...overrides,
  })
}

test('T-FR-183 real decoded frames put exposure and white balance in the right direction, monotonically', async () => {
  const a = await measure('cameraA', 'camera-a')
  const b = await measure('cameraB', 'camera-b')
  const strong = await measure('cameraBStrong', 'camera-b')

  assert.ok(value(b, 'exposure') > value(a, 'exposure'), 'the brightened camera measures brighter')
  assert.ok(
    component(b, 'whiteBalance', 'bOverG') > component(a, 'whiteBalance', 'bOverG'),
    'the blue-shifted camera measures bluer',
  )
  assert.ok(
    component(strong, 'whiteBalance', 'bOverG') > component(b, 'whiteBalance', 'bOverG'),
    'twice the blue shift measures bluer still',
  )
  assert.equal(a.sampledFrames, Math.round((SECONDS * 1_000) / SAMPLE_EVERY_MS))
  assert.equal(a.comparability.comparable, true)

  const plan = deriveMulticamMatchPlan({
    planId: 'mmp-integration-1',
    workspaceId: 'workspace-color',
    projectId: 'project-color',
    sessionId: 'session-color-1',
    sessionVersion: 1,
    referenceEpoch: 1,
    referenceCameraId: 'camera-a',
    referenceCameraSelection: {
      selectedBy: { kind: 'director', id: 'director-1' },
      selectedAt: '2029-06-01T10:00:00.000Z',
      baseVersionId: 'session-color-1:v1',
      baseHash: '7'.repeat(64),
    },
    measurements: [a, b],
    lineage: { colorProbeIds: ['probe-a', 'probe-b'] },
    createdAt: '2029-06-01T10:00:01.000Z',
  })
  const corrected = plan.cameraTransforms[0]
  const strongPlan = deriveMulticamMatchPlan({
    planId: 'mmp-integration-2',
    workspaceId: 'workspace-color',
    projectId: 'project-color',
    sessionId: 'session-color-1',
    sessionVersion: 1,
    referenceEpoch: 1,
    referenceCameraId: 'camera-a',
    referenceCameraSelection: {
      selectedBy: { kind: 'director', id: 'director-1' },
      selectedAt: '2029-06-01T10:00:00.000Z',
      baseVersionId: 'session-color-1:v1',
      baseHash: '7'.repeat(64),
    },
    measurements: [a, strong],
    lineage: { colorProbeIds: ['probe-a', 'probe-b'] },
    createdAt: '2029-06-01T10:00:01.000Z',
  })

  assert.ok(corrected.transform.implementation.parameters.brightness < 0, 'the brighter camera is darkened')
  assert.ok(corrected.transform.implementation.parameters['blue-gain'] < 1, 'the bluer camera loses blue')
  assert.ok(
    strongPlan.cameraTransforms[0].transform.implementation.parameters['blue-gain'] <
      corrected.transform.implementation.parameters['blue-gain'],
    'a stronger cast asks for a stronger correction',
  )

  console.log(`T-FR-183 exposure A=${value(a, 'exposure')} B=${value(b, 'exposure')} bOverG A=${component(a, 'whiteBalance', 'bOverG')} B=${component(b, 'whiteBalance', 'bOverG')} B2=${component(strong, 'whiteBalance', 'bOverG')} deltaEv=${corrected.deltas.exposureEv} brightness=${corrected.transform.implementation.parameters.brightness} blue-gain=${corrected.transform.implementation.parameters['blue-gain']} blue-gain2=${strongPlan.cameraTransforms[0].transform.implementation.parameters['blue-gain']} frames=${a.sampledFrames} hash=${a.measurementHash.slice(0, 16)}`)
})

test('T-FR-183 clipped and crushed halves are measured as the share of the frame they occupy', async () => {
  const clipped = await measure('clipped', 'camera-a')
  const crushed = await measure('crushed', 'camera-a')

  assert.ok(Math.abs(value(clipped, 'highlights') - 0.5) < 0.06, `highlights ${value(clipped, 'highlights')}`)
  assert.ok(value(clipped, 'blacks') < 0.06, `a white-over-grey frame crushes nothing, got ${value(clipped, 'blacks')}`)
  assert.ok(Math.abs(value(crushed, 'blacks') - 0.5) < 0.06, `blacks ${value(crushed, 'blacks')}`)
  assert.ok(value(crushed, 'highlights') < 0.06, `a black-over-grey frame clips nothing, got ${value(crushed, 'highlights')}`)

  console.log(`T-FR-183 clipped highlights=${value(clipped, 'highlights')} blacks=${value(clipped, 'blacks')} | crushed blacks=${value(crushed, 'blacks')} highlights=${value(crushed, 'highlights')} p50=${value(crushed, 'tonalResponse')}`)
})

test('T-FR-183 an HDR source fails closed instead of being measured in 8-bit RGB', async () => {
  const file = files.get('hdr')
  await assert.rejects(
    () => measurer.measureCameraColor({
      mediaPath: file.path,
      cameraId: 'camera-a',
      sourceAssetId: 'artifact-hdr',
      sourceSha256: file.sha256,
      ranges: [wholeClip('ccm-camera-a-hdr')],
      sampleEveryMs: SAMPLE_EVERY_MS,
    }),
    (error) => {
      assert.equal(error.code, 'COLOR_HDR_SDR_UNSUPPORTED', `received ${error.code}: ${error.message}`)
      assert.equal(error.details.hdrMode, 'pq')
      return true
    },
  )
  console.log(`T-FR-183 hdr refusal code=COLOR_HDR_SDR_UNSUPPORTED transfer=smpte2084 sha=${file.sha256.slice(0, 16)}`)
})

test('T-FR-184 the declaration is what separates a look from a defect', async () => {
  const before_ = [await measure('cameraA', 'camera-a')]
  const after_ = [await measure('castRed', 'camera-a')]

  const undeclared = critique(before_, after_)
  const castValue = undeclared.dimensions.find((entry) => entry.dimension === 'cast').value
  assert.ok(castValue > 0.08, `the red cast must clear the hard threshold to make the test meaningful, got ${castValue}`)
  assert.equal(undeclared.dimensions.find((entry) => entry.dimension === 'cast').classification, 'technical-defect')
  assert.notEqual(undeclared.action, 'approve')

  const declared = critique(before_, after_, {
    creativeIntent: { declared: true, castAllowedDelta: DEFAULT_COLOR_CRITIC_POLICY.maxDeclaredCastAllowance, lutId: 'lut-warm-1', note: 'warm look approved by the director' },
  })
  const declaredCast = declared.dimensions.find((entry) => entry.dimension === 'cast')
  assert.equal(declaredCast.value, castValue, 'the same bytes measured the same number')
  assert.equal(declaredCast.classification, 'documented-intent')
  assert.equal(declared.issues.filter((issue) => issue.dimension === 'cast').length, 0)
  assert.equal(declared.action, 'approve')

  console.log(`T-FR-184 cast=${castValue} undeclared=${undeclared.action}/${undeclared.cause} declared=${declared.action}/${declared.cause} confidence=${declared.confidence}`)
})

test('T-FR-184 a creative look never excuses a clipped frame', async () => {
  const before_ = [await measure('cameraA', 'camera-a')]
  const after_ = [await measure('clipped', 'camera-a')]
  const report = critique(before_, after_, {
    creativeIntent: { declared: true, castAllowedDelta: 0.2, lutId: 'lut-highkey-1', note: 'high key by design' },
  })
  const clipping = report.dimensions.find((entry) => entry.dimension === 'clipping')
  const issue = report.issues.find((entry) => entry.dimension === 'clipping')
  assert.equal(clipping.classification, 'technical-defect')
  assert.equal(issue.severity, 'hard')
  assert.equal(report.action, 'reject')
  console.log(`T-FR-184 clipping=${clipping.value} severity=${issue.severity} action=${report.action}/${report.cause} thresholds=${report.thresholds.calibrationVersion}`)
})

test('T-FR-184 a difference confined to one second is localized to that range', async () => {
  const ranges = [
    {
      sessionRange: createTickInterval(BigInt(0), BigInt(1_000)),
      sourceStartFrame: 0,
      sourceEndFrame: RATE,
      measurementId: 'ccm-range-1',
    },
    {
      sessionRange: createTickInterval(BigInt(1_000), BigInt(2_000)),
      sourceStartFrame: RATE,
      sourceEndFrame: FRAMES,
      measurementId: 'ccm-range-2',
    },
  ]
  const referenceRanges = await measureAll('cameraA', 'camera-a', ranges)
  const lateRanges = await measureAll('lateBrighter', 'camera-b', [
    { ...ranges[0], measurementId: 'ccm-range-3' },
    { ...ranges[1], measurementId: 'ccm-range-4' },
  ])
  const measurements = [...referenceRanges, ...lateRanges]

  // Both sides of the output transform read the same bytes here, so every
  // cross-stage dimension is a no-op and only the between-camera comparison
  // can move the verdict.
  const report = critique(measurements, measurements)
  const localized = report.dimensions.find((entry) => entry.dimension === 'localizedMismatch')
  assert.equal(localized.status, 'measured')
  assert.equal(localized.classification, 'localized')
  assert.equal(localized.value, 0.5, 'one of two compared ranges')
  const issues = report.issues.filter((entry) => entry.dimension === 'localizedMismatch')
  assert.equal(issues.length, 1)
  assert.equal(issues[0].range.start, 1_000n)
  assert.equal(issues[0].range.end, 2_000n)
  assert.equal(issues[0].cameraId, 'camera-b')

  console.log(`T-FR-184 localized share=${localized.value} range=[${issues[0].range.start},${issues[0].range.end}) camera=${issues[0].cameraId} exposure r1 a=${value(referenceRanges[0], 'exposure')} b=${value(lateRanges[0], 'exposure')} | r2 a=${value(referenceRanges[1], 'exposure')} b=${value(lateRanges[1], 'exposure')}`)
})

test('T-FR-184 a synthetic skin patch is measured by a controlled evaluator and is never called skin', async () => {
  const patch = await measure('skinPatch', 'camera-a')
  const skin = patch.dimensions.skin
  assert.equal(skin.status, 'measured')
  assert.equal(skin.evaluator.kind, 'controlled', 'a band mask stands in for a model that is not deployed')
  assert.equal(skin.evaluator.id, 'ycbcr-skin-band-mask')
  assert.ok(skin.components.areaRatio > 0.9, `the whole frame is inside the band, got ${skin.components.areaRatio}`)

  const report = critique([patch], [patch])
  const dimension = report.dimensions.find((entry) => entry.dimension === 'skinToneOffTarget')
  assert.equal(dimension.status, 'measured')
  const evaluator = report.evaluators.find((entry) => entry.id === 'ycbcr-skin-band-mask')
  assert.equal(evaluator.kind, 'controlled')
  assert.match(evaluator.scope, /never a perceptual judgement/)
  assert.equal(
    report.evaluators.every((entry) => entry.kind === 'measured' ? entry.id !== 'ycbcr-skin-band-mask' : true),
    true,
    'the band mask is never listed as an instrument reading',
  )

  // The same critic, on frames with no skin-band pixels, answers not-applicable.
  const grey = await measure('crushed', 'camera-a')
  const silent = critique([grey], [grey])
  const silentSkin = silent.dimensions.find((entry) => entry.dimension === 'skinToneOffTarget')
  assert.equal(silentSkin.status, 'not-applicable')
  assert.equal(silent.issues.filter((issue) => issue.dimension === 'skinToneOffTarget').length, 0)

  console.log(`T-FR-184 skin hue=${skin.value} area=${skin.components.areaRatio} meanCb=${skin.components.meanCb} meanCr=${skin.components.meanCr} evaluator=${skin.evaluator.id}/${skin.evaluator.kind} offTarget=${dimension.value} withoutSkin=${silentSkin.status}`)
})
