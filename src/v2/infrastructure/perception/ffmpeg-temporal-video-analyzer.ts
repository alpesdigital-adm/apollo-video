import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'

import { DomainError } from '../../domain/errors.ts'
import type { SourceClock, TemporalRange, VisualTemporalAnalysis,
  VisualTemporalAnalyzer } from '../../application/ports/visual-temporal-analyzer.ts'

const SHA = /^[a-f0-9]{64}$/
const GRID_WIDTH = 160, GRID_HEIGHT = 90, GRID_BYTES = GRID_WIDTH * GRID_HEIGHT
const MAX_FRAMES = 300, MAX_SOURCE_BYTES = 100_000_000
const MAX_ANALYSIS_MS = 120_000
const UNRELIABLE_CHANGE = 0.35

function invalid(message: string): never { throw new DomainError('RENDER_OUTPUT_INVALID', message) }
function hash(bytes: Buffer | Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const digest = createHash('sha256')
    const source = createReadStream(path)
    source.on('data', (bytes) => digest.update(bytes))
    source.on('error', reject)
    source.on('end', () => resolve(digest.digest('hex')))
  })
}

async function runBinary(binary: string, args: readonly string[], input: {
  signal?: AbortSignal; timeoutMs: number; maxBytes: number
  onStarted?: (pid: number) => void
}): Promise<Buffer> {
  if (input.signal?.aborted) throw new DomainError('PERSISTENCE_CONFLICT', 'Temporal analysis was aborted')
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let bytes = 0, stderrBytes = 0
    let failure: Error | undefined
    const stop = (reason: Error) => { failure ??= reason; child.kill('SIGKILL') }
    const abort = () => stop(new DomainError('PERSISTENCE_CONFLICT', 'Temporal analysis was aborted'))
    const timer = setTimeout(() => stop(new DomainError('RENDER_OUTPUT_INVALID', 'Temporal decoder deadline exceeded')),
      input.timeoutMs)
    input.signal?.addEventListener('abort', abort, { once: true })
    child.once('spawn', () => {
      try { if (child.pid !== undefined) input.onStarted?.(child.pid) }
      catch (error) { stop(error instanceof Error ? error : new Error('Temporal process observer failed')) }
    })
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > input.maxBytes) stop(new DomainError('RENDER_OUTPUT_INVALID', 'Temporal decoder output exceeded its bound'))
      else chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes > 64 * 1024) stop(new DomainError('RENDER_OUTPUT_INVALID', 'Temporal decoder stderr exceeded its bound'))
    })
    child.on('error', (error) => { failure ??= error })
    child.on('close', (code) => {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else if (code !== 0) reject(new DomainError('RENDER_OUTPUT_INVALID', 'Temporal decoder failed'))
      else resolve(Buffer.concat(chunks))
    })
  })
}

function rational(value: unknown, label: string): SourceClock {
  const parts = String(value).split('/')
  if (parts.length !== 2) invalid(`${label} is invalid`)
  const num = Number(parts[0]), den = Number(parts[1])
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num <= 0 || den <= 0) {
    invalid(`${label} is invalid`)
  }
  return Object.freeze({ num, den })
}

function meanChange(previous: Buffer, current: Buffer): number {
  let total = 0
  for (let index = 0; index < GRID_BYTES; index += 1) total += Math.abs(previous[index]! - current[index]!)
  return total / (GRID_BYTES * 255)
}

function translation(previous: Buffer, current: Buffer) {
  let best = Number.POSITIVE_INFINITY, runnerUp = Number.POSITIVE_INFINITY
  let bestX = 0, bestY = 0
  for (let dy = -4; dy <= 4; dy += 1) for (let dx = -4; dx <= 4; dx += 1) {
    let error = 0, count = 0
    for (let y = 8; y < GRID_HEIGHT - 8; y += 4) for (let x = 8; x < GRID_WIDTH - 8; x += 4) {
      error += Math.abs(current[y * GRID_WIDTH + x]! - previous[(y - dy) * GRID_WIDTH + x - dx]!)
      count += 1
    }
    const mean = error / count
    if (mean < best - 1e-9 || (Math.abs(mean - best) < 1e-9 &&
        Math.abs(dx) + Math.abs(dy) < Math.abs(bestX) + Math.abs(bestY))) {
      runnerUp = best
      best = mean
      bestX = dx
      bestY = dy
    } else if (mean < runnerUp) runnerUp = mean
  }
  return { dx: bestX, dy: bestY, residual: best / 255,
    ambiguity: runnerUp === 0 ? 1 : 1 - Math.max(0, Math.min(1, (runnerUp - best) / runnerUp)) }
}

function mergeRanges(ranges: readonly TemporalRange[]): readonly TemporalRange[] {
  const merged: Array<{ startSourcePts: number; endSourcePts: number }> = []
  for (const range of ranges) {
    const last = merged.at(-1)
    if (last?.endSourcePts === range.startSourcePts) last.endSourcePts = range.endSourcePts
    else merged.push({ ...range })
  }
  return Object.freeze(merged.map((range) => Object.freeze(range)))
}

