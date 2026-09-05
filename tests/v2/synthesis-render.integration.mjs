import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { compileSynthesisToDirectedPlan } from '../../src/v2/application/compile-synthesis-to-directed-plan.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createMediaColorProbe } from '../../src/v2/domain/color-and-export.ts'
import { createColorPipelineCompilation } from '../../src/v2/domain/color-pipeline-compilation.ts'
import { validateDirectedEditPlan } from '../../src/v2/domain/director-run.ts'
import { createEditorialSynthesis } from '../../src/v2/domain/editorial-synthesis.ts'
import { rational } from '../../src/v2/domain/session-time.ts'
import { STORY_GOLDEN_FIXTURES } from '../../src/v2/domain/story-plan.ts'
import { FfmpegEditorialProxyRenderer } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'

/**
 * F4.016 condition 6, measured — a ten-minute master becomes a two-minute cut
 * and the file on disk is inspected.
 *
 * The falsification this exists for: a bridge that quietly took the first two
 * minutes of the master, or that assumed the output is as long as the source,
 * renders perfectly well. Nothing in a unit test notices. So the master carries
 * a different marker colour in every minute, the six selected windows come from
 * six *different* minutes, and the assertions read the pixels back at the
 * middle of every output clip. A render that took the wrong span shows the
 * wrong colour.
 *
 * Nothing is committed: the master and the render live in a `mkdtemp` that is
 * removed in `finally`.
 */

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path

const FPS = 30
const MASTER_SECONDS = 600
/** One colour per minute of the master. Well separated in RGB on purpose. */
const MARKERS = Object.freeze([
  { name: 'red', hex: '0xFF0000', rgb: [255, 0, 0] },
  { name: 'green', hex: '0x00FF00', rgb: [0, 255, 0] },
  { name: 'blue', hex: '0x0000FF', rgb: [0, 0, 255] },
  { name: 'yellow', hex: '0xFFFF00', rgb: [255, 255, 0] },
  { name: 'magenta', hex: '0xFF00FF', rgb: [255, 0, 255] },
  { name: 'cyan', hex: '0x00FFFF', rgb: [0, 255, 255] },
  { name: 'orange', hex: '0xFF8000', rgb: [255, 128, 0] },
  { name: 'violet', hex: '0x8000FF', rgb: [128, 0, 255] },
  { name: 'spring', hex: '0x00FF80', rgb: [0, 255, 128] },
  { name: 'grey', hex: '0x808080', rgb: [128, 128, 128] },
])

const h = (n) => 'b'.repeat(63) + String(n)
const MASTER_SHA = h(1)
const MASTER_ARTIFACT = 'artifact-longform-master'

/**
 * Six windows, each wholly inside one minute of the master, together 120 s.
 *
 * They come from minutes 0, 1, 3, 5, 6 and 8 — never consecutive, so a render
 * that ran straight through would land on the wrong colours immediately.
 */
const WINDOWS = Object.freeze([
  { rangeId: 'range-1', startMs: 30_000, endMs: 55_000, minute: 0 },
  { rangeId: 'range-2', startMs: 90_000, endMs: 108_000, minute: 1 },
  { rangeId: 'range-3', startMs: 190_000, endMs: 212_000, minute: 3 },
  { rangeId: 'range-4', startMs: 310_000, endMs: 325_000, minute: 5 },
  { rangeId: 'range-5', startMs: 380_000, endMs: 405_000, minute: 6 },
  { rangeId: 'range-6', startMs: 500_000, endMs: 515_000, minute: 8 },
])

const LINEAGE = {
  sourceArtifactId: MASTER_ARTIFACT,
  sourceArtifactSha256: MASTER_SHA,
  sourceManifestId: 'manifest-longform-master',
  sourceManifestHash: h(2),
  indexRunId: 'index-run-longform',
  momentId: 'moment-longform',
  momentHash: h(3),
  evaluationId: 'evaluation-longform',
  evaluationHash: h(4),
}

const STORY_PLAN = {
  ...STORY_GOLDEN_FIXTURES.linear,
  id: 'story-plan-longform',
  mode: 'multi-range',
  targetDurationMs: { min: 100_000, max: 140_000 },
  blocks: STORY_GOLDEN_FIXTURES.linear.blocks.map((block) => ({
    ...block,
    durationTargetMs: { min: 20_000, ideal: 30_000, max: 45_000 },
  })),
}

const COLOR_METADATA = Object.freeze({
  colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709',
  range: 'limited', bitDepth: 8,
})

/**
 * The identity colour pipeline the renderer requires of every video source.
 *
 * Identity on purpose: this test is measuring which SPAN of the master came
 * out, and a grade would move the marker colours the assertions read back.
 */
