import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { calculateCanonicalHash } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { FACE0204_OUTPUT_BYTES, FACE0204_OUTPUT_POLICY_ID, FACE0204_OUTPUT_POLICY_SHA256 } from '../../domain/face-detector-output.ts'
import { FACE_EVIDENCE_POLICY, FACE_V9_OWNER_ACCEPTANCE_SHA256 } from '../../domain/face-evidence-policy.ts'
import type { FaceDetectorConfigV2, FaceProducerV2 } from '../../domain/face-producer-envelope-v2.ts'
import { ACCEPTED_FACE_PRODUCERS } from '../../domain/face-producer-registry.ts'
import type { FaceWindowAnalysis, FaceWindowAnalyzer } from '../../application/ports/face-window-worker.ts'
import type { FaceDetectorBatch, FaceDetectorFrameInput } from './openvino-face0204-detector.ts'

/**
 * Decodes the sampled frames of one window in a single FFmpeg pass and hands them to the pinned V9 detector.
 *
 * One process per window, not one per frame: the input is seeked to the first sample, `select` keeps every
 * `interval`-th frame, `showinfo` reports the real PTS of each kept frame and the frames are written as lossless PNG
 * files into a fresh directory that the detector reads. Each PTS is checked against the constant-frame-rate clock
 * of the verified probe; a frame whose time cannot be explained is a refusal, never a guess. The source, FFmpeg,
 * FFprobe, the model license and this adapter are hashed before and after.
 */
const SHA = /^[a-f0-9]{64}$/
const MAX_SOURCE_BYTES = 4_000_000_000
const MAX_PROBE_BYTES = 1_000_000
const MAX_STDERR_BYTES = 262_144
const MAX_FRAME_BYTES = 8_000_000
const MAX_WINDOW_BYTES = 240_000_000
const MAX_SAMPLES = FACE_EVIDENCE_POLICY.sampling.maxSamplesPerWindow
const SHOWINFO = /\bn:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:/g

type PinnedBinary = Readonly<{ path: string; sha256: string }>
type Rational = Readonly<{ num: number; den: number }>
export type FaceWindowRuntime = Readonly<{ ffmpeg: PinnedBinary; ffprobe: PinnedBinary; modelLicense: PinnedBinary }>
export type ProcessRunner = (binary: string, args: readonly string[], options: Readonly<{
  signal?: AbortSignal; timeoutMs: number; maxStdoutBytes: number; maxStderrBytes: number
}>) => Promise<Readonly<{ stdout: Buffer; stderr: Buffer }>>
export type FaceWindowDetector = Readonly<{
  detect(input: Readonly<{ sourceSha256: string; framesDirectory: string; frames: readonly FaceDetectorFrameInput[]; signal?: AbortSignal }>): Promise<FaceDetectorBatch>
}>
/** `runner`, `adapterPath` and `acceptedLicenseSha256` are test seams; production composition leaves them unset. */
export type FaceWindowAnalyzerOptions = Readonly<{ deadlineMs?: number; runner?: ProcessRunner; adapterPath?: string; acceptedLicenseSha256?: string }>