export type TemporalVideoRuntime = Readonly<{
  ffmpegBinary: string; ffprobeBinary: string
  expectedFFmpegSha256: string; expectedFFprobeSha256: string
}>
export type TemporalAnalyzerOptions = Readonly<{
  deadlineMs?: number
  onProcessStarted?: (kind: 'probe' | 'decode', pid: number) => void
  onPairMeasured?: (currentFrame: number) => void
}>

/** Raw frame-pair evidence only. No hard-cut, camera/object or ROI classification. */
export class FfmpegTemporalVideoAnalyzer implements VisualTemporalAnalyzer {
  private readonly runtime: TemporalVideoRuntime
  private readonly options: TemporalAnalyzerOptions

  constructor(runtime: TemporalVideoRuntime, options: TemporalAnalyzerOptions = {}) {
    if (!isAbsolute(runtime.ffmpegBinary) || !isAbsolute(runtime.ffprobeBinary)) {
      throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Temporal binaries require absolute paths')
    }
    if (!SHA.test(runtime.expectedFFmpegSha256) || !SHA.test(runtime.expectedFFprobeSha256) ||
        (options.deadlineMs !== undefined && (!Number.isSafeInteger(options.deadlineMs) ||
          options.deadlineMs < 1 || options.deadlineMs > MAX_ANALYSIS_MS))) {
      throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Temporal runtime pins or deadline are invalid')
    }
    this.runtime = Object.freeze({ ...runtime })
    this.options = Object.freeze({ ...options })
  }

