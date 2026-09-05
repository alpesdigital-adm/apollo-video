import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import ffmpegStatic from 'ffmpeg-static'

import {
  addCaptureSessionTrack,
  createCaptureSession,
} from '../../src/v2/domain/capture-session.ts'
import { runCaptureSyncWorker } from '../../src/v2/application/run-capture-sync-worker.ts'
import {
  createTickInterval,
  createTimebase,
  rational,
  timebaseFromRate,
} from '../../src/v2/domain/session-time.ts'
import { FfmpegAudioSyncSignalSource } from '../../src/v2/infrastructure/media/ffmpeg-audio-sync-signal-source.ts'

const execFileAsync = promisify(execFile)
const FFMPEG = ffmpegStatic ?? 'ffmpeg'

/**
 * T-F4.012 — the sync worker against two recordings FFmpeg actually made.
 *
 * Everything below the worker is real: real containers, a real decode, the real
 * correlator, the real evidence cascade and the real piecewise map constructor.
 * Only the repositories are in memory, in the shape
 * `sync-diagnostic-journey.e2e.mjs` established, because what is under test is
 * the measurement and not the storage.
 *
 * **Why the reference audio is a different sweep every second.** A constant tone
 * correlates equally well against every second of itself, so a locked window
 * would prove that *something* matched and never *which instant* matched — two
 * signals agreeing corroborate the instant, not the identity (ADR-151,
 * generalised). Each second here is a distinct linear sweep and consecutive
 * seconds sweep in opposite directions, so a window that locks names one second
 * and no other. The second camera then carries the same event through a
 * different microphone: the same sweeps, started late by a known lag, with its
 * own room noise on top.
 *
 * The three falsifications are the point of the suite. A measurement that only
 * ever succeeds proves nothing about what it would do when the audio does not
 * actually correspond, when the session has moved, or when the camera had no
 * microphone at all.
 */

const SAMPLE_RATE = 16_000
const FPS = 25
/** One tick is one frame, so every number below is readable as frames. */
const FRAME_TIMEBASE = createTimebase(rational(BigInt(1), BigInt(FPS)))
const REFERENCE_SECONDS = 40
const CANDIDATE_SECONDS = 30

/**
 * The lags the second camera is started late by, in seconds.
 *
 * Three of them land on a whole number of correlation samples and one, 1.5203 s,
 * deliberately does not: at 2 kHz its true lag is 3040.625 samples, so the
 * correlator has to round and the error it reports is its own quantisation
 * rather than zero. A fixture where every answer can be exact measures the
 * arithmetic, not the measurement.
 */
const PROJECTED_LAGS = Object.freeze([0.52, 1.52, 1.5203, 3.04])
/**
 * How far the measured offset may sit from the projected one.
 *
 * The correlator searches at 2 kHz, so it can place a lag to half a millisecond;
 * what actually bounds the answer is the AAC round trip, which shifts energy by
 * a fraction of its 1024-sample frame. One frame at 25 fps is 40 ms — two orders
 * of magnitude above that — and the measured errors are printed so a regression
 * appears as a number rather than as a pass.
 */
const LAG_TOLERANCE_FRAMES = 1

const frames = (seconds) => BigInt(Math.round(seconds * FPS))
const at = (second) => new Date(Date.parse('2029-04-01T09:00:00.000Z') + second * 1000).toISOString()
const digest = (character) => character.repeat(64)

// --------------------------------------------------------------------------
// Fixture generation — nothing large is committed; FFmpeg builds it here.
// --------------------------------------------------------------------------

/** Deterministic noise: `Math.random` would make a rerun a different fixture. */
function lcg(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 4_294_967_296 - 0.5
  }
}

/**
 * The reference room, second by second.
 *
 * Every sweep stays below 840 Hz. The correlation runs at 2 kHz and FFmpeg's
 * resampler lowpasses near 900, so a sweep reaching past that would be
 * attenuated in one file and aliased in the other — and the identity of the
 * second, which is the whole point of the fixture, would be the first casualty.
 */
function buildReferenceSamples() {
  const samples = new Float64Array(REFERENCE_SECONDS * SAMPLE_RATE)
  for (let second = 0; second < REFERENCE_SECONDS; second += 1) {
    const start = 180 + 13 * ((second * 7) % REFERENCE_SECONDS)
    const span = second % 2 === 0 ? 150 : -150
    for (let sample = 0; sample < SAMPLE_RATE; sample += 1) {
      const t = sample / SAMPLE_RATE
      samples[second * SAMPLE_RATE + sample] =
        0.55 * Math.sin(2 * Math.PI * (start * t + (span * t * t) / 2))
    }
  }
  return samples
}

