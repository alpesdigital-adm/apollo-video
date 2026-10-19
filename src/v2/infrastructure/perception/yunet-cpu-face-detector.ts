import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { performance } from 'node:perf_hooks'

const protocol = 'apollo-yunet-cpu-v1'
const modelSha256 = '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4'
const opencvVersion = '4.13.0'
const opencvPackageVersion = '4.13.0.92'
const maxFrames = 30
const maxFrameBytes = 5_000_000
const maxTotalBytes = 20_000_000
const maxResponseBytes = 2_000_000

export interface FaceFrameInput {
  readonly ptsMs: number
  readonly bytes: Uint8Array
}

export interface SampledFaceBox {
  /** Normalized [left, top, right, bottom], not XYWH. */
  readonly boxXYXY: readonly [number, number, number, number]
  readonly confidence: number
  readonly clipped: boolean
}

export interface SampledFaceObservation {
  readonly ptsMs: number
  readonly sha256: string
  readonly status: 'observed' | 'unknown'
  readonly boxes: readonly SampledFaceBox[]
  readonly reason?: string
}

export interface SampledFaceBatch {
  readonly sourceSha256: string
  readonly modelSha256: string
  readonly bridgeSha256: string
  readonly pythonSha256: string
  readonly opencvBinarySha256: string
  readonly opencvVersion: string
  readonly opencvPackageVersion: string
  readonly coverage: 'sampled-only'
  readonly frames: readonly SampledFaceObservation[]
  readonly elapsedMs: number
  readonly processId: number
}

export interface YunetCpuFaceDetectorConfig {
  readonly pythonExecutable: string
  readonly pythonExecutableSha256: string
  readonly pythonModulePath: string
  readonly modelPath: string
  readonly bridgePath: string
  readonly bridgeSha256: string
  readonly opencvBinaryPath: string
  readonly opencvBinarySha256: string
  readonly timeoutMs?: number
}

