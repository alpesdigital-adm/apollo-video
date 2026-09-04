import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import ffmpegStatic from 'ffmpeg-static'

import { createSyncMarker } from '../../src/v2/domain/sync-marker.ts'
import {
  fuseMarkerDetections,
  offsetBetweenDetections,
} from '../../src/v2/domain/sync-marker-detection.ts'
import {
  detectAudioMarker,
  detectVisualMarker,
} from '../../src/v2/infrastructure/media/ffmpeg-marker-detectors.ts'
import { FfmpegSyncMarkerRenderer } from '../../src/v2/infrastructure/media/ffmpeg-sync-marker-renderer.ts'

const execFileAsync = promisify(execFile)
const FFMPEG = ffmpegStatic ?? 'ffmpeg'
const FFPROBE = process.env.FFPROBE_PATH?.trim() || 'ffprobe'

/**
 * F4.010 — the detectors against recordings that are not ideal (FR-148).
 *
 * The clean fixture lives in marker-detection.integration.mjs. This file is
 * about the recordings people actually hand in: two recorders that disagree
 * about sample rate, a phone that compressed the picture to nothing, a clock
 * that runs slightly fast, a camera that stopped and started again.
 *
 * The point of every case is the same. A detector is only useful if the
 * confidence it reports tracks how hard the recording was. One that returns
 * the same confident answer on a marker it can barely see is worse than one
 * that refuses, because the refusal can be acted on.
 *
 * Fixtures are generated here rather than committed: nothing large enters the
 * repository, and the inputs are reproducible from the code that describes
 * them.
 */

const MARKER = createSyncMarker({
  markerId: 'marker-robust-1',
  workspaceId: 'workspace-1',
  sessionId: 'capture-session-robust',
  kind: 'audiovisual',
  position: 'start',
  sequence: 1,
  emittedAt: '2029-04-01T09:00:00.000Z',
})

/** Filler audio: a speech-band tone, so silence never makes correlation easy. */
async function fillerTrack(workRoot, name, totalMs, sampleRate) {
  const path = join(workRoot, `${name}-filler.pcm`)
  const count = Math.round((totalMs / 1_000) * sampleRate)
  const pcm = Buffer.alloc(count * 2)
  for (let index = 0; index < count; index += 1) {
    const value = Math.sin(2 * Math.PI * 300 * (index / sampleRate)) * 0.25
    pcm.writeInt16LE(Math.round(value * 32_767), index * 2)
  }
  await writeFile(path, pcm)
  return path
}

/**
 * A recording with the marker planted `offsetMs` in.
 *
 * `recorder` describes the gear: its sample rate, channel count, frame size and
 * how hard it compressed. Two recorders differing only here is exactly the
 * heterogeneous case a multicamera shoot produces.
 */
