import assert from 'node:assert/strict'
import test from 'node:test'

import { mp4ExportAcknowledgementFromEnvironment, mp4ExportGate, parseMp4ExportAcknowledgement } from '../../src/v2/domain/mp4-export-gate.ts'
import { createMp4QualityReport, MP4_PIXEL_CRITIC_POLICY } from '../../src/v2/domain/mp4-pixel-quality.ts'
import { pixelOracleModelPins } from '../../src/v2/domain/pixel-face-oracle.ts'
import { measureSubject } from '../../src/v2/domain/mp4-pixel-geometry.ts'

const ACK = Object.freeze({ actor: 'leandro@example.invalid', recordedAt: '2026-10-20T12:00:00.000Z', reason: 'footage without any face; reviewed by hand' })

/**
 * `ink`: 'none' | 'present-over-face' (ink, a face is protected, no overlap) | 'unreadable' (ink, the oracle could not read the frame) | 'absent' (ink, no face anywhere).
 */
function report({ ink = 'none', failures = [], models = pixelOracleModelPins() } = {}) {
  const hash = 'a'.repeat(64)
  const samples = Array.from({ length: 20 }, (_unused, frameIndex) => {
    const inked = ink !== 'none' && frameIndex >= 5 && frameIndex < 9
    const base = {
      sampleId: `gate-${frameIndex}`, frameIndex, ptsTicks: frameIndex * 512, frameSha256: 'f'.repeat(64),
      caption: inked ? { pixels: 900, bbox: { x0: 60, y0: 800, x1: 480, y1: 840 }, touchesCanvasEdge: false } : { pixels: 0, bbox: null, touchesCanvasEdge: false },
      cta: { pixels: 0, bbox: null, touchesCanvasEdge: false }, inkDensity: inked ? 0.01 : 0, registration: null,
    }
    if (ink === 'unreadable' && inked) return { ...base, oracle: { state: 'unknown', outputFaceCount: 0, sourceFaceCount: 0 }, protectedRegions: [], subject: { state: 'unknown', reason: 'SOURCE_FACE_ORACLE_UNREADABLE' } }
    if (ink === 'absent' && inked) return { ...base, oracle: { state: 'observed', outputFaceCount: 0, sourceFaceCount: 0 }, protectedRegions: [], subject: { state: 'not-applicable', reason: 'NO_SOURCE_FACE' } }
    return {
      ...base, oracle: { state: 'observed', outputFaceCount: 1, sourceFaceCount: 1 },
      protectedRegions: [{ origin: 'oracle-0204-v9', box: { x: 0.3, y: 0.1, width: 0.2, height: 0.2 }, captionInkPixels: 0, ctaInkPixels: 0 }],
      subject: { state: 'measured', visibleFraction: 1, outputConfirmed: true, projected: { x0: 0.3, y0: 0.1, x1: 0.5, y1: 0.3 } },
    }
  })
  return createMp4QualityReport({
    identity: { workspaceId: 'gate-workspace', projectId: 'gate-project', projectVersionId: 'gate-version', variantId: 'gate-variant', outputSpecId: 'preset-9x16', format: '9:16', operationId: 'gate-operation', renderInputHash: hash },
    artifact: { sha256: hash, byteSize: 4096, container: 'mp4', videoCodec: 'h264', pixelFormat: 'yuv420p', width: 540, height: 960, frameRate: { num: 30, den: 1 }, timeBase: { num: 1, den: 15360 }, frameCount: 20, durationTicks: 10240 },
    decode: { status: 'complete', framesExpected: 20, framesDecoded: 20, frameListSha256: 'e'.repeat(64), stderrSha256: 'd'.repeat(64), ffmpegBinarySha256: null },
    outputSpec: { width: 540, height: 960, safeArea: { top: 0.08, right: 0.06, bottom: 0.06, left: 0.06 } }, controls: [], noiseProbe: null,
    oracle: { protocol: 'apollo-pixel-oracle/v1', models, bridgeSha256: '1'.repeat(64), pythonSha256: '2'.repeat(64), runtime: {}, registration: MP4_PIXEL_CRITIC_POLICY.registration, failures, perSample: [] },
    samples,
  })
}
const codes = (gate) => gate.blockers.map((blocker) => blocker.code)

