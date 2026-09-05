import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createMediaColorProbe } from '../../src/v2/domain/color-and-export.ts'
import { createColorPipelineCompilation } from '../../src/v2/domain/color-pipeline-compilation.ts'
import { compileShotsToSourceRanges, directMulticam } from '../../src/v2/domain/multicam-direction.ts'
import { createMulticamEvidenceSet } from '../../src/v2/domain/multicam-evidence.ts'
import { createTickInterval, rational } from '../../src/v2/domain/session-time.ts'
import { FfmpegEditorialProxyRenderer } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'
import { buildDirectableMulticamWorld, fixtureInstant as at, fixtureSeconds as sec } from './wave20-fixtures.mjs'

/**
 * T-F4.012 — a two-camera direction, materialized, rendered and inspected.
 *
 * A compiled plan that nobody rendered is a claim. This suite generates two
 * real cameras and a real audio master with `lavfi`, directs the session,
 * compiles the shots into clips, hands them to the FFmpeg renderer exactly as
 * a worker would, and then measures the MP4: frame count from
 * `ffprobe -count_frames`, duration, codecs, sha256, and the actual pixels on
 * either side of the seam. Camera A is red and camera B is blue precisely so
 * that "the angle changed" is a measurement and not a hope.
 *
 * The second case is the refusal the domain documents: two cameras whose media
 * run at different cadences cannot both satisfy the renderer, which indexes
 * clip audio at the plan fps (`ffmpeg-editorial-proxy-renderer.ts:737-738`)
 * while trimming video by source frame index (`:752`) and then requires the two
 * spans to be equal (`:578`). The compile step refuses it, and the rates in the
 * refusal are the ones ffprobe actually reported.
 *
 * Nothing here is committed: the MP4s live in an `mkdtemp` directory removed in
 * `t.after`.
 */

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path

const WORKSPACE = 'workspace-render'
const SESSION = 'session-render'
const PROJECT = 'project-render'

const COLOR_METADATA = Object.freeze({
  colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709',
  range: 'limited', bitDepth: 8,
})

/**
 * The identity colour pipeline every VIDEO source has to carry.
 *
 * Not decoration: the renderer refuses an input where a video source has no
 * compilation and an audio source has one
 * (`ffmpeg-editorial-proxy-renderer.ts:470-474`). A multicam plan therefore
 * needs ONE compilation per camera, which is the integration need this suite
 * discovered by being refused.
 *
 * That refusal is a NAMED integration need and not a thing this suite quietly
 * worked around: `run-project-proxy-render-worker.ts:149-152` throws unless
 * `colorPipelineBindings` names every video artifactId with the matching
 * sourceManifestId, and `direct-multicam-session` does not produce bindings for
 * the cameras it newly puts on the timeline. So this suite fabricates the
 * compilations to reach the renderer at all, and the hand-off carries the
 * missing work. What the runtime path DOES accept is measured elsewhere and not
 * guessed here: `multicam-direction.e2e.mjs` calls
 * `PrismaProjectProxyRenderRepository.readCurrentSource` against the stored
 * multicam version and asserts the three render sources it derives.
 */
