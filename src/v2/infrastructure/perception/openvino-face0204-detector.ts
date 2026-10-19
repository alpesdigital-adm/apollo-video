import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { performance } from 'node:perf_hooks'

import { DomainError } from '../../domain/errors.ts'
import { decodeFace0204Output, face0204OutputSha256, FACE0204_OUTPUT_BYTES, FACE0204_OUTPUT_POLICY_ID,
  type Face0204Detection } from '../../domain/face-detector-output.ts'
import { FACE_EVIDENCE_POLICY } from '../../domain/face-evidence-policy.ts'
import { acceptedFaceRuntimeReasons, ACCEPTED_FACE_PRODUCERS } from '../../domain/face-producer-registry.ts'
import type { FaceRuntimeInventory } from './face-runtime-inventory.ts'

/**
 * Node side of the owner-accepted V9 detector. One bounded child process per window, no shell, no network.
 *
 * Before the process starts the model, bridge and interpreter are hashed and the private runtime inventory is
 * verified; after it exits they are hashed again. The response is distrusted: its runtime readback must be the
 * accepted platform and versions, and every frame's boxes are recomputed here, from the raw detector output the bridge
 * returns, with the TypeScript twin of the V9 policy. A bridge that disagrees with the policy cannot publish evidence.
 */
const PROTOCOL = 'apollo-openvino-face0204-v1'
const MAX_FRAMES = 60
const MAX_RESPONSE_BYTES = 8_000_000
const MAX_STDERR_BYTES = 64_000
const SHA = /^[a-f0-9]{64}$/
const FRAME_FILE = /^frame-\d{6}\.png$/
const REASON = /^[A-Z][A-Z0-9_]{2,63}$/

export type ModelPin = Readonly<{ sha256: string; bytes: number }>
export type OpenvinoFace0204DetectorConfig = Readonly<{
  pythonExecutable: string; pythonExecutableSha256: string
  pythonModulePath: string
  modelXmlPath: string; modelBinPath: string
  bridgePath: string; bridgeSha256: string
  runtimeInventory: Pick<FaceRuntimeInventory, 'verify' | 'manifestSha256'>
  timeoutMs?: number
  /** Test seam only: production composition never sets these, so the pins are the accepted producer's. */
  modelPins?: Readonly<{ xml: ModelPin; bin: ModelPin }>
  runtimeReasons?: (runtime: ObservedFaceRuntime) => readonly string[]
}>
export type ObservedFaceRuntime = Readonly<{
  platform: 'win32' | 'linux'; pythonVersion: string; openvinoVersion: string
  openvinoPackageVersion: string; opencvVersion: string; numpyVersion: string
}>
export type FaceDetectorFrameInput = Readonly<{ ptsMs: number; file: string; sha256: string }>
export type FaceDetectorFrameResult = Readonly<{
  ptsMs: number; file: string; sha256: string
  status: 'observed' | 'unknown'
  reason: string | null
  width: number | null; height: number | null
  inferMs: number | null
  rawOutput: Uint8Array | null
  rawOutputSha256: string | null
  detections: readonly Face0204Detection[]
}>
export type FaceDetectorBatch = Readonly<{
  sourceSha256: string
  bridgeSha256: string; pythonExecutableSha256: string
  modelXmlSha256: string; modelBinSha256: string
  runtimeManifestSha256: string
  runtime: ObservedFaceRuntime
  frames: readonly FaceDetectorFrameResult[]
  elapsedMs: number
  coverage: 'sampled-only'
}>

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
const denied = (code: string): never => { throw new DomainError('RENDER_OUTPUT_INVALID', `Face detector refused: ${code}`) }
const keys = (value: unknown, expected: readonly string[]) => typeof value === 'object' && value !== null && !Array.isArray(value) &&
  Object.keys(value).sort().join('|') === [...expected].sort().join('|')

export class OpenvinoFace0204Detector {
  private readonly config: OpenvinoFace0204DetectorConfig
  private readonly pins: Readonly<{ xml: ModelPin; bin: ModelPin }>

