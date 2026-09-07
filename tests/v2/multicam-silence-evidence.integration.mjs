import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { deriveMulticamEvidenceService } from '../../src/v2/application/multicam-direction.ts'
import {
  FfmpegMulticamSilenceProvider,
  MULTICAM_SILENCE_DEFAULTS,
  MULTICAM_SILENCE_EVIDENCE_METHOD,
  MULTICAM_SILENCE_MEASUREMENT_FLOOR_DBFS,
} from '../../src/v2/infrastructure/analysis/ffmpeg-multicam-silence-provider.ts'
import { FfmpegMulticamVisualEvidenceProvider } from '../../src/v2/infrastructure/analysis/ffmpeg-multicam-visual-evidence-provider.ts'
import { buildDirectableMulticamWorld } from './wave20-fixtures.mjs'

/**
 * T-F4.012 — the `silence` evidence kind, over real samples, with the numbers
 * printed.
 *
 * `silence` was in `MULTICAM_EVIDENCE_KINDS`, in the aggregate's validator and
 * in `multicam_observations_kind_check`, and no adapter in the repository
 * produced one. Every suite that mentioned it built the observation by hand.
 * This suite is what turns it into a measurement:
 *
 * 1. it runs the production adapter over four generated sources and PRINTS the
 *    table, so the threshold and the ceiling are numbers somebody produced;
 * 2. it asserts what the physics requires — a continuous tone yields NO stretch
 *    at all, a tone with a quiet gap yields exactly that gap, digital silence
 *    yields the whole file at the measurement floor, and a file with no audio
 *    stream yields no blocks rather than a silent stretch;
 * 3. it drives the whole evidence producer over that media, so the branch that
 *    drops an unheard window and the branch that maps a stretch onto the
 *    session clock are exercised by files that really behave that way;
 * 4. and it proves the two passes are selected apart: the microphones are
 *    listened to and never looked at, which is what stops the visual pass from
 *    being handed an audio-only file.
 *
 * Nothing is committed: the media lives in an `mkdtemp` directory removed in
 * `t.after`.
 */

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')

const WORKSPACE = 'workspace-silence-evidence'
const PROJECT = 'project-silence-evidence'
const SESSION = 'session-silence-evidence'
const CLIP_SECONDS = 8
/**
 * The gap inside `speech-with-gap`, in seconds of the file.
 *
 * The end is deliberately OFF the 100 ms grid `astats` measures blocks on, and
 * that is the whole reason this fixture can falsify anything. Ended at exactly
 * 5,000 ms, every block either lies wholly inside the stretch or starts after
 * it, so the provider's "wholly inside, not merely starting inside" filter and
 * a filter that only checks the start select the identical set: the guard is in
 * the source and no fixture can tell whether it is. Ended at 4,950 ms, the
 * block at 4,900-5,000 ms — the one carrying the tone that RESUMED — really
 * does straddle the end. Measured on this file: the guard reports
 * -77.04 dBFS for the gap and its removal reports -12.04 dBFS, which is what
 * the `< -60` ceiling assertion below is there to catch.
 */
const GAP = Object.freeze({ startSeconds: 2, endSeconds: 4.95 })
/** Amplitude 0.0002 of full scale is about -74 dBFS: quiet, and not zero. */
const ROOM_TONE = 0.0002

