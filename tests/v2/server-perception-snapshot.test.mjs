import assert from 'node:assert/strict'
import test from 'node:test'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { putPerceptionTimelineService } from '../../src/v2/application/perception-timelines.ts'
import { calculateCanonicalHash, stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { frameRangesToCoverageMs, frameSpanToMs, perceptionDurationMs } from '../../src/v2/domain/perception-frame-time.ts'
import { createPerceptionTimeline, PERCEPTION_GOLDEN_FIXTURES, PERCEPTION_KINDS } from '../../src/v2/domain/perception-timeline.ts'
import { expectedOcrTimeline } from '../../src/v2/domain/projected-ocr-timeline.ts'
import {
  assembleServerPerceptionSnapshot, editPlanSourceTimeMap, ocrEnvelopeSealIntact, queryServerPerceptionSnapshot,
  serverPerceptionSnapshotId, temporalEnvelopeSealIntact, verifyServerPerceptionSnapshot,
} from '../../src/v2/domain/server-perception-snapshot.ts'
import {
  assemblyBase, cutClips, digest, FPS, ocrEnvelope, sha, temporalAnalysis, temporalEnvelope, transcriptRef, transcriptWords, wholeClips,
} from './helpers/perception-snapshot-fixtures.mjs'
import { sealedSourceWindow } from './helpers/face-source-envelope-v3.mjs'

const FACE_ROWS = [[0.9, 0.2, 0.1, 0.4, 0.6]]
const coverageOf = (snapshot, kind) => snapshot.timeline.coverage.find((entry) => entry.kind === kind)
const observationsOf = (snapshot, kind) => snapshot.timeline.observations.filter((item) => item.kind === kind)
const rejectedReasons = (snapshot, kind) => snapshot.rejected.filter((item) => item.kind === kind).flatMap((item) => item.reasonCodes)
const faceWindow = (options = {}) => sealedSourceWindow({ start: 0, end: 150, interval: 5, rowsAt: (frame) => frame % 10 === 0 ? FACE_ROWS : [], ...options })

function fullAssembly(overrides = {}) {
  const clips = overrides.clips ?? wholeClips()
  return assemblyBase({
    clips,
    extra: {
      transcript: { transcript: transcriptRef(), words: transcriptWords({ clips }) },
      ocr: [ocrEnvelope({ clips, frames: [0, 30, 60, 90].filter((frame) => frame < clips.at(-1).timelineOutFrame) })],
      temporal: [temporalEnvelope({ clips, unreliableAt: [10, 11] })],
      faceWindows: [faceWindow()],
      ...overrides.extra,
    },
  })
}

test('W63a the snapshot fuses words, OCR, temporal and face onto the EditPlan clock and states what each kind examined', () => {
  const snapshot = assembleServerPerceptionSnapshot(fullAssembly())
  assert.equal(snapshot.schemaVersion, 'server-perception-snapshot/v1')
  assert.equal(snapshot.authority, 'server-assembled')
  assert.equal(snapshot.faceSafety, 'unknown')
  assert.equal(snapshot.timeline.inventedValues, 0)
  assert.equal(snapshot.timeline.durationMs, 5_000)
  assert.deepEqual(snapshot.timeBase, { unit: 'ms', frameToMs: 'round-nearest', fps: 30, durationFrames: 150, durationMs: 5_000 })
  assert.deepEqual(snapshot.timeline.coverage.map((entry) => entry.kind), PERCEPTION_KINDS)
  const states = Object.fromEntries(snapshot.timeline.coverage.map((entry) => [entry.kind, entry.state]))
  assert.deepEqual(states, {
    'transcript-word': 'partial', speaker: 'absent', silence: 'absent', face: 'partial', object: 'absent',
    shot: 'partial', motion: 'partial', ocr: 'partial', 'image-insert': 'absent',
  })
  for (const kind of ['transcript-word', 'face', 'shot', 'motion', 'ocr']) assert.ok(observationsOf(snapshot, kind).length > 0, kind)
  // The kinds no producer bound to a version exists for say why; nothing fills them.
  assert.equal(coverageOf(snapshot, 'object').reasonCode, 'NO_VERIFIED_DETECTOR')
  assert.equal(coverageOf(snapshot, 'speaker').reasonCode, 'DIARIZATION_UNAVAILABLE')
  assert.equal(coverageOf(snapshot, 'silence').reasonCode, 'SILENCE_PRODUCER_UNAVAILABLE')
  assert.equal(coverageOf(snapshot, 'image-insert').reasonCode, 'INSERT_GEOMETRY_NOT_COMPILED')
  for (const kind of ['object', 'speaker', 'silence', 'image-insert']) assert.equal(observationsOf(snapshot, kind).length, 0)
  // Every observation names the server and an input the snapshot lists.
  const inputs = new Set(snapshot.inputs.map((input) => `${input.envelopeId}|${input.envelopeHash}`))
  for (const observation of snapshot.timeline.observations) {
    assert.equal(observation.provenance.origin, 'server')
    assert.ok(inputs.has(`${observation.provenance.envelopeId}|${observation.provenance.envelopeHash}`), observation.id)
  }
  assert.deepEqual(snapshot.inputs.map((input) => input.kind), ['face', 'ocr', 'temporal', 'transcript'])
  assert.deepEqual(snapshot.rejected, [])
  assert.match(snapshot.snapshotHash, /^[a-f0-9]{64}$/)
  assert.equal(serverPerceptionSnapshotId(snapshot.snapshotHash), `perception-snapshot-${snapshot.snapshotHash.slice(0, 40)}`)
  // The stored shape rebuilds to the very same bytes.
  assert.equal(stableSerialize(verifyServerPerceptionSnapshot(JSON.parse(JSON.stringify(snapshot)))), stableSerialize(snapshot))
})

test('W63a a kind that nobody ran is absent with its reason, and never becomes complete because another kind has coverage', () => {
  const onlyTemporal = assembleServerPerceptionSnapshot(assemblyBase({ extra: { temporal: [temporalEnvelope()] } }))
  assert.equal(coverageOf(onlyTemporal, 'shot').state, 'partial')
  assert.equal(coverageOf(onlyTemporal, 'motion').state, 'partial')
  for (const kind of ['ocr', 'face']) {
    assert.equal(coverageOf(onlyTemporal, kind).state, 'absent')
    assert.equal(coverageOf(onlyTemporal, kind).observedMs, 0)
    assert.equal(coverageOf(onlyTemporal, kind).reasonCode, 'NO_PRODUCER_RUN')
  }
  assert.equal(coverageOf(onlyTemporal, 'transcript-word').reasonCode, 'NO_TRANSCRIPT_WORDS')
  // Not even a snapshot with nothing in it declares anything complete.
  const empty = assembleServerPerceptionSnapshot(assemblyBase())
  assert.deepEqual(empty.timeline.coverage.map((entry) => entry.state), PERCEPTION_KINDS.map(() => 'absent'))
  assert.ok(empty.timeline.coverage.every((entry) => /^[A-Z][A-Z0-9_]+$/.test(entry.reasonCode)))
  assert.equal(empty.timeline.observations.length, 0)
})

test('W63a complete means every frame of the version was examined, and nothing less', () => {
  const clips = wholeClips('source-1', 60)
  const sampledAll = assembleServerPerceptionSnapshot(assemblyBase({ clips, extra: {
    ocr: [ocrEnvelope({ clips, frames: Array.from({ length: 60 }, (_unused, index) => index) })] } }))
  assert.equal(coverageOf(sampledAll, 'ocr').state, 'complete')
  assert.deepEqual(coverageOf(sampledAll, 'ocr').ranges, [[0, 2_000]])
  assert.equal(coverageOf(sampledAll, 'ocr').reasonCode, undefined)
  const missingLast = assembleServerPerceptionSnapshot(assemblyBase({ clips, extra: {
    ocr: [ocrEnvelope({ clips, frames: Array.from({ length: 59 }, (_unused, index) => index) })] } }))
  assert.equal(coverageOf(missingLast, 'ocr').state, 'partial')
  assert.equal(coverageOf(missingLast, 'ocr').reasonCode, 'SAMPLED_FRAMES_ONLY')
  // Frame ranges that touch in frames touch in milliseconds: no phantom gap, no phantom overlap.
  assert.deepEqual(frameRangesToCoverageMs([{ startFrame: 0, endFrame: 7 }, { startFrame: 7, endFrame: 150 }], 30, 150, 5_000), [[0, 5_000]])
  assert.deepEqual(frameSpanToMs({ startFrame: 149, endFrame: 150 }, 30, 150, 5_000), [4_967, 5_000])
  assert.equal(perceptionDurationMs(100, 30), 3_334)
  // The adjacent-frame producers can never examine the last frame of their window.
  const temporal = assembleServerPerceptionSnapshot(assemblyBase({ extra: { temporal: [temporalEnvelope()] } }))
  assert.equal(coverageOf(temporal, 'shot').state, 'partial')
  assert.deepEqual(coverageOf(temporal, 'shot').ranges, [[0, 4_967]])
  const transcript = assembleServerPerceptionSnapshot(assemblyBase({ extra: { transcript: { transcript: transcriptRef(), words: transcriptWords() } } }))
  assert.equal(coverageOf(transcript, 'transcript-word').state, 'partial')
  assert.equal(coverageOf(transcript, 'transcript-word').reasonCode, 'RECOGNIZED_WORD_SPANS_ONLY')
})

test('W63a observations are ordered by start, end, kind and id, whatever order the evidence arrives in', () => {
  const snapshot = assembleServerPerceptionSnapshot(fullAssembly())
  const sorted = snapshot.timeline.observations.toSorted((left, right) =>
    left.startMs - right.startMs || left.endMs - right.endMs ||
    PERCEPTION_KINDS.indexOf(left.kind) - PERCEPTION_KINDS.indexOf(right.kind) || left.id.localeCompare(right.id))
  assert.deepEqual(snapshot.timeline.observations.map((item) => item.id), sorted.map((item) => item.id))
  // A tie on start, end and kind falls to the id: two OCR regions of one frame.
  const twoRegions = ocrEnvelope({ frames: [30] })
  assert.equal(new Set(snapshot.timeline.observations.map((item) => item.id)).size, snapshot.timeline.observations.length)
  const ids = assembleServerPerceptionSnapshot(assemblyBase({ extra: { ocr: [twoRegions] } })).timeline.observations.map((item) => item.id)
  assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)))
})