function colorCompilation(artifactId) {
  const manifestId = `manifest-${artifactId}`
  const probe = createMediaColorProbe({
    id: `probe-${artifactId}`,
    workspaceId: 'workspace-longform',
    artifactId,
    manifestId,
    detection: { state: 'ready', metadata: COLOR_METADATA, pixelFormat: 'yuv420p', hdrMode: 'sdr' },
    producer: { provider: 'ffprobe', version: 'json-v1', binaryDigest: '9'.repeat(64) },
    createdAt: '2029-06-01T08:00:00.000Z',
  })
  const implementation = (provider, parameters) => ({
    provider, version: 'v1', parameters, parametersHash: calculateCanonicalHash(parameters),
  })
  return createColorPipelineCompilation({
    id: `compilation-${artifactId}`,
    workspaceId: probe.workspaceId,
    projectId: 'project-longform',
    sourceArtifactId: artifactId,
    sourceManifestId: manifestId,
    probe,
    outputMetadata: COLOR_METADATA,
    createdByClientId: 'client-longform',
    createdAt: '2029-06-01T08:01:00.000Z',
    stages: [
      { id: 'technical-rec709', kind: 'technical', version: 'v1', enabled: true, input: COLOR_METADATA, output: COLOR_METADATA, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
      { id: 'match-bypass', kind: 'match', version: 'v1', enabled: false, input: COLOR_METADATA, output: COLOR_METADATA, implementation: implementation('apollo-match', { mode: 'bypass' }) },
      { id: 'creative-none', kind: 'creative-lut', version: 'v1', enabled: false, input: COLOR_METADATA, output: COLOR_METADATA, implementation: implementation('apollo-lut', { mode: 'none' }) },
      { id: 'output-rec709', kind: 'output', version: 'v1', enabled: true, input: COLOR_METADATA, output: COLOR_METADATA, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
    ],
  })
}

/** testsrc2 for ten minutes, with the top band painted a different colour each minute. */
function buildMaster(path) {
  const band = MARKERS.map((marker, minute) =>
    `drawbox=x=0:y=0:w=320:h=80:color=${marker.hex}@1:t=fill:` +
    `enable='between(t,${minute * 60},${(minute + 1) * 60})'`).join(',')
  execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=s=320x180:r=${FPS}:d=${MASTER_SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${MASTER_SECONDS}`,
    '-filter_complex', `[0:v]${band}[v]`,
    '-map', '[v]', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', String(FPS),
    '-c:a', 'aac', '-ar', '48000',
    path,
  ], { windowsHide: true, timeout: 900_000 })
}

/** The average colour of the marker band at one instant of a file. */
function bandColourAt(path, second) {
  const raw = execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-ss', String(second), '-i', path,
    '-frames:v', '1', '-vf', 'crop=320:70:0:5,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  return [raw[0], raw[1], raw[2]]
}

function distance(left, right) {
  return Math.sqrt(left.reduce((total, value, index) => total + (value - right[index]) ** 2, 0))
}

/** Which minute's marker the measured colour is nearest to. */
function nearestMinute(colour) {
  let best = 0
  let bestDistance = Infinity
  for (const [minute, marker] of MARKERS.entries()) {
    const measured = distance(colour, marker.rgb)
    if (measured < bestDistance) {
      bestDistance = measured
      best = minute
    }
  }
  return { minute: best, distance: bestDistance }
}

test('T-F4.016 a ten-minute master compiles to a two-minute cut and renders the windows it selected', { timeout: 30 * 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-synthesis-render-'))
  const masterPath = join(root, 'master.mp4')
  const renderer = new FfmpegEditorialProxyRenderer({ workRoot: join(root, 'work'), ffmpegPath })
  try {
    buildMaster(masterPath)
    const masterStreams = JSON.parse(execFileSync(ffprobePath, [
      '-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'json', masterPath,
    ], { encoding: 'utf8', windowsHide: true })).streams
    const masterVideo = masterStreams.find((stream) => stream.codec_type === 'video')
    assert.ok(
      Number(masterVideo.duration) >= MASTER_SECONDS - 1,
      `the master must be at least ten minutes, measured ${masterVideo.duration}s`,
    )
    // The marker really is one colour per minute in the file itself, not just
    // in the filtergraph this test wrote.
    for (const minute of [0, 3, 6, 9]) {
      const measured = nearestMinute(bandColourAt(masterPath, minute * 60 + 30))
      assert.equal(measured.minute, minute, `minute ${minute} of the master must carry its own marker`)
    }

    const ranges = WINDOWS.map((window) => ({
      rangeId: window.rangeId,
      startMs: window.startMs,
      endMs: window.endMs,
      lineage: LINEAGE,
      rightsSnapshotId: 'rights-longform',
      rightsStatus: 'approved',
      consentStatus: 'approved',
      claimIds: [],
      qualifierIds: [],
      proofContextIds: [],
    }))
    const synthesis = createEditorialSynthesis({
      id: 'synthesis-longform',
      workspaceId: 'workspace-longform',
      projectId: 'project-longform',
      objective: 'two-minute cut of a ten-minute master',
      targetDurationMs: 120_000,
      toleranceMs: 1_000,
      sourceDurationMs: MASTER_SECONDS * 1_000,
      frameRate: rational(BigInt(FPS), BigInt(1)),
      storyPlan: STORY_PLAN,
      editPlanId: 'edit-plan-longform',
      ranges,
      joins: ranges.slice(0, -1).map((range, index) => ({
        beforeRangeId: range.rangeId,
        afterRangeId: ranges[index + 1].rangeId,
        kind: 'spliced',
        justification: `window ${index + 1} closes the thought window ${index + 2} opens`,
        continuityRisks: ['argument'],
      })),
    })

    const plan = compileSynthesisToDirectedPlan(synthesis, {
      sources: [{ artifactId: MASTER_ARTIFACT, sha256: MASTER_SHA, durationSeconds: MASTER_SECONDS }],
      projectVersionId: 'version-longform',
      objective: 'discovery',
      createdAt: '2029-06-01T09:00:00.000Z',
    })
    validateDirectedEditPlan(plan)
    const clips = plan.videoTracks[0].clips
    const expectedFrames = WINDOWS.reduce(
      (total, window) => total + (window.endMs - window.startMs) / 1_000 * FPS, 0)
    assert.equal(plan.durationFrames, expectedFrames)

    const result = await renderer.render({
      operationId: 'synthesis-longform-final',
      renderKind: 'final',
      sources: [{
        artifactId: MASTER_ARTIFACT,
        path: masterPath,
        mediaType: 'video',
        colorPipelineCompilation: colorCompilation(MASTER_ARTIFACT),
      }],
      lutPaths: {},
      clips,
      audioTimelineHash: plan.audioTimelineHash,
      fps: plan.fps,
      format: '16:9',
      outputSpec: { width: 320, height: 180, fps: FPS },
      transitions: plan.transitions,
      composition: { foregroundScale: 1, verticalPosition: 0.5 },
    })

    const streams = JSON.parse(execFileSync(ffprobePath, [
      '-v', 'error', '-count_frames', '-show_entries',
      'stream=codec_type,nb_read_frames,duration', '-of', 'json', result.outputPath,
    ], { encoding: 'utf8', windowsHide: true })).streams
    const video = streams.find((stream) => stream.codec_type === 'video')
    const audio = streams.find((stream) => stream.codec_type === 'audio')

    const countedFrames = Number(video.nb_read_frames)
    const measuredSeconds = Number(video.duration)
    // Duration is the sum of the ranges, to within a frame. A bridge that
    // assumed the output is as long as the source would report 600.
    assert.equal(countedFrames, expectedFrames, 'the counted frames are the sum of the windows')
    assert.ok(
      Math.abs(measuredSeconds - 120) <= 1 / FPS,
      `the render measured ${measuredSeconds}s against 120s of selected windows`,
    )
    assert.ok(audio, 'the cut must carry audio')
    assert.ok(Math.abs(Number(audio.duration) - measuredSeconds) <= 1 / FPS, 'A/V drift')

    // The pixels say which minute of the master each output clip came from.
    const identified = []
    for (const [index, clip] of clips.entries()) {
      const middle = (clip.timelineInFrame + clip.timelineOutFrame) / 2 / FPS
      const measured = nearestMinute(bandColourAt(result.outputPath, middle))
      identified.push(measured.minute)
      assert.equal(
        measured.minute,
        WINDOWS[index].minute,
        `output clip ${index} at ${middle}s carries minute ${measured.minute}'s marker, not ${WINDOWS[index].minute}'s`,
      )
      assert.ok(measured.distance < 90, `marker colour drifted by ${measured.distance.toFixed(1)}`)
    }
    assert.deepEqual(identified, WINDOWS.map((window) => window.minute))

    const bytes = await readFile(result.outputPath)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    assert.equal(sha256, result.sha256, 'the digest the renderer reports must be the file it wrote')

    console.log(
      `T-F4.016 synthesis render: master ${Number(masterVideo.duration).toFixed(2)}s -> cut ` +
      `${measuredSeconds.toFixed(3)}s, ${countedFrames} frames (expected ${expectedFrames}), ` +
      `${clips.length} clips from minutes [${identified.join(',')}], ` +
      `${bytes.length} bytes, sha256 ${sha256.slice(0, 16)}`,
    )
  } finally {
    await renderer.cleanup('synthesis-longform-final').catch((error) => {
      console.error('renderer cleanup failed:', error?.message ?? error)
    })
    await rm(root, { recursive: true, force: true })
  }
})
