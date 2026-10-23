import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  ACCEPTED_FACE_PRODUCERS, authenticateFaceProducer, FACE_LINUX_PARITY_CRITERION, FACE_V9_LINUX_PARITY_RECEIPT_DOCUMENT,
  FACE_V9_LINUX_PARITY_RECEIPT_SHA256, FACE_V9_RECEIPT_SHA256, faceWorkerPinReasons, faceWorkerPlatformAccepted,
} from '../../src/v2/domain/face-producer-registry.ts'
import { acceptedProducer, sha } from './helpers/face-envelope-v2.mjs'

const clone = (value) => JSON.parse(JSON.stringify(value))
const accepted = ACCEPTED_FACE_PRODUCERS[0]
const platformEntry = (platform) => accepted.platforms.find((candidate) => candidate.platform === platform)
const NO_BYTES = { pythonExecutableSha256: '', runtimeManifestSha256: '', bridgeSha256: '' }

test('Linux is authenticated only on the exact bytes of its owner-accepted parity receipt (fail-closed)', () => {
  assert.equal(faceWorkerPlatformAccepted('linux'), true)
  assert.equal(authenticateFaceProducer(acceptedProducer('linux')).authenticated, true)
  const entry = platformEntry('linux')
  assert.equal(entry.parityCriterion, FACE_LINUX_PARITY_CRITERION)
  assert.equal(entry.parityReceiptSha256, FACE_V9_LINUX_PARITY_RECEIPT_SHA256)
  const mutate = (change) => { const producer = clone(acceptedProducer('linux')); change(producer); return authenticateFaceProducer(producer) }

  // Any pinned byte that moved refuses the platform again, one named reason each.
  assert.deepEqual(mutate((p) => { p.pythonExecutableSha256 = sha('9') }).reasons, ['PYTHON_EXECUTABLE_PIN_MISMATCH'])
  assert.deepEqual(mutate((p) => { p.runtime.runtimeManifestSha256 = sha('9') }).reasons, ['RUNTIME_MANIFEST_PIN_MISMATCH'])
  assert.deepEqual(mutate((p) => { p.bridgeSha256 = sha('9') }).reasons, ['BRIDGE_PIN_MISMATCH'])

  // Models and versions stay bound as on every platform.
  assert.ok(mutate((p) => { p.model.binSha256 = sha('9') }).reasons.includes('MODEL_BINSHA256_MISMATCH'))
  assert.deepEqual(mutate((p) => { p.runtime.pythonVersion = '3.14' }).reasons, ['RUNTIME_VERSION_MISMATCH'])
  assert.deepEqual(mutate((p) => { p.runtime.openvinoVersion = '2026.5.0' }).reasons, ['RUNTIME_VERSION_MISMATCH'])

  // No receipt, or the Windows receipt presented for Linux, is not a Linux receipt.
  assert.deepEqual(mutate((p) => { p.assessment.runtimeParity = { status: 'pending', receiptSha256: null } }).reasons, ['RUNTIME_PARITY_MISMATCH'])
  assert.deepEqual(mutate((p) => { p.assessment.runtimeParity.receiptSha256 = FACE_V9_RECEIPT_SHA256 }).reasons, ['RUNTIME_PARITY_MISMATCH'])

  // A platform with no receipt at all is refused.
  const darwin = clone(acceptedProducer('linux'))
  darwin.runtime.platform = 'darwin'
  assert.deepEqual(authenticateFaceProducer(darwin).reasons, ['RUNTIME_PLATFORM_NOT_PARITIED'])
})

test('the worker-start check reads the same pins from the configured bytes', () => {
  const pins = platformEntry('linux').pins
  assert.deepEqual(faceWorkerPinReasons('linux', pins), [])
  assert.deepEqual(faceWorkerPinReasons('linux', { ...pins, bridgeSha256: sha('9') }), ['BRIDGE_PIN_MISMATCH'])
  assert.deepEqual(faceWorkerPinReasons('linux', { ...pins, pythonExecutableSha256: sha('9') }), ['PYTHON_EXECUTABLE_PIN_MISMATCH'])
  assert.deepEqual(faceWorkerPinReasons('linux', NO_BYTES), ['PYTHON_EXECUTABLE_PIN_MISMATCH', 'RUNTIME_MANIFEST_PIN_MISMATCH', 'BRIDGE_PIN_MISMATCH'])
  assert.deepEqual(faceWorkerPinReasons('darwin', pins), ['RUNTIME_PLATFORM_NOT_PARITIED'])
})

