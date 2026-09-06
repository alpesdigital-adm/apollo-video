import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { after, before } from 'node:test'
import { promisify } from 'node:util'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createColorPlan, resolveColorPlan } from '../../src/v2/domain/color-and-export.ts'
import {
  DEFAULT_COLOR_CRITIC_POLICY,
  evaluateColorCritic,
} from '../../src/v2/domain/color-critic-report.ts'
import { measuredComponent, measuredValue } from '../../src/v2/domain/color-measurement.ts'
import {
  compileMatchPlanToColorPlanLayers,
  deriveMulticamMatchPlan,
} from '../../src/v2/domain/multicam-match-plan.ts'
import { createTickInterval } from '../../src/v2/domain/session-time.ts'
import { FfmpegColorMeasurement } from '../../src/v2/infrastructure/media/ffmpeg-color-measurement.ts'
import { FfmpegColorPipelineProcessor } from '../../src/v2/infrastructure/media/ffmpeg-color-pipeline-processor.ts'

/**
 * The Wave 20 visual evaluations: seven inspectable artifacts, and the numbers
 * that were measured on each.
 *
 * The lane's colour suites all assert and then throw their pixels away. That
 * is enough to prove a rule and not enough to let anyone LOOK — and "the match
 * worked" is a claim a reviewer should be able to check with their own eyes
 * against the number that was printed beside it. So this suite keeps the
 * files: every render is written to a named directory with a `manifest.json`
 * recording, per artifact, its sha256, dimensions, codec, frame count,
 * duration, byte size, the metrics measured on it and the ranges those metrics
 * came from. CI points `APOLLO_COLOR_VISUAL_EVAL_OUTPUT` at the runner
 * temporary directory and uploads the result; with the variable unset the
 * whole thing lives in a `mkdtemp` removed in `after`, so nothing is ever
 * committed.
 *
 * The seven:
 *
 * 1. **two-camera-match** — a reference and a camera that lost blue, before
 *    and after the derived correction.
 * 2. **three-camera-match** — the same with a third camera that lost red, so
 *    the plan has to correct two cameras onto one reference rather than
 *    average three.
 * 3. **two-creative-luts** — the same matched camera under two DIFFERENT
 *    looks, each a real 3D LUT the renderer materialises, measured apart.
 * 4. **clipped-source** — frames that really clip, declared as creative
 *    intent, still rejected. Kept with the FULL list of hard issues the report
 *    carries and with a control — the same flat base without the white bar —
 *    so the artifact shows that the rejection is the clipping's rather than
 *    implying it.
 * 5. **preserved-creative-cast** — one file, two verdicts: the same measured
 *    cast is a `technical-defect` undeclared and `documented-intent`
 *    declared. The number does not move; the classification does.
 * 6. **localized-mismatch** — a difference confined to the second half of the
 *    clip, reported as that range and no other.
 * 7. **controlled-skin-patch** — a flat patch inside the YCbCr skin band. It
 *    is labelled `controlled` everywhere it appears, in the manifest and in
 *    the assertions, because the evaluator is a band mask and not a
 *    perceptual model. It is NEVER called real skin, and the suite asserts
 *    that the report refuses to list the mask as an instrument reading.
 *
 * Every fixture is the unhealthy one on purpose. A match measured on two
 * already-identical cameras, a "clipping" test on a frame that does not clip
 * and a skin evaluation on a mid grey all pass while proving nothing.
 */

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path
const run = promisify(execFile)

const WIDTH = 320
const HEIGHT = 180
const RATE = 30
const SECONDS = 2
const FRAMES = RATE * SECONDS
const TICKS_PER_SECOND = 48_000
const SAMPLE_EVERY_MS = 100

const METADATA = Object.freeze({
  colorSpace: 'rec709',
  transfer: 'bt709',
  primaries: 'bt709',
  matrix: 'bt709',
  range: 'limited',
  bitDepth: 8,
})

const BASE = `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${RATE}:duration=${SECONDS}`
const FLAT = `color=c=gray:size=${WIDTH}x${HEIGHT}:rate=${RATE}:duration=${SECONDS}`
/** RGB 230,180,150 lands inside the Cb/Cr band the controlled evaluator masks. */
const PATCH = `color=c=0xE6B496:size=${WIDTH}x${HEIGHT}:rate=${RATE}:duration=${SECONDS}`

/** Two ranges, so dispersion between them is measured and not assumed. */
const RANGES = Object.freeze([
  Object.freeze({
    sessionRange: createTickInterval(0n, BigInt(TICKS_PER_SECOND)),
    sourceStartFrame: 0,
    sourceEndFrame: RATE,
  }),
  Object.freeze({
    sessionRange: createTickInterval(BigInt(TICKS_PER_SECOND), BigInt(TICKS_PER_SECOND * 2)),
    sourceStartFrame: RATE,
    sourceEndFrame: FRAMES,
  }),
])

const measurer = new FfmpegColorMeasurement({ timeoutMs: 120_000 })
const processor = new FfmpegColorPipelineProcessor()

/** Every artifact this suite kept, in the order it produced them. */
const artifacts = []
/** Every evaluation's measured numbers, keyed by evaluation id. */
const evaluations = []

let root = null
let retained = false
const files = new Map()

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length
const spread = (values) => Math.max(...values) - Math.min(...values)
const blueOverGreen = (measurement) => measuredComponent(measurement, 'whiteBalance', 'bOverG')
const redOverGreen = (measurement) => measuredComponent(measurement, 'whiteBalance', 'rOverG')
const round = (value, places = 6) =>
  value === null || value === undefined ? null : Number(value.toFixed(places))

