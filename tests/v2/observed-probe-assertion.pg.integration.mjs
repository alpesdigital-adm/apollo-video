import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import { PrismaClient } from '../../generated/prisma-v2/index.js'

/**
 * PostgreSQL proof of `w66_assert_probe_v3` after it stopped walking the frames one PL/pgSQL iteration at a time (written for the supervised
 * harness, which hands it a migrated disposable database in V2_DATABASE_URL; not run in CI).
 *
 * The function is an integrity assertion: it must refuse exactly what it refused before, and it must cost little enough for a long master to be
 * committed inside the 10 s statement budget of the commit. Both are proved against the function it replaced, whose body is read from the
 * migration that created it and installed here under another name:
 *   1. a probe the size of a 103 s master (3,085 video frames, 4,430 audio frames) is accepted by both, and the new one takes at most two thirds of
 *      the time of the old one (five runs of the new, three of the old; min / median / max are printed);
 *   2. every single fault of the list below is refused by both with the same SQLSTATE.
 */
const SKIP = process.env.V2_DATABASE_URL ? false : 'set V2_DATABASE_URL to a migrated disposable database (the supervised harness does)'
const LEGACY = 'w66_assert_probe_v3_per_frame_loop'
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const VIDEO_TIME_BASE = Object.freeze({ numerator: '1', denominator: '15360' })
const AUDIO_TIME_BASE = Object.freeze({ numerator: '1', denominator: '44100' })
const VIDEO_STEP = 512
const AUDIO_STEP = 1024

/** A raw ffprobe document of one video stream and one audio stream, and the two observed probes (video, audio) that bind it. */
function buildProbes({ videoFrames, audioFrames }) {
  const rawFrames = []
  for (let index = 0; index < Math.max(videoFrames, audioFrames); index += 1) {
    if (index < videoFrames) rawFrames.push({ media_type: 'video', stream_index: 0, best_effort_timestamp: index * VIDEO_STEP, duration: VIDEO_STEP })
    if (index < audioFrames) rawFrames.push({ media_type: 'audio', stream_index: 1, best_effort_timestamp: index * AUDIO_STEP, duration: AUDIO_STEP })
  }
  const raw = {
    format: { start_time: '0.000000' },
    streams: [
      { index: 0, codec_type: 'video', width: 1920, height: 1080, time_base: '1/15360', avg_frame_rate: '30/1', start_time: '0.000000' },
      { index: 1, codec_type: 'audio', sample_rate: '44100', channels: 2, time_base: '1/44100', start_time: '0.000000' },
    ],
    frames: rawFrames,
  }
  const probe = (mediaType, streamIndex, count, step, timeBase) => ({
    schemaVersion: 'output-observed-probe/v3',
    binarySha256: 'a'.repeat(64),
    rawJson: null,
    rawSha256: null,
    streamIndex,
    mediaType,
    sampleRateHz: mediaType === 'audio' ? 44100 : null,
    channels: mediaType === 'audio' ? 2 : null,
    originSource: 'format-start-time',
    originSeconds: { numerator: '0', denominator: '1' },
    width: mediaType === 'video' ? 1920 : 0,
    height: mediaType === 'video' ? 1080 : 0,
    fps: mediaType === 'video' ? { numerator: '30', denominator: '1' } : null,
    rotationDegrees: 0,
    timeBase,
    frames: Array.from({ length: count }, (_, index) => ({ frame: index, pts: index * step, timeBase })),
    frameEndPts: Array.from({ length: count }, (_, index) => index * step + step),
    endPts: count * step,
  })
  return { raw, video: probe('video', 0, videoFrames, VIDEO_STEP, VIDEO_TIME_BASE), audio: probe('audio', 1, audioFrames, AUDIO_STEP, AUDIO_TIME_BASE) }
}

/** The probe with its raw document sealed (rawJson text and its sha), after `mutate` changed the structures. */
function seal({ raw, probe, manifest = { probe: { width: 1920, height: 1080, fps: 30 } } }) {
  const rawJson = JSON.stringify(raw)
  return { probe: { ...probe, rawJson, rawSha256: sha(rawJson) }, manifest }
}

const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]
const stats = (values) => ({ n: values.length, minMs: Math.round(Math.min(...values)), medianMs: Math.round(median(values)), maxMs: Math.round(Math.max(...values)) })