async function buildRecording(input) {
  const {
    workRoot, name, offsetMs, markerPath, totalMs = 3_000,
    sampleRate = 48_000, channels = 1, width = 640, height = 360,
    videoBitrate = null, audioCodec = 'aac', blurMarker = 0, speed = 1, rescaleMarker = 0,
  } = input

  const filler = await fillerTrack(workRoot, name, totalMs, sampleRate)
  const output = join(workRoot, `${name}.mp4`)
  const seconds = (value) => (value / 1_000).toFixed(4)

  // The marker overlay, optionally shrunk and blurred: a camera far from the
  // slate, or one that compressed the picture until the code smeared.
  // The marker is overlaid at its native size and centred, never rescaled.
  // The decoder crops the code square from the centre of the frame at the
  // pixel size the marker declared, so a rescaled marker is unreadable by
  // construction — a real limit of this implementation, exercised on purpose
  // by the `rescaleMarker` case below rather than smuggled into every fixture.
  const markerChain = blurMarker > 0
    ? `[2:v]scale=iw/4:ih/4,boxblur=${blurMarker}:1,scale=640:360,`
      + `setpts=PTS-STARTPTS+${seconds(offsetMs)}/TB[mk]`
    : rescaleMarker
      ? `[2:v]scale=${Math.round(640 * rescaleMarker)}:${Math.round(360 * rescaleMarker)},`
        + `setpts=PTS-STARTPTS+${seconds(offsetMs)}/TB[mk]`
      : `[2:v]setpts=PTS-STARTPTS+${seconds(offsetMs)}/TB[mk]`

  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-f', 'lavfi', '-i', `color=c=gray:s=${width}x${height}:r=30:d=${(totalMs / 1000).toFixed(3)}`,
    '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', filler,
    '-i', markerPath,
    '-filter_complex', [
      markerChain,
      `[0:v][mk]overlay=(W-w)/2:(H-h)/2:enable='between(t,${seconds(offsetMs)},${seconds(offsetMs + 167)})'[v]`,
      `[2:a]aresample=${sampleRate},adelay=${offsetMs}|${offsetMs}[ma]`,
      `[1:a][ma]amix=inputs=2:duration=first:normalize=0[a]`,
    ].join(';'),
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    ...(videoBitrate ? ['-b:v', videoBitrate, '-maxrate', videoBitrate, '-bufsize', videoBitrate] : []),
    '-c:a', audioCodec, '-ar', String(sampleRate), '-ac', String(channels),
    '-t', (totalMs / 1000).toFixed(3),
    output,
  ]
  await execFileAsync(FFMPEG, args, { maxBuffer: 64 * 1024 * 1024, timeout: 240_000 })

  if (speed === 1) return output
  // A recorder whose clock runs fast: everything after the start slides, which
  // is what drift looks like before anybody measures it.
  const drifted = join(workRoot, `${name}-drift.mp4`)
  await execFileAsync(FFMPEG, [
    '-hide_banner', '-nostdin', '-y', '-i', output,
    '-filter_complex', `[0:v]setpts=${(1 / speed).toFixed(6)}*PTS[v];[0:a]atempo=${speed.toFixed(6)}[a]`,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', String(sampleRate),
    drifted,
  ], { maxBuffer: 64 * 1024 * 1024, timeout: 240_000 })
  return drifted
}

async function detectBoth(marker, mediaPath, trackId, workRoot, tag) {
  const options = { workRoot, ffprobePath: FFPROBE }
  // Started apart and never told each other's answer: two detectors that agree
  // because one read the other are one detector wearing a disguise.
  const [visual, audio] = await Promise.all([
    detectVisualMarker({ marker, mediaPath, trackId, observationId: `${tag}-v`, options }),
    detectAudioMarker({ marker, mediaPath, trackId, observationId: `${tag}-a`, options }),
  ])
  return { visual, audio }
}