function colorCompilation(artifactId) {
  const manifestId = `manifest-${artifactId}`
  const probe = createMediaColorProbe({
    id: `probe-${artifactId}`, workspaceId: WORKSPACE, artifactId, manifestId,
    detection: { state: 'ready', metadata: COLOR_METADATA, pixelFormat: 'yuv420p', hdrMode: 'sdr' },
    producer: { provider: 'ffprobe', version: 'json-v1', binaryDigest: '9'.repeat(64) },
    createdAt: '2029-04-01T08:00:00.000Z',
  })
  const implementation = (provider, parameters) => ({
    provider, version: 'v1', parameters, parametersHash: calculateCanonicalHash(parameters),
  })
  return createColorPipelineCompilation({
    id: `compilation-${artifactId}`, workspaceId: WORKSPACE, projectId: PROJECT,
    sourceArtifactId: artifactId, sourceManifestId: manifestId, probe,
    outputMetadata: COLOR_METADATA, createdByClientId: 'client-render', createdAt: '2029-04-01T08:01:00.000Z',
    stages: [
      { id: 'technical-rec709', kind: 'technical', version: 'v1', enabled: true, input: COLOR_METADATA, output: COLOR_METADATA, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
      { id: 'match-bypass', kind: 'match', version: 'v1', enabled: false, input: COLOR_METADATA, output: COLOR_METADATA, implementation: implementation('apollo-match', { mode: 'bypass' }) },
      { id: 'creative-none', kind: 'creative-lut', version: 'v1', enabled: false, input: COLOR_METADATA, output: COLOR_METADATA, implementation: implementation('apollo-lut', { mode: 'none' }) },
      { id: 'output-rec709', kind: 'output', version: 'v1', enabled: true, input: COLOR_METADATA, output: COLOR_METADATA, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
    ],
  })
}

function speaks(trackId, [fromSecond, toSecond], speakerKey) {
  return {
    observationId: `obs-speech-${trackId}-${fromSecond}`,
    trackId,
    range: createTickInterval(sec(fromSecond), sec(toSecond)),
    kind: 'active-speaker',
    value: { kind: 'active-speaker', speakerKey, identityResolved: false },
    confidence: 0.95,
    provenance: {
      method: 'fixture/diarization',
      evaluatorKind: 'controlled',
      evidenceRef: `run:${trackId}:${fromSecond}`,
      producedAt: at(0),
    },
  }
}

function makeCamera(path, colour, seconds, fps) {
  execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${colour}:s=320x180:r=${fps}:d=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path,
  ], { windowsHide: true, timeout: 180_000 })
}

function probeStreams(path) {
  return JSON.parse(execFileSync(ffprobePath, [
    '-v', 'error', '-count_frames',
    '-show_entries', 'stream=codec_type,codec_name,nb_read_frames,duration',
    '-of', 'json', path,
  ], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 })).streams
}

/** The mean RGB of one decoded frame of `path` at `second`. */
function meanRgbAt(path, second) {
  const raw = execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-ss', String(second), '-i', path,
    '-frames:v', '1', '-vf', 'scale=8:8', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  let red = 0
  let green = 0
  let blue = 0
  for (let index = 0; index < raw.length; index += 3) {
    red += raw[index]
    green += raw[index + 1]
    blue += raw[index + 2]
  }
  const pixels = raw.length / 3
  return { red: red / pixels, green: green / pixels, blue: blue / pixels }
}

