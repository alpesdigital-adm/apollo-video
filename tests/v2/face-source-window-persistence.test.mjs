import assert from 'node:assert/strict'
import test from 'node:test'

import { stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { createFaceProducerEnvelopeV3 } from '../../src/v2/domain/face-producer-envelope-v3.ts'
import { assertFaceSourceWindowRawOutputs, faceSourceWindowRawOutputRows, hydrateFaceSourceWindowContent,
  PrismaFaceSourceWindowRepository } from '../../src/v2/infrastructure/prisma/face-source-window-repository.ts'
import { acceptedProducer } from './helpers/face-envelope-v2.mjs'
import { sourceSampleWithRaw, sourceUnknownSample, sourceWindowInput } from './helpers/face-source-envelope-v3.mjs'

/** A sealed source window plus the raw outputs of its samples, aligned by index (null where the detector produced none). */
function windowWithRaw({ start = 0, end = 150, producer = acceptedProducer(), failAt = null } = {}) {
  const samples = [], rawOutputs = []
  for (let frame = start; frame < end; frame += 5) {
    if (frame === failAt) { samples.push(sourceUnknownSample({ sourceFrame: frame })); rawOutputs.push(null); continue }
    const built = sourceSampleWithRaw({ sourceFrame: frame, rows: frame % 10 === 0 ? [[0.9, 0.2, 0.2, 0.4, 0.6]] : [] })
    samples.push(built.sample); rawOutputs.push(built.raw)
  }
  return { envelope: createFaceProducerEnvelopeV3(sourceWindowInput({ start, end, samples, producer })), rawOutputs }
}
const rowsOf = (envelope, rawOutputs) => faceSourceWindowRawOutputRows(envelope, rawOutputs)
const publishInput = (built, extra = {}) => ({ envelope: built.envelope, rawOutputs: built.rawOutputs, leaseOwner: 'owner', now: new Date(), ...extra })

test('a sealed source window round-trips through its stored JSON and any edit is refused', () => {
  const { envelope } = windowWithRaw()
  const stored = stableSerialize(envelope)
  assert.equal(hydrateFaceSourceWindowContent(stored, envelope.envelopeHash).envelopeHash, envelope.envelopeHash)
  const edited = JSON.parse(stored)
  edited.faceSafety = 'safe'
  assert.throws(() => hydrateFaceSourceWindowContent(stableSerialize(edited), envelope.envelopeHash), { code: 'PERSISTENCE_CONFLICT' })
  const moved = JSON.parse(stored)
  moved.window.endSourceFrame -= 5
  assert.throws(() => hydrateFaceSourceWindowContent(stableSerialize(moved), envelope.envelopeHash), { code: 'PERSISTENCE_CONFLICT' })
  const otherBytes = JSON.parse(stored)
  otherBytes.sourceSha256 = 'f'.repeat(64)
  assert.throws(() => hydrateFaceSourceWindowContent(stableSerialize(otherBytes), envelope.envelopeHash), { code: 'PERSISTENCE_CONFLICT' }, 'a window cannot be re-pointed at other bytes')
  assert.throws(() => hydrateFaceSourceWindowContent(stored, 'f'.repeat(64)), { code: 'PERSISTENCE_CONFLICT' })
  assert.throws(() => hydrateFaceSourceWindowContent('{', envelope.envelopeHash), { code: 'PERSISTENCE_CONFLICT' })
  const extra = JSON.parse(stored)
  extra.approvedBy = 'someone'
  assert.throws(() => hydrateFaceSourceWindowContent(stableSerialize(extra), envelope.envelopeHash), { code: 'PERSISTENCE_CONFLICT' })
  // a v2 (timeline-keyed) document is not a source window
  const v2 = JSON.parse(stored); v2.schemaVersion = 'face-producer-envelope/v2'
  assert.throws(() => hydrateFaceSourceWindowContent(stableSerialize(v2), envelope.envelopeHash), { code: 'PERSISTENCE_CONFLICT' })
})

test('raw detector outputs must reproduce their samples exactly, in both directions', () => {
  const { envelope, rawOutputs } = windowWithRaw({ failAt: 20 })
  const rows = rowsOf(envelope, rawOutputs)
  assert.equal(rows.length, envelope.samples.length - 1, 'the unknown sample has no raw output')
  assert.deepEqual(rows.slice(0, 2).map((row) => row.sourceFrame), [0, 5])
  assertFaceSourceWindowRawOutputs(envelope, rows)

  // a missing row, a repeated row and a row for a sample that declares none
  assert.throws(() => assertFaceSourceWindowRawOutputs(envelope, rows.slice(1)), { code: 'PERSISTENCE_CONFLICT' })
  assert.throws(() => assertFaceSourceWindowRawOutputs(envelope, [...rows, rows[0]]), { code: 'PERSISTENCE_CONFLICT' })
  const unknownIndex = envelope.samples.findIndex((sample) => sample.status === 'unknown')
  assert.throws(() => assertFaceSourceWindowRawOutputs(envelope, [...rows, { ...rows[0], sampleIndex: unknownIndex }]), { code: 'PERSISTENCE_CONFLICT' })

  // bytes that do not hash to the sealed digest, a different tensor with its own honest digest, a shifted frame
  const flipped = new Uint8Array(rows[1].rawBytes); flipped[3] ^= 1
  assert.throws(() => assertFaceSourceWindowRawOutputs(envelope, rows.map((row, index) => index === 1 ? { ...row, rawBytes: flipped } : row)), { code: 'PERSISTENCE_CONFLICT' })
  const other = sourceSampleWithRaw({ sourceFrame: 0, rows: [[0.7, 0.1, 0.1, 0.2, 0.2]] }).raw
  assert.throws(() => assertFaceSourceWindowRawOutputs(envelope, rows.map((row, index) => index === 0 ? { ...row, rawBytes: other } : row)), { code: 'PERSISTENCE_CONFLICT' })
  assert.throws(() => assertFaceSourceWindowRawOutputs(envelope, rows.map((row, index) => index === 2 ? { ...row, sourceFrame: row.sourceFrame + 1 } : row)), { code: 'PERSISTENCE_CONFLICT' })
  assert.throws(() => assertFaceSourceWindowRawOutputs(envelope, rows.map((row, index) => index === 2 ? { ...row, rawBytes: row.rawBytes.subarray(0, 5599) } : row)), { code: 'PERSISTENCE_CONFLICT' })
})

test('the stored boxes are re-derived from the raw output: boxes that the tensor does not contain are refused', () => {
  const { envelope, rawOutputs } = windowWithRaw()
  const forged = JSON.parse(stableSerialize(envelope))
  forged.samples[2].boxes = [{ boxXYXY: [0.1, 0.1, 0.3, 0.3], confidence: 0.95, clipped: false, classification: 'unverified-face-candidate' }]
  // a forged envelope must be re-sealed to be hydratable; sealing it does not make it reproducible from the tensor
  const { schemaVersion: _a, authority: _b, coverage: _c, faceSafety: _d, identity: _e, detectorConfigHash: _g, envelopeHash: _h, ...input } = forged
  const resealed = createFaceProducerEnvelopeV3(input)
  assert.throws(() => assertFaceSourceWindowRawOutputs(resealed, rowsOf(envelope, rawOutputs)), { code: 'PERSISTENCE_CONFLICT' })
})

test('raw outputs that do not line up with the samples are refused before any row is built', () => {
  const { envelope, rawOutputs } = windowWithRaw()
  assert.throws(() => faceSourceWindowRawOutputRows(envelope, rawOutputs.slice(1)), { code: 'PERSISTENCE_CONFLICT' })
  assert.throws(() => faceSourceWindowRawOutputRows(envelope, [...rawOutputs, null]), { code: 'PERSISTENCE_CONFLICT' })
})

test('publish refuses, before touching the database, a producer the registry does not authenticate', async () => {
  let touched = 0
  const repository = new PrismaFaceSourceWindowRepository({ $transaction: async () => { touched += 1; throw new Error('database reached') } })
  const refused = (error) => error.code === 'PERSISTENCE_CONFLICT' && /accepted producer/.test(error.message)
  await assert.rejects(repository.publish(publishInput(windowWithRaw({ producer: { ...acceptedProducer('linux'), pythonExecutableSha256: 'f'.repeat(64) } }))), refused)
  const base = acceptedProducer()
  await assert.rejects(repository.publish(publishInput(windowWithRaw({
    producer: { ...base, assessment: { ...base.assessment, runtimeParity: { status: 'pending', receiptSha256: null } } } }))), refused)
  await assert.rejects(repository.publish(publishInput(windowWithRaw({
    producer: { ...base, runtime: { ...base.runtime, openvinoVersion: '2099.1.0' } } }))), refused)
  assert.equal(touched, 0)
})

test('publish refuses mismatched raw outputs before touching the database, and a sound window then reaches the transaction', async () => {
  let touched = 0
  const repository = new PrismaFaceSourceWindowRepository({ $transaction: async () => { touched += 1; throw new Error('database reached') } })
  const built = windowWithRaw()
  await assert.rejects(repository.publish(publishInput(built, { rawOutputs: built.rawOutputs.slice(1) })), { code: 'PERSISTENCE_CONFLICT' })
  const swapped = built.rawOutputs.map((raw, index) => index === 0 ? sourceSampleWithRaw({ sourceFrame: 0, rows: [[0.6, 0.3, 0.3, 0.5, 0.5]] }).raw : raw)
  await assert.rejects(repository.publish(publishInput(built, { rawOutputs: swapped })), { code: 'PERSISTENCE_CONFLICT' })
  assert.equal(touched, 0)
  await assert.rejects(repository.publish(publishInput(built)), /database reached/)
  assert.equal(touched, 1)
})

test('claim and listing refuse invalid arguments before the database', async () => {
  const unreachable = () => { throw new Error('database reached') }
  const repository = new PrismaFaceSourceWindowRepository({ $transaction: unreachable, v2FaceSourceWindowEnvelope: { findMany: unreachable } })
  await assert.rejects(repository.claimNext({ leaseOwner: ' ', now: new Date(), leaseMs: 30_000 }), { code: 'INVALID_ARGUMENT' })
  await assert.rejects(repository.claimNext({ leaseOwner: 'owner', now: new Date(), leaseMs: 1000 }), { code: 'INVALID_ARGUMENT' })
  const base = { workspaceId: 'w', projectId: 'p', sourceArtifactId: 's', now: new Date() }
  for (const range of [{ fromSourceFrame: -1, toSourceFrame: 10 }, { fromSourceFrame: 10, toSourceFrame: 10 }, { fromSourceFrame: 0.5, toSourceFrame: 10 }]) {
    await assert.rejects(repository.listSourceWindows({ ...base, ...range }), { code: 'INVALID_ARGUMENT' })
  }
  for (const limit of [0, 201, 1.5]) {
    await assert.rejects(repository.listSourceWindows({ ...base, fromSourceFrame: 0, toSourceFrame: 10, limit }), { code: 'INVALID_ARGUMENT' })
  }
})
