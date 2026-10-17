import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

import { calculateCanonicalHash } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import type { FaceVideoAnalyzer } from '../../application/ports/face-producer-worker.ts'
import type { YunetCpuFaceDetector } from './yunet-cpu-face-detector.ts'

const SHA = /^[a-f0-9]{64}$/
const MODEL_SHA = '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4'
const BRIDGE_SHA = '6e541eee8b1f527467fbaa33f28819dde992f1fb27d9fa9efda4e751d78b7ade'
const LICENSE_SHA = 'c83b8120c50ccbd4c4f96edf53141bdd566ebb8f8e9227e415326aa1b1aba958'
const MODEL_COMMIT = '47534e27c9851bb1128ccc0102f1145e27f23f98'
const V5_PREREG = 'e9de632da25f730b884ab6128830be99656836688e6d20cdec26c756aa48bba6'
const V5_DEV = '55c4f6e3f639db80a1a02ceed2b249fba84492d0bbea53b50d53a3c222d8191d'
const V5_CALIB = 'd29c1ca49344d027048e785d4baef0b2ce127f2f831223b7b5d63da9c8108b8b'
const MAX_SOURCE_BYTES = 100_000_000
const MAX_FRAMES = 300
const MAX_SAMPLES = 30
const MAX_ENCODED_FRAME_BYTES = 5_000_000
const MAX_ENCODED_BATCH_BYTES = 20_000_000
const MAX_PROBE_BYTES = 4_000_000
const MAX_STDERR_BYTES = 64_000

type Rational = Readonly<{ num: number; den: number }>
type PinnedBinary = Readonly<{ path: string; sha256: string }>

export type FaceVideoRuntime = Readonly<{
  ffmpeg: PinnedBinary
  ffprobe: PinnedBinary
  modelLicense: PinnedBinary
}>
export type FaceVideoAnalyzerOptions = Readonly<{
  deadlineMs?: number
  onProcessStarted?: (kind: 'probe' | 'frame', pid: number) => void
}>

function invalid(message: string): never { throw new DomainError('RENDER_OUTPUT_INVALID', message) }
function conflict(message: string): never { throw new DomainError('PERSISTENCE_CONFLICT', message) }
function hashBytes(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
async function hashFile(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}
function rational(value: unknown, label: string): Rational {
  if (typeof value !== 'string' || !/^\d+\/\d+$/.test(value)) invalid(`${label} is invalid`)
  const [num, den] = value.split('/').map(Number)
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num! <= 0 || den! <= 0) {
    invalid(`${label} is invalid`)
  }
  return Object.freeze({ num: num!, den: den! })
}
function sameRational(a: Rational, b: Rational) {
  const left = a.num * b.den, right = b.num * a.den
  return Number.isSafeInteger(left) && Number.isSafeInteger(right) && left === right
}

async function runBinary(binary: string, args: readonly string[], input: {
  signal?: AbortSignal; timeoutMs: number; maxBytes: number
  onStarted?: (pid: number) => void
}): Promise<Buffer> {
  if (input.signal?.aborted) conflict('Face video analysis was aborted')
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try { child = spawn(binary, [...args], { windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch { reject(new DomainError('RENDER_OUTPUT_INVALID', 'Face decoder process could not start')); return }
    const chunks: Buffer[] = []
    let bytes = 0, stderrBytes = 0
    let failure: Error | undefined
    const stop = (reason: Error) => { failure ??= reason; child.kill('SIGKILL') }
    const abort = () => stop(new DomainError('PERSISTENCE_CONFLICT', 'Face video analysis was aborted'))
    const timer = setTimeout(() => stop(new DomainError('RENDER_OUTPUT_INVALID',
      'Face decoder deadline exceeded')), input.timeoutMs)
    input.signal?.addEventListener('abort', abort, { once: true })
    child.once('spawn', () => {
      if (child.pid === undefined) return
      try { input.onStarted?.(child.pid) }
      catch { stop(new DomainError('RENDER_OUTPUT_INVALID', 'Face decoder observer failed')) }
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > input.maxBytes) stop(new DomainError('RENDER_OUTPUT_INVALID',
        'Face decoder output exceeded its byte bound'))
      else chunks.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes > MAX_STDERR_BYTES) stop(new DomainError('RENDER_OUTPUT_INVALID',
        'Face decoder stderr exceeded its byte bound'))
    })
    child.once('error', () => { failure ??= new DomainError('RENDER_OUTPUT_INVALID',
      'Face decoder process failed') })
    child.once('close', (code) => {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else if (code !== 0) reject(new DomainError('RENDER_OUTPUT_INVALID',
        'Face decoder exited unsuccessfully'))
      else resolve(Buffer.concat(chunks))
    })
    if (input.signal?.aborted) abort()
  })
}

