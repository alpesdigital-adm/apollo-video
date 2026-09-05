import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { deriveMulticamEvidenceService } from '../../src/v2/application/multicam-direction.ts'
import { SCREEN_ACTIVITY_SATURATION_BPS } from '../../src/v2/domain/multicam-direction.ts'
import {
  FfmpegMulticamVisualEvidenceProvider,
  MULTICAM_VISUAL_EVIDENCE_METHOD,
} from '../../src/v2/infrastructure/analysis/ffmpeg-multicam-visual-evidence-provider.ts'
import { buildDirectableMulticamWorld } from './wave20-fixtures.mjs'

/**
 * T-F4.012 — the production visual adapter, over real pixels, with the numbers
 * printed.
 *
 * `FfmpegMulticamVisualEvidenceProvider` was shipped and wired into
 * `repository-factory.ts` without a single test executing it; every suite in
 * the lane substituted a hand-written double whose `activityBps` was 4200. The
 * real pass over real footage returns two orders of magnitude less than that,
 * which made the screen-activity limb of the direction score inert in
 * production while the fakes exercised it at nearly half its weight. This suite
 * is what makes that a measured fact instead of a surprise:
 *
 * 1. it runs the adapter over five generated sources and PRINTS the table, so
 *    the axis the module header describes is a number somebody produced;
 * 2. it asserts the ordering the physics requires — a still frame measures no
 *    activity at all, a moving pattern measures a real number, and noise
 *    measures more than either;
 * 3. it drives the whole evidence producer over that media, so the branch that
 *    refuses a magnitude of zero (`multicam-direction.ts`, "zero activity is
 *    not an observation of stillness") is exercised by a source that really
 *    measures zero, rather than by a fixture that never yields one;
 * 4. and it pins the measured activity against `SCREEN_ACTIVITY_SATURATION_BPS`,
 *    the domain constant that turns it into a demonstration score, so the two
 *    can never drift apart again without a test saying so.
 *
 * Nothing is committed: the MP4s live in an `mkdtemp` directory removed in
 * `t.after`.
 */

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')

const WORKSPACE = 'workspace-visual-evidence'
const PROJECT = 'project-visual-evidence'
const SESSION = 'session-visual-evidence'
const CLIP_SECONDS = 8

/** One generated source. `input` is the lavfi half of the ffmpeg command line. */
const SOURCES = Object.freeze([
  ['static-slide', ['-f', 'lavfi', '-i', `color=c=gray:s=640x360:r=30:d=${CLIP_SECONDS}`]],
  ['slideshow', ['-f', 'lavfi', '-i', `testsrc=s=640x360:r=30:d=${CLIP_SECONDS}`, '-vf', 'fps=0.5,fps=30']],
  ['moving-pattern', ['-f', 'lavfi', '-i', `testsrc2=s=640x360:r=30:d=${CLIP_SECONDS}`]],
  ['mandelbrot', ['-f', 'lavfi', '-i', `mandelbrot=s=640x360:r=30`, '-t', String(CLIP_SECONDS)]],
  ['noise', ['-f', 'lavfi', '-i', `nullsrc=s=640x360:r=30:d=${CLIP_SECONDS}`, '-vf', 'geq=random(1)*255:128:128']],
])