test('W63a the same evidence in any order gives the same bytes and the same hash', () => {
  const clips = cutClips()
  const first = fullAssembly({ clips, extra: {
    ocr: [ocrEnvelope({ clips, frames: [0, 40], id: 'ocr-envelope-a' }), ocrEnvelope({ clips, frames: [10, 50], id: 'ocr-envelope-b' })],
    temporal: [temporalEnvelope({ clips, id: 'temporal-envelope-a' }), temporalEnvelope({ clips, id: 'temporal-envelope-b', unreliableAt: [95] })],
    faceWindows: [faceWindow({ start: 0, end: 75, id: 'face-window-a' }), faceWindow({ start: 75, end: 150, id: 'face-window-b' })],
  } })
  const reordered = {
    ...first,
    editPlan: { ...first.editPlan, clips: [...first.editPlan.clips].reverse() },
    sources: [...first.sources].reverse(),
    ocr: [...first.ocr].reverse(), temporal: [...first.temporal].reverse(), faceWindows: [...first.faceWindows].reverse(),
  }
  const left = assembleServerPerceptionSnapshot(first)
  const right = assembleServerPerceptionSnapshot(reordered)
  assert.equal(left.snapshotHash, right.snapshotHash)
  assert.equal(stableSerialize(left), stableSerialize(right))
  assert.equal(left.inputs.length, 7)
  // Different evidence is a different snapshot.
  const fewer = assembleServerPerceptionSnapshot({ ...first, faceWindows: first.faceWindows.slice(0, 1) })
  assert.notEqual(fewer.snapshotHash, left.snapshotHash)
})