/** One fault each; `apply(world)` edits the raw document and/or the probe in place. */
const FAULTS = Object.freeze([
  ['a probe frame repeats the pts of its predecessor', (w) => { w.video.frames[5].pts = w.video.frames[4].pts }],
  ['a probe frame goes back in time', (w) => { w.video.frames[9].pts = w.video.frames[7].pts }],
  ['an end pts in the middle is off by one', (w) => { w.video.frameEndPts[7] += 1 }],
  ['the terminal end pts is off by one', (w) => { w.video.endPts += 1 }],
  ['a probe frame number skips', (w) => { w.video.frames[3].frame = 9 }],
  ['a probe frame time base differs', (w) => { w.video.frames[2].timeBase = { numerator: '1', denominator: '15361' } }],
  ['a probe frame carries an extra key', (w) => { w.video.frames[2].extra = 1 }],
  ['a probe frame lacks its time base', (w) => { delete w.video.frames[2].timeBase }],
  ['a probe frame is not an object', (w) => { w.video.frames[2] = 5 }],
  ['a probe pts differs from the raw frame', (w) => { w.video.frames[6].pts += 1 }],
  ['a probe pts is not a number', (w) => { w.video.frames[3].pts = 'abc' }],
  ['a probe frame is missing', (w) => { w.video.frames.pop() }],
  ['the end pts list is shorter than the frames', (w) => { w.video.frameEndPts.pop() }],
  ['a raw frame has no duration', (w) => { delete w.raw.frames.find((f) => f.stream_index === 0).duration }],
  ['a raw frame has a zero duration', (w) => { w.raw.frames.find((f) => f.stream_index === 0).duration = 0 }],
  ['a raw frame names a stream the document lacks', (w) => { w.raw.frames[4].stream_index = 7 }],
  ['a raw frame media type differs from its stream', (w) => { w.raw.frames.find((f) => f.stream_index === 0).media_type = 'audio' }],
  ['a raw frame timestamp is not an integer', (w) => { w.raw.frames.find((f) => f.stream_index === 0).best_effort_timestamp = 1.5 }],
  ['a raw frame timestamp is beyond the safe integers', (w) => { w.raw.frames.find((f) => f.stream_index === 0).best_effort_timestamp = 9007199254740993 }],
  ['a raw frame is not an object', (w) => { w.raw.frames[3] = 'frame' }],
  ['the raw document repeats a stream index', (w) => { w.raw.streams.push({ ...w.raw.streams[0] }) }],
  ['the raw time base differs from the probe', (w) => { w.raw.streams[0].time_base = '1/15361' }],
  ['the raw stream is not the probe media type', (w) => { w.video.mediaType = 'audio' }],
  ['the rotation differs', (w) => { w.video.rotationDegrees = 90 }],
  ['the origin differs from the measured start time', (w) => { w.video.originSeconds = { numerator: '1', denominator: '1' } }],
  ['no raw frame belongs to the stream', (w) => { w.raw.frames = w.raw.frames.filter((f) => f.stream_index !== 0); w.video.frames = []; w.video.frameEndPts = [] }],
  ['the manifest width differs', (w) => { w.manifest = { probe: { width: 1280, height: 1080, fps: 30 } } }],
])