test('T-F4.012 a two-camera direction becomes clips, renders, and the angle really changes in the pixels', { timeout: 30 * 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-multicam-render-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch((error) => {
      console.log(`multicam render cleanup reported: ${error?.message ?? error}`)
    })
  })

  const fps = 30
  const cameraA = join(root, 'camera-a.mp4')
  const cameraB = join(root, 'camera-b.mp4')
  const master = join(root, 'master.m4a')
  makeCamera(cameraA, 'red', 12, fps)
  makeCamera(cameraB, 'blue', 12, fps)
  execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12',
    '-c:a', 'aac', '-ar', '48000', master,
  ], { windowsHide: true, timeout: 180_000 })

  const world = buildDirectableMulticamWorld({ workspaceId: WORKSPACE, sessionId: SESSION, projectId: PROJECT, endSecond: 12 })
  // One speaker per camera, in turn: the direction has a reason to cut, and the
  // reason is evidence rather than a schedule.
  const evidence = createMulticamEvidenceSet({
    session: world.session,
    observations: [
      speaks('track-mic-a', [1, 6], 'cluster-a'),
      speaks('track-mic-b', [6, 11], 'cluster-b'),
    ],
    generatedAt: at(60),
  })
  const direction = directMulticam({
    session: world.session,
    coverages: world.coverages,
    clockMaps: world.clockMaps,
    diagnostic: world.diagnostic,
    protocolCeiling: null,
    evidence,
    format: { aspectRatio: '16:9' },
    range: createTickInterval(sec(1), sec(11)),
    generatedAt: at(70),
  })
  assert.equal(direction.uncovered.length, 0, 'every directed instant had an eligible angle')
  const compilation = compileShotsToSourceRanges(direction, {
    session: world.session,
    clockMaps: world.clockMaps,
    coverages: world.coverages,
    planFps: rational(30, 1),
  })
  const chosen = new Set(compilation.clips.map((clip) => clip.sourceAssetId))
  assert.ok(chosen.has('asset-cam-a') && chosen.has('asset-cam-b'), `the plan cuts both cameras (${[...chosen].join(', ')})`)

  const clips = compilation.clips.map((clip) => ({
    id: `clip-${clip.shotId}`,
    sourceArtifactId: clip.sourceAssetId,
    cameraId: clip.cameraId,
    ...(clip.audioSourceAssetId
      ? {
        audioSourceArtifactId: clip.audioSourceAssetId,
        audioSourceInFrame: clip.audioSourceInFrame,
        audioSourceOutFrame: clip.audioSourceOutFrame,
      }
      : {}),
    sourceInFrame: clip.sourceInFrame,
    sourceOutFrame: clip.sourceOutFrame,
    timelineInFrame: clip.timelineInFrame,
    timelineOutFrame: clip.timelineOutFrame,
    rate: 1,
  }))
  assert.ok(clips.every((clip) => clip.audioSourceArtifactId === 'asset-master'), 'every clip lies on the recorder')

  const renderer = new FfmpegEditorialProxyRenderer({ workRoot: join(root, 'work'), ffmpegPath })
  const operationId = 'multicam-direction-render'
  // The renderer's own cleanup removes the work directory the output lives in,
  // so it runs after the file has been measured — not in a `finally` that would
  // delete the evidence before anybody read it.
  t.after(async () => {
    await renderer.cleanup(operationId).catch((error) => {
      console.log(`multicam renderer cleanup reported: ${error?.message ?? error}`)
    })
  })
  const rendered = await renderer.render({
      operationId,
      renderKind: 'proxy',
      // The union of every clip's video AND audio artifact, which is exactly
      // what `hydrateSource` derives from a stored plan
      // (`prisma/project-proxy-render-repository.ts:106-110`). Three files, two
      // of them pictures — the multi-source case a single-source plan would
      // have hidden.
      sources: [
        { artifactId: 'asset-cam-a', path: cameraA, mediaType: 'video', colorPipelineCompilation: colorCompilation('asset-cam-a') },
        { artifactId: 'asset-cam-b', path: cameraB, mediaType: 'video', colorPipelineCompilation: colorCompilation('asset-cam-b') },
        { artifactId: 'asset-master', path: master, mediaType: 'audio' },
      ],
      lutPaths: {},
      clips,
      fps,
      format: '16:9',
      outputSpec: { width: 320, height: 180, fps },
      transitions: compilation.clips.slice(0, -1).map((clip, index) => ({
        id: `transition-${index + 1}`,
        fromClipId: `clip-${clip.shotId}`,
        toClipId: `clip-${compilation.clips[index + 1].shotId}`,
        atFrame: clip.timelineOutFrame,
        type: 'straight-cut',
        audioFadeMs: 24,
        reason: 'Angle change over one continuous audio bed.',
      })),
  })

  const streams = probeStreams(rendered.outputPath)
  const video = streams.find((stream) => stream.codec_type === 'video')
  const audio = streams.find((stream) => stream.codec_type === 'audio')
  const bytes = await readFile(rendered.outputPath)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const frames = Number(video.nb_read_frames)
  assert.equal(frames, compilation.durationFrames, 'the file has exactly the frames the plan promised')
  assert.ok(audio, 'the recorder audio reached the output')
  assert.ok(Math.abs(Number(video.duration) - compilation.durationFrames / fps) < 0.2)

  // The pixels. For each clip, the middle of its timeline span must show the
  // camera the direction chose — red for A, blue for B — which is what makes
  // "the angle changed" a measurement.
  const expected = new Map([['asset-cam-a', 'red'], ['asset-cam-b', 'blue']])
  const samples = []
  for (const clip of compilation.clips) {
    const middleSecond = (clip.timelineInFrame + (clip.timelineOutFrame - clip.timelineInFrame) / 2) / fps
    const rgb = meanRgbAt(rendered.outputPath, middleSecond)
    const dominant = rgb.red > rgb.blue ? 'red' : 'blue'
    samples.push(`${clip.shotId}@${middleSecond.toFixed(2)}s=${dominant}`)
    assert.equal(
      dominant,
      expected.get(clip.sourceAssetId),
      `clip ${clip.shotId} cut ${clip.sourceAssetId} and the output shows ${dominant} (r=${rgb.red.toFixed(1)} b=${rgb.blue.toFixed(1)})`,
    )
  }

  console.log(`multicam render clips=${clips.length} sources=3 frames=${frames} duration=${Number(video.duration).toFixed(3)}s vcodec=${video.codec_name} acodec=${audio.codec_name} bytes=${rendered.byteSize} sha256=${sha256.slice(0, 16)} pixels=${samples.join(' ')}`)
})