function assertSha(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label}_INVALID_SHA256`)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function assertFrames(frames: readonly FaceFrameInput[]): void {
  if (frames.length < 1 || frames.length > maxFrames) throw new Error('FACE_FRAME_COUNT_OUT_OF_RANGE')
  let previous = -1
  let total = 0
  for (const frame of frames) {
    if (!Number.isFinite(frame.ptsMs) || frame.ptsMs < 0 || frame.ptsMs <= previous) throw new Error('FACE_FRAME_PTS_INVALID')
    previous = frame.ptsMs
    if (!(frame.bytes instanceof Uint8Array) || frame.bytes.byteLength < 1 || frame.bytes.byteLength > maxFrameBytes) throw new Error('FACE_FRAME_BYTES_INVALID')
    total += frame.bytes.byteLength
  }
  if (total > maxTotalBytes) throw new Error('FACE_BATCH_BYTES_TOO_LARGE')
}

function validateResponse(value: unknown, expectedFrames: readonly { ptsMs: number; sha256: string }[], sourceSha256: string, hashes: { bridge: string; python: string; opencv: string }): readonly SampledFaceObservation[] {
  if (typeof value !== 'object' || value === null) throw new Error('FACE_RESPONSE_INVALID')
  const result = value as Record<string, unknown>
  if (!hasOnlyKeys(result, ['protocol', 'sourceSha256', 'modelSha256', 'bridgeSha256', 'pythonSha256', 'opencvBinarySha256', 'opencvVersion', 'opencvPackageVersion', 'backend', 'coverage', 'frames'])) throw new Error('FACE_RESPONSE_KEYS_INVALID')
  if (result.protocol !== protocol || result.sourceSha256 !== sourceSha256 || result.modelSha256 !== modelSha256 || result.bridgeSha256 !== hashes.bridge || result.pythonSha256 !== hashes.python || result.opencvBinarySha256 !== hashes.opencv || result.opencvVersion !== opencvVersion || result.opencvPackageVersion !== opencvPackageVersion || result.backend !== 'OpenCV DNN CPU' || result.coverage !== 'sampled-only' || !Array.isArray(result.frames) || result.frames.length !== expectedFrames.length) throw new Error('FACE_RESPONSE_PROVENANCE_INVALID')
  return result.frames.map((raw, index) => {
    if (typeof raw !== 'object' || raw === null) throw new Error('FACE_RESPONSE_FRAME_INVALID')
    const frame = raw as Record<string, unknown>
    if (!hasOnlyKeys(frame, ['ptsMs', 'sha256', 'status', 'reason', 'boxes'])) throw new Error('FACE_RESPONSE_FRAME_KEYS_INVALID')
    if (frame.ptsMs !== expectedFrames[index].ptsMs || frame.sha256 !== expectedFrames[index].sha256 || !Array.isArray(frame.boxes) || (frame.status !== 'observed' && frame.status !== 'unknown')) throw new Error('FACE_RESPONSE_FRAME_INVALID')
    if (frame.status === 'unknown') {
      if (typeof frame.reason !== 'string' || frame.reason.length < 1 || frame.reason.length > 120 || frame.boxes.length !== 0) throw new Error('FACE_RESPONSE_UNKNOWN_INVALID')
      return Object.freeze({ ptsMs: expectedFrames[index].ptsMs, sha256: expectedFrames[index].sha256, status: 'unknown' as const, reason: frame.reason, boxes: Object.freeze([]) })
    }
    if (frame.boxes.length > 128) throw new Error('FACE_RESPONSE_BOX_COUNT_LIMIT')
    const boxes = frame.boxes.map((rawBox): SampledFaceBox => {
      if (typeof rawBox !== 'object' || rawBox === null) throw new Error('FACE_RESPONSE_BOX_INVALID')
      const value = rawBox as Record<string, unknown>
      if (!hasOnlyKeys(value, ['boxXYXY', 'confidence', 'clipped'])) throw new Error('FACE_RESPONSE_BOX_KEYS_INVALID')
      if (!Array.isArray(value.boxXYXY) || value.boxXYXY.length !== 4 || !value.boxXYXY.every((number) => typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= 1) || !(value.boxXYXY[0] < value.boxXYXY[2]) || !(value.boxXYXY[1] < value.boxXYXY[3]) || typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0.5 || value.confidence > 1 || typeof value.clipped !== 'boolean') throw new Error('FACE_RESPONSE_BOX_INVALID')
      return Object.freeze({ boxXYXY: Object.freeze([...value.boxXYXY]) as unknown as readonly [number, number, number, number], confidence: value.confidence, clipped: value.clipped })
    })
    return Object.freeze({ ptsMs: expectedFrames[index].ptsMs, sha256: expectedFrames[index].sha256, status: 'observed' as const, boxes: Object.freeze(boxes) })
  })
}

/** Isolated candidate only. Every unsampled time range remains unknown to the consumer. */
export class YunetCpuFaceDetector {
  private readonly config: YunetCpuFaceDetectorConfig

  constructor(config: YunetCpuFaceDetectorConfig) {
    for (const path of [config.pythonExecutable, config.pythonModulePath, config.modelPath, config.bridgePath, config.opencvBinaryPath]) if (!isAbsolute(path)) throw new Error('FACE_DETECTOR_PATH_NOT_ABSOLUTE')
    for (const [label, hash] of [['FACE_PYTHON', config.pythonExecutableSha256], ['FACE_BRIDGE', config.bridgeSha256], ['FACE_OPENCV', config.opencvBinarySha256]] as const) assertSha(hash, label)
    if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 30_000)) throw new Error('FACE_DETECTOR_TIMEOUT_INVALID')
    this.config = Object.freeze({ ...config })
  }

  async detect(input: { readonly sourceSha256: string; readonly frames: readonly FaceFrameInput[]; readonly signal?: AbortSignal }): Promise<SampledFaceBatch> {
    assertSha(input.sourceSha256, 'FACE_SOURCE')
    assertFrames(input.frames)
    if (input.signal?.aborted) throw new Error('FACE_DETECTOR_CANCELLED')
    const modelInfo = await stat(this.config.modelPath)
    if (modelInfo.size !== 232589 || await hashFile(this.config.modelPath) !== modelSha256) throw new Error('FACE_MODEL_HASH_MISMATCH')
    const hashes = { bridge: await hashFile(this.config.bridgePath), python: await hashFile(this.config.pythonExecutable), opencv: await hashFile(this.config.opencvBinaryPath) }
    if (hashes.bridge !== this.config.bridgeSha256 || hashes.python !== this.config.pythonExecutableSha256 || hashes.opencv !== this.config.opencvBinarySha256) throw new Error('FACE_RUNTIME_HASH_MISMATCH')
    if (input.signal?.aborted) throw new Error('FACE_DETECTOR_CANCELLED')
    const expectedFrames = input.frames.map((frame) => ({ ptsMs: frame.ptsMs, sha256: createHash('sha256').update(frame.bytes).digest('hex') }))
    const payload = JSON.stringify({ protocol, sourceSha256: input.sourceSha256, modelSha256, frames: input.frames.map((frame, index) => ({ ptsMs: frame.ptsMs, sha256: expectedFrames[index].sha256, bytesBase64: Buffer.from(frame.bytes).toString('base64') })) })
    const started = performance.now()
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(this.config.pythonExecutable, [this.config.bridgePath, this.config.modelPath, hashes.bridge, hashes.python, hashes.opencv], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONPATH: this.config.pythonModulePath, PYTHONNOUSERSITE: '1', OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '2', CUDA_VISIBLE_DEVICES: '' } })
    } catch {
      throw new Error('FACE_PROCESS_NOT_STARTED')
    }
    let failure: string | undefined
    let spawnError: Error | undefined
    const chunks: Buffer[] = []
    let outputBytes = 0
    const stop = (reason: string) => { failure ??= reason; if (child.pid !== undefined) child.kill('SIGKILL') }
    const closed = new Promise<number | null>((resolve) => {
      child.once('error', (error) => { spawnError = error })
      child.once('close', resolve)
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      outputBytes += chunk.byteLength
      if (outputBytes > maxResponseBytes) stop('FACE_RESPONSE_TOO_LARGE')
      else chunks.push(chunk)
    })
    child.stderr?.on('data', () => { /* stderr is intentionally not retained: source bytes and paths stay private */ })
    child.stdin?.on('error', () => { /* an early bridge exit is handled by close/exit status */ })
    if (!child.stdout || !child.stderr || !child.stdin) stop('FACE_PROCESS_STDIO_MISSING')
    const cancel = () => stop('FACE_DETECTOR_CANCELLED')
    input.signal?.addEventListener('abort', cancel, { once: true })
    const timeout = setTimeout(() => stop('FACE_DETECTOR_TIMEOUT'), this.config.timeoutMs ?? 30_000)
    if (input.signal?.aborted) cancel()
    else if (child.pid !== undefined) child.stdin?.end(payload)
    try {
      const exitCode = await closed
      if (failure) throw new Error(failure)
      if (spawnError || child.pid === undefined) throw new Error('FACE_PROCESS_NOT_STARTED')
      if (exitCode !== 0) throw new Error('FACE_PROCESS_FAILED')
      const after = await Promise.all([hashFile(this.config.modelPath),
        hashFile(this.config.bridgePath), hashFile(this.config.pythonExecutable),
        hashFile(this.config.opencvBinaryPath)])
      if (after[0] !== modelSha256 || after[1] !== hashes.bridge ||
          after[2] !== hashes.python || after[3] !== hashes.opencv) {
        throw new Error('FACE_RUNTIME_HASH_MISMATCH')
      }
      let response: unknown
      try { response = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('FACE_RESPONSE_JSON_INVALID') }
      const frames = validateResponse(response, expectedFrames, input.sourceSha256, hashes)
      return Object.freeze({ sourceSha256: input.sourceSha256, modelSha256, bridgeSha256: hashes.bridge, pythonSha256: hashes.python, opencvBinarySha256: hashes.opencv, opencvVersion, opencvPackageVersion, coverage: 'sampled-only' as const, frames: Object.freeze([...frames]), elapsedMs: performance.now() - started, processId: child.pid })
    } finally {
      clearTimeout(timeout)
      input.signal?.removeEventListener('abort', cancel)
    }
  }
}