test('W63a an envelope listed twice is rejected once, and its observations are never doubled', () => {
  const ocr = ocrEnvelope({ frames: [0, 30] })
  const temporal = temporalEnvelope()
  const window = faceWindow()
  const once = assembleServerPerceptionSnapshot(assemblyBase({ extra: { ocr: [ocr], temporal: [temporal], faceWindows: [window] } }))
  const twice = assembleServerPerceptionSnapshot(assemblyBase({ extra: { ocr: [ocr, ocr], temporal: [temporal, temporal], faceWindows: [window, window] } }))
  assert.equal(twice.timeline.observations.length, once.timeline.observations.length)
  assert.deepEqual(twice.rejected.map((item) => [item.kind, item.reasonCodes]),
    [['face', ['DUPLICATE_ENVELOPE']], ['ocr', ['DUPLICATE_ENVELOPE']], ['temporal', ['DUPLICATE_ENVELOPE']]])
  assert.equal(twice.timeline.coverage.find((entry) => entry.kind === 'ocr').observedMs, once.timeline.coverage.find((entry) => entry.kind === 'ocr').observedMs)
  // Observation ids stay unique inside the timeline (the domain refuses a repeated id).
  assert.throws(() => createPerceptionTimeline({ durationMs: 100, origin: 'server',
    observations: [{ ...once.timeline.observations[0], startMs: 0, endMs: 10 }, { ...once.timeline.observations[0], startMs: 0, endMs: 10 }] }),
  /unique/i)
})

