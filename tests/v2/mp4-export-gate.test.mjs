import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  apiEnvironmentOf, mp4ExportAcknowledgementFromEnvironment, mp4ExportAcknowledgementRecord, mp4ExportGate, parseMp4ExportAcknowledgement,
} from '../../src/v2/domain/mp4-export-gate.ts'
import { createMp4QualityReport, MP4_PIXEL_CRITIC_POLICY } from '../../src/v2/domain/mp4-pixel-quality.ts'
import { measureSubject } from '../../src/v2/domain/mp4-pixel-geometry.ts'
import { PIXEL_ORACLE_MODEL_IDS, PIXEL_ORACLE_MODELS, pixelOracleModelPins, regionOriginOf } from '../../src/v2/domain/pixel-face-oracle.ts'

const ACK = Object.freeze({ actor: 'leandro@example.invalid', recordedAt: '2026-10-20T12:00:00.000Z', reason: 'sandbox world without an MP4 critic; reviewed by hand' })
const [V9, RETAIL] = [PIXEL_ORACLE_MODELS.v9.id, PIXEL_ORACLE_MODELS.retail.id]
const READ = Object.freeze({ [V9]: 'observed', [RETAIL]: 'observed' })
const reads = (overrides = {}) => ({ ...READ, ...overrides })

const FACE = { origin: 'oracle-0204-v9', box: { x: 0.3, y: 0.1, width: 0.2, height: 0.2 }, captionInkPixels: 0, ctaInkPixels: 0 }
const SUBJECT = { state: 'measured', visibleFraction: 1, outputConfirmed: true, projected: { x0: 0.3, y0: 0.1, x1: 0.5, y1: 0.3 } }

/** What one frame that carries caption ink says, by kind. Every non-listed fact is the healthy one: faces read, registered and mapped. */
const INK_FRAMES = {
  'face-and-clear-of-ink': { oracle: { state: 'observed', outputFaceCount: 1, sourceFaceCount: 1, outputReads: reads(), sourceReads: reads(), registrationStatus: 'ok', mappedSourceFaces: 1 }, protectedRegions: [FACE], subject: SUBJECT },
  // both models read both frames, registration usable, zero faces anywhere: the recorded PASS
  'no-face-anywhere': { oracle: { state: 'observed', outputFaceCount: 0, sourceFaceCount: 0, outputReads: reads(), sourceReads: reads(), registrationStatus: 'ok', mappedSourceFaces: 0 }, protectedRegions: [], subject: { state: 'not-applicable', reason: 'NO_SOURCE_FACE' } },
  // the probe's first case: the OUTPUT oracle saw no face, but the SOURCE oracle was unreadable
  'source-unreadable-v9': { oracle: { state: 'observed', outputFaceCount: 0, sourceFaceCount: 0, outputReads: reads(), sourceReads: reads({ [V9]: 'unknown' }), registrationStatus: 'ok', mappedSourceFaces: 0 }, protectedRegions: [], subject: { state: 'unknown', reason: 'SOURCE_FACE_ORACLE_UNREADABLE' } },
  'source-unreadable-retail': { oracle: { state: 'observed', outputFaceCount: 0, sourceFaceCount: 0, outputReads: reads(), sourceReads: reads({ [RETAIL]: 'unknown' }), registrationStatus: 'ok', mappedSourceFaces: 0 }, protectedRegions: [], subject: { state: 'unknown', reason: 'SOURCE_FACE_ORACLE_UNREADABLE' } },
  'output-unreadable-v9': { oracle: { state: 'unknown', outputFaceCount: 0, sourceFaceCount: 0, outputReads: reads({ [V9]: 'unknown' }), sourceReads: reads(), registrationStatus: 'ok', mappedSourceFaces: 0 }, protectedRegions: [], subject: { state: 'not-applicable', reason: 'NO_SOURCE_FACE' } },
  'output-unreadable-retail': { oracle: { state: 'unknown', outputFaceCount: 0, sourceFaceCount: 0, outputReads: reads({ [RETAIL]: 'unknown' }), sourceReads: reads(), registrationStatus: 'ok', mappedSourceFaces: 0 }, protectedRegions: [], subject: { state: 'not-applicable', reason: 'NO_SOURCE_FACE' } },
  'source-absent': { oracle: { state: 'observed', outputFaceCount: 0, sourceFaceCount: 0, outputReads: reads(), sourceReads: null, registrationStatus: 'not-attempted', mappedSourceFaces: 0 }, protectedRegions: [], subject: { state: 'not-applicable', reason: 'NO_SOURCE_FRAME' } },
  // the probe's second case: a face found on the source, the registration failed
  'registration-failed': { oracle: { state: 'observed', outputFaceCount: 0, sourceFaceCount: 1, outputReads: reads(), sourceReads: reads(), registrationStatus: 'failed', mappedSourceFaces: 0 }, protectedRegions: [], subject: { state: 'unknown', reason: 'REGISTRATION_TOO_FEW_INLIERS' } },
  // registration failed and no face was found anywhere: the pass needs a usable registration, so this is not the pass
  'registration-failed-no-face': { oracle: { state: 'observed', outputFaceCount: 0, sourceFaceCount: 0, outputReads: reads(), sourceReads: reads(), registrationStatus: 'failed', mappedSourceFaces: 0 }, protectedRegions: [], subject: { state: 'not-applicable', reason: 'NO_SOURCE_FACE' } },
  'source-face-unmapped': { oracle: { state: 'observed', outputFaceCount: 0, sourceFaceCount: 2, outputReads: reads(), sourceReads: reads(), registrationStatus: 'ok', mappedSourceFaces: 1 }, protectedRegions: [], subject: SUBJECT },
  'face-intersects-ink': { oracle: { state: 'observed', outputFaceCount: 1, sourceFaceCount: 1, outputReads: reads(), sourceReads: reads(), registrationStatus: 'ok', mappedSourceFaces: 1 }, protectedRegions: [{ ...FACE, captionInkPixels: 40 }], subject: SUBJECT },
  'facts-missing': { oracle: { state: 'observed', outputFaceCount: 0, sourceFaceCount: 0 }, protectedRegions: [], subject: { state: 'not-applicable', reason: 'NO_SOURCE_FACE' } },
}