test('w66_assert_probe_v3 refuses what the per-frame loop refused and costs a fraction of it', { skip: SKIP }, async () => {
  const client = new PrismaClient({ datasources: { db: { url: process.env.V2_DATABASE_URL } } })
  try {
    const migration = readFileSync(new URL('../../prisma/v2/migrations/20261014120000_project_operational_output_v3/migration.sql', import.meta.url), 'utf8')
    const start = migration.indexOf('CREATE FUNCTION w66_assert_probe_v3(')
    const end = migration.indexOf('END $$;', start) + 'END $$;'.length
    assert.ok(start > 0 && end > start, 'the per-frame loop body is in the migration that created it')
    await client.$executeRawUnsafe(migration.slice(start, end).replace('CREATE FUNCTION w66_assert_probe_v3(', `CREATE OR REPLACE FUNCTION ${LEGACY}(`))

    const call = async (name, { probe, manifest }) => {
      const started = performance.now()
      try {
        await client.$queryRawUnsafe(`SELECT ${name}($1::jsonb, $2::jsonb)::text AS verdict`, JSON.stringify(probe), JSON.stringify(manifest))
        return { accepted: true, ms: performance.now() - started }
      } catch (error) {
        return { accepted: false, ms: performance.now() - started, sqlstate: error?.meta?.code ?? null, message: String(error?.meta?.message ?? error.message).replace(/\s+/g, ' ').slice(0, 160) }
      }
    }

    // 1. A master-sized probe: accepted by both, the new function in at most two thirds of the time (measured: about half; the margin is for a busy machine).
    const big = buildProbes({ videoFrames: 3085, audioFrames: 4430 })
    const sealedBig = [seal({ raw: big.raw, probe: big.video }), seal({ raw: big.raw, probe: big.audio, manifest: { probe: {} } })]
    const legacyRuns = []
    const currentRuns = []
    for (let run = 0; run < 5; run += 1) {
      let currentMs = 0
      for (const sealed of sealedBig) {
        const verdict = await call('w66_assert_probe_v3', sealed)
        assert.equal(verdict.accepted, true, `the current function refused a valid ${sealed.probe.mediaType} probe: ${verdict.message}`)
        currentMs += verdict.ms
      }
      currentRuns.push(currentMs)
      if (run < 3) {
        let legacyMs = 0
        for (const sealed of sealedBig) {
          const verdict = await call(LEGACY, sealed)
          assert.equal(verdict.accepted, true, `the per-frame loop refused a valid ${sealed.probe.mediaType} probe: ${verdict.message}`)
          legacyMs += verdict.ms
        }
        legacyRuns.push(legacyMs)
      }
    }
    const current = stats(currentRuns)
    const previous = stats(legacyRuns)
    console.log(`OBSERVED-PROBE-ASSERTION-TIMING ${JSON.stringify({ frames: { video: 3085, audio: 4430 }, perFrameLoop: previous, setBased: current })}`)
    assert.ok(current.medianMs * 3 <= previous.medianMs * 2, `the set-based assertion must take at most two thirds of the per-frame loop: ${JSON.stringify({ current, previous })}`)
    assert.ok(current.maxMs < 2_000, `a master-sized probe pair must be asserted well inside the 10 s commit budget: ${JSON.stringify(current)}`)

    // 2. Every single fault is refused by both, with the same SQLSTATE.
    const refusals = []
    for (const [name, apply] of FAULTS) {
      const world = buildProbes({ videoFrames: 40, audioFrames: 60 })
      const faulty = { raw: structuredClone(world.raw), video: structuredClone(world.video), manifest: { probe: { width: 1920, height: 1080, fps: 30 } } }
      apply(faulty)
      const sealed = seal({ raw: faulty.raw, probe: faulty.video, manifest: faulty.manifest })
      const before = await call(LEGACY, sealed)
      const after = await call('w66_assert_probe_v3', sealed)
      assert.equal(before.accepted, false, `fault "${name}" must be refused by the per-frame loop (the fault list is only as good as that)`)
      assert.equal(after.accepted, false, `fault "${name}" was accepted by the set-based assertion`)
      assert.equal(after.sqlstate, before.sqlstate, `fault "${name}" is refused with another SQLSTATE: ${before.sqlstate} -> ${after.sqlstate}`)
      refusals.push({ fault: name, sqlstate: after.sqlstate, sameMessage: after.message === before.message })
    }
    // A tampered seal is refused before any frame is read.
    const tampered = seal({ raw: big.raw, probe: { ...buildProbes({ videoFrames: 4, audioFrames: 4 }).video }, manifest: { probe: { width: 1920, height: 1080, fps: 30 } } })
    tampered.probe.rawSha256 = 'b'.repeat(64)
    for (const name of [LEGACY, 'w66_assert_probe_v3']) assert.equal((await call(name, tampered)).accepted, false)
    console.log(`OBSERVED-PROBE-ASSERTION-FAULTS ${JSON.stringify({ faults: refusals.length, sameMessage: refusals.filter((r) => r.sameMessage).length })}`)
    assert.equal(refusals.length, FAULTS.length)
  } finally {
    await client.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${LEGACY}(jsonb, jsonb)`).catch(() => {})
    await client.$disconnect()
  }
})