async function encodeWith(name, filter, input) {
  const path = join(root, `${name}.mp4`)
  await mkdir(join(path, '..'), { recursive: true })
  await run(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...input,
    '-vf', `${filter},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-color_range', 'tv',
    path,
  ], { windowsHide: true, timeout: 120_000 })
  const sha256 = createHash('sha256').update(await readFile(path)).digest('hex')
  files.set(name, { path, sha256 })
  return files.get(name)
}

const encode = (name, filter, source = BASE) =>
  encodeWith(name, filter, ['-f', 'lavfi', '-i', source])

/**
 * Probe an artifact and record it in the manifest.
 *
 * Nothing here is declared: width, height, codec, frame rate, frame count and
 * duration all come back from ffprobe, and the digest is taken over the bytes
 * on disk rather than from whatever wrote them.
 */
async function record({ id, evaluation, role, path, label, metrics = {}, ranges = null, note = null }) {
  const streams = JSON.parse(execFileSync(ffprobePath, [
    '-v', 'error', '-count_frames', '-show_entries',
    'stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_frames,duration',
    '-of', 'json', path,
  ], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).streams
  const video = streams.find((stream) => stream.codec_type === 'video')
  assert.ok(video, `${id} has no video stream`)
  const bytes = await readFile(path)
  const entry = Object.freeze({
    id,
    evaluation,
    role,
    label,
    file: path.slice(root.length + 1).replace(/\\/g, '/'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteSize: (await stat(path)).size,
    width: Number(video.width),
    height: Number(video.height),
    videoCodec: video.codec_name,
    frameRate: video.r_frame_rate,
    frameCount: Number(video.nb_read_frames),
    durationSeconds: Number(video.duration),
    metrics,
    ranges,
    note,
  })
  assert.equal(entry.width, WIDTH)
  assert.equal(entry.height, HEIGHT)
  assert.equal(entry.videoCodec, 'h264')
  assert.equal(entry.frameCount, FRAMES, `${id} counted ${entry.frameCount} frames`)
  artifacts.push(entry)
  return entry
}

async function measure(name, cameraId, artifactId, ranges = RANGES) {
  const file = files.get(name)
  return measurer.measureCameraColor({
    mediaPath: file.path,
    cameraId,
    sourceAssetId: artifactId,
    sourceSha256: file.sha256,
    sessionId: 'session-visual-evaluations',
    sampleEveryMs: SAMPLE_EVERY_MS,
    ranges: ranges.map((range, index) => ({
      ...range,
      measurementId: `ccm-${cameraId}-${name}-${index + 1}`,
    })),
  })
}

function transform(id, kind, provider, parameters, extra = {}) {
  const sorted = Object.freeze(
    Object.fromEntries(Object.entries(parameters).sort(([a], [b]) => a.localeCompare(b))),
  )
  return Object.freeze({
    id,
    kind,
    version: 'v1',
    enabled: false,
    input: METADATA,
    output: METADATA,
    implementation: Object.freeze({
      provider,
      version: 'v1',
      parameters: sorted,
      parametersHash: calculateCanonicalHash(sorted),
    }),
    ...extra,
  })
}

const IDENTITY_GLOBAL = Object.freeze([
  transform('technical-identity', 'technical', 'ffmpeg-zscale', { mode: 'identity' }),
  transform('match-global', 'match', 'apollo-match', { mode: 'bypass' }),
  transform('creative-none', 'creative-lut', 'apollo-lut', { mode: 'none' }),
  transform('output-identity', 'output', 'ffmpeg-zscale', { mode: 'identity' }),
])

const LUT_SIZE = 17

/** A .cube whose transfer is applied per channel. Red fastest, then green, then blue. */
function cubeText(title, transferByChannel) {
  const lines = [
    `TITLE "${title}"`,
    `LUT_3D_SIZE ${LUT_SIZE}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
    '',
  ]
  const step = 1 / (LUT_SIZE - 1)
  for (let bi = 0; bi < LUT_SIZE; bi += 1) {
    for (let gi = 0; gi < LUT_SIZE; gi += 1) {
      for (let ri = 0; ri < LUT_SIZE; ri += 1) {
        lines.push([
          transferByChannel.r(ri * step).toFixed(6),
          transferByChannel.g(gi * step).toFixed(6),
          transferByChannel.b(bi * step).toFixed(6),
        ].join(' '))
      }
    }
  }
  return `${lines.join('\n')}\n`
}

async function writeCube(name, title, transferByChannel) {
  const path = join(root, `${name}.cube`)
  const text = cubeText(title, transferByChannel)
  await writeFile(path, text, 'utf8')
  return { path, sha256: createHash('sha256').update(text).digest('hex') }
}

/** The global layer with one creative look enabled, bound to an immutable cube. */
function lookGlobal(artifactId, sha256) {
  const parameters = Object.freeze({ intensity: 1, mode: 'lut3d' })
  return Object.freeze([
    IDENTITY_GLOBAL[0],
    IDENTITY_GLOBAL[1],
    Object.freeze({
      id: `creative-${artifactId}`,
      kind: 'creative-lut',
      version: 'v1',
      enabled: true,
      input: METADATA,
      output: METADATA,
      implementation: Object.freeze({
        provider: 'apollo-lut',
        version: 'v1',
        parameters,
        parametersHash: calculateCanonicalHash(parameters),
      }),
      lut: Object.freeze({ artifactId, sha256 }),
    }),
    IDENTITY_GLOBAL[3],
  ])
}

/**
 * Derive the correction for every camera but the reference, using the real
 * plan factory over real measurements.
 */
function derivePlan(planId, referenceCameraId, measurements) {
  return deriveMulticamMatchPlan({
    planId,
    workspaceId: 'workspace-visual-evaluations',
    projectId: 'project-visual-evaluations',
    sessionId: 'session-visual-evaluations',
    sessionVersion: 1,
    referenceEpoch: 1,
    referenceCameraId,
    referenceCameraSelection: {
      selectedBy: { kind: 'human', id: 'operator-1' },
      selectedAt: '2029-06-01T10:00:00.000Z',
      baseVersionId: 'session-visual-evaluations:v1',
      baseHash: 'a'.repeat(64),
    },
    measurements,
    lineage: { colorProbeIds: [] },
    createdAt: '2029-06-01T10:00:00.000Z',
  })
}

