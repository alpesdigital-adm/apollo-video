import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ACCEPTED_FACE_PRODUCERS } from '../../src/v2/domain/face-producer-registry.ts'
import { buildFaceRuntimeManifest, FaceRuntimeInventory, faceRuntimeManifestSha256 } from '../../src/v2/infrastructure/perception/face-runtime-inventory.ts'
import { OpenvinoFace0204Detector } from '../../src/v2/infrastructure/perception/openvino-face0204-detector.ts'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const FAKE_BRIDGE = new URL('./helpers/fake-face0204-bridge.mjs', import.meta.url)
const SOURCE = 'b'.repeat(64)
const HEAD = [0.95, 0.35, 0.15, 0.65, 0.75]
const SMALL = [0.4, 0.05, 0.4, 0.09, 0.44]

async function rig(overrides = {}) {
  const base = await mkdtemp(join(tmpdir(), 'apollo-face-detector-'))
  const runtime = join(base, 'site-packages')
  await mkdir(runtime)
  await writeFile(join(runtime, 'openvino.py'), 'version = 1\n')
  const manifest = await buildFaceRuntimeManifest(runtime)
  const manifestPath = join(base, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify(manifest))
  const inventory = await FaceRuntimeInventory.load({ root: runtime, manifestPath, manifestSha256: faceRuntimeManifestSha256(manifest) })
  const xml = Buffer.from('<net/>'), bin = Buffer.from('weights')
  await writeFile(join(base, 'm.xml'), xml); await writeFile(join(base, 'm.bin'), bin)
  const bridgePath = new URL(FAKE_BRIDGE).pathname.replace(/^\/([A-Za-z]:)/, '$1').replaceAll('/', process.platform === 'win32' ? '\\' : '/')
  const bridgeSha256 = sha(await readFile(bridgePath))
  const pythonSha256 = sha(await readFile(process.execPath))
  const pins = { xml: { sha256: sha(xml), bytes: xml.length }, bin: { sha256: sha(bin), bytes: bin.length } }
  process.env.FAKE_BRIDGE_MODEL = JSON.stringify({ xml: pins.xml.sha256, bin: pins.bin.sha256 })
  const detector = new OpenvinoFace0204Detector({ pythonExecutable: process.execPath, pythonExecutableSha256: pythonSha256,
    pythonModulePath: runtime, modelXmlPath: join(base, 'm.xml'), modelBinPath: join(base, 'm.bin'), bridgePath, bridgeSha256,
    runtimeInventory: inventory, modelPins: pins, timeoutMs: 20_000, ...overrides })
  const frames = [0, 1, 2].map((index) => ({ ptsMs: index * 167, file: `frame-${String(index).padStart(6, '0')}.png`, sha256: sha(`frame-${index}`) }))
  return { base, detector, frames, runtime, inventory, framesDirectory: join(base, 'frames') }
}
const run = async (mode, rows, rigged) => {
  process.env.FAKE_BRIDGE_MODE = mode
  process.env.FAKE_BRIDGE_ROWS = JSON.stringify(rows)
  return rigged.detector.detect({ sourceSha256: SOURCE, framesDirectory: rigged.framesDirectory, frames: rigged.frames })
}

test('a valid response becomes frames whose boxes are re-derived from the raw detector output', async () => {
  const r = await rig()
  try {
    const batch = await run('ok', [[HEAD, SMALL], [], 'invalid'], r)
    assert.equal(batch.coverage, 'sampled-only')
    assert.equal(batch.frames.length, 3)
    assert.equal(batch.frames[0].status, 'observed')
    assert.equal(batch.frames[0].detections.length, 2)
    assert.equal(batch.frames[0].rawOutput.byteLength, 5600)
    assert.equal(batch.frames[1].status, 'observed')
    assert.deepEqual(batch.frames[1].detections, [])
    // The bridge reports a policy failure; the frame stays unknown with the policy's own reason and its raw output.
    assert.equal(batch.frames[2].status, 'unknown')
    assert.equal(batch.frames[2].reason, 'DETECTOR_FACE_BOX_REVERSED_OR_ZERO_AREA')
    assert.notEqual(batch.frames[2].rawOutput, null)
    assert.equal(batch.runtimeManifestSha256, r.inventory.manifestSha256)
    assert.equal(batch.runtime.platform, ACCEPTED_FACE_PRODUCERS[0].platforms[0].platform)
    assert.throws(() => { batch.frames[0].detections.push({}) }, TypeError)
    const unreadable = await run('ok', [[HEAD], 'unreadable', []], r)
    assert.equal(unreadable.frames[1].status, 'unknown')
    assert.equal(unreadable.frames[1].rawOutput, null)
  } finally { await rm(r.base, { recursive: true, force: true }) }
})

