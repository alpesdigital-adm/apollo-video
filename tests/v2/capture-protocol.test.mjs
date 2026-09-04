import assert from 'node:assert/strict'
import test from 'node:test'

import {
  addCaptureSessionTrack,
  addCaptureSessionTrackPart,
  createCaptureSession,
} from '../../src/v2/domain/capture-session.ts'
import {
  assertCaptureProtocolIntegrity,
  createCaptureProtocol,
} from '../../src/v2/domain/capture-protocol.ts'
import {
  PUBLISHED_CAPTURE_PROTOCOLS,
  currentProtocolForScenario,
  findCaptureProtocol,
} from '../../src/v2/domain/capture-protocol-catalog.ts'
import {
  assertCaptureProtocolEvaluationIntegrity,
  evaluateCaptureProtocol,
  outstandingRequirements,
} from '../../src/v2/domain/capture-protocol-evaluation.ts'
import { createTickInterval, timebaseFromRate } from '../../src/v2/domain/session-time.ts'

const t = (n) => BigInt(n)
const sec = (n) => t(90_000) * t(n)
const at = (second) => new Date(Date.parse('2029-04-01T09:00:00.000Z') + second * 1000).toISOString()
const h = (n) => String(n).repeat(64).slice(0, 64)

function part(overrides = {}) {
  return {
    partId: 'part-1',
    ordinal: 0,
    sourceAssetId: 'asset-1',
    timebase: timebaseFromRate(90_000),
    coverage: createTickInterval(t(0), sec(600)),
    streamIndex: 0,
    splitReason: 'single-file',
    evidence: {
      ingestArtifactId: 'artifact-1',
      ingestSha256: h(1),
      probeHash: h(2),
      probeSource: 'packet-scan',
      observedAt: at(0),
    },
    ...overrides,
  }
}