/** Resolve one camera's pipeline out of a plan and run the real processor over it. */
async function correct({ plan, global: globalLayer, cameraId, artifactId, sourceName, outputName, lutPaths = {} }) {
  const cameraIds = [plan.referenceCameraId, ...plan.cameraTransforms.map((entry) => entry.cameraId)]
  const layers = compileMatchPlanToColorPlanLayers(plan, {
    editPlanClipsByCameraId: Object.fromEntries(
      cameraIds.map((id, index) => [id, [{ clipId: `clip-${index + 1}` }]]),
    ),
  })
  const colorPlan = createColorPlan({
    schemaVersion: 'color-plan/v1',
    metadata: METADATA,
    outputMetadata: METADATA,
    global: globalLayer,
    sourceMetadata: Object.fromEntries(
      cameraIds.map((id) => [`artifact-${id}`, METADATA]),
    ),
    sources: {},
    cameras: layers.cameras,
    segments: layers.segments,
  })
  const segmentId = `clip-${cameraIds.indexOf(cameraId) + 1}`
  const pipeline = resolveColorPlan(colorPlan, { sourceId: artifactId, cameraId, segmentId })
  const outputPath = join(root, `${outputName}.mp4`)
  await mkdir(join(outputPath, '..'), { recursive: true })
  const rendered = await processor.process({
    sourcePath: files.get(sourceName).path,
    outputPath,
    execution: {
      pipeline,
      executionHash: calculateCanonicalHash({
        kind: 'visual-evaluation',
        pipelineHash: pipeline.pipelineHash,
      }),
    },
    lutPaths,
  })
  files.set(outputName, { path: rendered.outputPath, sha256: rendered.sha256 })
  return { rendered, pipeline }
}

function critique(before_, after_, overrides = {}) {
  return evaluateColorCritic({
    reportId: `ccr-visual-${randomUUID().slice(0, 8)}`,
    workspaceId: 'workspace-visual-evaluations',
    projectId: 'project-visual-evaluations',
    projectVersionId: 'version-visual-evaluations',
    subject: { kind: 'output', artifactId: 'artifact-output' },
    before: before_,
    after: after_,
    creativeIntent: { declared: false },
    evaluatedAt: '2029-06-01T10:00:00.000Z',
    ...overrides,
  })
}

before(async () => {
  const requested = process.env.APOLLO_COLOR_VISUAL_EVAL_OUTPUT?.trim()
  retained = Boolean(requested)
  root = requested
    ? join(resolve(requested), `color-visual-${Date.now()}-${randomUUID().slice(0, 8)}`)
    : await mkdtemp(join(tmpdir(), 'apollo-color-visual-'))
  await mkdir(root, { recursive: true })

  // Camera A is the reference. B lost blue, C lost red — two different
  // divergences, so a plan that corrected "the cameras" as a group instead of
  // each onto the reference would show up.
  await encode('reference', 'null')
  await encode('camera-b-before', 'colorchannelmixer=rr=1:gg=1:bb=0.85')
  await encode('camera-c-before', 'colorchannelmixer=rr=0.80:gg=1:bb=1')
  // Frames that really clip on a picture that is otherwise usable: a wholly
  // white frame would prove the rule against a fixture nobody would ship.
  await encode(
    'clipped',
    `drawbox=x=0:y=0:w=${WIDTH}:h=${HEIGHT / 2}:color=white:t=fill`,
    FLAT,
  )
  await encode('cast-red', 'colorbalance=rs=0.3:rm=0.3:rh=0.3')
  await encode('late-brighter', "eq=brightness=0.2:enable='between(t,1,2)'")
  await encode('skin-patch-controlled', 'null', PATCH)
  await encode(
    'crushed',
    `drawbox=x=0:y=0:w=${WIDTH}:h=${HEIGHT / 2}:color=black:t=fill`,
    FLAT,
  )
  // The same flat base WITHOUT the white bar. It is the control for the
  // clipping evaluation: everything else about the comparison is identical, so
  // the difference between the two verdicts is the clipping and nothing else.
  await encode('flat-unclipped', 'null', FLAT)
})

after(async () => {
  if (!root) return
  const manifest = {
    schemaVersion: 'color-visual-evaluations/v1',
    generator: 'tests/v2/color-visual-evaluations.integration.mjs',
    generatedAt: new Date().toISOString(),
    fixture: { width: WIDTH, height: HEIGHT, frameRate: RATE, seconds: SECONDS, frames: FRAMES },
    evaluations,
    artifacts,
  }
  try {
    await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    if (retained) console.log(`visual evaluations kept ${artifacts.length} artifacts in ${root}`)
  } catch (error) {
    console.log(`visual evaluation manifest was not written: ${error.message}`)
  }
  if (retained) return
  try {
    await rm(root, { recursive: true, force: true })
  } catch (error) {
    // Reported, never rethrown: a directory that would not go is not a failed
    // measurement, and turning it into one would hide the numbers above.
    console.log(`color-visual-evaluations cleanup left ${root}: ${error.message}`)
  }
})

