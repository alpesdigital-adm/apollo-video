import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, mkdtempSync, writeFileSync, existsSync, copyFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { YunetCpuFaceDetector } from '../../src/v2/infrastructure/perception/yunet-cpu-face-detector.ts'

const bridgePath = fileURLToPath(new URL('../../src/v2/infrastructure/perception/yunet_cpu_bridge.py', import.meta.url))
const fake = new YunetCpuFaceDetector({ pythonExecutable: join(tmpdir(), 'missing-python'), pythonExecutableSha256: 'a'.repeat(64), pythonModulePath: join(tmpdir(), 'missing-modules'), modelPath: join(tmpdir(), 'missing-model.onnx'), bridgePath, bridgeSha256: 'a'.repeat(64), opencvBinaryPath: join(tmpdir(), 'missing-cv2'), opencvBinarySha256: 'a'.repeat(64) })
const blackPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAEUlEQVR4nGNgGAWjYBQwQAEAAxAAAXyL/2UAAAAASUVORK5CYII=', 'base64')
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const hasRuntime = !!(process.env.W61_PYTHON && process.env.W61_PYDEPS && process.env.W61_YUNET_MODEL)
const nativeBinary = () => {
  const path = process.env.W61_OPENCV_BINARY
  if (path) return path
  const pyd = join(process.env.W61_PYDEPS, 'cv2', 'cv2.pyd')
  const so = join(process.env.W61_PYDEPS, 'cv2', 'cv2.abi3.so')
  if (existsSync(pyd)) return pyd
  if (existsSync(so)) return so
  throw new Error('W61_OPENCV_BINARY_REQUIRED')
}
const runtimeConfig = (overrides = {}) => {
  const opencvBinaryPath = nativeBinary()
  return { pythonExecutable: process.env.W61_PYTHON, pythonExecutableSha256: sha(process.env.W61_PYTHON), pythonModulePath: process.env.W61_PYDEPS, modelPath: process.env.W61_YUNET_MODEL, bridgePath, bridgeSha256: sha(bridgePath), opencvBinaryPath, opencvBinarySha256: sha(opencvBinaryPath), timeoutMs: 30_000, ...overrides }
}
const frameInput = () => ({ sourceSha256: 'a'.repeat(64), frames: [{ ptsMs: 0, bytes: blackPng }] })
const until = async (predicate, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('TEST_WAIT_EXPIRED')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true } catch { return false }
}

test('rejects invalid source and frame ordering before starting Python', async () => {
  await assert.rejects(() => fake.detect({ sourceSha256: 'not-sha', frames: [{ ptsMs: 0, bytes: blackPng }] }), /FACE_SOURCE_INVALID_SHA256/)
  await assert.rejects(() => fake.detect({ sourceSha256: 'a'.repeat(64), frames: [{ ptsMs: 0, bytes: blackPng }, { ptsMs: 0, bytes: blackPng }] }), /FACE_FRAME_PTS_INVALID/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => fake.detect({ sourceSha256: 'a'.repeat(64), frames: [{ ptsMs: 0, bytes: blackPng }], signal: controller.signal }), /FACE_DETECTOR_CANCELLED/)
})