function generate(path, input) {
  execFileSync(
    ffmpegPath,
    ['-hide_banner', '-loglevel', 'error', '-y', ...input, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-t', String(CLIP_SECONDS), path],
    { windowsHide: true, timeout: 5 * 60_000 },
  )
}

test('T-F4.012 the FFmpeg visual pass measures real pixels, and a still frame measures no activity at all', { timeout: 10 * 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-multicam-visual-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch((error) => {
      console.log(`visual evidence cleanup reported: ${error?.message ?? error}`)
    })
  })

  const windows = []
  for (const [name, input] of SOURCES) {
    const path = join(root, `${name}.mp4`)
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

  const measured = await new FfmpegMulticamVisualEvidenceProvider({ ffmpegPath }).measure({ windows })
  assert.equal(measured.length, SOURCES.length)
  const by = new Map(measured.map((entry) => [entry.trackId, entry]))
  for (const entry of measured) {
    console.log(
      `visual ${entry.trackId.padEnd(15)} frames=${String(entry.sampledFrameCount).padStart(4)}`
      + ` activityBps=${String(entry.activityBps).padStart(5)}`
      + ` stabilityBps=${String(entry.stabilityBps).padStart(5)}`
      + ` exposureBps=${String(entry.exposureBps).padStart(5)}`
      + ` sharpnessBps=${entry.sharpnessBps}`
      + ` method=${entry.method}`,
    )
  }

  // Every window decoded, and the provenance names only what it ran.
  assert.ok(measured.every((entry) => entry.sampledFrameCount > 200), 'every window decoded its frames')
  assert.ok(measured.every((entry) => entry.method === MULTICAM_VISUAL_EVIDENCE_METHOD))
  assert.equal(MULTICAM_VISUAL_EVIDENCE_METHOD, 'ffmpeg/signalstats', 'the method names the one filter that produced the numbers')
  // `signalstats` measures no sharpness, so the dimension stays absent rather
  // than becoming a number with the wrong name on it.
  assert.ok(measured.every((entry) => entry.sharpnessBps === null))
  assert.ok(measured.every((entry) => entry.stabilityBps !== null && entry.exposureBps !== null))

  // The physics. A frame that never changes has NO frame-to-frame difference;
  // this is the value the evidence domain refuses outright, and the case no
  // in-memory fixture in this lane ever produced.
  assert.equal(by.get('static-slide').activityBps, 0, 'a still colour field measures no activity whatsoever')
  assert.ok(by.get('moving-pattern').activityBps > 0, 'a moving pattern measures a real number')
  assert.ok(
    by.get('moving-pattern').activityBps > by.get('slideshow').activityBps,
    'continuous motion measures more than a slide changing every two seconds',
  )
  assert.ok(
    by.get('noise').activityBps > by.get('moving-pattern').activityBps,
    'full-frame noise measures more change than any structured motion',
  )

  // The axis. `activityBps` is basis points OF FULL SCALE, and real footage
  // lives in the low hundreds — which is why the domain saturates at
  // SCREEN_ACTIVITY_SATURATION_BPS instead of dividing by 10 000. If that
  // constant ever drifts back towards full scale, a busy screen share stops
  // contributing anything and this assertion is what says so.
  const busy = by.get('moving-pattern').activityBps
  const score = Math.min(1, busy / SCREEN_ACTIVITY_SATURATION_BPS)
  assert.ok(
    score >= 0.1 && score <= 1,
    `a moving screen must reach a meaningful demonstration score: ${busy} bps / ${SCREEN_ACTIVITY_SATURATION_BPS} = ${score.toFixed(4)}`,
  )
  assert.ok(
    by.get('noise').activityBps >= SCREEN_ACTIVITY_SATURATION_BPS,
    `the saturation point must sit at or below the busiest thing a screen can be: noise measured ${by.get('noise').activityBps} bps`,
  )
  console.log(`visual axis saturation=${SCREEN_ACTIVITY_SATURATION_BPS}bps movingScore=${score.toFixed(4)} noise=${by.get('noise').activityBps}bps`)
})