test('T-F4.013 two cameras, before and after the match', async () => {
  const reference = await measure('reference', 'cam-a', 'artifact-cam-a')
  const before_ = await measure('camera-b-before', 'cam-b', 'artifact-cam-b')
  const referenceRatios = reference.map(blueOverGreen)
  const beforeRatios = before_.map(blueOverGreen)
  assert.ok(
    mean(beforeRatios) < mean(referenceRatios) * 0.95,
    `camera B is not measurably bluer-poor: ${mean(beforeRatios)} vs ${mean(referenceRatios)}`,
  )

  const plan = derivePlan('mmp-visual-two', 'cam-a', [...reference, ...before_])
  assert.deepEqual(plan.cameraTransforms.map((entry) => entry.cameraId), ['cam-b'])
  await correct({
    plan,
    global: IDENTITY_GLOBAL,
    cameraId: 'cam-b',
    artifactId: 'artifact-cam-b',
    sourceName: 'camera-b-before',
    outputName: 'camera-b-after',
  })
  const after_ = await measure('camera-b-after', 'cam-b', 'artifact-cam-b')
  const afterRatios = after_.map(blueOverGreen)

  const target = mean(referenceRatios)
  const beforeError = Math.abs(mean(beforeRatios) - target) / target
  const afterError = Math.abs(mean(afterRatios) - target) / target
  assert.ok(afterError < beforeError / 2, `the correction did not halve the error: ${beforeError} -> ${afterError}`)
  assert.ok(afterError < 0.05, `camera B is still ${(afterError * 100).toFixed(2)}% off the reference`)

  const rangeSummary = RANGES.map((range) => ({
    startTicks: String(range.sessionRange.start),
    endTicks: String(range.sessionRange.end),
    sourceStartFrame: range.sourceStartFrame,
    sourceEndFrame: range.sourceEndFrame,
  }))
  await record({
    id: 'two-camera/reference', evaluation: 'two-camera-match', role: 'reference',
    path: files.get('reference').path, label: 'camera A, the reference',
    metrics: { bOverGMean: round(target), bOverGSpread: round(spread(referenceRatios)) },
    ranges: rangeSummary,
  })
  await record({
    id: 'two-camera/camera-b-before', evaluation: 'two-camera-match', role: 'before',
    path: files.get('camera-b-before').path, label: 'camera B as shot, blue attenuated to 0.85',
    metrics: {
      bOverGMean: round(mean(beforeRatios)),
      bOverGSpread: round(spread(beforeRatios)),
      errorAgainstReference: round(beforeError),
    },
    ranges: rangeSummary,
  })
  await record({
    id: 'two-camera/camera-b-after', evaluation: 'two-camera-match', role: 'after',
    path: files.get('camera-b-after').path, label: 'camera B after the derived match-stage correction',
    metrics: {
      bOverGMean: round(mean(afterRatios)),
      bOverGSpread: round(spread(afterRatios)),
      errorAgainstReference: round(afterError),
      blueGain: plan.cameraTransforms[0].transform.implementation.parameters['blue-gain'] ?? null,
      rangePairs: plan.cameraTransforms[0].rangePairs,
      planConfidence: plan.confidence,
    },
    ranges: rangeSummary,
  })
  evaluations.push({
    id: 'two-camera-match',
    metric: 'whiteBalance.bOverG',
    n: RANGES.length,
    referenceMean: round(target),
    beforeMean: round(mean(beforeRatios)),
    afterMean: round(mean(afterRatios)),
    acceptedRange: { errorAgainstReference: { max: 0.05 }, improvement: { minFactor: 2 } },
  })
  console.log(
    `T-F4.013 two-camera N=${RANGES.length} bOverG reference=${target.toFixed(6)} `
    + `before=${mean(beforeRatios).toFixed(6)} (err ${(beforeError * 100).toFixed(2)}%) `
    + `after=${mean(afterRatios).toFixed(6)} (err ${(afterError * 100).toFixed(2)}%) `
    + `gain=${plan.cameraTransforms[0].transform.implementation.parameters['blue-gain']} confidence=${plan.confidence}`,
  )
})

test('T-F4.013 three cameras, before and after the match', async () => {
  const reference = await measure('reference', 'cam-a', 'artifact-cam-a')
  const beforeB = await measure('camera-b-before', 'cam-b', 'artifact-cam-b')
  const beforeC = await measure('camera-c-before', 'cam-c', 'artifact-cam-c')
  const plan = derivePlan('mmp-visual-three', 'cam-a', [...reference, ...beforeB, ...beforeC])
  assert.deepEqual(
    plan.cameraTransforms.map((entry) => entry.cameraId).slice().sort(),
    ['cam-b', 'cam-c'],
    'the plan must correct both non-reference cameras',
  )

  for (const [cameraId, sourceName, outputName] of [
    ['cam-b', 'camera-b-before', 'three-camera-b-after'],
    ['cam-c', 'camera-c-before', 'three-camera-c-after'],
  ]) {
    await correct({
      plan,
      global: IDENTITY_GLOBAL,
      cameraId,
      artifactId: `artifact-${cameraId}`,
      sourceName,
      outputName,
    })
  }
  const afterB = await measure('three-camera-b-after', 'cam-b', 'artifact-cam-b')
  const afterC = await measure('three-camera-c-after', 'cam-c', 'artifact-cam-c')

  const blueTarget = mean(reference.map(blueOverGreen))
  const redTarget = mean(reference.map(redOverGreen))
  const errors = {
    blueBefore: Math.abs(mean(beforeB.map(blueOverGreen)) - blueTarget) / blueTarget,
    blueAfter: Math.abs(mean(afterB.map(blueOverGreen)) - blueTarget) / blueTarget,
    redBefore: Math.abs(mean(beforeC.map(redOverGreen)) - redTarget) / redTarget,
    redAfter: Math.abs(mean(afterC.map(redOverGreen)) - redTarget) / redTarget,
  }
  assert.ok(errors.blueAfter < errors.blueBefore / 2, `camera B: ${errors.blueBefore} -> ${errors.blueAfter}`)
  assert.ok(errors.redAfter < errors.redBefore / 2, `camera C: ${errors.redBefore} -> ${errors.redAfter}`)

  const rangeSummary = RANGES.map((range) => ({
    startTicks: String(range.sessionRange.start),
    endTicks: String(range.sessionRange.end),
  }))
  await record({
    id: 'three-camera/camera-c-before', evaluation: 'three-camera-match', role: 'before',
    path: files.get('camera-c-before').path, label: 'camera C as shot, red attenuated to 0.80',
    metrics: {
      rOverGMean: round(mean(beforeC.map(redOverGreen))),
      errorAgainstReference: round(errors.redBefore),
    },
    ranges: rangeSummary,
  })
  await record({
    id: 'three-camera/camera-b-after', evaluation: 'three-camera-match', role: 'after',
    path: files.get('three-camera-b-after').path, label: 'camera B corrected in the three-camera plan',
    metrics: {
      bOverGMean: round(mean(afterB.map(blueOverGreen))),
      errorAgainstReference: round(errors.blueAfter),
    },
    ranges: rangeSummary,
  })
  await record({
    id: 'three-camera/camera-c-after', evaluation: 'three-camera-match', role: 'after',
    path: files.get('three-camera-c-after').path, label: 'camera C corrected in the three-camera plan',
    metrics: {
      rOverGMean: round(mean(afterC.map(redOverGreen))),
      errorAgainstReference: round(errors.redAfter),
    },
    ranges: rangeSummary,
  })
  evaluations.push({
    id: 'three-camera-match',
    metric: 'whiteBalance.bOverG and whiteBalance.rOverG',
    n: RANGES.length,
    referenceBOverG: round(blueTarget),
    referenceROverG: round(redTarget),
    errors: Object.fromEntries(Object.entries(errors).map(([key, value]) => [key, round(value)])),
    acceptedRange: { errorAgainstReference: { max: 0.05 }, improvement: { minFactor: 2 } },
    correctedCameras: plan.cameraTransforms.map((entry) => entry.cameraId),
  })
  console.log(
    `T-F4.013 three-camera N=${RANGES.length} blue err ${(errors.blueBefore * 100).toFixed(2)}% -> `
    + `${(errors.blueAfter * 100).toFixed(2)}%, red err ${(errors.redBefore * 100).toFixed(2)}% -> `
    + `${(errors.redAfter * 100).toFixed(2)}%, confidence=${plan.confidence}`,
  )
})