test('T-F4.012 two cameras at different cadences are refused by the compile step, with the rates ffprobe reported', { timeout: 10 * 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-multicam-cadence-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch((error) => {
      console.log(`multicam cadence cleanup reported: ${error?.message ?? error}`)
    })
  })
  const thirty = join(root, 'thirty.mp4')
  const twentyFive = join(root, 'twenty-five.mp4')
  makeCamera(thirty, 'red', 12, 30)
  makeCamera(twentyFive, 'blue', 12, 25)
  const rateOf = (path) => execFileSync(ffprobePath, [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', path,
  ], { encoding: 'utf8', windowsHide: true }).trim()
  const rateA = rateOf(thirty)
  const rateB = rateOf(twentyFive)
  assert.notEqual(rateA, rateB)

  const world = buildDirectableMulticamWorld({ workspaceId: WORKSPACE, sessionId: `${SESSION}-cadence`, projectId: PROJECT, endSecond: 12 })
  const evidence = createMulticamEvidenceSet({
    session: world.session,
    observations: [speaks('track-mic-b', [1, 10], 'cluster-b')],
    generatedAt: at(60),
  })
  const direction = directMulticam({
    session: world.session,
    coverages: world.coverages,
    clockMaps: world.clockMaps,
    diagnostic: world.diagnostic,
    protocolCeiling: null,
    evidence,
    format: { aspectRatio: '16:9' },
    range: createTickInterval(sec(1), sec(11)),
    generatedAt: at(70),
  })
  const [numeratorB, denominatorB] = rateB.split('/').map((part) => BigInt(part))
  assert.throws(
    () => compileShotsToSourceRanges(direction, {
      session: world.session,
      clockMaps: world.clockMaps,
      coverages: world.coverages,
      planFps: rational(30, 1),
      // The rate the probe reported for camera B, not a number typed here.
      sourceFrameRates: [{ trackId: 'track-camera-b', frameRate: rational(numeratorB, denominatorB) }],
    }),
    (error) => error.code === 'DIRECTION_SOURCE_CADENCE_UNSUPPORTED'
      && error.details.trackId === 'track-camera-b'
      && error.details.sourceFrameRate === rateB
      && error.details.planFps === '30/1',
  )
  console.log(`multicam cadence refusal cameraA=${rateA} cameraB=${rateB} plan=30/1`)
})