test('an acknowledgement is an actor, a canonical UTC instant and a reason of at least ten characters, and nothing else', () => {
  assert.deepEqual(parseMp4ExportAcknowledgement({ ...ACK, actor: '  leandro  ', reason: `  ${ACK.reason}  ` }), { ...ACK, actor: 'leandro' })
  for (const bad of [null, 'ack', [], {}, { ...ACK, actor: '' }, { ...ACK, actor: '   ' }, { ...ACK, actor: 'x'.repeat(121) }, { ...ACK, recordedAt: '2026-10-20' }, { ...ACK, recordedAt: '2026-10-20T12:00:00Z' },
    { ...ACK, recordedAt: '2026-13-40T12:00:00.000Z' }, { ...ACK, reason: 'too short' }, { ...ACK, reason: 'x'.repeat(301) }, { ...ACK, extra: 1 }, { actor: ACK.actor, recordedAt: ACK.recordedAt }]) {
    assert.throws(() => parseMp4ExportAcknowledgement(bad), (error) => error.code === 'INVALID_ARGUMENT', JSON.stringify(bad))
  }
})

test('a critic that was not wired blocks the final, and only an acknowledgement lifts it', () => {
  const plain = mp4ExportGate({ report: null })
  assert.equal(plain.allowed, false)
  assert.deepEqual(codes(plain), ['MP4_CRITIC_NOT_CONFIGURED'])
  assert.match(plain.message, /without an explicit acknowledgement/)
  const acknowledged = mp4ExportGate({ report: null, acknowledgement: ACK })
  assert.equal(acknowledged.allowed, true)
  assert.deepEqual(acknowledged.blockers.map((blocker) => [blocker.code, blocker.waivable, blocker.waived]), [['MP4_CRITIC_NOT_CONFIGURED', true, true]])
  assert.match(acknowledged.message, /acknowledged by leandro@example\.invalid at 2026-10-20T12:00:00\.000Z: footage without any face/)
})

test('a report with everything it needs allows the final with no acknowledgement; ink over a protected, readable face is not a gate matter', () => {
  for (const input of [{}, { ink: 'present-over-face' }]) {
    const gate = mp4ExportGate({ report: report(input) })
    assert.equal(gate.allowed, true, JSON.stringify(input))
    assert.deepEqual(gate.blockers, [])
  }
})

test('a face oracle that failed blocks the final even with no ink in any frame, and no acknowledgement lifts it', () => {
  for (const ink of ['none', 'unreadable']) {
    for (const acknowledgement of [undefined, ACK]) {
      const gate = mp4ExportGate({ report: report({ ink, failures: ['BRIDGE_EXIT_NONZERO'] }), acknowledgement })
      assert.equal(gate.allowed, false, `${ink} ${acknowledgement ? 'ack' : 'plain'}`)
      assert.ok(codes(gate).includes('MP4_ORACLE_FAILED'))
      assert.equal(gate.blockers.find((blocker) => blocker.code === 'MP4_ORACLE_FAILED').waivable, false)
    }
  }
  assert.match(mp4ExportGate({ report: report({ failures: ['BRIDGE_EXIT_NONZERO', 'RESPONSE_TENSOR_HASH_MISMATCH'] }) }).message, /BRIDGE_EXIT_NONZERO.*RESPONSE_TENSOR_HASH_MISMATCH/)
  const noModel = mp4ExportGate({ report: report({ models: [] }), acknowledgement: ACK })
  assert.equal(noModel.allowed, false)
  assert.deepEqual(codes(noModel), ['MP4_ORACLE_MODEL_MISSING'])
})