test('W63a producer gaps and the unexamined parts of a range are kept, not interpolated', () => {
  const snapshot = assembleServerPerceptionSnapshot(assemblyBase({ extra: { temporal: [temporalEnvelope({ unreliableAt: [10, 11] })] } }))
  const temporal = snapshot.inputs.find((input) => input.kind === 'temporal')
  const motionGaps = temporal.unexamined.filter((gap) => gap.reasonCode === 'MOTION_UNRELIABLE_FRAME_DIFFERENCE')
  assert.deepEqual(motionGaps.map((gap) => [gap.startFrame, gap.endFrame]), [[10, 12]])
  assert.ok(temporal.unexamined.some((gap) => gap.reasonCode === 'MOTION_NO_ADJACENT_OBSERVED_PAIR' || gap.reasonCode === 'SHOT_NO_ADJACENT_OBSERVED_PAIR'))
  const motion = coverageOf(snapshot, 'motion')
  // Frames 10 and 11 are absent from motion coverage; shot, which measured them, still has them.
  const startMs = frameSpanToMs({ startFrame: 10, endFrame: 12 }, 30, 150, 5_000)
  assert.ok(motion.ranges.every((range) => range[1] <= startMs[0] || range[0] >= startMs[1]))
  assert.ok(coverageOf(snapshot, 'shot').ranges.some((range) => range[0] <= startMs[0] && range[1] >= startMs[1]))
  const gapQuery = queryServerPerceptionSnapshot(snapshot, { fromMs: 300, toMs: 450, kinds: ['motion', 'shot'] })
  const gapMotion = gapQuery.coverage.find((entry) => entry.kind === 'motion')
  assert.equal(gapMotion.state, 'partial')
  assert.deepEqual(gapMotion.unexaminedRanges, [[startMs[0], startMs[1]]])
  assert.equal(gapQuery.coverage.find((entry) => entry.kind === 'shot').state, 'complete')
  // The OCR gaps the producer sealed are carried as declared.
  const ocr = assembleServerPerceptionSnapshot(assemblyBase({ extra: { ocr: [ocrEnvelope({ frames: [0, 30] })] } }))
  assert.deepEqual(ocr.inputs[0].unexamined.map((gap) => [gap.startFrame, gap.endFrame, gap.reasonCode]),
    [[1, 30, 'NOT_SAMPLED'], [31, 150, 'NOT_SAMPLED']])
})

test('W63a a range query clips the coverage to the range and never calls an unexamined part complete', () => {
  const snapshot = assembleServerPerceptionSnapshot(fullAssembly())
  const query = queryServerPerceptionSnapshot(snapshot, { fromMs: 1_000, toMs: 2_000 })
  assert.deepEqual(query.range, { startMs: 1_000, endMs: 2_000 })
  assert.equal(query.snapshotHash, snapshot.snapshotHash)
  assert.deepEqual(query.kinds, PERCEPTION_KINDS)
  for (const entry of query.coverage) {
    assert.ok(entry.ranges.every((range) => range[0] >= 1_000 && range[1] <= 2_000), entry.kind)
    assert.equal(entry.observedMs + entry.unexaminedRanges.reduce((sum, range) => sum + range[1] - range[0], 0), 1_000, entry.kind)
    if (entry.state !== 'complete') assert.ok(entry.unexaminedRanges.length > 0 && entry.reasonCode, entry.kind)
  }
  assert.equal(query.coverage.find((entry) => entry.kind === 'object').state, 'absent')
  assert.equal(query.coverage.find((entry) => entry.kind === 'object').reasonCode, 'NO_VERIFIED_DETECTOR')
  // A range the producer never reached is `absent` here, with a reason that says so.
  const ocrOnly = queryServerPerceptionSnapshot(assembleServerPerceptionSnapshot(assemblyBase({ extra: { ocr: [ocrEnvelope({ frames: [0] })] } })),
    { fromMs: 2_000, toMs: 3_000, kinds: ['ocr'] })
  assert.equal(ocrOnly.coverage[0].state, 'absent')
  assert.equal(ocrOnly.coverage[0].reasonCode, 'RANGE_NOT_EXAMINED')
  assert.deepEqual(ocrOnly.coverage[0].unexaminedRanges, [[2_000, 3_000]])
  assert.ok(query.observations.every((item) => item.startMs < 2_000 && item.endMs > 1_000))
  assert.throws(() => queryServerPerceptionSnapshot(snapshot, { fromMs: 0, toMs: 5_001 }), /outside/i)
  assert.throws(() => queryServerPerceptionSnapshot(snapshot, { fromMs: 5, toMs: 5 }), /outside/i)
  assert.throws(() => queryServerPerceptionSnapshot(snapshot, { kinds: ['ocr', 'ocr'] }), /kinds/i)
})