function track(overrides = {}) {
  const first = overrides.firstPart ?? part(overrides.partOverrides ?? {})
  const { firstPart, partOverrides, ...rest } = overrides
  return {
    trackId: 'track-camera-main',
    role: 'camera-main',
    device: { deviceId: 'device-a', recorderId: 'recorder-a', make: null, model: null, serial: null },
    sourceAssetId: first.sourceAssetId,
    timebase: timebaseFromRate(90_000),
    streamIndex: 0,
    syncAudioPolicy: 'final-candidate',
    includeInFinalMix: true,
    parts: [first],
    ...rest,
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

/** A teacher session: camera plus a screen recording that kept its audio. */
function teacherSession(options = {}) {
  const base = createCaptureSession({
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    sessionId: 'capture-session-1',
    clock: { timebase: timebaseFromRate(90_000), rounding: 'nearest-half-even' },
    referenceTrackId: 'track-camera-main',
    tracks: [track()],
    lineage: LINEAGE,
    createdAt: at(0),
  })
  const screen = addCaptureSessionTrack(base, {
    track: track({
      trackId: 'track-screen',
      role: 'screen',
      device: { deviceId: 'device-screen', recorderId: 'recorder-screen', make: null, model: null, serial: null },
      syncAudioPolicy: options.screenAudio ?? 'sync-only',
      includeInFinalMix: false,
      partOverrides: { partId: 'part-screen-1', sourceAssetId: 'asset-screen' },
    }),
    lineage: { ...LINEAGE, operation: 'add-track', commandId: 'command-2' },
  })
  if (!options.screenRestart) return screen
  return addCaptureSessionTrackPart(screen, {
    trackId: 'track-screen',
    part: part({
      partId: 'part-screen-2',
      ordinal: 1,
      sourceAssetId: 'asset-screen-2',
      coverage: createTickInterval(sec(610), sec(1_200)),
      splitReason: 'recorder-restart',
    }),
    lineage: { ...LINEAGE, operation: 'add-track-part', commandId: 'command-3' },
  })
}

function evaluate(session, options = {}) {
  return evaluateCaptureProtocol({
    workspaceId: 'workspace-1',
    protocol: currentProtocolForScenario('teacher-and-screen'),
    session,
    markers: { confirmedPositions: options.markers ?? ['start', 'end'] },
    attestedRequirementIds: options.attested,
    evaluatedAt: at(60),
  })
}

test('T-FR-147 the four scenarios are published, versioned and content-addressed', () => {
  assert.equal(PUBLISHED_CAPTURE_PROTOCOLS.length, 4)
  const scenarios = PUBLISHED_CAPTURE_PROTOCOLS.map((protocol) => protocol.scenario).sort()
  assert.deepEqual(scenarios, ['multicam', 'podcast', 'react', 'teacher-and-screen'])

  for (const protocol of PUBLISHED_CAPTURE_PROTOCOLS) {
    assert.equal(assertCaptureProtocolIntegrity(protocol), protocol)
    assert.equal(protocol.version, 1)
    assert.ok(protocol.protocolHash.length === 64)
  }
  assert.equal(findCaptureProtocol('podcast-v1').scenario, 'podcast')
  assert.throws(() => findCaptureProtocol('does-not-exist'), /is not published/)
})

test('T-FR-147 a required item must name what stops being possible without it', () => {
  // The rule that keeps this from becoming a wish list. If skipping something
  // costs nothing, it is a preference wearing the wrong label.
  assert.throws(
    () => createCaptureProtocol({
      protocolId: 'bad-protocol',
      scenario: 'podcast',
      version: 1,
      title: 'Bad',
      summary: 'A protocol whose required item costs nothing when it is skipped.',
      bestCeiling: 'automatic',
      expectedTracks: [{ role: 'camera-main', minimum: 1, maximum: null, mustCarryAudio: true, note: 'x' }],
      requirements: [{
        requirementId: 'looks-nice',
        level: 'required',
        verification: 'observed',
        check: { kind: 'track-present', role: 'camera-main', minimum: 1 },
        statement: 'Please frame the shot nicely and keep the background tidy.',
        losesCapabilities: [],
        consequence: 'Nothing measurable is lost, which is why this must not be required.',
      }],
      publishedAt: at(0),
    }),
    /required but names nothing that is lost without it/,
  )

  // Every published required requirement does name one.
  for (const protocol of PUBLISHED_CAPTURE_PROTOCOLS) {
    for (const requirement of protocol.requirements) {
      if (requirement.level !== 'required') continue
      assert.ok(
        requirement.losesCapabilities.length > 0,
        `${protocol.protocolId}/${requirement.requirementId} is required and names no cost`,
      )
    }
  }
})

test('T-FR-147 a requirement cannot claim to be observed while only being attested', () => {
  // Otherwise a human sentence would be read downstream as a measurement.
  assert.throws(
    () => createCaptureProtocol({
      protocolId: 'lying-protocol',
      scenario: 'podcast',
      version: 1,
      title: 'Lying',
      summary: 'A protocol whose label and check disagree about what can be seen.',
      bestCeiling: 'automatic',
      expectedTracks: [{ role: 'camera-main', minimum: 1, maximum: null, mustCarryAudio: true, note: 'x' }],
      requirements: [{
        requirementId: 'wore-headphones',
        level: 'recommended',
        verification: 'observed',
        check: { kind: 'operator-attestation' },
        statement: 'Wear headphones so the computer audio does not return through the microphone.',
        losesCapabilities: ['audio-fingerprint'],
        consequence: 'Bleed creates a false correlation between tracks that are not aligned.',
      }],
      publishedAt: at(0),
    }),
    /disagrees with its own check about whether it can be observed/,
  )
})

test('T-FR-147 a compliant session reaches the protocol ceiling with nothing lost', () => {
  const evaluation = evaluate(teacherSession(), { attested: ['headphones'] })
  assert.equal(evaluation.ceiling, 'automatic')
  assert.equal(evaluation.blocksAutoEdit, false)
  assert.deepEqual([...evaluation.lostCapabilities], [])
  assert.deepEqual([...evaluation.attestedRequirementIds], ['headphones'])
  assert.deepEqual([...outstandingRequirements(evaluation)], [])
  assert.equal(assertCaptureProtocolEvaluationIntegrity(evaluation), evaluation)
})

test('T-FR-147 a muted screen recording loses fingerprinting and blocks auto-edit', () => {
  // The scenario the protocol exists to warn about, stated as a consequence
  // rather than as a warning nobody reads.
  const evaluation = evaluate(teacherSession({ screenAudio: 'none' }), { attested: ['headphones'] })
  const finding = evaluation.findings.find((entry) => entry.requirementId === 'screen-carries-audio')
  assert.equal(finding.outcome, 'unmet')
  assert.match(finding.observation, /syncAudioPolicy 'none'/)
  assert.ok(finding.consequence.includes('anchor manual'))
  assert.ok(evaluation.lostCapabilities.includes('audio-fingerprint'))
  assert.equal(evaluation.ceiling, 'manual-anchors-required')
  assert.equal(evaluation.blocksAutoEdit, true)
})

test('T-FR-147 an unmarked restart is detected from the session, not from a claim', () => {
  const evaluation = evaluate(teacherSession({ screenRestart: true }), { attested: ['headphones'] })
  const finding = evaluation.findings.find((entry) => entry.requirementId === 'no-unmarked-restart')
  assert.equal(finding.outcome, 'unmet')
  assert.match(finding.observation, /split across 2 files/)
  assert.ok(evaluation.lostCapabilities.includes('continuous-piecewise-map'))
  assert.equal(evaluation.blocksAutoEdit, true)
})

test('T-FR-147 markers come from the detector, never from the request', () => {
  const withMarkers = evaluate(teacherSession(), { markers: ['start', 'end'], attested: ['headphones'] })
  assert.equal(withMarkers.ceiling, 'automatic')

  // No marker detected: two required items fail and the ceiling drops. The
  // caller has no way to assert them into existence — the only input is what
  // the detector confirmed.
  const withoutMarkers = evaluate(teacherSession(), { markers: [], attested: ['headphones'] })
  const start = withoutMarkers.findings.find((entry) => entry.requirementId === 'start-marker')
  assert.equal(start.outcome, 'unmet')
  assert.ok(withoutMarkers.lostCapabilities.includes('marker-correlation'))
  assert.ok(withoutMarkers.lostCapabilities.includes('drift-measurement'))
  assert.equal(withoutMarkers.blocksAutoEdit, true)
})

test('T-FR-147 losing every automatic path is reported as not-synchronizable', () => {
  // Worse than needing anchors: there is no automatic route left at all, and
  // saying "manual anchors required" would be optimistic rather than cautious.
  const evaluation = evaluate(teacherSession({ screenAudio: 'none' }), { markers: [], attested: [] })
  assert.ok(evaluation.lostCapabilities.includes('audio-fingerprint'))
  assert.ok(evaluation.lostCapabilities.includes('marker-correlation'))
  assert.equal(evaluation.ceiling, 'not-synchronizable')
  assert.equal(evaluation.blocksAutoEdit, true)
})

test('T-FR-147 an attestation cannot answer a requirement the session can be read for', () => {
  // The whole point of deriving from the session: a client must not be able to
  // declare its own compliance on something observable.
  assert.throws(
    () => evaluate(teacherSession({ screenAudio: 'none' }), { attested: ['screen-carries-audio'] }),
    /is observed from the session and cannot be attested/,
  )
  assert.throws(
    () => evaluate(teacherSession(), { attested: ['not-a-requirement'] }),
    /is not part of protocol/,
  )
})

test('T-FR-147 a missing attestation is as blocking as an unmet observation, and is labelled', () => {
  const evaluation = evaluate(teacherSession(), { attested: [] })
  const finding = evaluation.findings.find((entry) => entry.requirementId === 'headphones')
  assert.equal(finding.outcome, 'attestation-missing')
  assert.ok(evaluation.lostCapabilities.includes('audio-fingerprint'))
  // Nobody said it was true and the media cannot say, so the capability is
  // treated as gone rather than assumed present.
  assert.equal(evaluation.ceiling, 'automatic-with-review')
  assert.deepEqual([...evaluation.attestedRequirementIds], [])
})

test('T-FR-147 an evaluation names the exact session version it judged, and is tamper-evident', () => {
  const session = teacherSession()
  const evaluation = evaluate(session, { attested: ['headphones'] })
  assert.equal(evaluation.sessionVersion, session.version)
  assert.equal(evaluation.sessionHash, session.sessionHash)
  assert.equal(evaluation.protocolHash, currentProtocolForScenario('teacher-and-screen').protocolHash)

  // A value that actually differs. The first version of this assertion set
  // `ceiling` to 'automatic' on an evaluation whose ceiling already was
  // 'automatic' — it changed nothing, so the hash matched and the test proved
  // nothing while appearing to pass.
  assert.throws(
    () => assertCaptureProtocolEvaluationIntegrity({ ...evaluation, ceiling: 'not-synchronizable' }),
    /hash/,
  )
  // Same trap, one line down: this evaluation already has blocksAutoEdit
  // false, so setting it to false asserted nothing. Flipping it to true is
  // what the hash has to catch.
  assert.throws(
    () => assertCaptureProtocolEvaluationIntegrity({ ...evaluation, blocksAutoEdit: true }),
    /hash/,
  )
})

test('T-FR-147 a session from another workspace is refused outright', () => {
  assert.throws(
    () => evaluateCaptureProtocol({
      workspaceId: 'workspace-other',
      protocol: currentProtocolForScenario('teacher-and-screen'),
      session: teacherSession(),
      evaluatedAt: at(60),
    }),
    /must judge a session from its own workspace/,
  )
})