/** The same event heard from another microphone, `lagSeconds` after the start. */
function buildLaggedSamples(reference, lagSeconds, seed) {
  const samples = new Float64Array(CANDIDATE_SECONDS * SAMPLE_RATE)
  const noise = lcg(seed)
  const shift = Math.round(lagSeconds * SAMPLE_RATE)
  for (let sample = 0; sample < samples.length; sample += 1) {
    samples[sample] = (reference[sample + shift] ?? 0) + 0.08 * noise()
  }
  return samples
}

/**
 * The falsification: the same seconds, in the wrong order.
 *
 * Every window still finds an excellent match somewhere in the reference — the
 * audio is genuinely there — but no single offset explains more than one of
 * them. A correlator that reported its best guess anyway would produce a
 * confident, wrong map, so what this asks is whether disagreement between
 * windows is treated as absence of evidence.
 */
function buildShuffledSamples(reference, seed) {
  const samples = new Float64Array(CANDIDATE_SECONDS * SAMPLE_RATE)
  const noise = lcg(seed)
  const order = []
  for (let second = 0; second < CANDIDATE_SECONDS; second += 1) order.push(second)
  // A fixed derangement rather than a shuffle: reproducible, and no second
  // stays where it was, so not one window can agree with its neighbour.
  for (let second = 0; second < CANDIDATE_SECONDS; second += 1) {
    const from = order[(second * 13 + 7) % CANDIDATE_SECONDS]
    for (let sample = 0; sample < SAMPLE_RATE; sample += 1) {
      samples[second * SAMPLE_RATE + sample] =
        (reference[from * SAMPLE_RATE + sample] ?? 0) + 0.08 * noise()
    }
  }
  return samples
}

function toPcm(samples) {
  const buffer = Buffer.alloc(samples.length * 2)
  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[index])) * 32_767), index * 2)
  }
  return buffer
}

async function encodeWithAudio(input) {
  await execFileAsync(FFMPEG, [
    '-hide_banner', '-nostdin', '-y',
    '-f', 'lavfi', '-i', `color=c=gray:s=320x180:r=${FPS}:d=${input.durationSeconds}`,
    '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', input.pcmPath,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-ar', String(SAMPLE_RATE), '-ac', '1',
    '-shortest', input.outputPath,
  ], { maxBuffer: 64 * 1024 * 1024, timeout: 300_000 })
  return input.outputPath
}