test('T-FR-148 two recorders at different sample rates yield the offset between them', async (t) => {
  const workRoot = await mkdtemp(join(tmpdir(), 'apollo-hetero-'))
  t.after(async () => { await rm(workRoot, { recursive: true, force: true }) })

  const artifact = await new FfmpegSyncMarkerRenderer({ workRoot, ffprobePath: FFPROBE }).render(MARKER)

  // The same marker, filmed by two recorders that share nothing else: one at
  // 48 kHz mono 640x360, the other at 44.1 kHz stereo 960x540. They saw it at
  // different points in their own recordings, which is the whole problem.
  const CAMERA_MS = 700
  const PHONE_MS = 1_450
  const [camera, phone] = await Promise.all([
    buildRecording({
      workRoot, name: 'camera', offsetMs: CAMERA_MS, markerPath: artifact.filePath,
      sampleRate: 48_000, channels: 1, width: 640, height: 360,
    }),
    buildRecording({
      workRoot, name: 'phone', offsetMs: PHONE_MS, markerPath: artifact.filePath,
      sampleRate: 44_100, channels: 2, width: 960, height: 540,
    }),
  ])

  const cameraSeen = await detectBoth(MARKER, camera, 'track-camera', workRoot, 'cam')
  const phoneSeen = await detectBoth(MARKER, phone, 'track-phone', workRoot, 'phone')
  assert.ok(cameraSeen.visual && cameraSeen.audio, 'the 48 kHz recording lost the marker')
  assert.ok(phoneSeen.visual && phoneSeen.audio, 'the 44.1 kHz recording lost the marker')

  console.log(
    `hetero decode: camera ${cameraSeen.visual.decodedPayload ? 'decoded' : 'UNREADABLE'} | `
    + `phone ${phoneSeen.visual.decodedPayload ? 'decoded' : 'UNREADABLE'}`,
  )
  const cameraFused = fuseMarkerDetections({
    marker: MARKER, trackId: 'track-camera', mode: 'both-channels', ...cameraSeen,
  })
  const phoneFused = fuseMarkerDetections({
    marker: MARKER, trackId: 'track-phone', mode: 'both-channels', ...phoneSeen,
  })
  assert.equal(cameraFused.outcome, 'confirmed')
  assert.equal(phoneFused.outcome, 'confirmed')

  const measured = offsetBetweenDetections({ reference: phoneFused, target: cameraFused })
  console.log(
    `heterogeneous: camera ${cameraFused.atMs.toFixed(1)} ms (48k mono), `
    + `phone ${phoneFused.atMs.toFixed(1)} ms (44.1k stereo), `
    + `offset ${measured.offsetMs.toFixed(1)} +-${measured.errorMs.toFixed(1)} ms `
    + `(planted ${PHONE_MS - CAMERA_MS})`,
  )
  // The number this whole feature exists to produce, against a known truth.
  assert.ok(
    Math.abs(measured.offsetMs - (PHONE_MS - CAMERA_MS)) <= 40,
    `offset ${measured.offsetMs} ms is not near the planted ${PHONE_MS - CAMERA_MS} ms`,
  )
  // And it carries an error bound rather than a bare number: both readings
  // have one, so their difference cannot have less.
  assert.ok(measured.errorMs > 0, 'an offset between two measurements reported no error at all')
})

test('T-FR-148 a marker crushed by compression is degraded honestly, not confidently', async (t) => {
  const workRoot = await mkdtemp(join(tmpdir(), 'apollo-degraded-'))
  t.after(async () => { await rm(workRoot, { recursive: true, force: true }) })

  const artifact = await new FfmpegSyncMarkerRenderer({ workRoot, ffprobePath: FFPROBE }).render(MARKER)
  const OFFSET_MS = 900
  // Shrunk to a quarter, blurred, then squeezed through a low bitrate: the
  // flash survives, the code almost certainly does not.
  const recording = await buildRecording({
    workRoot, name: 'degraded', offsetMs: OFFSET_MS, markerPath: artifact.filePath,
    videoBitrate: '80k', blurMarker: 6,
  })

  const { visual, audio } = await detectBoth(MARKER, recording, 'track-phone', workRoot, 'deg')
  console.log(
    `degraded: visual ${visual ? `${visual.atMs} ms score ${visual.patternScore.toFixed(2)} `
      + `code ${visual.decodedPayload ? 'decoded' : 'unreadable'} conf ${visual.confidence.toFixed(2)}` : 'nothing'} | `
    + `audio ${audio ? `${audio.atMs.toFixed(1)} ms peak ${audio.correlationPeak.toFixed(3)}` : 'nothing'}`,
  )

  // The audio path is untouched by video compression, so the recording is
  // still alignable — that is the reason two independent channels exist.
  assert.ok(audio, 'the chirp was lost, which the audio bitrate does not explain')
  assert.ok(
    Math.abs(audio.atMs - OFFSET_MS) <= 40,
    `audio found ${audio.atMs} ms, expected about ${OFFSET_MS}`,
  )

  // The visual channel may or may not survive this. What must not happen is a
  // confident reading of an unreadable code: if the payload could not be
  // decoded, the confidence has to say so.
  if (visual && visual.decodedPayload === null) {
    assert.ok(
      visual.confidence < 0.9,
      `the code was unreadable but confidence stayed at ${visual.confidence}`,
    )
  }

  // The instant survives; the identity does not. With the code unreadable,
  // nothing distinguishes this marker from any other marker of the session,
  // so the fusion offers the time under 'single-channel-only' and withholds
  // confirmation. That is what lets the diagnostic downgrade the track instead
  // of cutting against a marker nobody identified.
  const eitherChannel = fuseMarkerDetections({
    marker: MARKER, trackId: 'track-phone', mode: 'either-channel', visual, audio,
  })
  assert.notEqual(eitherChannel.outcome, 'confirmed')
  assert.ok(Math.abs(eitherChannel.atMs - OFFSET_MS) <= 40)
  assert.ok(eitherChannel.confidence <= 0.75, `unconfirmed detection kept confidence ${eitherChannel.confidence}`)

  // And demanding both channels refuses outright, naming why.
  const bothChannels = fuseMarkerDetections({
    marker: MARKER, trackId: 'track-phone', mode: 'both-channels', visual, audio,
  })
  assert.equal(bothChannels.outcome, 'rejected')
  assert.equal(bothChannels.rejection, 'identity-unverified')
})