test('ink over frames the face oracle could not read always blocks; ink where no face exists anywhere blocks unless acknowledged', () => {
  const unreadable = mp4ExportGate({ report: report({ ink: 'unreadable' }), acknowledgement: ACK })
  assert.equal(unreadable.allowed, false)
  assert.deepEqual(codes(unreadable), ['MP4_FACE_ORACLE_UNREADABLE_UNDER_INK'])
  assert.match(unreadable.message, /4 sampled frame\(s\) carry caption or CTA ink and the face oracle could not read them/)
  const absent = mp4ExportGate({ report: report({ ink: 'absent' }) })
  assert.equal(absent.allowed, false)
  assert.deepEqual(codes(absent), ['MP4_FACE_EVIDENCE_ABSENT_UNDER_INK'])
  const absentAcknowledged = mp4ExportGate({ report: report({ ink: 'absent' }), acknowledgement: ACK })
  assert.equal(absentAcknowledged.allowed, true)
  assert.equal(absentAcknowledged.blockers[0].waived, true)
  // one waivable blocker does not hide a non-waivable one
  const both = mp4ExportGate({ report: report({ ink: 'absent', failures: ['BRIDGE_EXIT_NONZERO'] }), acknowledgement: ACK })
  assert.equal(both.allowed, false)
  assert.deepEqual(both.blockers.map((blocker) => [blocker.code, blocker.waived]).toSorted(), [['MP4_FACE_EVIDENCE_ABSENT_UNDER_INK', true], ['MP4_ORACLE_FAILED', false]])
})

test('MUTATION: a gate that ignored failures, unreadable ink or a missing critic would pass the cases above (each rule is load-bearing)', () => {
  // the three reports below are exactly the ones a rule-less gate would let through: every one of them is a report the critic itself still marks exportable
  for (const input of [{ failures: ['BRIDGE_EXIT_NONZERO'] }, { ink: 'unreadable' }, { ink: 'absent' }]) {
    const built = report(input)
    assert.equal(built.exportAllowed, true, `the report alone allows it: ${JSON.stringify(input)}`)
    assert.equal(mp4ExportGate({ report: built }).allowed, false, `the gate refuses it: ${JSON.stringify(input)}`)
  }
})

test('a projected source face keeps the index, and so the detector, of the source face it came from, also when an earlier one is dropped', () => {
  const output = { width: 540, height: 960 }
  const registration = { status: 'ok', reason: null, matches: 200, inliers: 150, matrix: [[1, 0, 0], [0, 1, 0]], medianResidualPixels: 0.8, scale: 1, rotationDegrees: 0 }
  const measured = measureSubject({
    sourceFrameAvailable: true, sourceOracle: 'observed', registration, sourceDimensions: { width: 540, height: 960 }, outputDimensions: output, outputFaces: [],
    // the first face lies entirely outside the canvas after the identity projection shifted by the matrix, the second inside
    sourceFaces: [{ x: 1.2, y: 0.1, width: 0.1, height: 0.1 }, { x: 0.3, y: 0.3, width: 0.2, height: 0.2 }, { x: 0.6, y: 0.5, width: 0.1, height: 0.1 }],
  })
  assert.deepEqual(measured.projectedSourceFaceIndices, [1, 2])
  assert.equal(measured.projectedSourceFaces.length, 2)
  assert.deepEqual(measureSubject({ sourceFrameAvailable: false, sourceOracle: 'observed', sourceFaces: [], registration: null, sourceDimensions: null, outputDimensions: output, outputFaces: [] }).projectedSourceFaceIndices, [])
})

// ---- the deployment side: the acknowledgement's variables, all or none ----
test('a deployment records the acknowledgement in three variables, all or none, and a malformed one throws instead of acknowledging', () => {
  assert.equal(mp4ExportAcknowledgementFromEnvironment({}), null)
  assert.equal(mp4ExportAcknowledgementFromEnvironment({ APOLLO_V2_MP4_CRITIC_ACK_ACTOR: '  ' }), null)
  const full = { APOLLO_V2_MP4_CRITIC_ACK_ACTOR: ACK.actor, APOLLO_V2_MP4_CRITIC_ACK_AT: ACK.recordedAt, APOLLO_V2_MP4_CRITIC_ACK_REASON: ACK.reason }
  assert.deepEqual(mp4ExportAcknowledgementFromEnvironment(full), ACK)
  for (const missing of Object.keys(full)) {
    const partial = { ...full }; delete partial[missing]
    assert.throws(() => mp4ExportAcknowledgementFromEnvironment(partial), (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED', missing)
  }
  assert.throws(() => mp4ExportAcknowledgementFromEnvironment({ ...full, APOLLO_V2_MP4_CRITIC_ACK_AT: 'yesterday' }), (error) => error.code === 'INVALID_ARGUMENT')
})