test('W63a a tampered envelope is refused: the hash, a measurement or a sample cannot be changed under its seal', () => {
  const ocr = ocrEnvelope({ frames: [0, 30] })
  const temporal = temporalEnvelope()
  assert.equal(ocrEnvelopeSealIntact(ocr), true)
  assert.equal(temporalEnvelopeSealIntact(temporal), true)
  const wrongHash = { ...ocr, envelopeHash: sha('0') }
  const wrongText = { ...ocr, samples: [{ ...ocr.samples[0], ocr: [{ ...ocr.samples[0].ocr[0], text: 'Texto forjado' }] }, ...ocr.samples.slice(1)] }
  const wrongMeasurement = { ...temporal, shot: { ...temporal.shot, observations: [{ ...temporal.shot.observations[0], changeScore: 0.99 }, ...temporal.shot.observations.slice(1)] } }
  const wrongInput = { ...temporal, operationAttempt: 9 }
  for (const [kind, tampered] of [['ocr', wrongHash], ['ocr', wrongText], ['temporal', wrongMeasurement], ['temporal', wrongInput]]) {
    const snapshot = assembleServerPerceptionSnapshot(assemblyBase({ extra: { [kind]: [tampered] } }))
    assert.deepEqual(rejectedReasons(snapshot, kind), ['ENVELOPE_SEAL_INVALID'], `${kind} ${tampered.envelopeHash.slice(0, 6)}`)
    assert.equal(observationsOf(snapshot, kind === 'ocr' ? 'ocr' : 'shot').length, 0)
    assert.equal(coverageOf(snapshot, kind === 'ocr' ? 'ocr' : 'shot').state, 'absent')
    assert.equal(snapshot.inputs.length, 0)
  }
  // A face window with one sample changed under its seal is listed untrusted by the evidence stream and contributes nothing.
  const window = faceWindow()
  const forged = { ...window, samples: [{ ...window.samples[0], boxes: [] }, ...window.samples.slice(1)] }
  const face = assembleServerPerceptionSnapshot(assemblyBase({ extra: { faceWindows: [forged] } }))
  assert.deepEqual(rejectedReasons(face, 'face'), ['ENVELOPE_SEAL_INVALID'])
  assert.equal(coverageOf(face, 'face').state, 'absent')
  // A stored snapshot whose observation names an envelope the snapshot does not list is refused as a whole.
  const good = assembleServerPerceptionSnapshot(assemblyBase({ extra: { ocr: [ocr] } }))
  const stored = JSON.parse(JSON.stringify(good))
  stored.timeline.observations[0].provenance.envelopeHash = sha('9')
  assert.throws(() => verifyServerPerceptionSnapshot(stored), /hash/i)
  // Re-sealed all the way (the timeline's hash and the snapshot's are consistent again): only the binding of the observation to a
  // listed input can refuse it, which is what this isolates.
  const reseal = (mutate) => {
    const body = JSON.parse(JSON.stringify(good))
    delete body.snapshotHash
    mutate(body)
    const timeline = createPerceptionTimeline({ durationMs: body.timeline.durationMs, observations: body.timeline.observations, origin: 'server',
      coverage: body.timeline.coverage.map((entry) => ({ kind: entry.kind, ranges: entry.ranges, ...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {}) })) })
    body.timeline = JSON.parse(JSON.stringify(timeline))
    return { ...body, snapshotHash: calculateCanonicalHash(body) }
  }
  assert.ok(verifyServerPerceptionSnapshot(reseal(() => {})), 'the control re-seal is accepted')
  assert.throws(() => verifyServerPerceptionSnapshot(reseal((body) => { body.timeline.observations[0].provenance.envelopeHash = sha('9') })), /not bound to a listed input/)
  assert.throws(() => verifyServerPerceptionSnapshot(reseal((body) => { body.timeline.observations[0].provenance.envelopeId = 'envelope-elsewhere' })), /not bound to a listed input/)
})

test('W63a evidence about another version, plan, workspace, source or clock is rejected with its reason', () => {
  const base = assemblyBase()
  const cases = [
    ['STALE_VERSION', { ocr: [ocrEnvelope({ overrides: { projectVersionId: 'version-other' } })] }, 'ocr'],
    ['SCOPE_MISMATCH', { temporal: [temporalEnvelope({ overrides: { workspaceId: 'workspace-other' } })] }, 'temporal'],
    ['SCOPE_MISMATCH', { temporal: [temporalEnvelope({ overrides: { projectId: 'project-other' } })] }, 'temporal'],
    ['EDIT_PLAN_MISMATCH', { ocr: [ocrEnvelope({ overrides: { editPlanSnapshotId: 'snapshot-edit-other' } })] }, 'ocr'],
    ['EDIT_PLAN_MISMATCH', { temporal: [temporalEnvelope({ overrides: { editPlanSnapshotHash: sha('d') } })] }, 'temporal'],
    ['SOURCE_MISMATCH', { ocr: [ocrEnvelope({ sourceSha256: sha('a') })] }, 'ocr'],
    ['SOURCE_MISMATCH', { temporal: [temporalEnvelope({ sourceSha256: sha('a') })] }, 'temporal'],
    ['SOURCE_NOT_IN_TIMELINE', { ocr: [ocrEnvelope({ clips: wholeClips('source-elsewhere', 150) })] }, 'ocr'],
  ]
  for (const [reason, extra, kind] of cases) {
    const snapshot = assembleServerPerceptionSnapshot({ ...base, ...extra })
    assert.ok(rejectedReasons(snapshot, kind).includes(reason), `${reason}: ${JSON.stringify(snapshot.rejected)}`)
    assert.equal(snapshot.inputs.length, 0, reason)
    assert.equal(observationsOf(snapshot, kind === 'ocr' ? 'ocr' : 'shot').length, 0, reason)
  }
  // A time map of another cut, another duration or another clock is not about this timeline either.
  const cut = assembleServerPerceptionSnapshot({ ...assemblyBase({ clips: cutClips() }), temporal: [temporalEnvelope()] })
  assert.ok(rejectedReasons(cut, 'temporal').includes('TIME_MAP_MISMATCH'))
  assert.ok(rejectedReasons(cut, 'temporal').includes('DURATION_MISMATCH'))
  const slower = assembleServerPerceptionSnapshot({ ...assemblyBase({ fps: 25 }), ocr: [ocrEnvelope({ frames: [0] })] })
  assert.ok(rejectedReasons(slower, 'ocr').includes('CLOCK_MISMATCH'))
  // Hashes the caller could not verify are not invented: their checks are skipped and the snapshot says so.
  const unverified = assembleServerPerceptionSnapshot({ ...base, editPlan: { ...base.editPlan, snapshotHash: null }, sources: [],
    ocr: [ocrEnvelope({ sourceSha256: sha('a'), frames: [0] })] })
  assert.equal(unverified.editPlan.snapshotHash, null)
  assert.deepEqual(unverified.sources, [{ artifactId: 'source-1', sha256: null }])
  assert.equal(coverageOf(unverified, 'ocr').state, 'partial')
  assert.deepEqual(editPlanSourceTimeMap(cutClips(), 'source-1').map((range) => range.clipId), ['clip-a', 'clip-b'])
})

