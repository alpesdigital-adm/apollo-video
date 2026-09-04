import assert from 'node:assert/strict'
import test from 'node:test'

import { runCaptureSyncWorker } from '../../src/v2/application/run-capture-sync-worker.ts'
import {
  addCaptureSessionTrack,
  createCaptureSession,
} from '../../src/v2/domain/capture-session.ts'
import { evaluateSyncEvidence } from '../../src/v2/domain/sync-evidence.ts'
import {
  createTickInterval,
  rational,
  timebaseFromRate,
} from '../../src/v2/domain/session-time.ts'
import { presentSyncTrack } from '../../src/v2/public-api/capture-session-contract.ts'

/**
 * E2E — the session that cannot be synchronized, and says so.
 *
 * This is the journey the whole wave is built to make survivable. A phone
 * recorded in a different room; there is no shared timecode, no marker, no
 * common acoustic event, and the transcript has nothing to align to. Every
 * plausible answer here is worse than admitting there is none:
 *
 * - an offset of zero says the recordings line up, and an editor will cut on it;
 * - a best guess with low confidence gets rounded to "probably fine" by the
 *   next system that reads it;
 * - a hard failure loses the reference track's own perfectly good material.
 *
 * So the cascade returns `insufficient-evidence`, the worker persists it, no
 * map is written, and the run still *succeeds* — because the question was
 * answered. The answer was "we could not tell".
 */

const t = (n) => BigInt(n)
const HZ = t(90_000)
const sec = (n) => HZ * t(n)
const at = (second) => new Date(Date.parse('2029-04-01T09:00:00.000Z') + second * 1000).toISOString()
const h = (n) => String(n).repeat(64).slice(0, 64)

const SESSION_TB = timebaseFromRate(90_000)
const NTSC = rational(BigInt(30_000), BigInt(1_001))

function part(partId, sourceAssetId) {
  return {
    partId,
    ordinal: 0,
    sourceAssetId,
    timebase: SESSION_TB,
    coverage: createTickInterval(t(0), sec(600)),
    streamIndex: 0,
    splitReason: 'single-file',
    evidence: {
      ingestArtifactId: `artifact-${partId}`,
      ingestSha256: h(1),
      probeHash: h(2),
      probeSource: 'packet-scan',
      observedAt: at(5),
    },
  }
}

function track(trackId, role, sourceAssetId, deviceId) {
  return {
    trackId,
    role,
    device: { deviceId, recorderId: `${deviceId}-r`, make: null, model: null, serial: null },
    sourceAssetId,
    timebase: SESSION_TB,
    streamIndex: 0,
    syncAudioPolicy: role === 'camera-main' ? 'final-candidate' : 'sync-only',
    includeInFinalMix: role === 'camera-main',
    parts: [part(`part-${trackId}`, sourceAssetId)],
  }
}

const LINEAGE = {
  commandId: 'command-1',
  operation: 'create-session',
  actorKind: 'human',
  actorId: 'user-1',
  occurredAt: at(0),
  note: null,
}

function session() {
  const base = createCaptureSession({
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    sessionId: 'capture-session-no-evidence',
    clock: { timebase: SESSION_TB, rounding: 'nearest-half-even' },
    referenceTrackId: 'track-camera-main',
    tracks: [track('track-camera-main', 'camera-main', 'asset-camera', 'device-a')],
    lineage: LINEAGE,
    createdAt: at(0),
  })
  return addCaptureSessionTrack(base, {
    track: track('track-phone', 'phone', 'asset-phone', 'device-phone'),
    lineage: { ...LINEAGE, operation: 'add-track', commandId: 'command-2' },
  })
}

function fakeSessions(current) {
  const evidence = []
  const maps = []
  return {
    evidence,
    maps,
    async readHead() { return current },
    async readVersion() { return current },
    async listVersions() { return [current] },
    async listHeads() { return [] },
    async persistClock() { throw new Error('unused') },
    async readClock() { return null },
    async persistClockMap(input) { maps.push(input.map); return { map: input.map, replayed: false } },
    async readClockMap() { return null },
    async listClockMaps() { return maps },
    async persistCoverage(input) { return { coverage: input.coverage, replayed: false } },
    async readCoverage() { return null },
    async listCoverage() { return [] },
    async persistSyncEvidence(input) { evidence.push(input.record); return { record: input.record, replayed: false } },
    async readSyncEvidence() { return evidence[0] ?? null },
    async listSyncEvidence() { return evidence },
    async appendVersion() { throw new Error('unused') },
  }
}

function fakeRuns(baseSessionHash) {
  const state = { settled: null }
  const run = {
    id: 'capture-sync-run-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    sessionId: 'capture-session-no-evidence',
    baseVersionId: 'capture-session-no-evidence:v2',
    baseSessionHash,
    baseVersion: 2,
    status: 'running',
    fencingToken: t(1),
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
  }
  return {
    state,
    async claim() { return { run, leaseToken: 'lease-1' } },
    async heartbeat() { return true },
    async settle(input) { state.settled = input.outcome; return { settled: true, run } },
    async request() { throw new Error('unused') },
    async read() { return run },
    async readLatestForSession() { return run },
  }
}

/**
 * Signals that were all attempted and none of which is admissible.
 *
 * Each one fails for its own reason, and the record keeps all of them: an
 * operator deciding whether to place a manual anchor needs to know that the
 * audio was tried and found nothing, not merely that "sync failed".
 */
