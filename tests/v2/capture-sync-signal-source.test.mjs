import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_SYNC_EVIDENCE_THRESHOLDS,
  MAXIMUM_REPORTABLE_PEAK_RATIO,
  evaluateSyncEvidence,
} from '../../src/v2/domain/sync-evidence.ts'
import {
  createTickInterval,
  rational,
  timebaseFromRate,
} from '../../src/v2/domain/session-time.ts'
import {
  FfmpegAudioSyncSignalSource,
  reportablePeakRatio,
} from '../../src/v2/infrastructure/media/ffmpeg-audio-sync-signal-source.ts'
import { confidenceFromPeakRatio } from '../../src/v2/infrastructure/media/ffmpeg-playback-fingerprint.ts'

/**
 * The half of `FfmpegAudioSyncSignalSource` no suite had ever executed.
 *
 * `manualAnchorObservation` and `markerObservation` are roughly 130 lines and
 * the second deliverable of the brief, and the only construction of this class
 * anywhere in the repository passed no `diagnostics` at all — while the
 * production factory always passes one (`repository-factory.ts:2255`). So the
 * untested branch was the production branch.
 *
 * Nothing here touches FFmpeg. A track with no parts decodes nothing, which is
 * exactly the shape that isolates the anchor path: what is under test is the
 * arithmetic between an operator's milliseconds and the units the cascade
 * actually compares in, and that arithmetic is where the defect was.
 */

const t = (n) => BigInt(n)
const SESSION_TIMEBASE = timebaseFromRate(90_000)
const SESSION_SECONDS = 600
const SESSION_BOUNDS = createTickInterval(t(0), t(90_000 * SESSION_SECONDS))
const at = (second) => new Date(Date.parse('2029-04-01T09:00:00.000Z') + second * 1000).toISOString()

/** A session and two tracks with no files: enough identity, no media. */
const SESSION = Object.freeze({ workspaceId: 'workspace-1', sessionId: 'capture-session-1' })
const TRACK = Object.freeze({ trackId: 'track-phone', parts: Object.freeze([]) })
const REFERENCE = Object.freeze({ trackId: 'track-camera-main', parts: Object.freeze([]) })

function observeInput() {
  return {
    session: SESSION,
    track: TRACK,
    referenceTrack: REFERENCE,
    sessionTimebase: SESSION_TIMEBASE,
    sessionFrameRate: rational(t(25), t(1)),
    sessionBounds: SESSION_BOUNDS,
  }
}

/**
 * The diagnostic and the detections, read from where an operator left them.
 *
 * Both are in milliseconds because that is the unit both aggregates store
 * (`domain/sync-diagnostic.ts:69-72`, `sync-marker-detection.ts:112-115`), which is
 * the whole reason the conversion has to happen in the adapter.
 */
function fakeDiagnostics(options = {}) {
  return {
    async readHead() {
      if (!options.manualAnchorsAtSeconds) return null
      return {
        tracks: [{
          trackId: TRACK.trackId,
          manualAnchors: options.manualAnchorsAtSeconds.map((second, index) => ({
            anchorId: `anchor-${index}`,
            origin: 'manual',
            sourceMs: second * 1_000,
            sessionMs: second * 1_000 + (options.offsetMs ?? 500),
            method: 'operator',
            confidence: 0.9,
            residualMs: null,
            evidenceRef: `frame-${index}`,
            createdAt: at(0),
          })),
        }],
      }
    },
    async listDetections() {
      if (!options.markersAtSeconds) return []
      return options.markersAtSeconds.flatMap((second, index) => [
        {
          markerId: `marker-${index}`,
          trackId: REFERENCE.trackId,
          outcome: 'confirmed',
          atMs: second * 1_000 + (options.offsetMs ?? 500),
          confidence: 0.95,
          detectionHash: 'a'.repeat(64),
        },
        {
          markerId: `marker-${index}`,
          trackId: TRACK.trackId,
          outcome: 'confirmed',
          atMs: second * 1_000,
          confidence: 0.9,
          detectionHash: 'b'.repeat(64),
        },
      ])
    },
  }
}

function sourceWith(diagnostics) {
  // The media resolver is never reached: both tracks have no parts.
  return new FfmpegAudioSyncSignalSource({
    media: { async resolve() { throw new Error('no part may be resolved in this suite') } },
    diagnostics,
  })
}

function assess(observations) {
  return evaluateSyncEvidence({
    sessionId: SESSION.sessionId,
    trackId: TRACK.trackId,
    referenceTrackId: REFERENCE.trackId,
    sessionTimebase: SESSION_TIMEBASE,
    sessionFrameRate: rational(t(25), t(1)),
    sessionBounds: SESSION_BOUNDS,
    signals: observations,
  })
}