test('W63a the producers clock and PTS differences are preserved as measured, never re-derived', () => {
  const ninety = { num: 1, den: 90_000 }
  const analysis = temporalAnalysis({ frames: 150, timebase: ninety })
  const snapshot = assembleServerPerceptionSnapshot(assemblyBase({ extra: {
    temporal: [temporalEnvelope({ analysis })], ocr: [ocrEnvelope({ frames: [0] })] } }))
  const temporal = snapshot.inputs.find((input) => input.kind === 'temporal')
  const ocr = snapshot.inputs.find((input) => input.kind === 'ocr')
  assert.deepEqual(temporal.sourceClock, { fps: FPS, timebase: ninety })
  assert.deepEqual(ocr.sourceClock, { fps: FPS, timebase: { num: 1, den: 15_360 } })
  const shots = observationsOf(snapshot, 'shot')
  assert.equal(shots[1].value.startSourcePts, 3_000)
  assert.equal(shots[1].value.endSourcePts, 6_000)
  assert.equal(observationsOf(snapshot, 'ocr')[0].value.sourcePts, 0)
  // A source clock that is not the timeline clock is not mapped by guessing: a 30 fps face window on a 25 fps timeline is untrusted.
  const wrongClock = assembleServerPerceptionSnapshot(assemblyBase({ fps: 25, extra: { faceWindows: [faceWindow()] } }))
  assert.equal(coverageOf(wrongClock, 'face').state, 'absent')
  assert.deepEqual(rejectedReasons(wrongClock, 'face'), ['CLOCK_MISMATCH'])
})

test('W63a face evidence is projected through the cut clips by the source-minus-timeline offset, one sample at a time', () => {
  const clips = cutClips()
  const snapshot = assembleServerPerceptionSnapshot(assemblyBase({ clips, extra: { faceWindows: [faceWindow({ rowsAt: () => FACE_ROWS })] } }))
  const faces = observationsOf(snapshot, 'face')
  // source frames 30..55 (clip-a, offset 30) and 90..145 (clip-b, offset 60), sampled every 5 frames
  const expected = [
    ...[30, 35, 40, 45, 50, 55].map((sourceFrame) => [sourceFrame, sourceFrame - 30, 'clip-a']),
    ...[90, 95, 100, 105, 110, 115, 120, 125, 130, 135, 140, 145].map((sourceFrame) => [sourceFrame, sourceFrame - 60, 'clip-b']),
  ]
  assert.deepEqual(faces.map((item) => [item.value.sourceFrame, item.value.timelineFrame, item.value.clipId]).toSorted((a, b) => a[0] - b[0]), expected)
  for (const item of faces) {
    const [startMs, endMs] = frameSpanToMs({ startFrame: item.value.timelineFrame, endFrame: item.value.timelineFrame + 1 }, 30, 90, 3_000)
    assert.deepEqual([item.startMs, item.endMs], [startMs, endMs])
    assert.equal(item.value.classification, 'unverified-face-candidate')
    assert.equal(item.value.identity, 'not-performed')
    assert.equal(item.provenance.producer, 'openvino-face-detection-0204')
    assert.equal(item.provenance.confidenceBasis, 'producer-reported')
  }
  // Source frames the cut dropped (60..89) are not in the timeline at all; the rest of the timeline is unexamined, not clear.
  const coverage = coverageOf(snapshot, 'face')
  assert.equal(coverage.state, 'partial')
  assert.equal(coverage.reasonCode, 'SAMPLED_FRAMES_ONLY')
  assert.ok(coverage.ranges.length > 1)
  assert.ok(coverage.observedMs < 3_000)
})