function attemptedButUnusable() {
  return {
    async observe() {
      return [
        {
          signalId: 'signal-fingerprint-1',
          method: 'audio-fingerprint',
          timebase: SESSION_TB,
          offsetTicks: t(122_300),
          anchors: [
            { anchorId: 'a-1', sourceTick: t(0), sessionTick: t(122_300), evidenceRef: 'probe-fp-1' },
          ],
          preconditions: [
            { id: 'both-tracks-carry-audio', satisfied: true, detail: 'both carry audio' },
            // The room was different. There is no event in common to align on.
            { id: 'common-acoustic-event', satisfied: false, detail: 'no shared transient above the noise floor' },
          ],
          // And even the peak it did find is barely better than the runner-up:
          // the search could have picked either.
          ambiguity: { bestPeak: 0.31, secondBestPeak: 0.29, windowsConsidered: 64, windowsAgreeing: 9 },
          coverage: [createTickInterval(t(0), sec(600))],
          residualTicks: t(41_000),
          confidence: 0.22,
          independenceGroup: 'audio',
          evidenceRefs: ['probe-fp-1'],
        },
        {
          signalId: 'signal-transcript-1',
          method: 'transcript-lip',
          timebase: SESSION_TB,
          offsetTicks: t(9_100),
          anchors: [
            { anchorId: 'a-2', sourceTick: t(0), sessionTick: t(9_100), evidenceRef: 'probe-lip-1' },
          ],
          preconditions: [
            { id: 'speech-present', satisfied: true, detail: 'speech detected in both' },
            { id: 'transcript-aligned-to-media', satisfied: false, detail: 'the transcript is not time-aligned' },
          ],
          coverage: [createTickInterval(t(0), sec(120))],
          residualTicks: t(18_000),
          confidence: 0.18,
          independenceGroup: 'transcript',
          evidenceRefs: ['probe-lip-1'],
        },
      ]
    },
  }
}

test('E2E-FR-142 the cascade refuses rather than emitting an unfounded offset', () => {
  const current = session()
  const record = evaluateSyncEvidence({
    sessionId: current.sessionId,
    trackId: 'track-phone',
    referenceTrackId: 'track-camera-main',
    sessionTimebase: SESSION_TB,
    sessionFrameRate: NTSC,
    sessionBounds: createTickInterval(t(0), sec(600)),
    signals: [],
  })
  assert.equal(record.outcome, 'insufficient-evidence')
  // The load-bearing assertion of the whole wave: no map, not a zero map.
  assert.equal(record.clockMap, null)
  assert.equal(record.selectedMethod, null)
  assert.equal(record.manualRequired, true)
})

test('E2E-FR-142 signals that were tried and failed are kept, not summarised away', async () => {
  const current = session()
  const sessions = fakeSessions(current)
  const runs = fakeRuns(current.sessionHash)

  const result = await runCaptureSyncWorker({
    sessions,
    runs,
    signals: attemptedButUnusable(),
    owner: 'worker-1',
    clock: () => new Date(at(10)),
  })()

  assert.equal(result.insufficient, 1)
  assert.equal(result.resolved, 0)
  assert.equal(result.review, 0)
  assert.equal(sessions.maps.length, 0, 'a refusal must leave no map behind')

  const [record] = sessions.evidence
  assert.equal(record.outcome, 'insufficient-evidence')
  assert.equal(record.clockMap, null)

  // Both attempts survive in the record. An operator about to place a manual
  // anchor needs to know the audio was tried and found nothing — "sync failed"
  // alone would send them to look for a bug instead of a clapperboard.
  const discardedIds = record.discarded.map((entry) => entry.signalId)
  assert.equal(discardedIds.length, 2)
  assert.ok(discardedIds.includes('signal-fingerprint-1'))
  assert.ok(discardedIds.includes('signal-transcript-1'))
  for (const entry of record.discarded) {
    assert.ok(entry.reason.length > 0, `${entry.signalId} must say why it was discarded`)
  }
  assert.ok(record.outcomeReasons.length > 0)
})

test('E2E-FR-142 the run succeeds: the question was answered, and the answer was "we cannot tell"', async () => {
  const current = session()
  const sessions = fakeSessions(current)
  const runs = fakeRuns(current.sessionHash)

  await runCaptureSyncWorker({
    sessions,
    runs,
    signals: attemptedButUnusable(),
    owner: 'worker-1',
    clock: () => new Date(at(10)),
  })()

  // Not 'failed'. A failed run gets retried, and retrying will produce the same
  // refusal for the same reason — the evidence is missing, not flaky.
  assert.equal(runs.state.settled.status, 'succeeded')
  assert.equal(runs.state.settled.insufficientCount, 1)
  assert.equal(runs.state.settled.resolvedCount, 0)
  assert.equal(
    runs.state.settled.resolvedCount + runs.state.settled.reviewCount + runs.state.settled.insufficientCount,
    1,
    'the counts must account for every track the run was asked about',
  )
})

test('E2E-FR-142 the API view carries the refusal forward without softening it', async () => {
  const current = session()
  const sessions = fakeSessions(current)
  const runs = fakeRuns(current.sessionHash)

  await runCaptureSyncWorker({
    sessions,
    runs,
    signals: attemptedButUnusable(),
    owner: 'worker-1',
    clock: () => new Date(at(10)),
  })()

  const view = presentSyncTrack({ record: sessions.evidence[0], map: null, coverage: null })
  assert.equal(view.outcome, 'insufficient-evidence')
  assert.equal(view.map, null)
  assert.equal(view.manualRequired, true)
  assert.equal(view.selectedMethod, null)
  // A client cannot mistake this for an alignment: there is no offset field to
  // read as zero, and no map object to walk.
  assert.equal(Object.prototype.hasOwnProperty.call(view, 'offsetTicks'), false)
  assert.ok(view.outcomeReasons.length > 0)
})