  constructor(config: OpenvinoFace0204DetectorConfig) {
    for (const path of [config.pythonExecutable, config.pythonModulePath, config.modelXmlPath, config.modelBinPath, config.bridgePath]) {
      if (typeof path !== 'string' || !isAbsolute(path)) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Face detector paths must be absolute')
    }
    if (!SHA.test(config.pythonExecutableSha256) || !SHA.test(config.bridgeSha256)) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Face detector hashes are invalid')
    if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 120_000)) {
      throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Face detector timeout is invalid')
    }
    const accepted = ACCEPTED_FACE_PRODUCERS[0]!.model
    this.pins = config.modelPins ?? { xml: { sha256: accepted.xmlSha256, bytes: accepted.xmlBytes }, bin: { sha256: accepted.binSha256, bytes: accepted.binBytes } }
    this.config = Object.freeze({ ...config })
  }

  private async verifyFiles(): Promise<Readonly<{ python: string; bridge: string }>> {
    const [xmlInfo, binInfo] = await Promise.all([stat(this.config.modelXmlPath), stat(this.config.modelBinPath)])
    if (xmlInfo.size !== this.pins.xml.bytes || binInfo.size !== this.pins.bin.bytes) denied('MODEL_SIZE_MISMATCH')
    const [xml, bin, bridge, python] = await Promise.all([hashFile(this.config.modelXmlPath), hashFile(this.config.modelBinPath),
      hashFile(this.config.bridgePath), hashFile(this.config.pythonExecutable)])
    if (xml !== this.pins.xml.sha256 || bin !== this.pins.bin.sha256) denied('MODEL_HASH_MISMATCH')
    if (bridge !== this.config.bridgeSha256 || python !== this.config.pythonExecutableSha256) denied('RUNTIME_HASH_MISMATCH')
    await this.config.runtimeInventory.verify()
    return { python, bridge }
  }

  async detect(input: Readonly<{ sourceSha256: string; framesDirectory: string; frames: readonly FaceDetectorFrameInput[]; signal?: AbortSignal }>): Promise<FaceDetectorBatch> {
    if (!SHA.test(input.sourceSha256) || !isAbsolute(input.framesDirectory) || input.frames.length < 1 || input.frames.length > MAX_FRAMES) denied('REQUEST_INVALID')
    let previous = -1
    for (const frame of input.frames) {
      if (!Number.isFinite(frame.ptsMs) || frame.ptsMs < 0 || frame.ptsMs <= previous || !FRAME_FILE.test(frame.file) || !SHA.test(frame.sha256)) denied('FRAME_ENTRY_INVALID')
      previous = frame.ptsMs
    }
    if (input.signal?.aborted) denied('CANCELLED')
    const before = await this.verifyFiles()
    const payload = JSON.stringify({ protocol: PROTOCOL, sourceSha256: input.sourceSha256, framesDirectory: input.framesDirectory,
      frames: input.frames.map((frame) => ({ ptsMs: frame.ptsMs, file: frame.file, sha256: frame.sha256 })) })
    const started = performance.now()
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(this.config.pythonExecutable, [this.config.bridgePath, this.config.modelXmlPath, this.config.modelBinPath,
        this.config.bridgeSha256, this.config.pythonExecutableSha256], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONPATH: this.config.pythonModulePath, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
      })
    } catch { return denied('PROCESS_NOT_STARTED') }
    let failure: string | undefined
    const chunks: Buffer[] = []
    let outputBytes = 0, errorBytes = 0
    const stop = (reason: string) => { failure ??= reason; if (child.pid !== undefined) child.kill('SIGKILL') }
    const closed = new Promise<number | null>((resolve) => { child.once('error', () => { failure ??= 'PROCESS_ERROR' }); child.once('close', resolve) })
    child.stdout?.on('data', (chunk: Buffer) => { outputBytes += chunk.byteLength; if (outputBytes > MAX_RESPONSE_BYTES) stop('RESPONSE_TOO_LARGE'); else chunks.push(chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { errorBytes += chunk.byteLength; if (errorBytes > MAX_STDERR_BYTES) stop('STDERR_TOO_LARGE') })
    child.stdin?.on('error', () => { /* an early bridge exit is reported by its close status */ })
    const cancel = () => stop('CANCELLED')
    input.signal?.addEventListener('abort', cancel, { once: true })
    const timeout = setTimeout(() => stop('TIMEOUT'), this.config.timeoutMs ?? 60_000)
    if (input.signal?.aborted) cancel()
    else if (child.pid !== undefined) child.stdin?.end(payload)
    try {
      const exitCode = await closed
      if (failure) denied(failure)
      if (child.pid === undefined) denied('PROCESS_NOT_STARTED')
      if (exitCode !== 0) denied('PROCESS_FAILED')
      const after = await this.verifyFiles()
      if (after.python !== before.python || after.bridge !== before.bridge) denied('RUNTIME_CHANGED_DURING_RUN')
      let response: unknown
      try { response = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { denied('RESPONSE_JSON_INVALID') }
      return this.validate(response, input, before, performance.now() - started)
    } finally {
      clearTimeout(timeout)
      input.signal?.removeEventListener('abort', cancel)
    }
  }

  private validate(response: unknown, input: Readonly<{ sourceSha256: string; frames: readonly FaceDetectorFrameInput[] }>,
    hashes: Readonly<{ python: string; bridge: string }>, elapsedMs: number): FaceDetectorBatch {
    const r = response as Record<string, unknown>
    if (!keys(r, ['protocol', 'sourceSha256', 'bridgeSha256', 'pythonSha256', 'modelXmlSha256', 'modelBinSha256', 'outputPolicyId',
      'collectionFloor', 'runtime', 'coverage', 'elapsedMs', 'frames']) || r.protocol !== PROTOCOL || r.sourceSha256 !== input.sourceSha256 ||
        r.bridgeSha256 !== hashes.bridge || r.pythonSha256 !== hashes.python || r.modelXmlSha256 !== this.pins.xml.sha256 ||
        r.modelBinSha256 !== this.pins.bin.sha256 || r.outputPolicyId !== FACE0204_OUTPUT_POLICY_ID ||
        r.collectionFloor !== FACE_EVIDENCE_POLICY.detection.collectionScoreFloor || r.coverage !== 'sampled-only' ||
        typeof r.elapsedMs !== 'number' || !Array.isArray(r.frames) || r.frames.length !== input.frames.length) return denied('RESPONSE_INVALID')
    const runtime = r.runtime as Record<string, unknown>
    if (!keys(runtime, ['platform', 'pythonVersion', 'openvinoVersion', 'openvinoPackageVersion', 'opencvVersion', 'numpyVersion']) ||
        Object.values(runtime).some((value) => typeof value !== 'string' || value.length === 0 || value.length > 128)) return denied('RUNTIME_READBACK_INVALID')
    const observed = runtime as unknown as ObservedFaceRuntime
    const reasons = (this.config.runtimeReasons ?? acceptedFaceRuntimeReasons)(observed)
    if (reasons.length > 0) return denied(`RUNTIME_NOT_ACCEPTED_${reasons.join('_')}`)
    const frames = (r.frames as unknown[]).map((raw, index) => {
      const sent = input.frames[index]!
      const f = raw as Record<string, unknown>
      if (!keys(f, ['ptsMs', 'file', 'sha256', 'status', 'reason', 'failedSlot', 'width', 'height', 'inferMs', 'rawOutputBase64', 'rawOutputSha256', 'detections']) ||
          f.ptsMs !== sent.ptsMs || f.file !== sent.file || f.sha256 !== sent.sha256 || !Array.isArray(f.detections)) return denied('FRAME_RESPONSE_INVALID')
      if (f.status === 'unknown') {
        if (typeof f.reason !== 'string' || !REASON.test(f.reason) || f.detections.length !== 0) return denied('UNKNOWN_FRAME_INVALID')
      } else if (f.status !== 'observed' || f.reason !== null) return denied('FRAME_STATUS_INVALID')
      let rawOutput: Uint8Array | null = null
      if (f.rawOutputBase64 !== null) {
        if (typeof f.rawOutputBase64 !== 'string' || typeof f.rawOutputSha256 !== 'string') return denied('RAW_OUTPUT_INVALID')
        rawOutput = new Uint8Array(Buffer.from(f.rawOutputBase64, 'base64'))
        if (rawOutput.byteLength !== FACE0204_OUTPUT_BYTES || face0204OutputSha256(rawOutput) !== f.rawOutputSha256) return denied('RAW_OUTPUT_HASH_MISMATCH')
      } else if (f.rawOutputSha256 !== null) return denied('RAW_OUTPUT_INVALID')
      // Recompute from the raw bytes: the bridge's boxes are only accepted when they are exactly the policy's.
      const decoded = rawOutput ? decodeFace0204Output(rawOutput, FACE_EVIDENCE_POLICY.detection.collectionScoreFloor) : null
      let detections: readonly Face0204Detection[] = Object.freeze([])
      if (f.status === 'observed') {
        if (!decoded || decoded.status !== 'decoded') return denied('OBSERVED_FRAME_WITHOUT_VALID_OUTPUT')
        if (JSON.stringify(decoded.detections) !== JSON.stringify(f.detections)) return denied('DETECTIONS_DIFFER_FROM_POLICY')
        detections = decoded.detections
      } else if (decoded && decoded.status === 'decoded') return denied('UNKNOWN_FRAME_HAS_VALID_OUTPUT')
      else if (decoded && (decoded.reason !== f.reason || decoded.slot !== f.failedSlot)) return denied('UNKNOWN_REASON_DIFFERS_FROM_POLICY')
      const dimension = (value: unknown) => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
      if (!dimension(f.width) || !dimension(f.height) || (f.inferMs !== null && (typeof f.inferMs !== 'number' || !Number.isFinite(f.inferMs) || f.inferMs < 0))) return denied('FRAME_METRICS_INVALID')
      return Object.freeze({ ptsMs: sent.ptsMs, file: sent.file, sha256: sent.sha256, status: f.status as 'observed' | 'unknown',
        reason: f.reason as string | null, width: f.width as number | null, height: f.height as number | null,
        inferMs: f.inferMs as number | null, rawOutput, rawOutputSha256: f.rawOutputSha256 as string | null, detections })
    })
    return Object.freeze({ sourceSha256: input.sourceSha256, bridgeSha256: hashes.bridge, pythonExecutableSha256: hashes.python,
      modelXmlSha256: this.pins.xml.sha256, modelBinSha256: this.pins.bin.sha256,
      runtimeManifestSha256: this.config.runtimeInventory.manifestSha256, runtime: Object.freeze({ ...observed }),
      frames: Object.freeze(frames), elapsedMs, coverage: 'sampled-only' as const })
  }
}