test('T-F4.013 the same matched camera under two different creative LUTs', async () => {
  const reference = await measure('reference', 'cam-a', 'artifact-cam-a')
  const before_ = await measure('camera-b-before', 'cam-b', 'artifact-cam-b')
  const plan = derivePlan('mmp-visual-luts', 'cam-a', [...reference, ...before_])

  // Two looks that bend different channels, so "the look changed" is a
  // measurement on two axes rather than one number moving twice.
  const cool = await writeCube('lut-cool', 'apollo visual evaluation cool', {
    r: (value) => value ** 2.2,
    g: (value) => value,
    b: (value) => value ** 0.35,
  })
  const warm = await writeCube('lut-warm', 'apollo visual evaluation warm', {
    r: (value) => value ** 0.35,
    g: (value) => value,
    b: (value) => value ** 2.2,
  })

  const looks = []
  for (const [name, lut, outputName] of [
    ['cool', cool, 'lut-cool-after'],
    ['warm', warm, 'lut-warm-after'],
  ]) {
    const artifactId = `lut-${name}`
    const { pipeline } = await correct({
      plan,
      global: lookGlobal(artifactId, lut.sha256),
      cameraId: 'cam-b',
      artifactId: 'artifact-cam-b',
      sourceName: 'camera-b-before',
      outputName,
      lutPaths: { [artifactId]: lut.path },
    })
    // The look really is enabled after the match, in the chain the product
    // builds. A disabled stage cannot move a pixel, so two identical files
    // would prove nothing at all.
    assert.equal(pipeline.stages[1].enabled, true, 'the match stage must be the derived correction')
    assert.equal(pipeline.stages[2].enabled, true, 'the creative LUT stage must really be enabled')
    assert.equal(pipeline.stages[2].kind, 'creative-lut')
    const measured = await measure(outputName, 'cam-b', 'artifact-cam-b')
    looks.push({
      name,
      lutSha256: lut.sha256,
      outputName,
      bOverG: mean(measured.map(blueOverGreen)),
      rOverG: mean(measured.map(redOverGreen)),
      exposure: mean(measured.map((entry) => measuredValue(entry, 'exposure'))),
    })
  }

  const [coolLook, warmLook] = looks
  assert.notEqual(files.get('lut-cool-after').sha256, files.get('lut-warm-after').sha256)
  // Measured separation through the product's own chain on this fixture: 8.3%
  // on blue, 12.4% on red (N=2 ranges). Smaller than the same two cubes
  // applied by a bare `lut3d` link, because a power law fixes 0 and 1 and
  // testsrc2 is mostly saturated bars — only the mid-tones move. The
  // thresholds sit below the measured values with margin, so the assertion
  // fails when a look stops being applied rather than when an encoder moves a
  // least significant bit.
  assert.ok(
    Math.abs(coolLook.bOverG - warmLook.bOverG) / coolLook.bOverG > 0.05,
    `the two looks are not measurably apart on blue: ${coolLook.bOverG} vs ${warmLook.bOverG}`,
  )
  assert.ok(
    Math.abs(coolLook.rOverG - warmLook.rOverG) / coolLook.rOverG > 0.08,
    `the two looks are not measurably apart on red: ${coolLook.rOverG} vs ${warmLook.rOverG}`,
  )

  for (const look of looks) {
    await record({
      id: `creative-luts/${look.name}`, evaluation: 'two-creative-luts', role: 'after',
      path: files.get(look.outputName).path,
      label: `camera B matched, then graded through the ${look.name} 3D LUT`,
      metrics: {
        lutSha256: look.lutSha256,
        bOverGMean: round(look.bOverG),
        rOverGMean: round(look.rOverG),
        exposureMean: round(look.exposure),
      },
      note: 'the match stage resolves before the creative LUT; the pipeline order is the product\'s own',
    })
  }
  evaluations.push({
    id: 'two-creative-luts',
    metric: 'whiteBalance.bOverG, whiteBalance.rOverG, exposure',
    n: RANGES.length,
    cool: { bOverG: round(coolLook.bOverG), rOverG: round(coolLook.rOverG), exposure: round(coolLook.exposure) },
    warm: { bOverG: round(warmLook.bOverG), rOverG: round(warmLook.rOverG), exposure: round(warmLook.exposure) },
    acceptedRange: { relativeSeparation: { bOverG: { min: 0.05 }, rOverG: { min: 0.08 } } },
  })
  console.log(
    `T-F4.013 two-LUTs cool bOverG=${coolLook.bOverG.toFixed(6)} rOverG=${coolLook.rOverG.toFixed(6)} `
    + `| warm bOverG=${warmLook.bOverG.toFixed(6)} rOverG=${warmLook.rOverG.toFixed(6)} `
    + `| bsep ${(Math.abs(coolLook.bOverG - warmLook.bOverG) / coolLook.bOverG).toFixed(4)} `
    + `rsep ${(Math.abs(coolLook.rOverG - warmLook.rOverG) / coolLook.rOverG).toFixed(4)} `
    + `| sha ${files.get('lut-cool-after').sha256.slice(0, 12)} vs ${files.get('lut-warm-after').sha256.slice(0, 12)}`,
  )
})