test('T-F4.012 manual anchors are published in the unit the cascade compares in', async () => {
  // The defect: the observation declared MILLISECOND_TIMEBASE while
  // `anchorDistribution` reads `anchor.sessionTick` raw against session bounds
  // (`sync-evidence.ts:628`, :502-522) — the same mismatch `correlatePair`
  // documents and works around for the audio path 200 lines earlier. Three
  // anchors spread over ten minutes of a 90 kHz session landed inside its first
  // 0.6 s: `anchorThirdsOccupied` came back 1 where 2 are required, and the
  // elected manual anchor was demoted from auto-apply to review with that false
  // reason persisted in the evidence record.
  const source = sourceWith(fakeDiagnostics({ manualAnchorsAtSeconds: [30, 300, 570] }))
  const observations = await source.observe(observeInput())

  assert.equal(observations.length, 1)
  const manual = observations[0]
  assert.equal(manual.method, 'manual-anchor')
  assert.deepEqual({ ...manual.timebase.secondsPerTick }, { ...SESSION_TIMEBASE.secondsPerTick })
  // 30 s at 90 kHz, not 30000.
  assert.equal(manual.anchors[0].sourceTick, t(30 * 90_000))
  assert.equal(manual.anchors[2].sessionTick, t(570 * 90_000 + 45_000))
  assert.equal(manual.offsetTicks, t(45_000), 'half a second, counted in session ticks')

  const record = assess(observations)
  const assessment = record.assessments[0]
  assert.equal(assessment.anchorThirdsOccupied, 3, 'start, middle and end were all seen')
  assert.ok(assessment.anchorSpanRatio > 0.85, `span ratio ${assessment.anchorSpanRatio}`)
  assert.deepEqual(
    assessment.autoApplyBlockers.filter((entry) => entry.includes('third')),
    [],
    'a distribution gate the anchors satisfied may not block the verdict',
  )
  assert.equal(record.outcome, 'auto-apply')
  console.log(
    `T-F4.012 manual anchors: thirds=${assessment.anchorThirdsOccupied} span=${assessment.anchorSpanRatio} ` +
    `coverage=${assessment.coverageRatio} offset=${assessment.sessionOffsetTicks}t outcome=${record.outcome} ` +
    `blockers=[${assessment.autoApplyBlockers.join('; ')}]`,
  )
})

test('T-F4.012 an anchor set clustered in one third is still reported as clustered', async () => {
  // The falsification of the case above. If the conversion had simply made
  // every set look well spread, the fix would have replaced a false refusal
  // with a false approval — which is worse.
  // Thirty seconds apart, which is enough support to stay admissible — the
  // point is the distribution gate, and a set the coverage floor threw out
  // first would not exercise it.
  const source = sourceWith(fakeDiagnostics({ manualAnchorsAtSeconds: [10, 25, 40] }))
  const record = assess(await source.observe(observeInput()))
  const assessment = record.assessments[0]

  assert.deepEqual([...assessment.inadmissibleReasons], [], 'the signal is admissible; only its spread is poor')
  assert.equal(assessment.anchorThirdsOccupied, 1)
  assert.ok(
    assessment.autoApplyBlockers.some((entry) => entry.includes('third')),
    `three anchors inside thirty seconds must still be called clustered: ${assessment.autoApplyBlockers}`,
  )
  assert.equal(record.outcome, 'review')
})

test('T-F4.012 confirmed markers are paired across tracks and published in session ticks', async () => {
  const source = sourceWith(fakeDiagnostics({ markersAtSeconds: [20, 290, 580], offsetMs: 500 }))
  const observations = await source.observe(observeInput())
  const marker = observations.find((entry) => entry.method === 'apollo-marker')

  assert.ok(marker, 'a marker confirmed on both tracks is a correspondence')
  assert.deepEqual({ ...marker.timebase.secondsPerTick }, { ...SESSION_TIMEBASE.secondsPerTick })
  assert.equal(marker.anchors.length, 3)
  assert.equal(marker.offsetTicks, t(45_000))

  const record = assess(observations)
  const assessment = record.assessments.find((entry) => entry.method === 'apollo-marker')
  assert.equal(assessment.anchorThirdsOccupied, 3)
  // And the honest limitation the adapter documents: the cascade demands
  // ambiguity evidence from any method that locates by searching, and
  // `MarkerDetection` did not keep the peak and its runner-up. The observation
  // is therefore still discarded — but for the true reason, not for a
  // distribution it satisfied.
  assert.deepEqual([...assessment.inadmissibleReasons], ['ambiguity-evidence-missing'])
})

test('T-F4.012 a marker seen on only one track is a timestamp, not a correspondence', async () => {
  const oneSided = fakeDiagnostics({ markersAtSeconds: [20, 290, 580] })
  const source = sourceWith({
    readHead: oneSided.readHead,
    async listDetections() {
      const all = await oneSided.listDetections()
      return all.filter((entry) => entry.trackId === TRACK.trackId)
    },
  })
  const observations = await source.observe(observeInput())
  assert.deepEqual([...observations], [], 'nothing pairs, so nothing is claimed')
})

test('T-F4.012 a correlation with no runner-up at all is perfect separation, not zero', async () => {
  // Reported as `Infinity`, this went into `confidenceFromPeakRatio`, whose
  // first guard rejects every non-finite ratio and returns 0 — under the 0.35
  // admission floor. The single strongest measurement the adapter can make was
  // being discarded as `confidence-below-floor`.
  assert.equal(reportablePeakRatio(0.94, 0), MAXIMUM_REPORTABLE_PEAK_RATIO)
  assert.equal(confidenceFromPeakRatio(reportablePeakRatio(0.94, 0)) > 0.98, true)
  assert.ok(
    confidenceFromPeakRatio(reportablePeakRatio(0.94, 0)) >=
      DEFAULT_SYNC_EVIDENCE_THRESHOLDS.minimumConfidenceForAutoApply,
    'perfect separation must clear the floor it used to fail',
  )
  // The ordinary cases are unchanged, and the clamp still caps.
  assert.equal(reportablePeakRatio(0.64, 0.01), 64)
  assert.equal(reportablePeakRatio(1, 1e-9), MAXIMUM_REPORTABLE_PEAK_RATIO)
  assert.equal(reportablePeakRatio(0, 0), 0, 'no peak is no measurement, not perfect separation')
  assert.equal(confidenceFromPeakRatio(reportablePeakRatio(0, 0)), 0)
})