test('a bridge that disagrees with the V9 policy, the request or the accepted runtime cannot publish evidence', async () => {
  const r = await rig()
  try {
    const refusal = (mode, pattern, rows = [[HEAD], [HEAD], []]) => assert.rejects(run(mode, rows, r), pattern, mode)
    await refusal('tamper-box', /DETECTIONS_DIFFER_FROM_POLICY/)
    await refusal('drop-box', /DETECTIONS_DIFFER_FROM_POLICY/)
    await refusal('raw-hash', /RAW_OUTPUT_HASH_MISMATCH/)
    await refusal('echo-pts', /FRAME_RESPONSE_INVALID/)
    await refusal('extra-frame', /RESPONSE_INVALID/)
    await refusal('wrong-source', /RESPONSE_INVALID/)
    await refusal('wrong-floor', /RESPONSE_INVALID/)
    await refusal('extra-key', /RESPONSE_INVALID/)
    await refusal('observed-without-output', /OBSERVED_FRAME_WITHOUT_VALID_OUTPUT/)
    await refusal('wrong-runtime', /RUNTIME_NOT_ACCEPTED_RUNTIME_VERSION_MISMATCH/)
    await refusal('crash', /PROCESS_FAILED/)
    await refusal('huge', /RESPONSE_TOO_LARGE/)
  } finally { await rm(r.base, { recursive: true, force: true }) }
})

test('model, bridge, interpreter and runtime are verified before and after the process', async () => {
  const r = await rig()
  try {
    await writeFile(join(r.base, 'm.bin'), Buffer.from('weightz'))
    await assert.rejects(run('ok', [[]], r), /MODEL_HASH_MISMATCH/)
    await writeFile(join(r.base, 'm.bin'), Buffer.from('weights-and-more'))
    await assert.rejects(run('ok', [[]], r), /MODEL_SIZE_MISMATCH/)
    await writeFile(join(r.base, 'm.bin'), Buffer.from('weights'))
    await run('ok', [[]], r)
    await writeFile(join(r.runtime, 'openvino.py'), 'version = 2\n')
    await assert.rejects(run('ok', [[]], r), /Face runtime file/)
  } finally { await rm(r.base, { recursive: true, force: true }) }
  const wrongBridge = await rig({ bridgeSha256: 'a'.repeat(64) })
  try { await assert.rejects(run('ok', [[]], wrongBridge), /RUNTIME_HASH_MISMATCH/) } finally { await rm(wrongBridge.base, { recursive: true, force: true }) }
  const wrongPython = await rig({ pythonExecutableSha256: 'a'.repeat(64) })
  try { await assert.rejects(run('ok', [[]], wrongPython), /RUNTIME_HASH_MISMATCH/) } finally { await rm(wrongPython.base, { recursive: true, force: true }) }
})

test('a hung process is killed at the timeout and a cancelled request never starts', async () => {
  const r = await rig({ timeoutMs: 1_500 })
  try {
    await assert.rejects(run('hang', [], r), /TIMEOUT/)
    const controller = new AbortController()
    controller.abort()
    process.env.FAKE_BRIDGE_MODE = 'ok'
    await assert.rejects(r.detector.detect({ sourceSha256: SOURCE, framesDirectory: r.framesDirectory, frames: r.frames, signal: controller.signal }), /CANCELLED/)
  } finally { await rm(r.base, { recursive: true, force: true }) }
})

test('malformed requests and configuration are refused before any process', async () => {
  const r = await rig()
  try {
    const detect = (input) => r.detector.detect({ sourceSha256: SOURCE, framesDirectory: r.framesDirectory, frames: r.frames, ...input })
    await assert.rejects(detect({ sourceSha256: 'xyz' }), /REQUEST_INVALID/)
    await assert.rejects(detect({ framesDirectory: 'relative' }), /REQUEST_INVALID/)
    await assert.rejects(detect({ frames: [] }), /REQUEST_INVALID/)
    await assert.rejects(detect({ frames: Array.from({ length: 61 }, (_u, i) => ({ ptsMs: i, file: 'frame-000000.png', sha256: sha('x') })) }), /REQUEST_INVALID/)
    await assert.rejects(detect({ frames: [{ ptsMs: 5, file: 'a.png', sha256: sha('x') }] }), /FRAME_ENTRY_INVALID/)
    await assert.rejects(detect({ frames: [r.frames[1], r.frames[0]] }), /FRAME_ENTRY_INVALID/)
    assert.throws(() => new OpenvinoFace0204Detector({ ...r.detector.config, pythonExecutable: 'python', pythonModulePath: 'x' }), /absolute|undefined/)
  } finally { await rm(r.base, { recursive: true, force: true }) }
})