test('T-FR-148 a recorder whose clock runs fast is found late, by an amount that matches the drift', async (t) => {
  const workRoot = await mkdtemp(join(tmpdir(), 'apollo-drift-'))
  t.after(async () => { await rm(workRoot, { recursive: true, force: true }) })

  const artifact = await new FfmpegSyncMarkerRenderer({ workRoot, ffprobePath: FFPROBE }).render(MARKER)
  const OFFSET_MS = 2_000
  const SPEED = 1.02

  const [steady, fast] = await Promise.all([
    buildRecording({
      workRoot, name: 'steady', offsetMs: OFFSET_MS, markerPath: artifact.filePath, totalMs: 4_000,
    }),
    buildRecording({
      workRoot, name: 'fast', offsetMs: OFFSET_MS, markerPath: artifact.filePath, totalMs: 4_000,
      speed: SPEED,
    }),
  ])

  const steadySeen = await detectBoth(MARKER, steady, 'track-a', workRoot, 'steady')
  const fastSeen = await detectBoth(MARKER, fast, 'track-b', workRoot, 'fast')
  assert.ok(steadySeen.audio && fastSeen.audio, 'a drifted recording lost the chirp entirely')

  // A clock 2% fast reaches the same wall-clock instant 2% earlier in its own
  // timeline. That relationship is the thing drift correction later depends on,
  // so it is measured here rather than assumed.
  const expected = OFFSET_MS / SPEED
  console.log(
    `drift: steady ${steadySeen.audio.atMs.toFixed(1)} ms, fast ${fastSeen.audio.atMs.toFixed(1)} ms, `
    + `expected ${expected.toFixed(1)} ms at ${SPEED}x`,
  )
  assert.ok(
    Math.abs(fastSeen.audio.atMs - expected) <= 60,
    `a ${SPEED}x recorder put the marker at ${fastSeen.audio.atMs} ms, not near ${expected.toFixed(0)} ms`,
  )
  assert.ok(
    fastSeen.audio.atMs < steadySeen.audio.atMs,
    'the faster clock did not reach the marker earlier in its own timeline',
  )
})