test('T-F4.014 a clipped source is rejected even when the clipping is declared as the look', async () => {
  const before_ = await measure('reference', 'cam-a', 'artifact-cam-a')
  const after_ = await measure('clipped', 'cam-a', 'artifact-clipped')
  const report = critique(before_, after_, {
    creativeIntent: {
      declared: true,
      castAllowedDelta: DEFAULT_COLOR_CRITIC_POLICY.maxDeclaredCastAllowance,
      lutId: 'lut-highkey-1',
      note: 'high key by design',
    },
  })
  const clipping = report.dimensions.find((entry) => entry.dimension === 'clipping')
  const issue = report.issues.find((entry) => entry.dimension === 'clipping')
  assert.equal(clipping.classification, 'technical-defect')
  assert.equal(issue.severity, 'hard')
  assert.equal(report.action, 'reject')

  // Every hard issue this report carries, not only the one the test is named
  // after. A reader of the manifest who sees `reject` next to a note about
  // clipping is entitled to know that three other dimensions were vetoing
  // too — the fixture is a flat grey with half the frame pinned to white, so
  // its saturation and its match against testsrc2 are both wrong on purpose.
  // Recording only the interesting one is how an artifact starts to argue.
  const hardDimensions = report.issues
    .filter((entry) => entry.severity === 'hard')
    .map((entry) => entry.dimension)
  assert.deepEqual(
    hardDimensions,
    ['clipping', 'saturationDeficit', 'matchRegression', 'matchRegression'],
    `the clipped report's hard issues moved: ${
      report.issues.map((entry) => `${entry.dimension}/${entry.severity}`).join(', ')}`,
  )

  // The control: the same flat grey, the same declared intent, the same
  // comparison against the same reference — WITHOUT the white bar. It still
  // fails, because a flat grey is not a match for testsrc2, but it fails
  // differently. That difference is the clipping, and it is what makes the
  // attribution above defensible rather than asserted.
  const control_ = await measure('flat-unclipped', 'cam-a', 'artifact-flat-unclipped')
  const controlReport = critique(before_, control_, {
    creativeIntent: {
      declared: true,
      castAllowedDelta: DEFAULT_COLOR_CRITIC_POLICY.maxDeclaredCastAllowance,
      lutId: 'lut-highkey-1',
      note: 'high key by design',
    },
  })
  const controlClipping = controlReport.dimensions.find((entry) => entry.dimension === 'clipping')
  assert.equal(controlClipping.value, 0, 'the control fixture clips')
  assert.equal(
    controlReport.issues.filter((entry) => entry.dimension === 'clipping').length,
    0,
    'the control raised a clipping issue with nothing clipped',
  )
  assert.equal(controlReport.action, 'human-review')
  assert.notEqual(
    controlReport.action,
    report.action,
    'the white bar changed nothing about the verdict, so the rejection is not the clipping\'s',
  )

  const highlights = mean(after_.map((entry) => measuredValue(entry, 'highlights')))
  await record({
    id: 'clipping/clipped', evaluation: 'clipped-source', role: 'after',
    path: files.get('clipped').path,
    label: 'top half pinned to white on an otherwise usable mid grey',
    metrics: {
      highlightsShare: round(highlights),
      clippingValue: round(clipping.value),
      classification: clipping.classification,
      issueSeverity: issue.severity,
      action: report.action,
      cause: report.cause,
      declaredHardIssueDimensions: hardDimensions,
      controlAction: controlReport.action,
      controlCause: controlReport.cause,
      controlClippingValue: round(controlClipping.value),
      calibrationVersion: report.thresholds.calibrationVersion,
    },
    note: 'declared as creative intent and refused anyway: an intent bounds a colour shift, it cannot excuse a destroyed sample. '
      + 'The report carries four hard issues, listed above; the same fixture WITHOUT the white bar '
      + `answers ${controlReport.action}/${controlReport.cause}, which is what makes the rejection the clipping's`,
  })
  await record({
    id: 'clipping/flat-unclipped', evaluation: 'clipped-source', role: 'control',
    path: files.get('flat-unclipped').path,
    label: 'the same flat mid grey with nothing pinned to white',
    metrics: {
      clippingValue: round(controlClipping.value),
      classification: controlClipping.classification,
      action: controlReport.action,
      cause: controlReport.cause,
      hardIssueDimensions: controlReport.issues
        .filter((entry) => entry.severity === 'hard')
        .map((entry) => entry.dimension),
      calibrationVersion: controlReport.thresholds.calibrationVersion,
    },
    note: 'the control for the clipping evaluation: same base, same declared intent, no clipping',
  })
  evaluations.push({
    id: 'clipped-source',
    metric: 'clipping',
    n: 1,
    value: round(clipping.value),
    controlValue: round(controlClipping.value),
    hardIssueDimensions: hardDimensions,
    controlHardIssueDimensions: controlReport.issues
      .filter((entry) => entry.severity === 'hard')
      .map((entry) => entry.dimension),
    acceptedRange: { verdict: 'reject', severity: 'hard', control: { verdict: 'human-review' } },
  })
  console.log(
    `T-F4.014 clipping value=${clipping.value} highlights=${highlights.toFixed(6)} `
    + `severity=${issue.severity} action=${report.action}/${report.cause} `
    + `hard=[${hardDimensions.join(', ')}] `
    + `| control value=${controlClipping.value} action=${controlReport.action}/${controlReport.cause}`,
  )
})