const refuse = (message: string): never => { throw new DomainError('RENDER_OUTPUT_INVALID', message) }
const conflict = (message: string): never => { throw new DomainError('PERSISTENCE_CONFLICT', message) }
const sha256Bytes = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
async function hashFile(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}
function rational(value: unknown, label: string): Rational {
  if (typeof value !== 'string' || !/^\d+\/\d+$/.test(value)) return refuse(`${label} is invalid`)
  const [num, den] = value.split('/').map(Number)
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num! <= 0 || den! <= 0) return refuse(`${label} is invalid`)
  return Object.freeze({ num: num!, den: den! })
}
const sameRational = (a: Rational, b: Rational) => {
  const left = a.num * b.den, right = b.num * a.den
  return Number.isSafeInteger(left) && Number.isSafeInteger(right) && left === right
}
function pngDimensions(bytes: Buffer): Readonly<{ width: number; height: number }> {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    return refuse('Face frame is not PNG')
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

export const spawnProcessRunner: ProcessRunner = (binary, args, options) => new Promise((resolve, reject) => {
  if (options.signal?.aborted) { reject(new DomainError('PERSISTENCE_CONFLICT', 'Face video analysis was aborted')); return }
  let child: ReturnType<typeof spawn>
  try { child = spawn(binary, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch { reject(new DomainError('RENDER_OUTPUT_INVALID', 'Face decoder process could not start')); return }
  const stdout: Buffer[] = [], stderr: Buffer[] = []
  let outBytes = 0, errBytes = 0
  let failure: Error | undefined
  const stop = (reason: Error) => { failure ??= reason; child.kill('SIGKILL') }
  const abort = () => stop(new DomainError('PERSISTENCE_CONFLICT', 'Face video analysis was aborted'))
  const timer = setTimeout(() => stop(new DomainError('RENDER_OUTPUT_INVALID', 'Face decoder deadline exceeded')), options.timeoutMs)
  options.signal?.addEventListener('abort', abort, { once: true })
  child.stdout?.on('data', (chunk: Buffer) => { outBytes += chunk.length; if (outBytes > options.maxStdoutBytes) stop(new DomainError('RENDER_OUTPUT_INVALID', 'Face decoder output exceeded its bound')); else stdout.push(chunk) })
  child.stderr?.on('data', (chunk: Buffer) => { errBytes += chunk.length; if (errBytes > options.maxStderrBytes) stop(new DomainError('RENDER_OUTPUT_INVALID', 'Face decoder stderr exceeded its bound')); else stderr.push(chunk) })
  child.once('error', () => { failure ??= new DomainError('RENDER_OUTPUT_INVALID', 'Face decoder process failed') })
  child.once('close', (code) => {
    clearTimeout(timer); options.signal?.removeEventListener('abort', abort)
    if (failure) reject(failure)
    else if (code !== 0) reject(new DomainError('RENDER_OUTPUT_INVALID', 'Face decoder exited unsuccessfully'))
    else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
  })
})

export class FfmpegOpenvinoFaceVideoAnalyzer implements FaceWindowAnalyzer {
  private readonly runtime: FaceWindowRuntime
  private readonly detector: FaceWindowDetector
  private readonly options: FaceWindowAnalyzerOptions

  constructor(runtime: FaceWindowRuntime, detector: FaceWindowDetector, options: FaceWindowAnalyzerOptions = {}) {
    for (const binary of [runtime.ffmpeg, runtime.ffprobe, runtime.modelLicense]) {
      if (!isAbsolute(binary.path) || !SHA.test(binary.sha256)) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Face video runtime path or SHA-256 is invalid')
    }
    if (runtime.modelLicense.sha256 !== (options.acceptedLicenseSha256 ?? ACCEPTED_FACE_PRODUCERS[0]!.model.licenseSha256)) {
      throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Face model license is not the accepted one')
    }
    if (options.deadlineMs !== undefined && (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs < 1000 || options.deadlineMs > 300_000)) {
      throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Face video deadline is invalid')
    }
    this.runtime = Object.freeze({ ffmpeg: Object.freeze({ ...runtime.ffmpeg }), ffprobe: Object.freeze({ ...runtime.ffprobe }), modelLicense: Object.freeze({ ...runtime.modelLicense }) })
    this.detector = detector
    this.options = Object.freeze({ ...options })
  }

  async analyze(input: Parameters<FaceWindowAnalyzer['analyze']>[0]): Promise<FaceWindowAnalysis> {
    const interval = input.sampleIntervalFrames
    if (!isAbsolute(input.sourcePath) || !isAbsolute(input.workDirectory) || !SHA.test(input.expectedSourceSha256) ||
        !Number.isSafeInteger(input.sourceInFrame) || input.sourceInFrame < 0 || !Number.isSafeInteger(input.sourceOutFrame) ||
        input.sourceOutFrame <= input.sourceInFrame || !Number.isSafeInteger(interval) || interval < 1 ||
        !Number.isSafeInteger(input.maxSamples) || input.maxSamples < 1 || input.maxSamples > MAX_SAMPLES) {
      throw new DomainError('INVALID_ARGUMENT', 'Face video analyzer input is invalid')
    }
    const firstSample = Math.ceil(input.sourceInFrame / interval) * interval
    const count = firstSample < input.sourceOutFrame ? Math.floor((input.sourceOutFrame - 1 - firstSample) / interval) + 1 : 0
    if (count < 1 || count > input.maxSamples) throw new DomainError('INVALID_ARGUMENT', 'Face sampling must request between one and the maximum number of frames')

    const runner = this.options.runner ?? spawnProcessRunner
    const adapterPath = this.options.adapterPath ?? fileURLToPath(import.meta.url)
    const deadlineAt = performance.now() + (this.options.deadlineMs ?? 120_000)
    const phase = (maximum: number) => {
      if (input.signal?.aborted) conflict('Face video analysis was aborted')
      const remaining = Math.floor(deadlineAt - performance.now())
      if (remaining <= 0) refuse('Face video aggregate deadline exceeded')
      return Math.max(1, Math.min(maximum, remaining))
    }
    const sourceInfo = await stat(input.sourcePath)
    if (!sourceInfo.isFile() || sourceInfo.size < 1 || sourceInfo.size > MAX_SOURCE_BYTES) refuse('Face source video exceeds its byte bound')
    const pinPaths = [input.sourcePath, this.runtime.ffmpeg.path, this.runtime.ffprobe.path, this.runtime.modelLicense.path, adapterPath]
    const before = await Promise.all(pinPaths.map(hashFile))
    if (before[0] !== input.expectedSourceSha256 || before[1] !== this.runtime.ffmpeg.sha256 || before[2] !== this.runtime.ffprobe.sha256 ||
        before[3] !== this.runtime.modelLicense.sha256) conflict('Face source or runtime hash differs from its expected digest')

    // 1. Probe the verified source: stream facts and the first frame's PTS only.
    const probeRaw = await runner(this.runtime.ffprobe.path, ['-v', 'error', '-threads', '2', '-select_streams', 'v:0', '-show_streams',
      '-show_frames', '-read_intervals', '%+#1', '-of', 'json', input.sourcePath],
    { signal: input.signal, timeoutMs: phase(30_000), maxStdoutBytes: MAX_PROBE_BYTES, maxStderrBytes: 64_000 })
    let probe: { streams?: Array<Record<string, unknown>>; frames?: Array<Record<string, unknown>> }
    try { probe = JSON.parse(probeRaw.stdout.toString('utf8')) as typeof probe } catch { return refuse('Face source probe JSON is invalid') }
    const stream = probe.streams?.[0], first = probe.frames?.[0]
    const width = Number(stream?.width), height = Number(stream?.height)
    if (!stream || !first || !Number.isSafeInteger(width) || width < 1 || width > 1920 || !Number.isSafeInteger(height) || height < 1 || height > 1080) {
      refuse('Face source dimensions are unsupported')
    }
    const sideData = Array.isArray(stream!.side_data_list) ? stream!.side_data_list : []
    const tagRotation = stream!.tags && typeof stream!.tags === 'object' ? Number((stream!.tags as Record<string, unknown>).rotate ?? 0) : 0
    if (!Number.isFinite(tagRotation) || tagRotation !== 0 || sideData.some((item) => {
      const data = item as Record<string, unknown>
      return data.side_data_type === 'Display Matrix' && (!Number.isFinite(Number(data.rotation)) || Number(data.rotation) !== 0)
    })) refuse('Face source display rotation is unsupported')
    const sourceFps = rational(stream!.r_frame_rate, 'Face source fps')
    if (!sameRational(sourceFps, rational(stream!.avg_frame_rate, 'Face source average fps'))) refuse('Face source is not constant frame rate')
    const sourceTimebase = rational(stream!.time_base, 'Face source timebase')
    if (!sameRational(sourceFps, input.timelineFps)) refuse('Face source/timeline fps differ')
    const ticksNumerator = sourceFps.den * sourceTimebase.den, ticksDenominator = sourceFps.num * sourceTimebase.num
    const ticksPerFrame = ticksNumerator / ticksDenominator
    const sourcePtsStart = Number(first!.best_effort_timestamp)
    if (!Number.isSafeInteger(ticksNumerator) || !Number.isSafeInteger(ticksDenominator) || !Number.isFinite(ticksPerFrame) || ticksPerFrame < 1 ||
        !Number.isSafeInteger(sourcePtsStart) || sourcePtsStart < 0) refuse('Face source PTS cannot resolve individual frames')
    const expectedPts = (frame: number) => Math.round(sourcePtsStart + frame * ticksPerFrame)

    // 2. One decode pass for the whole window into a fresh directory.
    const framesDirectory = join(input.workDirectory, `face-frames-${createHash('sha256').update(`${input.expectedSourceSha256}:${firstSample}:${interval}:${count}:${Date.now()}`).digest('hex').slice(0, 16)}`)
    await mkdir(framesDirectory)
    try {
      const seekSeconds = Math.max(0, (sourcePtsStart + firstSample * ticksPerFrame - ticksPerFrame / 2) * sourceTimebase.num / sourceTimebase.den)
      const decoded = await runner(this.runtime.ffmpeg.path, ['-hide_banner', '-loglevel', 'info', '-nostats', '-threads', '2', '-filter_threads', '2',
        '-noautorotate', '-copyts', '-ss', seekSeconds.toFixed(6), '-i', input.sourcePath, '-map', '0:v:0', '-an', '-sn', '-dn',
        '-vf', `select=not(mod(n\\,${interval})),showinfo`, '-fps_mode', 'passthrough', '-frames:v', String(count),
        '-f', 'image2', '-c:v', 'png', '-start_number', '0', join(framesDirectory, 'frame-%06d.png')],
      { signal: input.signal, timeoutMs: phase(90_000), maxStdoutBytes: 4096, maxStderrBytes: MAX_STDERR_BYTES })
      const pts = [...decoded.stderr.toString('utf8').matchAll(SHOWINFO)].map((match) => ({ n: Number(match[1]), pts: Number(match[2]) }))
      if (pts.length !== count || pts.some((entry, index) => entry.n !== index)) refuse('Face decoder did not report every requested frame in order')
      const files = (await readdir(framesDirectory)).sort()
      if (files.length !== count || files.some((name, index) => name !== `frame-${String(index).padStart(6, '0')}.png`)) refuse('Face decoder wrote an unexpected set of frames')
      const frames: Array<{ file: string; bytes: Buffer; sourceFrame: number; pts: number; ptsMs: number; sha256: string }> = []
      let totalBytes = 0, previousMs = -1
      for (const [index, file] of files.entries()) {
        const sourceFrame = firstSample + index * interval
        if (Math.abs(pts[index]!.pts - expectedPts(sourceFrame)) > 1) refuse('Face frame PTS does not match the constant-frame-rate clock')
        const bytes = await readFile(join(framesDirectory, file))
        const dimensions = pngDimensions(bytes)
        totalBytes += bytes.length
        if (bytes.length < 1 || bytes.length > MAX_FRAME_BYTES || totalBytes > MAX_WINDOW_BYTES) refuse('Face encoded frames exceed their byte bound')
        if (dimensions.width !== width || dimensions.height !== height) refuse('Face decoded frame geometry differs from the source probe')
        const ptsMs = Math.round(pts[index]!.pts * sourceTimebase.num * 1000 / sourceTimebase.den)
        if (!Number.isSafeInteger(ptsMs) || ptsMs <= previousMs) refuse('Face sampled frame times in milliseconds collide')
        previousMs = ptsMs
        frames.push({ file, bytes, sourceFrame, pts: pts[index]!.pts, ptsMs, sha256: sha256Bytes(bytes) })
      }
      if (input.signal?.aborted) conflict('Face video analysis was aborted')

      // 3. Detect, then confirm nothing we trusted moved while the detector ran.
      const batch = await this.detector.detect({ sourceSha256: input.expectedSourceSha256, framesDirectory,
        frames: frames.map((frame) => ({ ptsMs: frame.ptsMs, file: frame.file, sha256: frame.sha256 })), signal: input.signal })
      if (batch.frames.length !== frames.length || batch.sourceSha256 !== input.expectedSourceSha256 ||
          batch.frames.some((result, index) => result.sha256 !== frames[index]!.sha256 || result.ptsMs !== frames[index]!.ptsMs)) {
        refuse('Face detector response does not match the requested frames')
      }
      const after = await Promise.all(pinPaths.map(hashFile))
      if (after.some((value, index) => value !== before[index])) conflict('Face source or runtime bytes changed during analysis')

      const accepted = ACCEPTED_FACE_PRODUCERS[0]!
      const platform = accepted.platforms.find((entry) => entry.platform === batch.runtime.platform)
      const detectorConfig: FaceDetectorConfigV2 = Object.freeze({ family: 'openvino-ssd', model: 'face-detection-0204', inputWidth: 448, inputHeight: 448,
        colorOrder: 'bgr', tensorLayout: 'nchw', tensorType: 'float32', pixelRange: '0-255', resize: 'direct-bilinear',
        orientationPolicy: 'ignore-exif-after-source-validation', frameEncoding: 'png-lossless', backend: 'openvino-cpu', precision: 'f32',
        threads: 2, streams: 1, outputSlots: 200, outputBytes: FACE0204_OUTPUT_BYTES,
        collectionScoreFloor: FACE_EVIDENCE_POLICY.detection.collectionScoreFloor })
      const producer: FaceProducerV2 = Object.freeze({
        name: accepted.name,
        model: Object.freeze({ precision: 'FP32' as const, ...accepted.model }),
        outputPolicy: Object.freeze({ id: FACE0204_OUTPUT_POLICY_ID, sha256: FACE0204_OUTPUT_POLICY_SHA256 }),
        runtime: Object.freeze({ ...batch.runtime, runtimeManifestSha256: batch.runtimeManifestSha256 }),
        adapterSha256: before[4]!, bridgeSha256: batch.bridgeSha256, pythonExecutableSha256: batch.pythonExecutableSha256,
        ffmpegSha256: before[1]!, ffprobeSha256: before[2]!,
        assessment: Object.freeze({ status: 'owner-accepted-scoped' as const, scope: 'foreground-faces-and-speaker' as const,
          ownerAcceptanceSha256: FACE_V9_OWNER_ACCEPTANCE_SHA256, v9ReceiptSha256: accepted.v9ReceiptSha256,
          v9PreregistrationSha256: accepted.v9PreregistrationSha256, independentConfirmation: 'not-performed' as const,
          runtimeParity: Object.freeze(platform ? { status: 'passed' as const, receiptSha256: platform.parityReceiptSha256 } : { status: 'pending' as const, receiptSha256: null }) }),
      })
      const samples = batch.frames.map((result, index) => Object.freeze({
        sourceFrame: frames[index]!.sourceFrame, sourcePts: frames[index]!.pts,
        sourcePtsEvidenceHash: calculateCanonicalHash({ sourceSha256: input.expectedSourceSha256, sourceFrame: frames[index]!.sourceFrame,
          sourcePts: frames[index]!.pts, sourceTimebase, imageSha256: frames[index]!.sha256 }),
        imageSha256: frames[index]!.sha256, frameWidth: width, frameHeight: height, status: result.status,
        boxes: Object.freeze(result.detections.map((detection) => Object.freeze({ boxXYXY: detection.boxXYXY, confidence: detection.confidence,
          clipped: detection.clipped, classification: 'unverified-face-candidate' as const }))),
        rawOutput: result.rawOutputSha256 ? Object.freeze({ sha256: result.rawOutputSha256, bytes: 5600 as const }) : null,
        reasonCode: result.status === 'unknown' ? (result.reason ?? 'DETECTOR_FRAME_UNKNOWN') : null,
      }))
      return Object.freeze({ sourceTimebase, sourceFps, sourcePtsStart, sourceClock: 'constant-frame-rate' as const, sourcePtsRounding: 'nearest' as const,
        sourceWidth: width, sourceHeight: height, sourceOrientation: 'rotation-0-exif-neutral' as const, detectorConfig, producer,
        samples: Object.freeze(samples), rawOutputs: Object.freeze(batch.frames.map((result) => result.rawOutput)) })
    } finally {
      await rm(framesDirectory, { recursive: true, force: true })
    }
  }
}