function pngDimensions(bytes: Buffer): Readonly<{ width: number; height: number }> {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.toString('ascii', 12, 16) !== 'IHDR') invalid('Face frame is not PNG')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/** Source-verified CFR sampling; all face boxes remain unverified candidates. */
export class FfmpegYunetFaceVideoAnalyzer implements FaceVideoAnalyzer {
  private readonly runtime: FaceVideoRuntime
  private readonly options: FaceVideoAnalyzerOptions
  private readonly detector: Pick<YunetCpuFaceDetector, 'detect'>

  constructor(runtime: FaceVideoRuntime, detector: Pick<YunetCpuFaceDetector, 'detect'>,
    options: FaceVideoAnalyzerOptions = {}) {
    for (const binary of [runtime.ffmpeg, runtime.ffprobe, runtime.modelLicense]) {
      if (!isAbsolute(binary.path) || !SHA.test(binary.sha256)) {
        throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Face video runtime path or SHA-256 is invalid')
      }
    }
    if (options.deadlineMs !== undefined && (!Number.isSafeInteger(options.deadlineMs) ||
        options.deadlineMs < 1000 || options.deadlineMs > 120_000)) {
      throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Face video deadline is invalid')
    }
    this.runtime = Object.freeze({ ffmpeg: Object.freeze({ ...runtime.ffmpeg }),
      ffprobe: Object.freeze({ ...runtime.ffprobe }),
      modelLicense: Object.freeze({ ...runtime.modelLicense }) })
    this.detector = detector
    this.options = Object.freeze({ ...options })
  }