  async analyze(input: { sourcePath: string; expectedSourceSha256: string; signal?: AbortSignal }):
    Promise<VisualTemporalAnalysis> {
    if (!isAbsolute(input.sourcePath) || !SHA.test(input.expectedSourceSha256)) {
      throw new DomainError('INVALID_ARGUMENT', 'Temporal source identity is invalid')
    }
    const deadlineAt = performance.now() + (this.options.deadlineMs ?? MAX_ANALYSIS_MS)
    const checkActive = () => {
      if (input.signal?.aborted) throw new DomainError('PERSISTENCE_CONFLICT', 'Temporal analysis was aborted')
      if (performance.now() >= deadlineAt) invalid('Temporal aggregate deadline exceeded')
    }
    const phaseTimeout = (maximum: number) => {
      checkActive()
      return Math.max(1, Math.min(maximum, Math.floor(deadlineAt - performance.now())))
    }
    checkActive()
    const sourceStat = await stat(input.sourcePath)
    checkActive()
    if (!sourceStat.isFile() || sourceStat.size > MAX_SOURCE_BYTES) invalid('Temporal source exceeds byte bound')
    const before = await Promise.all([sha256File(input.sourcePath),
      sha256File(this.runtime.ffmpegBinary), sha256File(this.runtime.ffprobeBinary)])
    checkActive()
    if (before[0] !== input.expectedSourceSha256) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Temporal source bytes changed')
    }
    if (before[1] !== this.runtime.expectedFFmpegSha256 ||
        before[2] !== this.runtime.expectedFFprobeSha256) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Temporal binary hash does not match its pinned digest')
    }
    const probeBytes = await runBinary(this.runtime.ffprobeBinary, [
      '-v', 'error', '-threads', '2', '-select_streams', 'v:0', '-show_streams', '-show_frames',
      '-of', 'json', input.sourcePath,
    ], { signal: input.signal, timeoutMs: phaseTimeout(30_000), maxBytes: 4 * 1024 * 1024,
      onStarted: (pid) => this.options.onProcessStarted?.('probe', pid) })
    checkActive()
    let probe: { streams?: Array<Record<string, unknown>>; frames?: Array<Record<string, unknown>> }
    try { probe = JSON.parse(probeBytes.toString('utf8')) as typeof probe }
    catch { invalid('Temporal probe JSON is invalid') }
    const stream = probe.streams?.[0]
    const frames = probe.frames ?? []
    const width = Number(stream?.width), height = Number(stream?.height)
    if (!stream || !Number.isSafeInteger(width) || width < 1 || width > 1920 ||
        !Number.isSafeInteger(height) || height < 1 || height > 1080 ||
        frames.length < 2 || frames.length > MAX_FRAMES) invalid('Temporal video dimensions or frame count are unsupported')
    const sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list : []
    const tagRotation = stream.tags && typeof stream.tags === 'object' ?
      Number((stream.tags as Record<string, unknown>).rotate ?? 0) : 0
    if (!Number.isFinite(tagRotation) || tagRotation !== 0 || sideData.some((item) => {
      const data = item as Record<string, unknown>
      return data.side_data_type === 'Display Matrix' &&
        (!Number.isFinite(Number(data.rotation)) || Number(data.rotation) !== 0)
    })) invalid('Temporal display rotation is unsupported')
    const sourceFps = rational(stream.r_frame_rate, 'Temporal frame rate')
    const sourceTimebase = rational(stream.time_base, 'Temporal timebase')
    const ticksPerFrame = sourceFps.den * sourceTimebase.den / (sourceFps.num * sourceTimebase.num)
    const pts = frames.map((frame) => Number(frame.best_effort_timestamp))
    if (!Number.isFinite(ticksPerFrame) || ticksPerFrame < 1 ||
        pts.some((value, index) => !Number.isSafeInteger(value) || value < 0 ||
          (index > 0 && (value <= pts[index - 1]! ||
            Math.abs(value - (pts[0]! + index * ticksPerFrame)) > 1)))) {
      invalid('Temporal frame PTS are missing, reordered or non-CFR')
    }
    if (frames.length * sourceFps.den / sourceFps.num > 10) invalid('Temporal video exceeds duration bound')
    const raw = await runBinary(this.runtime.ffmpegBinary, [
      '-hide_banner', '-loglevel', 'error', '-threads', '2', '-filter_threads', '2',
      '-i', input.sourcePath, '-map', '0:v:0',
      '-vf', `scale=${GRID_WIDTH}:${GRID_HEIGHT}:flags=bicubic,format=gray`,
      '-fps_mode', 'passthrough', '-an', '-f', 'rawvideo', 'pipe:1',
    ], { signal: input.signal, timeoutMs: phaseTimeout(60_000), maxBytes: MAX_FRAMES * GRID_BYTES,
      onStarted: (pid) => this.options.onProcessStarted?.('decode', pid) })
    checkActive()
    if (raw.length !== frames.length * GRID_BYTES) invalid('Temporal decoded frames differ from observed PTS')
    const grids = Array.from({ length: frames.length }, (_, index) =>
      raw.subarray(index * GRID_BYTES, (index + 1) * GRID_BYTES))
    const gridHashes = grids.map(hash)
    const shotObservations: VisualTemporalAnalysis['shot']['observations'][number][] = []
    const motionObservations: VisualTemporalAnalysis['motion']['observations'][number][] = []
    const motionGaps: VisualTemporalAnalysis['motion']['gaps'][number][] = []
    for (let index = 1; index < frames.length; index += 1) {
      if (index % 8 === 0) await yieldToEventLoop()
      checkActive()
      const previous = grids[index - 1]!, current = grids[index]!
      const range = { startSourcePts: pts[index - 1]!, endSourcePts: pts[index]! }
      const changeScore = meanChange(previous, current)
      shotObservations.push(Object.freeze({ ...range, previousFrame: index - 1, currentFrame: index,
        previousGridSha256: gridHashes[index - 1]!, currentGridSha256: gridHashes[index]!, changeScore }))
      if (changeScore > UNRELIABLE_CHANGE) {
        motionGaps.push(Object.freeze({ ...range, reasonCode: 'UNRELIABLE_FRAME_DIFFERENCE' }))
        this.options.onPairMeasured?.(index)
        continue
      }
      const vector = translation(previous, current)
      const elapsedSeconds = (range.endSourcePts - range.startSourcePts) *
        sourceTimebase.num / sourceTimebase.den
      motionObservations.push(Object.freeze({ ...range, previousFrame: index - 1, currentFrame: index,
        vectorPxPerSecond: Object.freeze({ x: vector.dx * width / GRID_WIDTH / elapsedSeconds,
          y: vector.dy * height / GRID_HEIGHT / elapsedSeconds }),
        residualMeanAbsoluteLuma: vector.residual, ambiguity: vector.ambiguity }))
      this.options.onPairMeasured?.(index)
    }
    checkActive()
    const after = await Promise.all([sha256File(input.sourcePath),
      sha256File(this.runtime.ffmpegBinary), sha256File(this.runtime.ffprobeBinary)])
    checkActive()
    if (after.some((value, index) => value !== before[index])) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Temporal source or runtime bytes changed during analysis')
    }
    const shotRanges = shotObservations.map(({ startSourcePts, endSourcePts }) => ({ startSourcePts, endSourcePts }))
    const motionRanges = motionObservations.map(({ startSourcePts, endSourcePts }) => ({ startSourcePts, endSourcePts }))
    return Object.freeze({ algorithmVersion: 'visual-temporal-grid/v1', sourceSha256: before[0]!,
      sourceFps, sourceTimebase, sourceClock: 'constant-frame-rate', sourceWidth: width,
      sourceHeight: height, observedFrameCount: frames.length,
      assessedDomain: Object.freeze({ startSourcePts: pts[0]!, endSourcePts: pts.at(-1)! }),
      analysisGrid: Object.freeze({ width: GRID_WIDTH, height: GRID_HEIGHT }),
      runtime: Object.freeze({ ffmpegSha256: before[1]!, ffprobeSha256: before[2]! }),
      shot: Object.freeze({ observations: Object.freeze(shotObservations),
        coverage: mergeRanges(shotRanges), gaps: Object.freeze([]) }),
      motion: Object.freeze({ observations: Object.freeze(motionObservations),
        coverage: mergeRanges(motionRanges), gaps: Object.freeze(motionGaps) }),
    })
  }
}