test('T-F4.014 a declared creative cast is preserved; the same cast undeclared is a defect', async () => {
  const before_ = await measure('reference', 'cam-a', 'artifact-cam-a')
  const after_ = await measure('cast-red', 'cam-a', 'artifact-cast-red')
  const undeclared = critique(before_, after_)
  const cast = undeclared.dimensions.find((entry) => entry.dimension === 'cast')
  assert.ok(cast.value > 0.08, `the cast must clear the hard threshold to mean anything, got ${cast.value}`)
  assert.equal(cast.classification, 'technical-defect')
  assert.notEqual(undeclared.action, 'approve')

  const declared = critique(before_, after_, {
    creativeIntent: {
      declared: true,
      castAllowedDelta: DEFAULT_COLOR_CRITIC_POLICY.maxDeclaredCastAllowance,
      lutId: 'lut-warm-1',
      note: 'warm look approved by the director',
    },
  })
  const declaredCast = declared.dimensions.find((entry) => entry.dimension === 'cast')
  assert.equal(declaredCast.value, cast.value, 'the same bytes must measure the same number')
  assert.equal(declaredCast.classification, 'documented-intent')
  assert.equal(
    declared.issues.filter((issue) => issue.dimension === 'cast').length,
    0,
    'a declared cast inside the allowance must raise no cast issue',
  )

  // The declared report still REJECTS, and the reason is worth writing down
  // rather than tuning away. The red cast pushes this fixture's pixels into
  // the YCbCr band the CONTROLLED skin evaluator masks, so `skinToneOffTarget`
  // — a band mask standing in for a perceptual model nobody deployed — raises
  // the hard issue that decides the verdict. The cast itself was preserved;
  // the delivery is refused by a stand-in. Asserted, not hidden, because a
  // controlled evaluator holding a hard veto is a product decision somebody
  // should make on purpose.
  const declaredHard = declared.issues.filter((issue) => issue.severity === 'hard')
  assert.deepEqual(
    declaredHard.map((issue) => issue.dimension),
    ['skinToneOffTarget'],
    `the declared report kept other hard issues: ${
      declared.issues.map((issue) => `${issue.dimension}/${issue.severity}`).join(', ')}`,
  )
  assert.equal(
    declared.dimensions.find((entry) => entry.dimension === 'skinToneOffTarget').classification,
    'technical-defect',
  )

  await record({
    id: 'creative-cast/cast-red', evaluation: 'preserved-creative-cast', role: 'after',
    path: files.get('cast-red').path,
    label: 'a red cast across shadows, midtones and highlights',
    metrics: {
      castValue: round(cast.value),
      undeclaredClassification: cast.classification,
      undeclaredAction: undeclared.action,
      undeclaredCause: undeclared.cause,
      declaredClassification: declaredCast.classification,
      declaredCastIssues: declared.issues.filter((issue) => issue.dimension === 'cast').length,
      declaredAction: declared.action,
      declaredCause: declared.cause,
      declaredHardIssueDimensions: declaredHard.map((issue) => issue.dimension),
      declaredConfidence: declared.confidence,
      castAllowedDelta: DEFAULT_COLOR_CRITIC_POLICY.maxDeclaredCastAllowance,
    },
    note: 'the declaration moves the cast CLASSIFICATION and never the measurement; the delivery is still refused, by the controlled skin-band evaluator rather than by the cast',
  })
  evaluations.push({
    id: 'preserved-creative-cast',
    metric: 'cast',
    n: 1,
    value: round(cast.value),
    acceptedRange: {
      undeclared: 'technical-defect, not approved',
      declared: `documented-intent within ${DEFAULT_COLOR_CRITIC_POLICY.maxDeclaredCastAllowance}, zero cast issues`,
      remainingHardIssues: ['skinToneOffTarget (controlled evaluator)'],
    },
  })
  console.log(
    `T-F4.014 cast=${cast.value} undeclared=${undeclared.action}/${undeclared.cause} `
    + `declared=${declared.action}/${declared.cause} classification=${declaredCast.classification} `
    + `castIssuesWhenDeclared=0 remainingHard=[${declaredHard.map((issue) => issue.dimension).join(',')}]`,
  )
})