  async analyze(input: Parameters<FaceVideoAnalyzer['analyze']>[0]): ReturnType<FaceVideoAnalyzer['analyze']> {
    if (!isAbsolute(input.sourcePath) || !isAbsolute(input.workDirectory) ||
        !SHA.test(input.expectedSourceSha256) ||
        !Number.isSafeInteger(input.sourceInFrame) || input.sourceInFrame < 0 ||
        !Number.isSafeInteger(input.sourceOutFrame) ||
        input.sourceOutFrame <= input.sourceInFrame || input.sourceOutFrame > MAX_FRAMES ||
        !Number.isSafeInteger(input.sampleIntervalFrames) || input.sampleIntervalFrames < 1 ||
        !Number.isSafeInteger(input.maxSamples) || input.maxSamples < 1 ||
        input.maxSamples > MAX_SAMPLES) {
      throw new DomainError('INVALID_ARGUMENT', 'Face video analyzer input is invalid')
    }
    const deadlineAt = performance.now() + (this.options.deadlineMs ?? 120_000)
    const checkActive = () => {
      if (input.signal?.aborted) conflict('Face video analysis was aborted')
      if (performance.now() >= deadlineAt) invalid('Face video aggregate deadline exceeded')
    }
    const phaseTimeout = (maximum: number) => {
      checkActive()
      return Math.max(1, Math.min(maximum, Math.floor(deadlineAt - performance.now())))
    }
    checkActive()
    const sourceStat = await stat(input.sourcePath)
    if (!sourceStat.isFile() || sourceStat.size < 1 || sourceStat.size > MAX_SOURCE_BYTES) {
      invalid('Face source video exceeds byte bound')
    }
    const pins = await Promise.all([hashFile(input.sourcePath), hashFile(this.runtime.ffmpeg.path),
      hashFile(this.runtime.ffprobe.path), hashFile(this.runtime.modelLicense.path),
      hashFile(fileURLToPath(import.meta.url))])
    checkActive()
    if (pins[0] !== input.expectedSourceSha256 ||
        pins[1] !== this.runtime.ffmpeg.sha256 || pins[2] !== this.runtime.ffprobe.sha256 ||
        pins[3] !== this.runtime.modelLicense.sha256 || pins[3] !== LICENSE_SHA) {
      conflict('Face source or runtime hash differs from its expected digest')
    }
    const probeBytes = await runBinary(this.runtime.ffprobe.path, [
      '-v', 'error', '-threads', '2', '-select_streams', 'v:0', '-show_streams',
      '-show_frames', '-of', 'json', input.sourcePath,
    ], { signal: input.signal, timeoutMs: phaseTimeout(30_000), maxBytes: MAX_PROBE_BYTES,
      onStarted: (pid) => this.options.onProcessStarted?.('probe', pid) })
    checkActive()
    let probe: { streams?: Array<Record<string, unknown>>; frames?: Array<Record<string, unknown>> }
    try { probe = JSON.parse(probeBytes.toString('utf8')) as typeof probe }
    catch { invalid('Face source probe JSON is invalid') }
    const stream = probe.streams?.[0], frames = probe.frames
    const width = Number(stream?.width), height = Number(stream?.height)
    if (!stream || !frames || frames.length < 1 || frames.length > MAX_FRAMES ||
        !Number.isSafeInteger(width) || width < 1 || width > 1920 ||
        !Number.isSafeInteger(height) || height < 1 || height > 1080 ||
        width * height > 2_073_600) invalid('Face source dimensions or frame count are unsupported')
    const sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list : []
    const tagRotation = stream.tags && typeof stream.tags === 'object' ?
      Number((stream.tags as Record<string, unknown>).rotate ?? 0) : 0
    if (!Number.isFinite(tagRotation) || tagRotation !== 0 || sideData.some((item) => {
      const data = item as Record<string, unknown>
      return data.side_data_type === 'Display Matrix' &&
        (!Number.isFinite(Number(data.rotation)) || Number(data.rotation) !== 0)
    })) invalid('Face source display rotation is unsupported')
    const sourceFps = rational(stream.r_frame_rate, 'Face source fps')
    const sourceTimebase = rational(stream.time_base, 'Face source timebase')
    if (!sameRational(sourceFps, input.timelineFps)) invalid('Face source/timeline fps differ')
    const ticksNumerator = sourceFps.den * sourceTimebase.den
    const ticksDenominator = sourceFps.num * sourceTimebase.num
    const ticksPerFrame = ticksNumerator / ticksDenominator
    const pts = frames.map((frame) => Number(frame.best_effort_timestamp))
    if (!Number.isSafeInteger(ticksNumerator) || !Number.isSafeInteger(ticksDenominator) ||
        !Number.isFinite(ticksPerFrame) || ticksPerFrame < 1 ||
        pts.some((value, index) => !Number.isSafeInteger(value) || value < 0 ||
          (index > 0 && (value <= pts[index - 1]! ||
            Math.abs(value - (pts[0]! + index * ticksPerFrame)) > 1))) ||
        frames.length * sourceFps.den / sourceFps.num > 10) {
      invalid('Face source PTS are missing, reordered, non-CFR or too long')
    }
    if (input.sourceOutFrame > frames.length) invalid('Face clip exceeds decoded source frames')
    const selected = Array.from({ length: frames.length }, (_, index) => index)
      .filter((index) => index >= input.sourceInFrame &&
        index < input.sourceOutFrame && index % input.sampleIntervalFrames === 0)
    if (selected.length < 1 || selected.length > input.maxSamples) {
      invalid('Face source sampling exceeds the configured bound')
    }
    const encoded: Array<{ ptsMs: number; bytes: Buffer; frameIndex: number; pts: number }> = []
    let totalBytes = 0, previousMs = -1
    for (const index of selected) {
      const bytes = await runBinary(this.runtime.ffmpeg.path, [
        '-hide_banner', '-loglevel', 'error', '-threads', '2', '-filter_threads', '2',
        '-noautorotate', '-i', input.sourcePath, '-map', '0:v:0',
        '-vf', `select=eq(n\\,${index})`, '-frames:v', '1', '-an', '-f', 'image2pipe',
        '-vcodec', 'png', 'pipe:1',
      ], { signal: input.signal, timeoutMs: phaseTimeout(15_000),
        maxBytes: MAX_ENCODED_FRAME_BYTES,
        onStarted: (pid) => this.options.onProcessStarted?.('frame', pid) })
      checkActive()
      const dimensions = pngDimensions(bytes)
      if (dimensions.width !== width || dimensions.height !== height) {
        invalid('Face decoded frame geometry differs from source probe')
      }
      totalBytes += bytes.length
      if (bytes.length < 1 || totalBytes > MAX_ENCODED_BATCH_BYTES) {
        invalid('Face encoded frame batch exceeds its byte bound')
      }
      const ptsMs = Math.round(pts[index]! * sourceTimebase.num * 1000 / sourceTimebase.den)
      if (!Number.isSafeInteger(ptsMs) || ptsMs <= previousMs) invalid('Face sampled frame PTS in milliseconds collide')
      previousMs = ptsMs
      encoded.push({ ptsMs, bytes, frameIndex: index, pts: pts[index]! })
    }
    checkActive()
    const observed = await this.detector.detect({ sourceSha256: input.expectedSourceSha256,
      frames: encoded.map((frame) => ({ ptsMs: frame.ptsMs, bytes: frame.bytes })),
      signal: input.signal })
    checkActive()
    if (observed.frames.length !== encoded.length || observed.sourceSha256 !== input.expectedSourceSha256 ||
        observed.modelSha256 !== MODEL_SHA || observed.bridgeSha256 !== BRIDGE_SHA ||
        observed.frames.some((frame, index) => frame.ptsMs !== encoded[index]!.ptsMs ||
          frame.sha256 !== hashBytes(encoded[index]!.bytes))) {
      invalid('Face detector response does not match requested source frames')
    }
    const after = await Promise.all([hashFile(input.sourcePath), hashFile(this.runtime.ffmpeg.path),
      hashFile(this.runtime.ffprobe.path), hashFile(this.runtime.modelLicense.path),
      hashFile(fileURLToPath(import.meta.url))])
    checkActive()
    if (after.some((value, index) => value !== pins[index])) {
      conflict('Face source or runtime bytes changed during analysis')
    }
    return Object.freeze({
      sourceTimebase, sourceFps, sourcePtsStart: pts[0]!,
      sourceClock: 'constant-frame-rate' as const, sourcePtsRounding: 'nearest' as const,
      sourceWidth: width, sourceHeight: height,
      sourceOrientation: 'rotation-0-exif-neutral' as const,
      detectorConfig: Object.freeze({ inputWidth: 640, inputHeight: 640, longestSide: 640,
        upscale: false, orientationPolicy: 'ignore-exif-after-source-validation' as const,
        resizeInterpolation: 'area' as const, canvasPlacement: 'top-left-zero-pad' as const,
        scoreThreshold: 0.5, nmsThreshold: 0.3, topK: 5000,
        backend: 'opencv-dnn-cpu' as const, threads: 2 }),
      producer: Object.freeze({ name: 'yunet-cpu', modelSha256: observed.modelSha256,
        modelLicenseSha256: pins[3]!, modelSourceCommit: MODEL_COMMIT,
        adapterSha256: pins[4]!, bridgeSha256: observed.bridgeSha256,
        executableSha256: observed.pythonSha256,
        opencvBinarySha256: observed.opencvBinarySha256,
        opencvVersion: observed.opencvVersion,
        opencvPackageVersion: observed.opencvPackageVersion,
        ffmpegSha256: pins[1]!, ffprobeSha256: pins[2]!,
        assessment: Object.freeze({ status: 'failed-gate' as const,
          preregistrationSha256: V5_PREREG, developmentReportSha256: V5_DEV,
          calibrationReportSha256: V5_CALIB }) }),
      samples: Object.freeze(observed.frames.map((frame, index) => Object.freeze({
        sourceFrame: encoded[index]!.frameIndex, sourcePts: encoded[index]!.pts,
        sourcePtsEvidenceHash: calculateCanonicalHash({ sourceSha256: input.expectedSourceSha256,
          sourceFrame: encoded[index]!.frameIndex, sourcePts: encoded[index]!.pts,
          sourceTimebase, imageSha256: hashBytes(encoded[index]!.bytes) }),
        imageSha256: frame.sha256, frameWidth: width, frameHeight: height,
        status: frame.status, reasonCode: frame.status === 'unknown' ?
          'DETECTOR_FRAME_UNKNOWN' : null,
        boxes: frame.status === 'observed' ? Object.freeze(frame.boxes.map((box) =>
          Object.freeze({ ...box, classification: 'unverified-face-candidate' as const }))) :
          Object.freeze([]),
      }))),
    })
  }
}