/** A report whose frames 5-8 carry ink of `kind`; every other frame is a healthy ink-free one. */
function report({ kind = null, failures = [], models = pixelOracleModelPins() } = {}) {
  const hash = 'a'.repeat(64)
  const samples = Array.from({ length: 20 }, (_unused, frameIndex) => {
    const inked = kind !== null && frameIndex >= 5 && frameIndex < 9
    const base = {
      sampleId: `gate-${frameIndex}`, frameIndex, ptsTicks: frameIndex * 512, frameSha256: 'f'.repeat(64),
      caption: inked ? { pixels: 900, bbox: { x0: 60, y0: 800, x1: 480, y1: 840 }, touchesCanvasEdge: false } : { pixels: 0, bbox: null, touchesCanvasEdge: false },
      cta: { pixels: 0, bbox: null, touchesCanvasEdge: false }, inkDensity: inked ? 0.01 : 0, registration: null,
    }
    return inked ? { ...base, ...INK_FRAMES[kind] } : { ...base, ...INK_FRAMES['face-and-clear-of-ink'] }
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

test('a critic that was not wired blocks the final, and only an acknowledgement lifts it; the lifting is a structured record', () => {
  const plain = mp4ExportGate({ report: null })
  assert.equal(plain.allowed, false)
  assert.deepEqual(codes(plain), ['MP4_CRITIC_NOT_CONFIGURED'])
  assert.match(plain.message, /without an explicit acknowledgement/)
  assert.equal(mp4ExportAcknowledgementRecord({ gate: plain, workspaceId: 'w', projectId: 'p', variantId: 'v', outputSpecId: 'preset-9x16', operationId: 'o', reportHash: null }), null, 'nothing lifted, no record')
  const acknowledged = mp4ExportGate({ report: null, acknowledgement: ACK })
  assert.equal(acknowledged.allowed, true)
  assert.deepEqual(acknowledged.blockers.map((blocker) => [blocker.code, blocker.waivable, blocker.waived]), [['MP4_CRITIC_NOT_CONFIGURED', true, true]])
  assert.ok(!acknowledged.message.includes(ACK.reason), 'the free text is in the structured record, not in the short message')
  const written = mp4ExportAcknowledgementRecord({ gate: acknowledged, workspaceId: 'workspace-1', projectId: 'project-1', variantId: 'variant-1', outputSpecId: 'preset-9x16', operationId: 'operation-1', reportHash: null })
  assert.deepEqual(written.record, {
    schemaVersion: 'mp4-export-acknowledgement/v1', actor: ACK.actor, recordedAt: ACK.recordedAt, reason: ACK.reason, workspaceId: 'workspace-1', projectId: 'project-1',
    variantId: 'variant-1', outputSpecId: 'preset-9x16', operationId: 'operation-1', reportHash: null, liftedBlockers: ['MP4_CRITIC_NOT_CONFIGURED'],
  })
  assert.deepEqual(JSON.parse(written.text), written.record)
})

test('a healthy report, and ink over a readable face that it does not touch, allow the final with nothing to record', () => {
  for (const input of [{}, { kind: 'face-and-clear-of-ink' }]) {
    const gate = mp4ExportGate({ report: report(input) })
    assert.equal(gate.allowed, true, JSON.stringify(input))
    assert.deepEqual(gate.blockers, [])
    assert.deepEqual(gate.informational, [])
  }
})

test('PASS, recorded and with no acknowledgement: both models read the source and the output, the registration is usable and neither frame has a face', () => {
  const gate = mp4ExportGate({ report: report({ kind: 'no-face-anywhere' }) })
  assert.equal(gate.allowed, true)
  assert.deepEqual(gate.blockers, [])
  assert.equal(gate.informational.length, 1)
  assert.equal(gate.informational[0].code, 'NO_FACE_DETECTED_UNDER_INK')
  assert.equal(gate.informational[0].sampledFrames, 4)
  assert.deepEqual(gate.informational[0].models, [...PIXEL_ORACLE_MODEL_IDS], 'both model ids are on the record')
  assert.match(gate.message, /NO_FACE_DETECTED_UNDER_INK \(4 sampled frame\(s\), models omz-face-detection-0204-v9 \+ omz-face-detection-retail-0004\)/)
  assert.equal(mp4ExportAcknowledgementRecord({ gate, workspaceId: 'w', projectId: 'p', variantId: 'v', outputSpecId: 'preset-9x16', operationId: 'o', reportHash: null }), null, 'no acknowledgement was needed, so none is recorded')
})

test('NOT WAIVABLE: each fact that leaves a frame with ink unestablished blocks the final, and no acknowledgement lifts it', () => {
  const cases = {
    'source-unreadable-v9': 'MP4_SOURCE_FRAME_UNREADABLE_UNDER_INK',
    'source-unreadable-retail': 'MP4_SOURCE_FRAME_UNREADABLE_UNDER_INK',
    'output-unreadable-v9': 'MP4_OUTPUT_FRAME_UNREADABLE_UNDER_INK',
    'output-unreadable-retail': 'MP4_OUTPUT_FRAME_UNREADABLE_UNDER_INK',
    'source-absent': 'MP4_SOURCE_FRAME_ABSENT_UNDER_INK',
    'registration-failed': 'MP4_REGISTRATION_FAILED_UNDER_INK',
    'registration-failed-no-face': 'MP4_REGISTRATION_FAILED_UNDER_INK',
    'source-face-unmapped': 'MP4_SOURCE_FACE_UNMAPPED_UNDER_INK',
    'face-intersects-ink': 'MP4_FACE_INTERSECTS_INK',
    'facts-missing': 'MP4_GATE_FACTS_MISSING_UNDER_INK',
  }
  for (const [kind, code] of Object.entries(cases)) {
    for (const acknowledgement of [undefined, ACK]) {
      const gate = mp4ExportGate({ report: report({ kind }), acknowledgement })
      assert.equal(gate.allowed, false, `${kind} ${acknowledgement ? 'with' : 'without'} acknowledgement`)
      assert.ok(codes(gate).includes(code), `${kind} -> ${code}, got ${codes(gate)}`)
      assert.ok(gate.blockers.every((blocker) => !blocker.waivable && !blocker.waived), kind)
      assert.deepEqual(gate.informational, [], kind)
    }
  }
})

test('the probe cases of the validator: an unreadable SOURCE oracle, or a source face whose registration failed, never land in a waivable or informational code', () => {
  const unreadableSource = mp4ExportGate({ report: report({ kind: 'source-unreadable-v9' }), acknowledgement: ACK })
  assert.deepEqual(codes(unreadableSource), ['MP4_SOURCE_FRAME_UNREADABLE_UNDER_INK'])
  assert.equal(unreadableSource.allowed, false)
  const registration = mp4ExportGate({ report: report({ kind: 'registration-failed' }), acknowledgement: ACK })
  assert.deepEqual(codes(registration), ['MP4_REGISTRATION_FAILED_UNDER_INK'])
  assert.equal(registration.allowed, false)
  // while true absence of a face (both models read both frames, usable registration) is the recorded pass
  assert.equal(mp4ExportGate({ report: report({ kind: 'no-face-anywhere' }) }).allowed, true)
})

test('a face oracle that failed blocks the final even with no ink in any frame, and a pinned-model-less report blocks too; nothing lifts either', () => {
  for (const kind of [null, 'output-unreadable-v9']) {
    for (const acknowledgement of [undefined, ACK]) {
      const gate = mp4ExportGate({ report: report({ kind, failures: ['BRIDGE_EXIT_NONZERO'] }), acknowledgement })
      assert.equal(gate.allowed, false, `${kind} ${acknowledgement ? 'ack' : 'plain'}`)
      assert.ok(codes(gate).includes('MP4_ORACLE_FAILED'))
      assert.equal(gate.blockers.find((blocker) => blocker.code === 'MP4_ORACLE_FAILED').waivable, false)
    }
  }
  assert.match(mp4ExportGate({ report: report({ failures: ['BRIDGE_EXIT_NONZERO', 'RESPONSE_TENSOR_HASH_MISMATCH'] }) }).message, /BRIDGE_EXIT_NONZERO, RESPONSE_TENSOR_HASH_MISMATCH/)
  const noModel = mp4ExportGate({ report: report({ models: [] }), acknowledgement: ACK })
  assert.equal(noModel.allowed, false)
  assert.deepEqual(codes(noModel), ['MP4_ORACLE_MODEL_MISSING'])
})

test('a deployment records the acknowledgement in three variables, all or none, never in production, and a malformed one throws instead of acknowledging', () => {
  assert.equal(mp4ExportAcknowledgementFromEnvironment({}), null)
  assert.equal(mp4ExportAcknowledgementFromEnvironment({ APOLLO_V2_MP4_CRITIC_ACK_ACTOR: '  ' }), null)
  const full = { APOLLO_V2_MP4_CRITIC_ACK_ACTOR: ACK.actor, APOLLO_V2_MP4_CRITIC_ACK_AT: ACK.recordedAt, APOLLO_V2_MP4_CRITIC_ACK_REASON: ACK.reason, APOLLO_API_ENVIRONMENT: 'sandbox' }
  assert.deepEqual(mp4ExportAcknowledgementFromEnvironment(full), ACK)
  assert.deepEqual(mp4ExportAcknowledgementFromEnvironment({ ...full, APOLLO_API_ENVIRONMENT: undefined }), ACK, 'no environment named, NODE_ENV not production: sandbox')
  for (const missing of ['APOLLO_V2_MP4_CRITIC_ACK_ACTOR', 'APOLLO_V2_MP4_CRITIC_ACK_AT', 'APOLLO_V2_MP4_CRITIC_ACK_REASON']) {
    const partial = { ...full }; delete partial[missing]
    assert.throws(() => mp4ExportAcknowledgementFromEnvironment(partial), (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED', missing)
  }
  assert.throws(() => mp4ExportAcknowledgementFromEnvironment({ ...full, APOLLO_V2_MP4_CRITIC_ACK_AT: 'yesterday' }), (error) => error.code === 'INVALID_ARGUMENT')
  // PRODUCTION: an acknowledgement in the environment is a deployment-wide bypass, so it throws
  for (const production of [{ APOLLO_API_ENVIRONMENT: 'production' }, { APOLLO_API_ENVIRONMENT: undefined, NODE_ENV: 'production' }]) {
    assert.throws(() => mp4ExportAcknowledgementFromEnvironment({ ...full, ...production }), (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED' && /cannot be set in production/.test(error.message), JSON.stringify(production))
  }
  assert.equal(mp4ExportAcknowledgementFromEnvironment({ APOLLO_API_ENVIRONMENT: 'production' }), null, 'production with no acknowledgement set is just production')
  assert.equal(apiEnvironmentOf({ NODE_ENV: 'production' }), 'production')
  assert.equal(apiEnvironmentOf({ APOLLO_API_ENVIRONMENT: 'sandbox', NODE_ENV: 'production' }), 'sandbox')
  assert.throws(() => apiEnvironmentOf({ APOLLO_API_ENVIRONMENT: 'staging' }), (error) => error.code === 'INVALID_ARGUMENT')
})

test('a region origin is mapped from the exact pinned model id, and an id that is neither pinned model is refused', () => {
  assert.equal(regionOriginOf(V9), 'oracle-0204-v9')
  assert.equal(regionOriginOf(RETAIL), 'oracle-retail-0004')
  for (const unknown of ['omz-face-detection-9999', '', 'oracle-retail-0004', 'omz-face-detection-0204-v9 ']) {
    assert.throws(() => regionOriginOf(unknown), (error) => error.code === 'INVALID_RENDER_INPUT', JSON.stringify(unknown))
  }
})

test('a projected source face keeps the index, and so the detector, of the source face it came from, also when an earlier one is dropped; mapped faces count the ones outside the canvas too', () => {
  const output = { width: 540, height: 960 }
  const registration = { status: 'ok', reason: null, matches: 200, inliers: 150, matrix: [[1, 0, 0], [0, 1, 0]], medianResidualPixels: 0.8, scale: 1, rotationDegrees: 0 }
  const input = {
    sourceFrameAvailable: true, sourceOracle: 'observed', registration, sourceDimensions: { width: 540, height: 960 }, outputDimensions: output, outputFaces: [],
    // the first face lies entirely outside the canvas after the identity projection, the others inside
    sourceFaces: [{ x: 1.2, y: 0.1, width: 0.1, height: 0.1 }, { x: 0.3, y: 0.3, width: 0.2, height: 0.2 }, { x: 0.6, y: 0.5, width: 0.1, height: 0.1 }],
  }
  const measured = measureSubject(input)
  assert.deepEqual(measured.projectedSourceFaceIndices, [1, 2])
  assert.equal(measured.projectedSourceFaces.length, 2)
  assert.equal(measured.mappedSourceFaces, 3, 'the face outside the canvas is still accounted for')
  assert.equal(measureSubject({ ...input, registration: { ...registration, inliers: 3 } }).mappedSourceFaces, 0, 'a registration that fails its gates maps nothing')
  assert.deepEqual(measureSubject({ ...input, sourceFrameAvailable: false }).projectedSourceFaceIndices, [])
})

// ---- MUTATION: the classifier, weakened one rule at a time in a copy outside the repository, lets through what the real one blocks ----
const gateSourcePath = fileURLToPath(new URL('../../src/v2/domain/mp4-export-gate.ts', import.meta.url))
const domainRoot = pathToFileURL(gateSourcePath).href.replace(/mp4-export-gate\.ts$/, '')

test('MUTATION: every rule of the gate is load-bearing (a copy without it delivers what the real gate refuses)', async () => {
  const original = readFileSync(gateSourcePath, 'utf8')
  const scratch = mkdtempSync(join(tmpdir(), 'apollo-w67-gate-mutant-'))
  let counter = 0
  const load = async (from, to) => {
    assert.ok(original.includes(from), `mutation anchor missing: ${from.slice(0, 60)}`)
    const text = original.replace(from, () => to).replaceAll("from './", `from '${domainRoot}`)
    const path = join(scratch, `gate-mutant-${counter += 1}.ts`)
    writeFileSync(path, text)
    return import(pathToFileURL(path).href)
  }
  const blocks = (module, kind, acknowledgement) => module.mp4ExportGate({ report: report({ kind }), acknowledgement }).allowed === false
  try {
    // 1. a frame is read when EITHER model read it
    let mutant = await load('PIXEL_ORACLE_MODEL_IDS.every((id) => reads![id] === \'observed\')', 'PIXEL_ORACLE_MODEL_IDS.some((id) => reads![id] === \'observed\')')
    for (const kind of ['source-unreadable-v9', 'output-unreadable-retail']) { assert.equal(blocks(mutant, kind), false, `mutant 1 lets ${kind} through`); assert.ok(blocks({ mp4ExportGate }, kind), kind) }
    // 2. the registration status is not looked at
    mutant = await load("else if (oracle.registrationStatus !== 'ok') block('MP4_REGISTRATION_FAILED_UNDER_INK')\n      else if", 'else if')
    assert.equal(blocks(mutant, 'registration-failed-no-face'), false, 'mutant 2 lets a failed registration through'); assert.ok(blocks({ mp4ExportGate }, 'registration-failed-no-face'))
    // 3. a source face that is not mapped is not looked at
    mutant = await load("      else if (oracle.mappedSourceFaces < oracle.sourceFaceCount) block('MP4_SOURCE_FACE_UNMAPPED_UNDER_INK')\n", '\n')
    assert.equal(blocks(mutant, 'source-face-unmapped'), false, 'mutant 3 lets an unmapped source face through'); assert.ok(blocks({ mp4ExportGate }, 'source-face-unmapped'))
    // 4. a missing source frame is not looked at
    mutant = await load("if (oracle.sourceReads === null) block('MP4_SOURCE_FRAME_ABSENT_UNDER_INK')\n      else if", 'if')
    // (an absent source frame is still not a read one, so the copy blocks it too, but as the wrong fact: the code that names it is gone)
    assert.ok(!codes(mutant.mp4ExportGate({ report: report({ kind: 'source-absent' }) })).includes('MP4_SOURCE_FRAME_ABSENT_UNDER_INK'), 'mutant 4 no longer names an absent source frame')
    assert.ok(codes(mp4ExportGate({ report: report({ kind: 'source-absent' }) })).includes('MP4_SOURCE_FRAME_ABSENT_UNDER_INK'))
    // 5. everything is waivable
    mutant = await load("new Set(['MP4_CRITIC_NOT_CONFIGURED'])", "new Set(['MP4_CRITIC_NOT_CONFIGURED', 'MP4_SOURCE_FRAME_UNREADABLE_UNDER_INK', 'MP4_ORACLE_FAILED', 'MP4_REGISTRATION_FAILED_UNDER_INK'])")
    assert.equal(blocks(mutant, 'source-unreadable-v9', ACK), false, 'mutant 5 lets an acknowledgement lift an unreadable source frame')
    assert.equal(mutant.mp4ExportGate({ report: report({ failures: ['BRIDGE_EXIT_NONZERO'] }), acknowledgement: ACK }).allowed, true, 'mutant 5 lets an acknowledgement lift a crashed oracle')
    assert.ok(blocks({ mp4ExportGate }, 'source-unreadable-v9', ACK))
    // 6. a crashed oracle is not looked at
    mutant = await load("if (failures.length > 0) found.set('MP4_ORACLE_FAILED'", 'if (false) found.set(\'MP4_ORACLE_FAILED\'')
    assert.equal(mutant.mp4ExportGate({ report: report({ failures: ['BRIDGE_EXIT_NONZERO'] }) }).allowed, true, 'mutant 6 lets a crashed oracle through')
    // 7. the unwired critic does not block
    mutant = await load("found.set('MP4_CRITIC_NOT_CONFIGURED', 'no MP4 pixel critic is wired for this final')", 'void 0')
    assert.equal(mutant.mp4ExportGate({ report: null }).allowed, true, 'mutant 7 lets an unwired critic through'); assert.equal(mp4ExportGate({ report: null }).allowed, false)
    // 8. the production guard on the environment acknowledgement
    mutant = await load("assertDomain(apiEnvironmentOf(environment) !== 'production'", "assertDomain(true || apiEnvironmentOf(environment) !== 'production'")
    const full = { APOLLO_V2_MP4_CRITIC_ACK_ACTOR: ACK.actor, APOLLO_V2_MP4_CRITIC_ACK_AT: ACK.recordedAt, APOLLO_V2_MP4_CRITIC_ACK_REASON: ACK.reason, APOLLO_API_ENVIRONMENT: 'production' }
    assert.deepEqual(mutant.mp4ExportAcknowledgementFromEnvironment(full), ACK, 'mutant 8 lets production take an environment acknowledgement')
    assert.throws(() => mp4ExportAcknowledgementFromEnvironment(full))
    // 9. the recorded pass stops being informational-only: it becomes a blocker
    mutant = await load('if (!blocked && oracle.sourceFaceCount === 0 && oracle.outputFaceCount === 0) noFaceFrames += 1', "if (!blocked && oracle.sourceFaceCount === 0 && oracle.outputFaceCount === 0) bump('MP4_GATE_FACTS_MISSING_UNDER_INK')")
    assert.equal(mutant.mp4ExportGate({ report: report({ kind: 'no-face-anywhere' }) }).allowed, false, 'sanity: the pass case is what the mutant breaks')
    assert.equal(mp4ExportGate({ report: report({ kind: 'no-face-anywhere' }) }).allowed, true)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

// ---- the deployment wiring (the factory needs the transform-types flag to be imported, so it is audited as source here) ----
test('the final worker factory reads the environment acknowledgement before it connects to anything, the proxy worker never reads it, and the factory delegates the production rule to the domain', () => {
  const factory = readFileSync(fileURLToPath(new URL('../../src/v2/infrastructure/repository-factory.ts', import.meta.url)), 'utf8')
  const body = (name) => {
    const start = factory.indexOf(`export function ${name}(`)
    assert.ok(start >= 0, name)
    const next = factory.indexOf('\nexport ', start + 10)
    return factory.slice(start, next < 0 ? factory.length : next)
  }
  const finalWorker = body('createProjectFinalExportWorker')
  assert.ok(finalWorker.indexOf('const mp4Acknowledgement = optionalMp4ExportAcknowledgement(environment)') > 0, 'read at the top')
  assert.ok(finalWorker.indexOf('optionalMp4ExportAcknowledgement(environment)') < finalWorker.indexOf('createConfiguredOperationTelemetry'), 'before any connection')
  assert.ok(finalWorker.includes('...mp4Acknowledgement,'))
  assert.ok(finalWorker.includes('...optionalMp4PixelCritic(environment, artifactRoot),'))
  for (const other of ['createProjectProxyRenderWorker', 'createProjectDirectorWorker']) {
    const text = factory.includes(`export function ${other}(`) ? body(other) : ''
    assert.ok(!text.includes('optionalMp4ExportAcknowledgement'), `${other} takes no acknowledgement`)
  }
  assert.match(body('optionalMp4ExportAcknowledgement'), /mp4ExportAcknowledgementFromEnvironment\(environment\)/)
})