test('T-F4.012 the producer drops a screen that measured zero and keeps one that measured motion', { timeout: 10 * 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-multicam-producer-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch((error) => {
      console.log(`producer cleanup reported: ${error?.message ?? error}`)
    })
  })

  const world = buildDirectableMulticamWorld({ workspaceId: WORKSPACE, sessionId: SESSION, projectId: PROJECT, endSecond: CLIP_SECONDS })
  const camera = join(root, 'camera.mp4')
  const stillScreen = join(root, 'screen-still.mp4')
  const movingScreen = join(root, 'screen-moving.mp4')
  generate(camera, ['-f', 'lavfi', '-i', `testsrc2=s=320x180:r=30:d=${CLIP_SECONDS}`])
  generate(stillScreen, ['-f', 'lavfi', '-i', `color=c=white:s=320x180:r=30:d=${CLIP_SECONDS}`])
  generate(movingScreen, ['-f', 'lavfi', '-i', `testsrc2=s=320x180:r=30:d=${CLIP_SECONDS}`])

  const run = async (screenPath) => {
    const stored = new Map()
    const evidence = deriveMulticamEvidenceService({
      sessions: {
        async readHead() { return world.session },
        async listClockMaps() { return world.clockMaps },
      },
      directions: {
        async persistEvidenceSet({ set }) {
          const key = `${set.workspaceId}:${set.evidenceHash}`
          if (stored.has(key)) return { set: stored.get(key), replayed: true }
          stored.set(key, set)
          return { set, replayed: false }
        },
      },
      // No diarization for this session: the visual limb is what is under test,
      // and an invented speech run would put a second variable in the result.
      diarization: { async listLatestRunsForArtifacts() { return [] } },
      visual: new FfmpegMulticamVisualEvidenceProvider({ ffmpegPath }),
      media: {
        async resolve({ part }) {
          return {
            path: part.sourceAssetId === 'asset-screen' ? screenPath : camera,
            release: async () => {},
          }
        },
      },
      clock: () => new Date('2029-04-01T09:05:00.000Z'),
      evidenceWindowMs: 4_000,
    })
    return evidence({ workspaceId: WORKSPACE, projectId: PROJECT, sessionId: SESSION })
  }

  const still = await run(stillScreen)
  const stillActivity = still.set.observations.filter((observation) => observation.kind === 'screen-activity')
  assert.equal(
    stillActivity.length,
    0,
    'a screen whose pixels never changed produces NO screen-activity observation — zero is the absence of activity, not a measurement of stillness',
  )
  // …and it is not a silent drop: the quality of that same window IS recorded,
  // so the direction can still tell a clean still slide from an unmeasured one.
  assert.ok(
    still.set.observations.some((observation) => observation.trackId === 'track-screen' && observation.kind === 'technical-quality'),
    'the still screen was measured — it simply had no activity to report',
  )

  const moving = await run(movingScreen)
  const movingActivity = moving.set.observations.filter((observation) => observation.kind === 'screen-activity')
  assert.ok(movingActivity.length > 0, 'a screen being scrolled produces screen-activity observations')
  assert.ok(movingActivity.every((observation) => observation.trackId === 'track-screen'))
  assert.ok(
    movingActivity.every((observation) => observation.value.activityBps > 0),
    'and every one of them carries the number FFmpeg measured',
  )
  assert.ok(
    movingActivity.every((observation) => observation.provenance.method === MULTICAM_VISUAL_EVIDENCE_METHOD),
    'whose provenance names the pass that produced it',
  )
  assert.notEqual(still.set.evidenceHash, moving.set.evidenceHash, 'two different screens are two different evidence sets')

  // What the sweep read and did not turn into an observation, printed rather
  // than counted: the last window of every part ends exactly on the part's
  // coverage bound, and a half-open clock-map piece does not contain its own
  // end tick, so it is refused. That refusal is the map doing its job; it is
  // shown here so nobody has to guess why six windows became four observations.
  for (const entry of moving.skipped) console.log(`producer skipped ${entry.source} :: ${entry.reason}`)
  const activityValues = movingActivity.map((observation) => observation.value.activityBps)
  assert.ok(
    moving.skipped.every((entry) => entry.reason.length > 0 && entry.source.length > 0),
    'every drop says what was read and why it produced nothing',
  )
  console.log(
    `producer still: observations=${still.set.observations.length} screenActivity=0`
    + ` | moving: observations=${moving.set.observations.length} screenActivity=${movingActivity.length}`
    + ` activityBps=[${activityValues.join(',')}] skipped=${moving.skipped.length}`,
  )
})