test('T-F4.014 a mismatch confined to one second is reported as that range and no other', async () => {
  const ranges = [
    {
      sessionRange: createTickInterval(0n, 1_000n),
      sourceStartFrame: 0,
      sourceEndFrame: RATE,
    },
    {
      sessionRange: createTickInterval(1_000n, 2_000n),
      sourceStartFrame: RATE,
      sourceEndFrame: FRAMES,
    },
  ]
  const referenceRanges = await measure('reference', 'cam-a', 'artifact-cam-a', ranges)
  const lateRanges = await measure('late-brighter', 'cam-b', 'artifact-late', ranges)
  const measurements = [...referenceRanges, ...lateRanges]
  const matchPlan = derivePlan('mmp-visual-localized', 'cam-a', measurements)
  // Both sides of the output transform read the same bytes, so every
  // cross-stage dimension is a no-op and only the between-camera comparison
  // can move the verdict.
  const report = critique(measurements, measurements, { matchPlan })
  const localized = report.dimensions.find((entry) => entry.dimension === 'localizedMismatch')
  assert.equal(localized.status, 'measured')
  assert.equal(localized.classification, 'localized')
  assert.equal(localized.value, 0.5, 'one of two compared ranges')
  const issues = report.issues.filter((entry) => entry.dimension === 'localizedMismatch')
  assert.equal(issues.length, 1)
  assert.equal(issues[0].range.start, 1_000n)
  assert.equal(issues[0].range.end, 2_000n)
  assert.equal(issues[0].cameraId, 'cam-b')

  await record({
    id: 'localized/late-brighter', evaluation: 'localized-mismatch', role: 'after',
    path: files.get('late-brighter').path,
    label: 'camera B, brightened only between t=1s and t=2s',
    metrics: {
      localizedShare: localized.value,
      offendingCameraId: issues[0].cameraId,
      exposureFirstRangeReference: round(measuredValue(referenceRanges[0], 'exposure')),
      exposureFirstRangeCamera: round(measuredValue(lateRanges[0], 'exposure')),
      exposureSecondRangeReference: round(measuredValue(referenceRanges[1], 'exposure')),
      exposureSecondRangeCamera: round(measuredValue(lateRanges[1], 'exposure')),
    },
    ranges: [
      { startTicks: '0', endTicks: '1000', mismatch: false },
      { startTicks: String(issues[0].range.start), endTicks: String(issues[0].range.end), mismatch: true },
    ],
  })
  evaluations.push({
    id: 'localized-mismatch',
    metric: 'localizedMismatch',
    n: 2,
    value: localized.value,
    acceptedRange: { share: 0.5, range: { startTicks: '1000', endTicks: '2000' } },
  })
  console.log(
    `T-F4.014 localized share=${localized.value} range=[${issues[0].range.start},${issues[0].range.end}) `
    + `camera=${issues[0].cameraId}`,
  )
})

test('T-F4.014 a CONTROLLED skin patch is measured by a band mask and is never called real skin', async () => {
  const patch = await measure('skin-patch-controlled', 'cam-a', 'artifact-skin-patch')
  const skin = patch[0].dimensions.skin
  assert.equal(skin.status, 'measured')
  assert.equal(
    skin.evaluator.kind,
    'controlled',
    'the evaluator is a band mask standing in for a model that is not deployed',
  )
  assert.equal(skin.evaluator.id, 'ycbcr-skin-band-mask')
  assert.ok(skin.components.areaRatio > 0.9, `the whole patch is inside the band, got ${skin.components.areaRatio}`)

  const report = critique(patch, patch)
  const dimension = report.dimensions.find((entry) => entry.dimension === 'skinToneOffTarget')
  assert.equal(dimension.status, 'measured')
  const evaluator = report.evaluators.find((entry) => entry.id === 'ycbcr-skin-band-mask')
  assert.equal(evaluator.kind, 'controlled')
  assert.match(evaluator.scope, /never a perceptual judgement/)
  assert.ok(
    report.evaluators.every((entry) => entry.kind !== 'measured' || entry.id !== 'ycbcr-skin-band-mask'),
    'the band mask must never be listed as an instrument reading',
  )

  // The same critic on frames with no band pixels answers not-applicable
  // rather than zero: "no skin found" is not "skin found and perfect".
  const grey = await measure('crushed', 'cam-a', 'artifact-crushed')
  const silent = critique(grey, grey)
  const silentSkin = silent.dimensions.find((entry) => entry.dimension === 'skinToneOffTarget')
  assert.equal(silentSkin.status, 'not-applicable')
  assert.equal(silent.issues.filter((issue) => issue.dimension === 'skinToneOffTarget').length, 0)

  await record({
    id: 'skin/controlled-patch', evaluation: 'controlled-skin-patch', role: 'controlled-patch',
    path: files.get('skin-patch-controlled').path,
    label: 'CONTROLLED patch: a flat RGB 230,180,150 field inside the YCbCr band. Not real skin.',
    metrics: {
      evaluatorId: skin.evaluator.id,
      evaluatorKind: skin.evaluator.kind,
      hue: round(skin.value),
      areaRatio: round(skin.components.areaRatio),
      meanCb: round(skin.components.meanCb),
      meanCr: round(skin.components.meanCr),
      offTarget: round(dimension.value),
    },
    note: 'a controlled stand-in for a perceptual model that is not deployed; it is never evidence about a person',
  })
  await record({
    id: 'skin/no-band-pixels', evaluation: 'controlled-skin-patch', role: 'control',
    path: files.get('crushed').path,
    label: 'a frame with no band pixels at all',
    metrics: { skinToneOffTargetStatus: silentSkin.status, issues: 0 },
    note: 'not-applicable, never 0.000: an absence reported as a number reads as a perfect measurement',
  })
  evaluations.push({
    id: 'controlled-skin-patch',
    metric: 'skinToneOffTarget (controlled evaluator ycbcr-skin-band-mask)',
    n: 1,
    value: round(dimension.value),
    acceptedRange: {
      areaRatio: { min: 0.9 },
      evaluatorKind: 'controlled',
      withoutBandPixels: 'not-applicable',
    },
  })
  console.log(
    `T-F4.014 controlled skin patch hue=${skin.value} area=${skin.components.areaRatio} `
    + `meanCb=${skin.components.meanCb} meanCr=${skin.components.meanCr} `
    + `evaluator=${skin.evaluator.id}/${skin.evaluator.kind} offTarget=${dimension.value} `
    + `withoutBandPixels=${silentSkin.status}`,
  )
})