test('Windows is unchanged by the Linux receipt: its own V9 receipt, no byte pins, its own criterion', () => {
  const entry = platformEntry('win32')
  assert.equal(entry.parityReceiptSha256, FACE_V9_RECEIPT_SHA256)
  assert.equal(entry.parityCriterion, 'v9-development-receipt')
  assert.equal(entry.pins, undefined)
  assert.deepEqual(faceWorkerPinReasons('win32', NO_BYTES), [])
  assert.equal(authenticateFaceProducer(acceptedProducer('win32')).authenticated, true)
  const windows = clone(acceptedProducer('win32'))
  windows.assessment.runtimeParity.receiptSha256 = FACE_V9_LINUX_PARITY_RECEIPT_SHA256
  assert.deepEqual(authenticateFaceProducer(windows).reasons, ['RUNTIME_PARITY_MISMATCH'])
})

test('the Linux parity receipt is content-addressed, agrees with the registry pins and meets the criterion the owner accepted', () => {
  const bytes = readFileSync(new URL(`../../${FACE_V9_LINUX_PARITY_RECEIPT_DOCUMENT}`, import.meta.url))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), FACE_V9_LINUX_PARITY_RECEIPT_SHA256)
  assert.equal(bytes.includes(13), false, 'the receipt is pinned by hash and must stay LF')
  const receipt = JSON.parse(bytes.toString('utf8'))
  const entry = platformEntry('linux')
  assert.equal(receipt.producerId, accepted.id)
  assert.equal(receipt.platform, 'linux')
  assert.equal(receipt.criterion.id, FACE_LINUX_PARITY_CRITERION)
  assert.equal(receipt.criterion.scoreFloor, 0.5)
  assert.equal(receipt.criterion.maxAbsDelta, 1e-6)
  assert.equal(receipt.criterion.tensorsByteIdenticalRequired, false)
  assert.equal(receipt.acceptance.by, 'owner')
  assert.equal(receipt.acceptance.on, '2026-10-22')

  // The receipt names exactly the bytes and versions the registry pins.
  assert.equal(receipt.pins.pythonExecutableSha256, entry.pins.pythonExecutableSha256)
  assert.equal(receipt.pins.runtimeManifestSha256, entry.pins.runtimeManifestSha256)
  assert.equal(receipt.pins.workerBridgeSha256, entry.pins.bridgeSha256)
  assert.equal(receipt.pins.modelXmlSha256, accepted.model.xmlSha256)
  assert.equal(receipt.pins.modelBinSha256, accepted.model.binSha256)
  assert.equal(receipt.pins.modelLicenseSha256, accepted.model.licenseSha256)
  for (const key of ['pythonVersion', 'openvinoVersion', 'openvinoPackageVersion', 'opencvVersion', 'numpyVersion']) assert.equal(receipt.pins[key], entry[key], key)

  // The recorded results satisfy the named criterion on every measured Linux platform, for V9 and for retail-0004.
  const measured = receipt.platformsMeasured.filter((platform) => platform.role === 'measured').map((platform) => platform.id)
  assert.deepEqual(measured, ['linux-x64-intel', 'linux-x64-amd-epyc-9555p'])
  for (const id of measured) for (const model of ['v9', 'retail0004']) {
    const result = receipt.results[id][model]
    const detections = result['detectionsAtOrAbove0.5']
    assert.equal(detections.identical, true, `${id} ${model}`)
    assert.equal(detections.measured, detections.reference, `${id} ${model}`)
    assert.ok(result.maxAbsDeltaBoxOrScore <= receipt.criterion.maxAbsDelta, `${id} ${model}`)
  }
  assert.equal(receipt.results['linux-x64-intel'].v9['detectionsAtOrAbove0.5'].measured, 61)
  assert.equal(receipt.results['linux-x64-intel'].retail0004['detectionsAtOrAbove0.5'].measured, 52)

  // Evidence is referenced by hash; no media is carried.
  assert.equal(receipt.inputs.images, 60)
  assert.equal(receipt.inputs.mediaInRepository, false)
  const evidenceHashes = Object.entries(receipt.evidence).filter(([key]) => key.endsWith('Sha256'))
  assert.ok(evidenceHashes.length >= 5)
  for (const [key, value] of evidenceHashes) assert.match(value, /^[0-9a-f]{64}$/, key)
})