test('T-FR-148 a marker filmed only after a restart is absent from the first file', async (t) => {
  const workRoot = await mkdtemp(join(tmpdir(), 'apollo-restart-'))
  t.after(async () => { await rm(workRoot, { recursive: true, force: true }) })

  const renderer = new FfmpegSyncMarkerRenderer({ workRoot, ffprobePath: FFPROBE })
  const restartMarker = createSyncMarker({
    markerId: 'marker-restart-1',
    workspaceId: 'workspace-1',
    sessionId: 'capture-session-robust',
    kind: 'audiovisual',
    position: 'after-restart',
    sequence: 2,
    emittedAt: '2029-04-01T09:10:00.000Z',
  })
  const [before, after] = await Promise.all([
    renderer.render(MARKER),
    renderer.render(restartMarker),
  ])

  // Two files, as a recorder that stopped and started leaves them. The restart
  // marker is only in the second.
  const [firstFile, secondFile] = await Promise.all([
    buildRecording({ workRoot, name: 'part-1', offsetMs: 600, markerPath: before.filePath }),
    buildRecording({ workRoot, name: 'part-2', offsetMs: 500, markerPath: after.filePath }),
  ])

  const inFirst = await detectBoth(restartMarker, firstFile, 'track-a', workRoot, 'p1')
  const inSecond = await detectBoth(restartMarker, secondFile, 'track-a', workRoot, 'p2')

  const firstFused = fuseMarkerDetections({
    marker: restartMarker, trackId: 'track-a', mode: 'both-channels', ...inFirst,
  })
  const secondFused = fuseMarkerDetections({
    marker: restartMarker, trackId: 'track-a', mode: 'both-channels', ...inSecond,
  })
  console.log(
    `restart: first file ${firstFused.outcome} (${firstFused.rejection ?? 'no rejection'})`
    + ` | visual in first: ${inFirst.visual ? `score ${inFirst.visual.patternScore.toFixed(2)} code ${inFirst.visual.decodedPayload ?? 'UNREADABLE'}` : 'nothing'}`
    + ` | expected payload: ${restartMarker.payload}`
    + ` | second file ${secondFused.outcome} at ${secondFused.atMs?.toFixed(1) ?? 'null'} ms`,
  )

  // The restart marker is genuinely not in the first file, and searching it
  // must produce a refusal rather than the nearest thing that looked similar.
  assert.equal(firstFused.outcome, 'rejected')
  assert.equal(
    firstFused.rejection,
    'identity-unverified',
    'the first file was refused for the wrong reason',
  )
  assert.equal(firstFused.atMs, null, 'a rejected detection reported an instant anyway')

  assert.equal(secondFused.outcome, 'confirmed')
  assert.ok(Math.abs(secondFused.atMs - 500) <= 40)
})

test('T-FR-148 a marker filmed at the wrong apparent size is refused, not guessed at', async (t) => {
  const workRoot = await mkdtemp(join(tmpdir(), 'apollo-rescale-'))
  t.after(async () => { await rm(workRoot, { recursive: true, force: true }) })

  const artifact = await new FfmpegSyncMarkerRenderer({ workRoot, ffprobePath: FFPROBE }).render(MARKER)
  // The same marker, shown at 1.5x — a camera further back, or a slate filling
  // less of the frame. The flash is unmistakable; the code is not readable,
  // because the decoder crops the code square at the pixel size the marker
  // declared and anything rescaled no longer lines up with that grid.
  const recording = await buildRecording({
    workRoot, name: 'rescaled', offsetMs: 800, markerPath: artifact.filePath,
    width: 960, height: 540, rescaleMarker: 1.5,
  })

  const { visual, audio } = await detectBoth(MARKER, recording, 'track-a', workRoot, 'rescale')
  assert.ok(visual, 'the flash itself was missed, which rescaling does not explain')
  console.log(
    `rescaled 1.5x: pattern ${visual.patternScore.toFixed(2)}, `
    + `code ${visual.decodedPayload ? 'decoded' : 'UNREADABLE'}, conf ${visual.confidence.toFixed(2)}`,
  )

  // This is the documented limit of the visual channel: it reads a code shown
  // at native size, and says so rather than reading a rescaled one wrongly.
  assert.equal(visual.decodedPayload, null)
  assert.ok(visual.patternScore >= 0.7, 'the alternation should still be obvious')
  assert.ok(visual.confidence <= 0.6, `an unidentified flash reported confidence ${visual.confidence}`)

  const fused = fuseMarkerDetections({
    marker: MARKER, trackId: 'track-a', mode: 'both-channels', visual, audio,
  })
  assert.equal(fused.outcome, 'rejected')
  assert.equal(fused.rejection, 'identity-unverified')
  assert.ok(
    fused.reasons.some((reason) => reason.includes('unreadable')),
    'the refusal did not say the code could not be read',
  )
})