test('W63a face evidence of a non-unit-rate clip, a mismatched span or a fractional frame rate is absent with its reason, not guessed', () => {
  const faster = [{ id: 'clip-fast', sourceArtifactId: 'source-1', sourceInFrame: 0, sourceOutFrame: 60, timelineInFrame: 0, timelineOutFrame: 30, rate: 2 }]
  const rate = assembleServerPerceptionSnapshot(assemblyBase({ clips: faster, extra: { faceWindows: [faceWindow({ rowsAt: () => FACE_ROWS })] } }))
  assert.equal(coverageOf(rate, 'face').state, 'absent')
  assert.equal(coverageOf(rate, 'face').reasonCode, 'NO_UNIT_RATE_CLIP')
  assert.equal(observationsOf(rate, 'face').length, 0)
  const mixed = [
    { id: 'clip-real', sourceArtifactId: 'source-1', sourceInFrame: 0, sourceOutFrame: 30, timelineInFrame: 0, timelineOutFrame: 30, rate: 1 },
    { id: 'clip-fast', sourceArtifactId: 'source-1', sourceInFrame: 30, sourceOutFrame: 90, timelineInFrame: 30, timelineOutFrame: 60, rate: 2 },
  ]
  const partial = assembleServerPerceptionSnapshot(assemblyBase({ clips: mixed, extra: { faceWindows: [faceWindow({ rowsAt: () => FACE_ROWS })] } }))
  assert.deepEqual(observationsOf(partial, 'face').map((item) => item.value.clipId), Array(6).fill('clip-real'))
  assert.ok(coverageOf(partial, 'face').observedMs < 1_000)
  const fractional = assembleServerPerceptionSnapshot(assemblyBase({ fps: 29.97, extra: { faceWindows: [faceWindow()] } }))
  assert.equal(coverageOf(fractional, 'face').state, 'absent')
  assert.equal(coverageOf(fractional, 'face').reasonCode, 'TIMELINE_FPS_NOT_INTEGER')
  assert.deepEqual(rejectedReasons(fractional, 'face'), ['TIMELINE_FPS_NOT_INTEGER'])
  // An unknown sample (the detector failed on that frame) is not coverage.
  const unknownFrames = faceWindow({ rowsAt: (frame) => frame < 75 ? 'unknown' : FACE_ROWS })
  const unknown = assembleServerPerceptionSnapshot(assemblyBase({ extra: { faceWindows: [unknownFrames] } }))
  const faceInput = unknown.inputs.find((input) => input.kind === 'face')
  assert.equal(faceInput.unexamined.filter((gap) => gap.reasonCode === 'DETECTOR_OUTPUT_INVALID').length, 15)
  assert.ok(coverageOf(unknown, 'face').ranges[0][0] >= 2_500)
  // A window with no stored sample over the cut has no coverage over it, and a source we cannot prove is not trusted.
  const noSha = assembleServerPerceptionSnapshot({ ...assemblyBase({ extra: { faceWindows: [faceWindow()] } }), sources: [{ artifactId: 'source-1', sha256: null }] })
  assert.deepEqual(rejectedReasons(noSha, 'face'), ['SOURCE_MISMATCH'])
})

test('W63a object is never filled: not by a fixture, not by evidence, not by a stored snapshot that claims it', () => {
  const snapshot = assembleServerPerceptionSnapshot(fullAssembly())
  assert.equal(coverageOf(snapshot, 'object').state, 'absent')
  assert.equal(coverageOf(snapshot, 'object').reasonCode, 'NO_VERIFIED_DETECTOR')
  assert.equal(coverageOf(snapshot, 'object').observedMs, 0)
  // The manual golden fixture may carry an object (it is a fixture, labelled as one); a server snapshot built from it must not.
  const forged = JSON.parse(JSON.stringify(snapshot))
  const object = { id: 'object-forged', kind: 'object', startMs: 0, endMs: 100, value: { label: 'product' },
    provenance: { ...snapshot.timeline.observations.find((item) => item.kind === 'ocr').provenance } }
  const timeline = createPerceptionTimeline({ durationMs: forged.timeline.durationMs, origin: 'server',
    observations: [...forged.timeline.observations, object],
    coverage: forged.timeline.coverage.map((entry) => entry.kind === 'object'
      ? { kind: 'object', ranges: [[0, 100]] } : { kind: entry.kind, ranges: entry.ranges, ...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {}) }) })
  const { snapshotHash: _old, ...body } = { ...forged, timeline }
  const reSealed = { ...body, snapshotHash: calculateCanonicalHash(body) }
  assert.throws(() => verifyServerPerceptionSnapshot(reSealed), /object must be absent/i)
  assert.ok(PERCEPTION_GOLDEN_FIXTURES.insertedImage.observations.some((item) => item.kind === 'object'))
})

