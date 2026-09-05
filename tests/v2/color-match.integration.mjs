import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, before } from 'node:test'
import { promisify } from 'node:util'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createColorPlan, resolveColorPlan } from '../../src/v2/domain/color-and-export.ts'
import { evaluateColorCritic } from '../../src/v2/domain/color-critic-report.ts'
import { measuredComponent, measuredValue } from '../../src/v2/domain/color-measurement.ts'
import {
  compileMatchPlanToColorPlanLayers,
  deriveMulticamMatchPlan,
  MATCH_PROVIDER_VERSIONS,
} from '../../src/v2/domain/multicam-match-plan.ts'
import { createTickInterval } from '../../src/v2/domain/session-time.ts'
import { FfmpegColorMeasurement } from '../../src/v2/infrastructure/media/ffmpeg-color-measurement.ts'
import { FfmpegColorPipelineProcessor } from '../../src/v2/infrastructure/media/ffmpeg-color-pipeline-processor.ts'

const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static')
const run = promisify(execFile)

/**
 * F4.013 end to end over real bytes.
 *
 * Two encoded cameras whose white balance genuinely differs, measured by the
 * FFmpeg statistics instrument, derived into a match plan, compiled into a
 * ColorPlan, resolved into a pipeline and rendered by the real processor. The
 * claim under test is the only one that matters: after the correction, the
 * camera's measured blue-over-green ratio moves onto the reference's.
 *
 * Two falsifications run beside it, both measured rather than argued:
 *
 * - **Order.** Applying the same correction after the creative look instead of
 *   before it leaves the camera measurably off. The canonical stage order is
 *   not a convention that could have been the other way round.
 * - **Intent.** Frames that really clip, declared with the largest creative
 *   allowance the policy accepts, are still rejected. An intent bounds a colour
 *   shift; it cannot excuse a destroyed sample.
 */

const WIDTH = 320
const HEIGHT = 180
const RATE = 30
const SECONDS = 2
const TICKS_PER_SECOND = 48_000
/** The blue attenuation camera B was shot with. */
const BLUE_ATTENUATION = 0.85
/**
 * The creative look. `curves` is a per-channel non-linear transfer, which is
 * exactly the property that makes the stage order matter: a channel gain and a
 * non-linear curve do not commute, so the same correction lands differently
 * depending on which side of the look it is applied.
 */
const LOOK = "curves=b='0/0 0.5/0.25 1/1'"

const METADATA = Object.freeze({
  colorSpace: 'rec709',
  transfer: 'bt709',
  primaries: 'bt709',
  matrix: 'bt709',
  range: 'limited',
  bitDepth: 8,
})

const BASE = `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${RATE}:duration=${SECONDS}`

let root = null
const files = new Map()
const measurer = new FfmpegColorMeasurement({ timeoutMs: 120_000 })
const processor = new FfmpegColorPipelineProcessor()

async function encode(name, filter, source = BASE) {
  return encodeWith(name, filter, ['-f', 'lavfi', '-i', source])
}

/** The same encode, but reading an already-encoded fixture instead of lavfi. */
async function encodeFrom(name, inputName, filter) {
  return encodeWith(name, filter, ['-i', files.get(inputName).path])
}