/** One generated source. `input` is the lavfi half of the ffmpeg command line. */
const SOURCES = Object.freeze([
  ['speech-with-gap', [
    '-f', 'lavfi', '-i',
    `aevalsrc='if(between(t,${GAP.startSeconds},${GAP.endSeconds}),${ROOM_TONE}*sin(2*PI*300*t),0.5*sin(2*PI*440*t))':d=${CLIP_SECONDS}:s=48000`,
    '-c:a', 'aac',
  ], 'm4a'],
  ['continuous-speech', [
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${CLIP_SECONDS}`,
    '-c:a', 'aac',
  ], 'm4a'],
  ['digital-silence', [
    '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono:d=${CLIP_SECONDS}`,
    '-t', String(CLIP_SECONDS), '-c:a', 'pcm_s16le',
  ], 'wav'],
  ['picture-only', [
    '-f', 'lavfi', '-i', `testsrc2=s=320x180:r=30:d=${CLIP_SECONDS}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  ], 'mp4'],
])

function generate(path, input) {
  execFileSync(
    ffmpegPath,
    ['-hide_banner', '-loglevel', 'error', '-y', ...input, path],
    { windowsHide: true, timeout: 5 * 60_000 },
  )
}

test('T-F4.012 the FFmpeg listening pass finds the gap, and a continuous tone has none', { timeout: 10 * 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-multicam-silence-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch((error) => {
      console.log(`silence evidence cleanup reported: ${error?.message ?? error}`)
    })
  })

  const windows = []
  for (const [name, input, extension] of SOURCES) {
    const path = join(root, `${name}.${extension}`)
    generate(path, input)
    windows.push({
      trackId: name,
      partId: `part-${name}`,
      sourceArtifactId: `asset-${name}`,
      path,
      sourceStartMs: 0,
      sourceEndMs: CLIP_SECONDS * 1_000,
    })
  }

  const measured = await new FfmpegMulticamSilenceProvider({ ffmpegPath }).measure({ windows })
  assert.equal(measured.length, SOURCES.length)
  const by = new Map(measured.map((entry) => [entry.trackId, entry]))
  for (const entry of measured) {
    console.log(
      `silence ${entry.trackId.padEnd(18)} blocks=${String(entry.measuredBlockCount).padStart(3)}`
      + ` stretches=${entry.stretches.length}`
      + ` ranges=[${entry.stretches.map((stretch) => `${Math.round(stretch.startMs)}-${Math.round(stretch.endMs)}ms@${stretch.ceilingDbfs}dBFS`).join(' ')}]`
      + ` threshold=${entry.thresholdDbfs}dBFS/${entry.minimumSilenceMs}ms`
      + ` method=${entry.method}`,
    )
  }

  assert.ok(measured.every((entry) => entry.method === MULTICAM_SILENCE_EVIDENCE_METHOD))
  assert.equal(MULTICAM_SILENCE_EVIDENCE_METHOD, 'ffmpeg/silencedetect+astats', 'the method names both filters that produced the numbers')

  // A tone that never stops is never silent. This is the value the evidence
  // domain has no way to express — there is no observation meaning "measured,
  // and it was loud" — so it must produce nothing at all.
  const loud = by.get('continuous-speech')
  assert.ok(loud.measuredBlockCount > 0, 'the continuous tone was decoded')
  assert.equal(loud.stretches.length, 0, 'a tone that never stops produces NO silence observation whatsoever')

  // The gap, where it really is. Both bounds inside a tenth of a second of the
  // generated gap: silencedetect needs the level to have stayed down for
  // `minimumSilenceMs` before it reports, and the encoder smears the edges.
  const gap = by.get('speech-with-gap')
  assert.equal(gap.stretches.length, 1, 'one gap in the file is one stretch in the measurement')
  const found = gap.stretches[0]
  assert.ok(
    Math.abs(found.startMs - GAP.startSeconds * 1_000) <= 100,
    `the stretch starts where the gap does: ${found.startMs} ms against ${GAP.startSeconds * 1_000} ms`,
  )
  assert.ok(
    Math.abs(found.endMs - GAP.endSeconds * 1_000) <= 100,
    `and ends where it does: ${found.endMs} ms against ${GAP.endSeconds * 1_000} ms`,
  )
  // The ceiling is the room tone that was really there, not the -50 dBFS
  // threshold it was detected under. A block that merely STARTS inside the
  // stretch carries the sound that ended it, and counting one puts this number
  // at -12.04 dBFS while the samples in the gap are 65 dB quieter. Falsified,
  // not asserted from reading: replacing the provider's whole-block filter with
  // `block.atMs < range.endMs` makes this assertion fail at -12.04 dBFS and the
  // producer case below fail at the same value.
  assert.ok(
    found.ceilingDbfs < -60 && found.ceilingDbfs > -90,
    `the ceiling is the measured room tone, not the threshold: ${found.ceilingDbfs} dBFS`,
  )
  assert.ok(found.ceilingDbfs < gap.thresholdDbfs, 'and it is under the threshold it was detected with')

  // Digital silence has no dBFS. It is reported at the floor, said out loud,
  // rather than as a null that would claim nobody listened.
  const zeros = by.get('digital-silence')
  assert.equal(zeros.stretches.length, 1, 'a file of exact zeros is one stretch')
  assert.equal(zeros.stretches[0].startMs, 0)
  assert.equal(
    zeros.stretches[0].ceilingDbfs,
    MULTICAM_SILENCE_MEASUREMENT_FLOOR_DBFS,
    'every block was -inf, so the floor is reported and no level is invented',
  )

  // A picture with no audio track is not a quiet room.
  const mute = by.get('picture-only')
  assert.equal(mute.measuredBlockCount, 0, 'a file with no audio stream produces no blocks')
  assert.equal(mute.stretches.length, 0, 'and no silent stretch: nothing was heard, which is not the same as nothing sounded')

  console.log(
    `silence axis threshold=${MULTICAM_SILENCE_DEFAULTS.thresholdDbfs}dBFS`
    + ` minimum=${MULTICAM_SILENCE_DEFAULTS.minimumSilenceMs}ms block=${MULTICAM_SILENCE_DEFAULTS.blockMs}ms`
    + ` gapCeiling=${found.ceilingDbfs}dBFS floor=${MULTICAM_SILENCE_MEASUREMENT_FLOOR_DBFS}dBFS`,
  )
})

test('T-F4.012 the producer turns measured stretches into observations and drops what it could not hear', { timeout: 10 * 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-silence-producer-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch((error) => {
      console.log(`silence producer cleanup reported: ${error?.message ?? error}`)
    })
  })

  const paths = new Map()
  for (const [name, input, extension] of SOURCES) {
    const path = join(root, `${name}.${extension}`)
    generate(path, input)
    paths.set(name, path)
  }

  const world = buildDirectableMulticamWorld({
    workspaceId: WORKSPACE,
    sessionId: SESSION,
    projectId: PROJECT,
    endSecond: CLIP_SECONDS,
  })
  // The reference track is the master audio; giving it the file of exact zeros
  // exercises the floor through the whole producer, and the microphones give it
  // one file that goes quiet and one that never does.
  const media = new Map([
    ['asset-master', paths.get('digital-silence')],
    ['asset-mic-a', paths.get('speech-with-gap')],
    ['asset-mic-b', paths.get('continuous-speech')],
    ['asset-cam-a', paths.get('picture-only')],
    ['asset-cam-b', paths.get('picture-only')],
    ['asset-screen', paths.get('picture-only')],
  ])

  const looked = []
  const visual = new FfmpegMulticamVisualEvidenceProvider({ ffmpegPath })
  const derive = deriveMulticamEvidenceService({
    sessions: {
      async readHead() { return world.session },
      async listClockMaps() { return world.clockMaps },
    },
    directions: {
      async persistEvidenceSet({ set }) { return { set, replayed: false } },
    },
    // No diarization: the listening limb is what is under test, and invented
    // speech would put a second variable in the result.
    diarization: { async listLatestRunsForArtifacts() { return [] } },
    visual: {
      async measure(input) {
        looked.push(...input.windows.map((window) => window.trackId))
        return visual.measure(input)
      },
    },
    silence: new FfmpegMulticamSilenceProvider({ ffmpegPath }),
    media: {
      async resolve({ part }) {
        const path = media.get(part.sourceAssetId)
        assert.ok(path, `the fixture has a file for ${part.sourceAssetId}`)
        return { path, release: async () => {} }
      },
    },
    clock: () => new Date('2029-04-01T09:05:00.000Z'),
    evidenceWindowMs: 4_000,
  })

  const result = await derive({ workspaceId: WORKSPACE, projectId: PROJECT, sessionId: SESSION })
  const silence = result.set.observations.filter((observation) => observation.kind === 'silence')
  const byTrack = new Map()
  for (const observation of silence) {
    byTrack.set(observation.trackId, [...(byTrack.get(observation.trackId) ?? []), observation])
  }
  for (const observation of silence) {
    console.log(
      `observation ${observation.observationId.padEnd(34)} track=${observation.trackId.padEnd(18)}`
      + ` ticks=${observation.range.start}-${observation.range.end}`
      + ` levelDbfs=${observation.value.levelDbfs}`
      + ` method=${observation.provenance.method}`,
    )
  }
  for (const entry of result.skipped) console.log(`producer skipped ${entry.source} :: ${entry.reason}`)

  // The microphone that goes quiet reports; the one that never does reports
  // nothing, and that is absence, not a level.
  assert.ok((byTrack.get('track-mic-a') ?? []).length > 0, 'the microphone with a gap produces silence observations')
  assert.equal(
    (byTrack.get('track-mic-b') ?? []).length,
    0,
    'the microphone that never goes quiet produces none — no observation is the only way to say "not silent"',
  )
  assert.ok(
    (byTrack.get('track-mic-a') ?? []).every((observation) => observation.value.levelDbfs < -50 && observation.value.levelDbfs <= 0),
    'and each carries a measured ceiling under the detection threshold',
  )
  assert.ok(
    (byTrack.get('track-master-audio') ?? []).some((observation) => observation.value.levelDbfs === MULTICAM_SILENCE_MEASUREMENT_FLOOR_DBFS),
    'the reference track of exact zeros reports the floor through the whole producer',
  )
  assert.ok(
    silence.every((observation) => observation.provenance.evaluatorKind === 'measured'
      && observation.provenance.method === MULTICAM_SILENCE_EVIDENCE_METHOD),
    'every observation names the pass that measured it',
  )
  assert.ok(
    silence.every((observation) => observation.range.end > observation.range.start),
    'and is a forward half-open interval of session ticks',
  )
  assert.equal(new Set(silence.map((observation) => observation.observationId)).size, silence.length, 'ids are unique')

  // The cameras carry no audio, so they are heard-and-dropped rather than
  // recorded as silent, and the drop is reported.
  assert.equal(
    [...byTrack.keys()].filter((trackId) => trackId.startsWith('track-camera') || trackId === 'track-screen').length,
    0,
    'a picture with no audio stream contributes no silence observation',
  )
  const unheard = result.skipped.filter((entry) => entry.reason === 'the decode produced no audio')
  assert.ok(unheard.length > 0, 'and every one of those windows is reported rather than silently lost')

  // The two passes are selected apart. Handing an audio-only file to the visual
  // pass is how this producer would fail in production once microphones started
  // being materialized for it.
  assert.ok(!looked.includes('track-mic-a') && !looked.includes('track-master-audio'), 'audio-only tracks are never looked at')
  assert.ok(looked.includes('track-camera-a'), 'and the cameras still are')

  console.log(
    `producer observations=${result.set.observations.length} silence=${silence.length}`
    + ` tracks=[${[...byTrack.keys()].sort().join(',')}] unheard=${unheard.length} skipped=${result.skipped.length}`,
  )
})