test('W63a a manual timeline can never assert server provenance, a coverage reason or a server origin', () => {
  const serverProvenance = { source: 'envelope-1', model: 'tesseract', version: sha('1'), confidence: 0.9,
    origin: 'server', producer: 'tesseract', envelopeId: 'envelope-1', envelopeHash: sha('1'), confidenceBasis: 'producer-reported' }
  const observation = { id: 'ocr-1', kind: 'ocr', startMs: 0, endMs: 100, value: { text: 'x' }, provenance: serverProvenance }
  assert.throws(() => createPerceptionTimeline({ durationMs: 1_000, observations: [observation] }), /manual perception observation cannot assert server provenance/)
  assert.throws(() => createPerceptionTimeline({ durationMs: 1_000, observations: [], origin: 'manual',
    coverage: PERCEPTION_KINDS.map((kind) => ({ kind, ranges: [], reasonCode: 'NO_PRODUCER_RUN' })) }), /server-assembled/)
  assert.ok(createPerceptionTimeline({ durationMs: 1_000, observations: [observation], origin: 'server' }))
  // Server fields come together or not at all, and a complete kind has no reason.
  assert.throws(() => createPerceptionTimeline({ durationMs: 1_000, origin: 'server',
    observations: [{ ...observation, provenance: { ...serverProvenance, envelopeHash: undefined } }] }), /provenance/i)
  assert.throws(() => createPerceptionTimeline({ durationMs: 1_000, origin: 'server', observations: [],
    coverage: PERCEPTION_KINDS.map((kind) => ({ kind, ranges: [[0, 1_000]], reasonCode: 'NO_PRODUCER_RUN' })) }), /Invalid coverage reason/)
  // The PUT service takes no provenance of origin: even a request carrying the server fields becomes a manual, unverified timeline.
  const auditContext = createExternalAuditContext({ clientId: 'client-1', credentialId: 'credential-1', workspaceId: 'workspace-1', environment: 'production' })
  const actor = { ...auditContext, scopes: new Set(['projects:write']), authenticationKind: 'bearer', clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext }
  const put = putPerceptionTimelineService({ repository: { findIdempotent: async () => null, persist: async (record) => ({ timeline: record, replayed: false }) },
    clock: () => new Date('2026-10-19T00:00:00.000Z'), createId: () => 'perception-timeline-1' })
  return assert.rejects(put({ workspaceId: 'workspace-1', projectId: 'project-1', projectVersionId: 'version-1', baseRevision: null, durationMs: 1_000,
    observations: [observation], coverage: PERCEPTION_KINDS.map((kind) => ({ kind, ranges: kind === 'ocr' ? [[0, 100]] : [] })),
    idempotencyKey: 'idempotency-key-1', actor }), /server provenance/)
})

test('W63a the OCR projection is the one the Director and the snapshot share', () => {
  const envelope = ocrEnvelope({ frames: [0, 100], text: (frame) => `Texto ${frame}` })
  const snapshot = assembleServerPerceptionSnapshot(assemblyBase({ clips: wholeClips('source-1', 150), extra: { ocr: [envelope] } }))
  const expected = expectedOcrTimeline(envelope, 30, 150)
  assert.equal(stableSerialize(snapshot.timeline.observations.filter((item) => item.kind === 'ocr')),
    stableSerialize(expected.observations.filter((item) => item.kind === 'ocr')))
  assert.equal(stableSerialize(coverageOf(snapshot, 'ocr')), stableSerialize(expected.coverage.find((entry) => entry.kind === 'ocr')))
  const noRegions = ocrEnvelope({ frames: [0, 100], empty: true })
  const emptySnapshot = assembleServerPerceptionSnapshot(assemblyBase({ extra: { ocr: [noRegions] } }))
  assert.equal(observationsOf(emptySnapshot, 'ocr').length, 0)
  assert.equal(coverageOf(emptySnapshot, 'ocr').state, 'partial')
  assert.equal(stableSerialize(coverageOf(emptySnapshot, 'ocr')), stableSerialize(expectedOcrTimeline(noRegions, 30, 150).coverage.find((entry) => entry.kind === 'ocr')))
  const none = ocrEnvelope({ frames: [] })
  const nothing = assembleServerPerceptionSnapshot(assemblyBase({ extra: { ocr: [none] } }))
  assert.equal(coverageOf(nothing, 'ocr').state, 'absent')
  assert.equal(coverageOf(nothing, 'ocr').reasonCode, 'NO_SAMPLES_OBSERVED')
  assert.equal(digest('x').length, 64)
})
