// A stand-in for openvino_face0204_bridge.py that speaks its protocol, run by Node in place of Python.
// FAKE_BRIDGE_MODE selects a behavior; FAKE_BRIDGE_ROWS is a JSON array (one entry per frame) of detector rows.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { decodeFace0204Output } from '../../../src/v2/domain/face-detector-output.ts'
import { ACCEPTED_FACE_PRODUCERS } from '../../../src/v2/domain/face-producer-registry.ts'

const mode = process.env.FAKE_BRIDGE_MODE ?? 'ok'
const rowsByFrame = JSON.parse(process.env.FAKE_BRIDGE_ROWS ?? '[]')
const request = JSON.parse(readFileSync(0, 'utf8'))
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const bridgeSha = process.argv[4], pythonSha = process.argv[5]
const accepted = ACCEPTED_FACE_PRODUCERS[0]
const platform = accepted.platforms[0]

function tensor(rows) {
  const bytes = new Uint8Array(5600)
  const view = new DataView(bytes.buffer)
  for (let slot = 0; slot < 200; slot += 1) {
    const row = rows[slot]
    const values = row ? [0, 0, ...row] : [-1, 0, 0, 0, 0, 0, 0]
    values.forEach((value, index) => view.setFloat32((slot * 7 + index) * 4, value, true))
  }
  return bytes
}

if (mode === 'crash') process.exit(3)
if (mode === 'hang') setInterval(() => {}, 1000)
else {
  const frames = request.frames.map((entry, index) => {
    const rows = rowsByFrame[index] ?? []
    if (rows === 'unreadable') return { ...entry, status: 'unknown', reason: 'FRAME_READ_FAILED', failedSlot: null, width: null, height: null,
      inferMs: null, rawOutputBase64: null, rawOutputSha256: null, detections: [] }
    const raw = rows === 'invalid' ? tensor([[0.9, 0.5, 0.1, 0.3, 0.3]]) : tensor(rows)
    const decoded = decodeFace0204Output(raw, 0.2)
    const base = { ...entry, width: 1280, height: 720, inferMs: 17.5, rawOutputBase64: Buffer.from(raw).toString('base64'), rawOutputSha256: sha(raw) }
    if (decoded.status === 'failed') return { ...base, status: 'unknown', reason: decoded.reason, failedSlot: decoded.slot, detections: [] }
    return { ...base, status: 'observed', reason: null, failedSlot: null, detections: JSON.parse(JSON.stringify(decoded.detections)) }
  })
  if (mode === 'tamper-box' && frames[0].detections[0]) frames[0].detections[0].boxXYXY[3] += 0.01
  if (mode === 'drop-box' && frames[0].detections.length) frames[0].detections.pop()
  if (mode === 'raw-hash') frames[0].rawOutputSha256 = '0'.repeat(64)
  if (mode === 'echo-pts') frames[0].ptsMs += 1
  if (mode === 'extra-frame') frames.push({ ...frames[0] })
  if (mode === 'observed-without-output') { frames[0].rawOutputBase64 = null; frames[0].rawOutputSha256 = null }
  const runtime = { platform: platform.platform, pythonVersion: platform.pythonVersion, openvinoVersion: platform.openvinoVersion,
    openvinoPackageVersion: platform.openvinoPackageVersion, opencvVersion: platform.opencvVersion, numpyVersion: platform.numpyVersion }
  if (mode === 'wrong-runtime') runtime.openvinoVersion = '2026.9.9'
  const model = process.env.FAKE_BRIDGE_MODEL ? JSON.parse(process.env.FAKE_BRIDGE_MODEL) : { xml: accepted.model.xmlSha256, bin: accepted.model.binSha256 }
  const response = { protocol: 'apollo-openvino-face0204-v1', sourceSha256: request.sourceSha256, bridgeSha256: bridgeSha, pythonSha256: pythonSha,
    modelXmlSha256: model.xml, modelBinSha256: model.bin, outputPolicyId: 'w62-v9-visible-intersection-continuous/v1', collectionFloor: 0.2,
    runtime, coverage: 'sampled-only', elapsedMs: 12.5, frames }
  if (mode === 'wrong-source') response.sourceSha256 = '1'.repeat(64)
  if (mode === 'wrong-floor') response.collectionFloor = 0.5
  if (mode === 'extra-key') response.extra = true
  if (mode === 'huge') process.stdout.write('x'.repeat(9_000_000))
  else process.stdout.write(JSON.stringify(response))
}