test('actual pinned CPU bridge reports only sampled frame coverage', { skip: !hasRuntime }, async () => {
  const opencvBinaryPath = nativeBinary()
  const detector = new YunetCpuFaceDetector(runtimeConfig())
  const result = await detector.detect({ sourceSha256: 'a'.repeat(64), frames: [{ ptsMs: 1250, bytes: blackPng }] })
  assert.equal(result.coverage, 'sampled-only')
  assert.equal(result.frames.length, 1)
  assert.deepEqual(result.frames[0], { ptsMs: 1250, sha256: createHash('sha256').update(blackPng).digest('hex'), status: 'observed', boxes: [] })
  assert.equal(result.opencvVersion, '4.13.0')
  assert.equal(result.opencvPackageVersion, '4.13.0.92')
  assert.equal(result.bridgeSha256, sha(bridgePath))
  assert.equal(result.opencvBinarySha256, sha(opencvBinaryPath))
  assert.ok(Object.isFrozen(result.frames[0]) && Object.isFrozen(result.frames))
  const oversized = Buffer.from(blackPng)
  oversized.writeUInt32BE(100_000, 16)
  const rejected = await detector.detect({ sourceSha256: 'a'.repeat(64), frames: [{ ptsMs: 0, bytes: oversized }] })
  assert.equal(rejected.frames[0].status, 'unknown')
  assert.equal(rejected.frames[0].reason, 'FRAME_DIMENSION_LIMIT')
  const invalidJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x20])
  const malformed = await detector.detect({ sourceSha256: 'a'.repeat(64), frames: [{ ptsMs: 0, bytes: invalidJpeg }] })
  assert.equal(malformed.frames[0].status, 'unknown')
  assert.equal(malformed.frames[0].reason, 'JPEG_HEADER_INVALID')
})

test('rejects altered model and runtime files before spawn', { skip: !hasRuntime }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'w61-face-hash-'))
  try {
    const modelPath = join(dir, 'model.onnx')
    const model = Buffer.from(readFileSync(process.env.W61_YUNET_MODEL))
    model[0] ^= 1
    writeFileSync(modelPath, model)
    await assert.rejects(() => new YunetCpuFaceDetector(runtimeConfig({ modelPath })).detect(frameInput()), /FACE_MODEL_HASH_MISMATCH/)
    await assert.rejects(() => new YunetCpuFaceDetector(runtimeConfig({ bridgeSha256: '0'.repeat(64) })).detect(frameInput()), /FACE_RUNTIME_HASH_MISMATCH/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('timeout and in-flight abort close their exact owned child', { skip: !hasRuntime }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'w61-face-lifecycle-'))
  const sleeperPath = join(dir, 'sleep.py')
  writeFileSync(sleeperPath, 'import os,time,pathlib\npathlib.Path(os.environ["W61_TEST_PIDFILE"]).write_text(str(os.getpid()))\ntime.sleep(30)\n')
  try {
    for (const mode of ['timeout', 'abort']) {
      const pidFile = join(dir, `${mode}.pid`)
      process.env.W61_TEST_PIDFILE = pidFile
      const detector = new YunetCpuFaceDetector(runtimeConfig({ bridgePath: sleeperPath, bridgeSha256: sha(sleeperPath), timeoutMs: mode === 'timeout' ? 1000 : 5000 }))
      const controller = new AbortController()
      const pending = detector.detect({ ...frameInput(), signal: controller.signal })
      await until(() => existsSync(pidFile))
      const pid = Number(readFileSync(pidFile, 'utf8'))
      assert.ok(pidAlive(pid))
      if (mode === 'abort') controller.abort()
      await assert.rejects(() => pending, mode === 'timeout' ? /FACE_DETECTOR_TIMEOUT/ : /FACE_DETECTOR_CANCELLED/)
      await until(() => !pidAlive(pid))
    }
  } finally { delete process.env.W61_TEST_PIDFILE; rmSync(dir, { recursive: true, force: true }) }
})

test('spawn failure is handled without an unhandled error event', { skip: !hasRuntime }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'w61-face-spawn-'))
  try {
    const badExecutable = join(dir, process.platform === 'win32' ? 'invalid.exe' : 'invalid')
    writeFileSync(badExecutable, 'this is not an executable')
    if (process.platform !== 'win32') chmodSync(badExecutable, 0o755)
    const detector = new YunetCpuFaceDetector(runtimeConfig({ pythonExecutable: badExecutable, pythonExecutableSha256: sha(badExecutable) }))
    await assert.rejects(() => detector.detect(frameInput()), /FACE_PROCESS_(NOT_STARTED|FAILED)/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