/** A camera nobody put a microphone on. Video only, and no audio stream at all. */
async function encodeSilentVideo(outputPath) {
  await execFileAsync(FFMPEG, [
    '-hide_banner', '-nostdin', '-y',
    '-f', 'lavfi', '-i', `testsrc2=s=320x180:r=${FPS}:d=${CANDIDATE_SECONDS}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-an', outputPath,
  ], { maxBuffer: 64 * 1024 * 1024, timeout: 300_000 })
  return outputPath
}

// --------------------------------------------------------------------------
// Session, repositories and the media resolver
// --------------------------------------------------------------------------

const LINEAGE = {
  commandId: 'command-1',
  operation: 'create-session',
  actorKind: 'human',
  actorId: 'user-1',
  occurredAt: at(0),
  note: null,
}

function part(overrides) {
  return {
    partId: overrides.partId,
    ordinal: 0,
    sourceAssetId: overrides.sourceAssetId,
    timebase: FRAME_TIMEBASE,
    coverage: overrides.coverage,
    streamIndex: 0,
    splitReason: 'single-file',
    evidence: {
      ingestArtifactId: overrides.artifactId,
      ingestSha256: digest(overrides.character),
      probeHash: digest('b'),
      probeSource: 'packet-scan',
      observedAt: at(0),
    },
  }
}

function track(overrides) {
  return {
    trackId: overrides.trackId,
    role: overrides.role,
    device: {
      deviceId: overrides.trackId.replace('track-', 'device-'),
      recorderId: overrides.trackId.replace('track-', 'recorder-'),
      make: null,
      model: null,
      serial: null,
    },
    sourceAssetId: overrides.parts[0].sourceAssetId,
    timebase: FRAME_TIMEBASE,
    streamIndex: 0,
    syncAudioPolicy: overrides.syncAudioPolicy,
    includeInFinalMix: overrides.includeInFinalMix,
    parts: overrides.parts,
  }
}

/** Reference camera plus one candidate; the candidate's file is chosen per test. */
function sessionWith(candidate, sessionTimebase = FRAME_TIMEBASE) {
  const base = createCaptureSession({
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    sessionId: 'capture-session-1',
    // No session clock is ever persisted, so the frame rate has to come from
    // the reference track's own timebase. Under the old fallback this session
    // would have been measured at 29.97 whatever the camera actually ran at.
    clock: { timebase: sessionTimebase, rounding: 'nearest-half-even' },
    referenceTrackId: 'track-camera-main',
    tracks: [track({
      trackId: 'track-camera-main',
      role: 'camera-main',
      syncAudioPolicy: 'final-candidate',
      includeInFinalMix: true,
      parts: [part({
        partId: 'part-reference',
        sourceAssetId: 'asset-reference',
        artifactId: 'artifact-reference',
        character: '1',
        coverage: createTickInterval(BigInt(0), frames(REFERENCE_SECONDS)),
      })],
    })],
    lineage: LINEAGE,
    createdAt: at(0),
  })
  return addCaptureSessionTrack(base, {
    track: track({
      trackId: candidate.trackId,
      role: candidate.role ?? 'camera-alt',
      syncAudioPolicy: 'sync-only',
      includeInFinalMix: false,
      parts: [part({
        partId: candidate.partId,
        sourceAssetId: candidate.sourceAssetId,
        artifactId: candidate.artifactId,
        character: '2',
        coverage: createTickInterval(BigInt(0), frames(CANDIDATE_SECONDS)),
      })],
    }),
    lineage: { ...LINEAGE, operation: 'add-track', commandId: 'command-2' },
  })
}

function fakeSessions(session) {
  const evidence = []
  const maps = []
  const coverage = []
  return {
    evidence,
    maps,
    coverage,
    async readHead() { return session },
    async readVersion() { return session },
    async listVersions() { return [session] },
    async listHeads() { return [] },
    async persistClock() { throw new Error('unused') },
    // Nothing persists a session clock in production (map §19.3), so the
    // fixture does not either: the frame rate must come from the track.
    async readClock() { return null },
    async persistClockMap(input) { maps.push(input.map); return { map: input.map, replayed: false } },
    async readClockMap() { return null },
    async listClockMaps() { return maps },
    async persistCoverage(input) { coverage.push(input.coverage); return { coverage: input.coverage, replayed: false } },
    async readCoverage() { return null },
    async listCoverage() { return coverage },
    async persistSyncEvidence(input) { evidence.push(input.record); return { record: input.record, replayed: false } },
    async readSyncEvidence() { return null },
    async listSyncEvidence() { return evidence },
    async appendVersion() { throw new Error('unused') },
  }
}

function fakeRuns(baseSessionHash) {
  const state = {
    settled: null,
    heartbeats: 0,
    run: {
      id: 'capture-sync-run-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      sessionId: 'capture-session-1',
      baseVersionId: 'capture-session-1:v2',
      baseSessionHash,
      baseVersion: 2,
      status: 'running',
      fencingToken: BigInt(1),
      attemptCount: 1,
      maxAttempts: 3,
      trackCount: 1,
      resolvedCount: null,
      reviewCount: null,
      insufficientCount: null,
      failureReason: null,
      leaseExpiresAt: at(60),
      heartbeatAt: at(0),
      startedAt: at(0),
      settledAt: null,
      createdAt: at(0),
      updatedAt: at(0),
    },
  }
  return {
    state,
    async claim() { return { run: state.run, leaseToken: 'lease-token-1' } },
    async heartbeat() { state.heartbeats += 1; return true },
    async settle(input) { state.settled = input.outcome; return { settled: true, run: state.run } },
    async request() { throw new Error('unused') },
    async read() { return state.run },
    async readLatestForSession() { return state.run },
  }
}

/**
 * The resolver, counting its releases.
 *
 * The S3 driver materializes by downloading the whole recording, so a `resolve`
 * without a matching `release` leaves a complete copy of every file the pass
 * measured. Counting here is what makes that leak a failing test rather than a
 * disk that fills up in production three weeks later.
 */
function fakeMedia(pathsByArtifactId) {
  const state = { resolved: 0, released: 0 }
  return {
    state,
    async resolve({ part: capturePart }) {
      const path = pathsByArtifactId.get(capturePart.evidence.ingestArtifactId)
      assert.ok(path, `no fixture file for artifact ${capturePart.evidence.ingestArtifactId}`)
      state.resolved += 1
      return { path, release: async () => { state.released += 1 } }
    },
  }
}

function signalSource(media) {
  return new FfmpegAudioSyncSignalSource({ media, ffmpegPath: FFMPEG })
}

test('T-F4.012 capture sync worker over generated audio', async (t) => {
  const workRoot = await mkdtemp(join(tmpdir(), 'apollo-capture-sync-'))
  t.after(async () => {
    await rm(workRoot, { recursive: true, force: true }).catch((error) => {
      // Reported rather than rethrown: a cleanup failure must not turn a
      // measured result into a failed suite.
      console.error(`capture sync fixture ${workRoot} could not be removed: ${error}`)
    })
  })

  const reference = buildReferenceSamples()
  const referencePcm = join(workRoot, 'reference.pcm')
  await writeFile(referencePcm, toPcm(reference))
  const referencePath = await encodeWithAudio({
    durationSeconds: REFERENCE_SECONDS,
    pcmPath: referencePcm,
    outputPath: join(workRoot, 'reference.mp4'),
  })

  const laggedPaths = new Map()
  for (const lag of PROJECTED_LAGS) {
    const pcm = join(workRoot, `lagged-${lag}.pcm`)
    await writeFile(pcm, toPcm(buildLaggedSamples(reference, lag, 20_260_905)))
    laggedPaths.set(lag, await encodeWithAudio({
      durationSeconds: CANDIDATE_SECONDS,
      pcmPath: pcm,
      outputPath: join(workRoot, `lagged-${lag}.mp4`),
    }))
  }

  const shuffledPcm = join(workRoot, 'shuffled.pcm')
  await writeFile(shuffledPcm, toPcm(buildShuffledSamples(reference, 20_260_906)))
  const shuffledPath = await encodeWithAudio({
    durationSeconds: CANDIDATE_SECONDS,
    pcmPath: shuffledPcm,
    outputPath: join(workRoot, 'shuffled.mp4'),
  })
  const silentPath = await encodeSilentVideo(join(workRoot, 'silent.mp4'))

  const candidate = {
    trackId: 'track-camera-alt',
    partId: 'part-camera-alt',
    sourceAssetId: 'asset-camera-alt',
    artifactId: 'artifact-camera-alt',
  }

  /** One full worker pass over one candidate file. */
  async function runOver(path, sessionTimebase = FRAME_TIMEBASE) {
    const session = sessionWith(candidate, sessionTimebase)
    const sessions = fakeSessions(session)
    const runs = fakeRuns(session.sessionHash)
    const media = fakeMedia(new Map([
      ['artifact-reference', referencePath],
      ['artifact-camera-alt', path],
    ]))
    const result = await runCaptureSyncWorker({
      sessions,
      runs,
      signals: signalSource(media),
      owner: 'worker-integration',
      clock: () => new Date(at(10)),
    })()
    return { session, sessions, runs, media, result }
  }

  const measurements = []

  await t.test('the worker measures the lag and writes a map with it', async () => {
    for (const lag of PROJECTED_LAGS) {
      const { sessions, runs, media, result } = await runOver(laggedPaths.get(lag))

      assert.equal(result.claimed, true)
      assert.equal(result.settled, true)
      assert.equal(sessions.evidence.length, 1, 'one verdict per non-reference track')
      const record = sessions.evidence[0]
      assert.equal(record.outcome !== 'insufficient-evidence', true, `no offset was found for lag ${lag}`)
      assert.equal(record.selectedMethod, 'audio-fingerprint')
      assert.equal(sessions.maps.length, 1)

      const piece = sessions.maps[0].pieces[0]
      const measuredFrames = Number(piece.map.offsetTicks)
      const projectedFrames = lag * FPS
      measurements.push({
        lag,
        projectedFrames,
        measuredFrames,
        errorFrames: measuredFrames - projectedFrames,
        outcome: record.outcome,
        confidence: record.assessments[0].reportedConfidence,
        peakRatio: record.assessments[0].peakRatio,
        residualFrames: record.assessments[0].residualFrames,
        windows: `${record.assessments[0].windowsAgreeing}/${record.assessments[0].windowsConsidered}`,
        coverageRatio: record.assessments[0].coverageRatio,
        blockers: record.assessments[0].autoApplyBlockers,
        reasons: record.outcomeReasons,
      })

      assert.ok(
        Math.abs(measuredFrames - projectedFrames) <= LAG_TOLERANCE_FRAMES,
        `lag ${lag}s: measured ${measuredFrames} frames against a projected ${projectedFrames}`,
      )
      // A correlator that returns 1.0 has stopped measuring and started
      // asserting; the curve this uses approaches 0.99 and never reaches it.
      assert.ok(record.assessments[0].reportedConfidence < 1)
      // The piece carries the residual the elected signal measured, not the
      // hardcoded zero it used to. Zero is a claim of exactness that no
      // correlation can support, and the cascade had already measured the
      // truth in the same record.
      // Plus the one tick that integer rounding always costs
      // (SESSION_CLOCK_ROUNDING_BOUND_TICKS): a bound that ignored it would
      // claim an accuracy the representation cannot deliver.
      assert.equal(
        piece.residualBoundTicks,
        record.assessments[0].residualSessionTicks + BigInt(1),
      )
      assert.equal(runs.state.settled.status, 'succeeded')
      assert.equal(
        media.state.resolved,
        media.state.released,
        'every materialized recording must be released',
      )
    }

    const errors = measurements.map((entry) => entry.errorFrames)
    console.log(`T-F4.012 audio sync lag: ${measurements.map((entry) =>
      `${entry.lag}s projected=${entry.projectedFrames}f measured=${entry.measuredFrames}f err=${entry.errorFrames}f ` +
      `outcome=${entry.outcome} peakRatio=${entry.peakRatio} conf=${entry.confidence.toFixed(4)} ` +
      `residual=${entry.residualFrames}f windows=${entry.windows} coverage=${entry.coverageRatio} ` +
      `blockers=[${entry.blockers.join('; ')}] reasons=[${entry.reasons.join('; ')}]`).join(' | ')
    } | N=${errors.length} errorMin=${Math.min(...errors)}f errorMax=${Math.max(...errors)}f`)
  })

  await t.test('the same lags, measured on a 90 kHz session clock', async () => {
    // Two things at once. The session now counts in 90 kHz ticks while both
    // cameras count in frames, so the reference track's hull has to be
    // converted before it can be used as session bounds — handing frame counts
    // to the cascade as session ticks made every coverage ratio wrong by the
    // ratio of the clocks, and every fixture so far gave the two the same
    // timebase and could not see it.
    //
    // And it is where the dispersion actually shows. At 25 fps a tick is 40 ms
    // and rounding swallows everything the correlator gets wrong; at 90 kHz a
    // tick is 11 microseconds, so the error below is the measurement's own and
    // not the grid's.
    const errors = []
    for (const lag of PROJECTED_LAGS) {
      const { sessions, result } = await runOver(laggedPaths.get(lag), timebaseFromRate(90_000))
      assert.equal(result.settled, true)
      const record = sessions.evidence[0]
      assert.notEqual(record.outcome, 'insufficient-evidence')
      const measured = Number(sessions.maps[0].pieces[0].map.offsetTicks)
      const projected = Math.round(lag * 90_000)
      errors.push({
        lag,
        projected,
        measured,
        errorTicks: measured - projected,
        errorMs: ((measured - projected) / 90_000) * 1_000,
        residualTicks: record.assessments[0].residualSessionTicks,
        coverage: record.assessments[0].coverageRatio,
        outcome: record.outcome,
      })
      // One frame at 25 fps is 3600 ticks here. The measurement is expected to
      // be two orders of magnitude better than that, and the numbers are
      // printed so a regression is a number rather than a pass.
      assert.ok(
        Math.abs(measured - projected) <= 3_600,
        `lag ${lag}s: measured ${measured} ticks against a projected ${projected}`,
      )
    }
    const ticks = errors.map((entry) => entry.errorTicks)
    const mean = ticks.reduce((total, value) => total + value, 0) / ticks.length
    const spread = Math.sqrt(ticks.reduce((total, value) => total + (value - mean) ** 2, 0) / ticks.length)
    console.log(`T-F4.012 audio sync lag at 90 kHz: ${errors.map((entry) =>
      `${entry.lag}s projected=${entry.projected}t measured=${entry.measured}t err=${entry.errorTicks}t ` +
      `(${entry.errorMs.toFixed(3)}ms) residual=${entry.residualTicks}t coverage=${entry.coverage} ` +
      `outcome=${entry.outcome}`).join(' | ')
    } | N=${ticks.length} meanErr=${mean.toFixed(2)}t sd=${spread.toFixed(2)}t`)
  })

  await t.test('coverage is derived for every track from the same pass', async () => {
    // The producer map §19.2 found missing. Removing the worker's coverage call
    // makes this fail, and so does promoting an unprobed part above the floor.
    const { sessions, result } = await runOver(laggedPaths.get(PROJECTED_LAGS[1]))
    assert.equal(result.coverageDerived, 2)
    assert.equal(result.coverageRefused, 0)
    assert.deepEqual(sessions.coverage.map((entry) => entry.trackId).sort(), [
      'track-camera-alt',
      'track-camera-main',
    ])
    for (const entry of sessions.coverage) {
      assert.equal(entry.gaps.length, 0)
      assert.equal(entry.available.length, 1)
      assert.equal(entry.available[0].confidenceBps, 9_500, 'packet-scan is a probe, and is worth one')
    }
  })

  await t.test('shuffled audio is refused instead of being mapped', async () => {
    // Falsification (a). The audio really is present — every window finds an
    // excellent match — but no single offset explains three of them, and a
    // best guess reported anyway would be a confident wrong map.
    const { sessions, runs, result } = await runOver(shuffledPath)

    assert.equal(sessions.evidence.length, 1)
    assert.equal(sessions.evidence[0].outcome, 'insufficient-evidence')
    assert.equal(sessions.evidence[0].clockMap, null)
    assert.equal(sessions.maps.length, 0, 'a refusal must leave no map behind')
    assert.equal(result.insufficient, 1)
    // The run itself succeeded: the cascade answered, and the answer was that
    // it could not tell. That is a result, not a failed run.
    assert.equal(runs.state.settled.status, 'succeeded')
    console.log(
      `T-F4.012 shuffled audio: outcome=${sessions.evidence[0].outcome} ` +
      `signals=${sessions.evidence[0].assessments.length} maps=${sessions.maps.length}`,
    )
  })

  await t.test('a camera with no microphone yields no observation, not a zero', async () => {
    // The non-healthy case AGENTS.md asks a fixture to carry. FFmpeg refuses to
    // write an audio-only output from a video-only file, and that refusal is a
    // fact about the session — not a failure of the run, and not an offset.
    const { sessions, runs, media, result } = await runOver(silentPath)

    assert.equal(sessions.evidence.length, 1)
    assert.equal(sessions.evidence[0].outcome, 'insufficient-evidence')
    assert.equal(sessions.evidence[0].assessments.length, 0, 'nothing was observed to assess')
    assert.equal(sessions.maps.length, 0)
    assert.equal(result.insufficient, 1)
    assert.equal(runs.state.settled.status, 'succeeded')
    assert.equal(media.state.resolved, media.state.released)
  })

  await t.test('a session that moved after the claim is abandoned, not filed', async () => {
    // Falsification (b). The tracks this run would measure are not the tracks
    // in the session any more, so a map filed against the new version would be
    // attributed to a recording it never described.
    const session = sessionWith(candidate)
    const sessions = fakeSessions(session)
    const runs = fakeRuns(digest('9'))
    const media = fakeMedia(new Map([
      ['artifact-reference', referencePath],
      ['artifact-camera-alt', laggedPaths.get(PROJECTED_LAGS[1])],
    ]))
    const result = await runCaptureSyncWorker({
      sessions,
      runs,
      signals: signalSource(media),
      owner: 'worker-integration',
      clock: () => new Date(at(10)),
    })()

    assert.equal(result.abandonedBecause, 'session-moved')
    assert.equal(sessions.evidence.length, 0)
    assert.equal(sessions.maps.length, 0)
    assert.equal(sessions.coverage.length, 0, 'not even coverage may be filed against a moved session')
    assert.equal(media.state.resolved, 0, 'no media may be opened for a run that cannot be filed')
    assert.equal(runs.state.settled.status, 'failed')
  })
})