async function encodeWith(name, filter, input) {
  const path = join(root, `${name}.mp4`)
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...input,
    '-vf', `${filter},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
    path,
  ], { windowsHide: true, timeout: 120_000 })
  const sha256 = createHash('sha256').update(await readFile(path)).digest('hex')
  files.set(name, { path, sha256 })
  return files.get(name)
}

/** Two ranges, so dispersion between them is a measurement and not an assumption. */
const RANGES = Object.freeze([
  Object.freeze({
    sessionRange: createTickInterval(0n, BigInt(TICKS_PER_SECOND)),
    sourceStartFrame: 0,
    sourceEndFrame: RATE,
  }),
  Object.freeze({
    sessionRange: createTickInterval(BigInt(TICKS_PER_SECOND), BigInt(TICKS_PER_SECOND * 2)),
    sourceStartFrame: RATE,
    sourceEndFrame: RATE * 2,
  }),
])

async function measure(name, cameraId, artifactId) {
  const file = files.get(name)
  return measurer.measureCameraColor({
    mediaPath: file.path,
    cameraId,
    sourceAssetId: artifactId,
    sourceSha256: file.sha256,
    sessionId: 'session-integration',
    sampleEveryMs: 100,
    ranges: RANGES.map((range, index) => ({ ...range, measurementId: `ccm-${cameraId}-${name}-${index + 1}` })),
  })
}

const blueOverGreen = (measurement) => measuredComponent(measurement, 'whiteBalance', 'bOverG')
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length
const spread = (values) => Math.max(...values) - Math.min(...values)

function transform(id, kind, provider, parameters) {
  const sorted = Object.freeze(Object.fromEntries(Object.entries(parameters).sort(([a], [b]) => a.localeCompare(b))))
  return Object.freeze({
    id, kind, version: 'v1', enabled: false,
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

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'apollo-color-match-'))
  // Camera A is the reference. Camera B is the same scene through a lens that
  // lost blue — a real white-balance divergence, not a tag.
  await encode('cameraA', 'null')
  await encode('cameraB', `colorchannelmixer=rr=1:gg=1:bb=${BLUE_ATTENUATION}`)
  // The reference through the creative look: what a matched camera has to
  // land on once the look is applied to it too.
  await encodeFrom('referenceLook', 'cameraA', LOOK)
  // Frames that really clip, on a picture that is otherwise fine: the top half
  // is pinned to white and the bottom half is a usable mid grey. A wholly white
  // frame would prove the same rule against a fixture nobody would ship.
  await encode(
    'clipped',
    `drawbox=x=0:y=0:w=${WIDTH}:h=${HEIGHT / 2}:color=white:t=fill`,
    `color=c=gray:size=${WIDTH}x${HEIGHT}:rate=${RATE}:duration=${SECONDS}`,
  )
})

after(async () => {
  if (!root) return
  try {
    await rm(root, { recursive: true, force: true })
  } catch (error) {
    // Reported, never rethrown: a directory that would not go is not a failed
    // measurement, and turning it into one would hide the numbers above.
    console.log(`color-match.integration cleanup left ${root}: ${error.message}`)
  }
})

test('T-F4.013 a derived match moves the camera blue ratio onto the reference in real pixels', async (t) => {
  const referenceMeasurements = await measure('cameraA', 'cam-a', 'artifact-a')
  const cameraMeasurements = await measure('cameraB', 'cam-b', 'artifact-b')
  assert.equal(referenceMeasurements.length, 2)
  assert.equal(cameraMeasurements.length, 2)

  const referenceRatios = referenceMeasurements.map(blueOverGreen)
  const beforeRatios = cameraMeasurements.map(blueOverGreen)
  assert.ok(referenceRatios.every((value) => value !== null))
  assert.ok(beforeRatios.every((value) => value !== null))
  // The two cameras really differ before anything is derived.
  assert.ok(mean(beforeRatios) < mean(referenceRatios) * 0.95, `camera B is not measurably bluer-poor: ${mean(beforeRatios)} vs ${mean(referenceRatios)}`)

  const plan = deriveMulticamMatchPlan({
    planId: 'mmp-integration-1',
    workspaceId: 'workspace-integration',
    projectId: 'project-integration',
    sessionId: 'session-integration',
    sessionVersion: 1,
    referenceEpoch: 1,
    referenceCameraId: 'cam-a',
    referenceCameraSelection: {
      selectedBy: { kind: 'human', id: 'user-1' },
      selectedAt: '2029-06-01T10:00:00.000Z',
      baseVersionId: 'session-integration:v1',
      baseHash: 'a'.repeat(64),
    },
    measurements: [...referenceMeasurements, ...cameraMeasurements],
    lineage: { colorProbeIds: [] },
    createdAt: '2029-06-01T10:00:00.000Z',
  })
  assert.deepEqual(plan.cameraTransforms.map((entry) => entry.cameraId), ['cam-b'])
  const derived = plan.cameraTransforms[0]
  assert.equal(derived.transform.implementation.version, MATCH_PROVIDER_VERSIONS.v2.version,
    'a white balance the eq cannot express needs apollo-match v2')
  assert.equal(derived.rangePairs, 2, 'both range pairs contributed; one pair cannot show dispersion')

  const layers = compileMatchPlanToColorPlanLayers(plan, {
    editPlanClipsByCameraId: {
      'cam-a': [{ clipId: 'clip-1' }],
      'cam-b': [{ clipId: 'clip-2' }],
    },
  })
  const colorPlan = createColorPlan({
    schemaVersion: 'color-plan/v1',
    metadata: METADATA,
    outputMetadata: METADATA,
    global: IDENTITY_GLOBAL,
    sourceMetadata: { 'artifact-a': METADATA, 'artifact-b': METADATA },
    sources: {},
    cameras: layers.cameras,
    segments: layers.segments,
  })
  const pipeline = resolveColorPlan(colorPlan, { sourceId: 'artifact-b', cameraId: 'cam-b', segmentId: 'clip-2' })
  assert.equal(pipeline.stages[1].enabled, true)
  assert.equal(pipeline.stages[1].implementation.provider, 'apollo-match')

  const correctedPath = join(root, 'cameraB-corrected.mp4')
  const rendered = await processor.process({
    sourcePath: files.get('cameraB').path,
    outputPath: correctedPath,
    execution: { pipeline, executionHash: calculateCanonicalHash({ kind: 'integration', pipelineHash: pipeline.pipelineHash }) },
  })
  files.set('cameraBCorrected', { path: rendered.outputPath, sha256: rendered.sha256 })
  const correctedMeasurements = await measure('cameraBCorrected', 'cam-b', 'artifact-b')
  const afterRatios = correctedMeasurements.map(blueOverGreen)

  const referenceMean = mean(referenceRatios)
  const beforeError = Math.abs(mean(beforeRatios) - referenceMean) / referenceMean
  const afterError = Math.abs(mean(afterRatios) - referenceMean) / referenceMean
  console.log(`T-F4.013 bOverG N=2 reference=${referenceMean.toFixed(6)}(spread ${spread(referenceRatios).toFixed(6)}) before=${mean(beforeRatios).toFixed(6)}(spread ${spread(beforeRatios).toFixed(6)}, err ${(beforeError * 100).toFixed(2)}%) after=${mean(afterRatios).toFixed(6)}(spread ${spread(afterRatios).toFixed(6)}, err ${(afterError * 100).toFixed(2)}%) gain=${derived.transform.implementation.parameters['blue-gain']} planConfidence=${plan.confidence}`)

  assert.ok(afterError < beforeError / 2,
    `the correction did not halve the white-balance error: before ${beforeError}, after ${afterError}`)
  assert.ok(afterError < 0.05,
    `the corrected camera is still ${(afterError * 100).toFixed(2)}% from the reference blue ratio`)
  // The rendered file really carries the declared colourimetry; the processor
  // re-probed it, so this is the file that would ship.
  assert.equal(rendered.probe.color.state, 'ready')
  assert.equal(rendered.probe.color.metadata.range, 'limited')
  t.diagnostic(`corrected sha256 ${rendered.sha256.slice(0, 16)} bytes ${rendered.byteSize}`)
})

test('T-F4.013 the same correction applied after the look leaves the camera measurably off', async () => {
  // The gain under test is the derived one, not a number chosen for the test:
  // the falsification has to be about the pipeline the system would build.
  const plan = deriveMulticamMatchPlan({
    planId: 'mmp-integration-2',
    workspaceId: 'workspace-integration',
    projectId: 'project-integration',
    sessionId: 'session-integration',
    sessionVersion: 1,
    referenceEpoch: 1,
    referenceCameraId: 'cam-a',
    referenceCameraSelection: {
      selectedBy: { kind: 'human', id: 'user-1' },
      selectedAt: '2029-06-01T10:00:00.000Z',
      baseVersionId: 'session-integration:v1',
      baseHash: 'a'.repeat(64),
    },
    measurements: [
      ...(await measure('cameraA', 'cam-a', 'artifact-a')),
      ...(await measure('cameraB', 'cam-b', 'artifact-b')),
    ],
    lineage: { colorProbeIds: [] },
    createdAt: '2029-06-01T10:00:00.000Z',
  })
  const parameters = plan.cameraTransforms[0].transform.implementation.parameters
  // The exact filter the processor builds for this transform, so the two
  // orders differ in nothing but their order.
  const matchFilter = [
    `colorchannelmixer=rr=${Number(parameters['red-gain']).toFixed(6)}:gg=${Number(parameters['green-gain']).toFixed(6)}:bb=${Number(parameters['blue-gain']).toFixed(6)}`,
    `eq=brightness=${Number(parameters.brightness).toFixed(6)}:contrast=${Number(parameters.contrast).toFixed(6)}:saturation=${Number(parameters.saturation).toFixed(6)}`,
  ].join(',')
  // Both chains start from the SAME camera B file and apply the SAME match and
  // the SAME look. Only the order differs.
  await encodeFrom('correctThenLook', 'cameraB', `${matchFilter},${LOOK}`)
  await encodeFrom('lookThenCorrect', 'cameraB', `${LOOK},${matchFilter}`)

  const withLook = await measure('referenceLook', 'cam-a', 'artifact-a')
  const canonical = await measure('correctThenLook', 'cam-b', 'artifact-b')
  const swapped = await measure('lookThenCorrect', 'cam-b', 'artifact-b')

  const target = mean(withLook.map(blueOverGreen))
  const canonicalError = Math.abs(mean(canonical.map(blueOverGreen)) - target) / target
  const swappedError = Math.abs(mean(swapped.map(blueOverGreen)) - target) / target
  console.log(`T-F4.013 stage-order falsification N=2 target=${target.toFixed(6)} match-before-look=${mean(canonical.map(blueOverGreen)).toFixed(6)}(err ${(canonicalError * 100).toFixed(2)}%) match-after-look=${mean(swapped.map(blueOverGreen)).toFixed(6)}(err ${(swappedError * 100).toFixed(2)}%)`)

  assert.ok(canonicalError < 0.03, `the canonical order did not land the correction: ${canonicalError}`)
  assert.ok(swappedError > canonicalError * 3,
    `moving the match after the look changed nothing measurable (${swappedError} vs ${canonicalError}); the stage order would then be a convention rather than a requirement`)
})

test('T-F4.014 clipping declared as creative intent is still rejected on real frames', async () => {
  const before = await measure('cameraA', 'cam-a', 'artifact-a')
  const after = await measure('clipped', 'cam-a', 'artifact-clipped')
  const clippedShare = mean(after.map((measurement) => measuredValue(measurement, 'highlights')))
  assert.ok(clippedShare > 0.02, `the fixture does not actually clip: ${clippedShare}`)

  const report = evaluateColorCritic({
    reportId: 'ccr-integration-1',
    workspaceId: 'workspace-integration',
    projectId: 'project-integration',
    projectVersionId: 'version-1',
    subject: { kind: 'output', artifactId: 'artifact-clipped' },
    before,
    after,
    // The largest allowance the policy accepts, declared alongside a look.
    creativeIntent: { declared: true, castAllowedDelta: 0.25, lutId: 'lut-integration-1' },
    evaluatedAt: '2029-06-01T10:00:00.000Z',
  })
  const clipping = report.dimensions.find((dimension) => dimension.dimension === 'clipping')
  console.log(`T-F4.014 clipping falsification N=2 measuredClipping=${clippedShare.toFixed(6)} reportedClipping=${clipping.value} action=${report.action} cause=${report.cause}`)
  assert.equal(clipping.status, 'measured')
  assert.equal(report.action, 'reject')
  assert.equal(report.cause, 'irreversible-technical-defect')
  assert.ok(report.issues.some((issue) => issue.dimension === 'clipping' && issue.severity === 'hard'))
})
