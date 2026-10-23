import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { promisify } from 'node:util'
import sharp from 'sharp'

import type {
  Mp4ControlKind, Mp4PixelCritic, Mp4PixelCriticRequest, Mp4PixelVerification, PixelOracle, PixelOracleAnalysis, PixelOracleFrameResult,
  PixelOracleRegistration,
} from '../../application/ports/mp4-pixel-critic.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  countPackedMaskInRect, measureInk, measureSubject, packMask, pixelRectOf, rawLumaChangedPixels, registrationFacts, type RegistrationMeasurement,
} from '../../domain/mp4-pixel-geometry.ts'
import {
  createMp4QualityReport, MP4_PIXEL_CRITIC_POLICY, planMp4SampleFrames, type InkFacts, type Mp4ArtifactIdentity, type Mp4ControlReceipt,
  type Mp4NoiseProbe, type Mp4OracleReceipt, type Mp4SampleFacts, type ProtectedRegionFacts,
} from '../../domain/mp4-pixel-quality.ts'
import { modelReadStatuses, pixelOracleModelPins, PIXEL_ORACLE_PROTOCOL, regionOriginOf, unionOracleReadings, type PixelOracleModelId } from '../../domain/pixel-face-oracle.ts'
import { resolveFfmpegBinary } from './ffmpeg-binary.ts'
import { resolveFfprobeBinary } from './ffmpeg-sync-marker-renderer.ts'
import { PIXEL_ORACLE_MAX_FRAMES_PER_BATCH } from '../perception/openvino-pixel-oracle.ts'

const execFileAsync = promisify(execFile)
const policy = MP4_PIXEL_CRITIC_POLICY

/**
 * W67 critic of the delivered MP4 (extends the W65 caption pixel critic to captions, CTA, safe area, subject and density).
 *
 * It decodes EVERY frame of the file (hash per frame, count against the container and the PTS list), decodes the control encodes of the
 * same input in lockstep (captions off, CTA off, both off), and measures ink as the pixels that differ from the control. The face oracle
 * reads the overlay-free frame, so a caption can never hide the face it covers; the source frame is registered onto the output frame on
 * pixels, so the position of the subject in the output is measured and not derived from the crop the renderer was given.
 */
type ProbeResult = Readonly<{
  formatName: string; codec: string; pixelFormat: string; width: number; height: number
  frameRate: Readonly<{ num: number; den: number }>; timeBase: Readonly<{ num: number; den: number }>
  declaredFrames: number | null; durationTicks: number; ptsTicks: readonly number[]
}>

const parseRatio = (value: unknown): { num: number; den: number } => {
  const [num, den] = String(value ?? '').split('/').map(Number)
  return { num: Number.isFinite(num) ? num! : 0, den: Number.isFinite(den) && den! > 0 ? den! : 1 }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Frames of a rawvideo pipe, one Buffer each; the generator throws when the stream ends in the middle of a frame. */
async function* rawFrames(stdout: Readable, frameBytes: number): AsyncGenerator<Buffer> {
  let pending: Buffer[] = []
  let size = 0
  for await (const chunk of stdout as AsyncIterable<Buffer>) {
    pending.push(chunk)
    size += chunk.length
    while (size >= frameBytes) {
      const joined = pending.length === 1 ? pending[0]! : Buffer.concat(pending)
      yield Buffer.from(joined.subarray(0, frameBytes))
      const rest = joined.subarray(frameBytes)
      pending = rest.length ? [Buffer.from(rest)] : []
      size = rest.length
    }
  }
  if (size !== 0) throw new DomainError('RENDER_OUTPUT_INVALID', 'The MP4 critic decoded a partial frame')
}

/** `select` filter graph for the ascending, de-duplicated frames; runs of 3+ become one `between`, so a dense request stays short. */
export function selectExpression(frames: readonly number[]): string {
  const terms: string[] = []
  for (let index = 0; index < frames.length;) {
    let end = index
    while (end + 1 < frames.length && frames[end + 1] === frames[end]! + 1) end += 1
    if (!Number.isSafeInteger(frames[index]) || frames[index]! < 0) throw new DomainError('RENDER_OUTPUT_INVALID', 'The MP4 critic was asked for an invalid frame')
    terms.push(end - index >= 2 ? `between(n\\,${frames[index]}\\,${frames[end]})` : [...Array(end - index + 1).keys()].map((offset) => `eq(n\\,${frames[index]! + offset})`).join('+'))
    index = end + 1
  }
  return `select=${terms.join('+')}`
}

type Decoder = Readonly<{ frames: AsyncGenerator<Buffer>; child: ChildProcess; stderr: () => string; closed: Promise<number | null> }>

export type FfmpegMp4PixelCriticOptions = Readonly<{
  oracle: PixelOracle
  /** Directory the critic may create its per-run work directories in (frames as PNG); always removed afterwards. */
  workRoot: string
  ffmpegPath?: string
  ffprobePath?: string
  /** The sha256 of the ffmpeg binary, recorded in the decode receipt (null when not known). */
  ffmpegBinarySha256?: string | null
  /** Overlays the RenderInput does not contain need no control render. Defaults: both present. */
  overlays?: Readonly<{ captions: boolean; cta: boolean }>
  /** Sampling parameters other than the policy's (a long output measured with a coarser stride, or a test); recorded in the report. */
  sampling?: Readonly<{ allFramesUpTo: number; strideFrames: number }>
  /** Called with the argument vector of every ffmpeg process the critic starts (a test counts the passes; production leaves it unset). */
  onFfmpegSpawn?: (args: readonly string[]) => void
}>

export class FfmpegMp4PixelCritic implements Mp4PixelCritic {
  private readonly ffmpegPath: string
  private readonly ffprobePath: string
  private readonly options: FfmpegMp4PixelCriticOptions

  constructor(options: FfmpegMp4PixelCriticOptions) {
    this.options = options
    this.ffmpegPath = resolveFfmpegBinary(options.ffmpegPath)
    this.ffprobePath = resolveFfprobeBinary(options.ffprobePath)
  }

  private async probe(path: string, withFrames: boolean): Promise<ProbeResult> {
    const run = async (entries: string) => JSON.parse((await execFileAsync(this.ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', entries, '-of', 'json', path], {
      windowsHide: true, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8',
    })).stdout) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown>; frames?: Array<Record<string, unknown>> }
    const stream = await run('stream=codec_name,pix_fmt,width,height,avg_frame_rate,r_frame_rate,time_base,nb_frames,duration_ts:format=format_name')
    const video = stream.streams?.[0]
    if (!video) throw new DomainError('RENDER_OUTPUT_INVALID', 'The MP4 critic found no video stream')
    const pts: number[] = []
    if (withFrames) {
      const frames = await run('frame=pts,best_effort_timestamp')
      for (const frame of frames.frames ?? []) {
        const value = Number(frame.pts ?? frame.best_effort_timestamp)
        if (!Number.isFinite(value)) throw new DomainError('RENDER_OUTPUT_INVALID', 'The MP4 critic found a frame without a timestamp')
        pts.push(value)
      }
    }
    const frameRate = parseRatio(video.avg_frame_rate ?? video.r_frame_rate)
    const timeBase = parseRatio(video.time_base)
    const declared = Number(video.nb_frames)
    const durationTicks = Number.isFinite(Number(video.duration_ts)) ? Number(video.duration_ts)
      : pts.length ? pts.at(-1)! + Math.round(timeBase.den * frameRate.den / (timeBase.num * Math.max(1, frameRate.num))) : 0
    return Object.freeze({
      formatName: String(stream.format?.format_name ?? ''), codec: String(video.codec_name ?? ''), pixelFormat: String(video.pix_fmt ?? ''),
      width: Number(video.width), height: Number(video.height), frameRate, timeBase,
      declaredFrames: Number.isFinite(declared) && declared > 0 ? declared : null, durationTicks, ptsTicks: Object.freeze(pts),
    })
  }

  private decoder(path: string, width: number, height: number, signal?: AbortSignal, selectScript?: string): Decoder {
    // A selection is read from a script file: the expression of a long list of frames outgrows the command line.
    const args = ['-hide_banner', '-v', 'error', '-i', path, '-map', '0:v:0',
      ...(selectScript ? ['-filter_script:v', selectScript, '-fps_mode', 'passthrough'] : []), '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']
    this.options.onFfmpegSpawn?.(args)
    const child = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 64_000) stderr += chunk.toString('utf8') })
    const closed = new Promise<number | null>((resolve) => { child.once('error', () => resolve(-1)); child.once('close', resolve) })
    signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true })
    return { frames: rawFrames(child.stdout, width * height * 3), child, stderr: () => stderr, closed }
  }

  /**
   * Specific frames of a file (decode order index) as RGB24, in ASCENDING frame order, from ONE decoding pass of the file through the
   * select filter. Frames are handed over one at a time as the pipe delivers them (never all in memory); the select filter emits in
   * decode order, so the n-th buffer is the n-th smallest requested frame. Throws when the pass ends before every frame arrived or
   * with an error on stderr. The ffmpeg process is registered in `decoders` so the caller's cleanup also kills an abandoned pass.
   */
  private async *selectedFrames(
    path: string, frames: readonly number[], width: number, height: number, script: string, decoders: Decoder[], signal?: AbortSignal,
  ): AsyncGenerator<Buffer> {
    await writeFile(script, selectExpression(frames), 'utf8')
    const decoder = this.decoder(path, width, height, signal, script)
    decoders.push(decoder)
    let produced = 0
    for await (const frame of decoder.frames) {
      if (produced >= frames.length) throw new DomainError('RENDER_OUTPUT_INVALID', 'The MP4 critic decoded more frames than requested')
      produced += 1
      yield frame
    }
    const code = await decoder.closed
    if (produced !== frames.length || code !== 0 || decoder.stderr().length > 0) {
      throw new DomainError('RENDER_OUTPUT_INVALID', 'The MP4 critic could not decode every requested frame')
    }
  }

  async verify(request: Mp4PixelCriticRequest): Promise<Readonly<Mp4PixelVerification>> {
    const { outputSpec } = request
    const { width, height } = outputSpec
    const work = join(this.options.workRoot, `mp4-critic-${createHash('sha256').update(`${request.identity.operationId}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 16)}`)
    await mkdir(work, { recursive: true })
    const decoders: Decoder[] = []
    try {
      const deliveredStat = await stat(request.deliveredPath)
      const [deliveredSha, probe] = await Promise.all([sha256File(request.deliveredPath), this.probe(request.deliveredPath, true)])
      if (probe.width !== width || probe.height !== height) throw new DomainError('RENDER_OUTPUT_INVALID', 'The delivered canvas differs from the OutputSpec')
      const totalFrames = probe.ptsTicks.length
      // ---- controls: the same RenderInput without the overlay ----
      const overlays = request.overlays ?? this.options.overlays ?? { captions: true, cta: true }
      const controlPath = new Map<Mp4ControlKind, string>()
      const controlReceipts: Mp4ControlReceipt[] = []
      const control = async (kind: Mp4ControlKind): Promise<string> => {
        const cached = controlPath.get(kind)
        if (cached) return cached
        const rendered = await request.renderControl(kind)
        const [sha, info, controlProbe] = await Promise.all([sha256File(rendered.path), stat(rendered.path), this.probe(rendered.path, true)])
        if (controlProbe.width !== width || controlProbe.height !== height || controlProbe.ptsTicks.length !== totalFrames) {
          throw new DomainError('RENDER_OUTPUT_INVALID', `The ${kind} control differs from the delivered file in canvas or frame count`)
        }
        controlPath.set(kind, rendered.path)
        controlReceipts.push(Object.freeze({ kind, sha256: sha, byteSize: info.size, frameCount: controlProbe.ptsTicks.length }))
        return rendered.path
      }
      const bare = overlays.captions || overlays.cta ? await control('overlays-off') : request.deliveredPath
      const noCaptions = overlays.captions && overlays.cta ? await control('captions-off') : overlays.captions ? bare : request.deliveredPath
      const noCta = overlays.captions && overlays.cta ? await control('cta-off') : overlays.cta ? bare : request.deliveredPath
      // ---- sampling plan ----
      const cutFrames = [...new Set(request.clips.map((clip) => clip.timelineInFrame).filter((frame) => frame > 0))]
      const samplingPolicy = this.options.sampling ?? { allFramesUpTo: policy.sampling.allFramesUpTo, strideFrames: policy.sampling.strideFrames }
      const planning = { ...policy, sampling: { ...policy.sampling, ...samplingPolicy } }
      const sampled = new Set(planMp4SampleFrames({ totalFrames, cutFrames, policy: planning }))
      // ---- pass 1: every frame of the delivered file and of the controls, in lockstep ----
      const delivered = this.decoder(request.deliveredPath, width, height, request.signal)
      const cc = this.decoder(noCaptions, width, height, request.signal)
      const ca = this.decoder(noCta, width, height, request.signal)
      const cb = this.decoder(bare, width, height, request.signal)
      decoders.push(delivered, cc, ca, cb)
      type Capture = { caption: InkFacts; cta: InkFacts; captionMask: Uint8Array | null; ctaMask: Uint8Array | null; png: string | null }
      const captures = new Map<number, Capture>()
      const frameLines: string[] = []
      const frameShas: string[] = []
      const noise: number[] = []
      const capture = async (index: number, d: Buffer, ccFrame: Buffer, caFrame: Buffer, cbFrame: Buffer, keep: boolean): Promise<Capture> => {
        const captionInk = measureInk(d, ccFrame, width, height)
        const ctaInk = measureInk(d, caFrame, width, height)
        let png: string | null = null
        if (keep) {
          png = join(work, `o-${String(index).padStart(6, '0')}.png`)
          await sharp(cbFrame, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 1 }).toFile(png)
        }
        if (captionInk.facts.pixels === 0 && ctaInk.facts.pixels === 0 && (overlays.captions || overlays.cta)) {
          noise.push(Math.max(rawLumaChangedPixels(d, ccFrame, width, height, policy.ink.lumaThresholdLevels), rawLumaChangedPixels(d, caFrame, width, height, policy.ink.lumaThresholdLevels)))
        }
        return {
          caption: captionInk.facts, cta: ctaInk.facts, png,
          captionMask: keep && captionInk.mask ? packMask(captionInk.mask) : null, ctaMask: keep && ctaInk.mask ? packMask(ctaInk.mask) : null,
        }
      }
      let decoded = 0
      for (let index = 0; ; index += 1) {
        const [d, c1, c2, c3] = await Promise.all([delivered.frames.next(), cc.frames.next(), ca.frames.next(), cb.frames.next()])
        if (d.done) {
          if (!c1.done || !c2.done || !c3.done) throw new DomainError('RENDER_OUTPUT_INVALID', 'A control has more frames than the delivered file')
          break
        }
        if (c1.done || c2.done || c3.done) throw new DomainError('RENDER_OUTPUT_INVALID', 'A control has fewer frames than the delivered file')
        decoded += 1
        const frameSha = createHash('sha256').update(d.value).digest('hex')
        frameShas.push(frameSha)
        frameLines.push(`${index}:${probe.ptsTicks[index] ?? 'none'}:${frameSha}`)
        captures.set(index, await capture(index, d.value, c1.value, c2.value, c3.value, sampled.has(index)))
      }
      const stderrs = decoders.map((entry) => entry.stderr())
      const exits = await Promise.all(decoders.map((entry) => entry.closed))
      const decodeComplete = decoded === totalFrames && (probe.declaredFrames === null || probe.declaredFrames === totalFrames) && exits.every((code) => code === 0) && stderrs.every((text) => text.length === 0)
      // Ink-run edges (long outputs only): their pixels are decoded again, because only now is it known where the ink starts and ends.
      const inkFrames = new Set([...captures].filter(([, entry]) => entry.caption.pixels > 0 || entry.cta.pixels > 0).map(([frame]) => frame))
      const extra = planMp4SampleFrames({ totalFrames, cutFrames, inkFrames, policy: planning }).filter((frame) => !sampled.has(frame))
      if (extra.length > 0 && decodeComplete) {
        // One pass per distinct file (the overlay-free controls can be the delivered file itself), each frame handed over as it arrives.
        const extraSorted = [...new Set(extra)].toSorted((left, right) => left - right)
        const passes = new Map<string, AsyncGenerator<Buffer>>()
        const passOf = (path: string) => {
          if (!passes.has(path)) passes.set(path, this.selectedFrames(path, extraSorted, width, height, join(work, `select-extra-${passes.size}.txt`), decoders, request.signal))
          return passes.get(path)!
        }
        const streams = [request.deliveredPath, noCaptions, noCta, bare].map(passOf)
        for (const frame of extraSorted) {
          const stepped = await Promise.all([...passes.values()].map((pass) => pass.next()))
          const byPass = new Map([...passes.keys()].map((path, position) => [path, stepped[position]!] as const))
          const [dd, c1, c2, c3] = [request.deliveredPath, noCaptions, noCta, bare].map((path) => byPass.get(path)!)
          if (!dd || !c1 || !c2 || !c3 || dd.done || c1.done || c2.done || c3.done) throw new DomainError('RENDER_OUTPUT_INVALID', 'The MP4 critic could not decode every requested frame')
          captures.set(frame, await capture(frame, dd.value, c1.value, c2.value, c3.value, true))
          sampled.add(frame)
        }
        for (const pass of new Set(streams)) if (!(await pass.next()).done) throw new DomainError('RENDER_OUTPUT_INVALID', 'The MP4 critic decoded more frames than requested')
      }
      const sampleFrames = [...sampled].filter((frame) => captures.get(frame)?.png).toSorted((left, right) => left - right)
      // ---- source frames ----
      const clipOf = (frame: number) => request.clips.find((clip) => clip.timelineInFrame <= frame && frame < clip.timelineOutFrame)
      const sourceDims = new Map<string, Readonly<{ width: number; height: number }>>()
      const sourceNeeds = new Map<string, number[]>()
      const sourceKeyOf = (frame: number): { artifactId: string; sourceFrame: number } | null => {
        const clip = clipOf(frame)
        if (!clip || clip.rate !== 1 || !request.sources[clip.sourceArtifactId]) return null
        return { artifactId: clip.sourceArtifactId, sourceFrame: clip.sourceInFrame + (frame - clip.timelineInFrame) }
      }
      for (const frame of sampleFrames) {
        const key = sourceKeyOf(frame)
        if (key) sourceNeeds.set(key.artifactId, [...new Set([...(sourceNeeds.get(key.artifactId) ?? []), key.sourceFrame])])
      }
      const sourcePng = new Map<string, Readonly<{ id: string; file: string; sha256: string }>>()
      for (const [artifactId, wanted] of sourceNeeds) {
        const source = request.sources[artifactId]!
        const sourceProbe = await this.probe(source.path, false)
        sourceDims.set(artifactId, { width: sourceProbe.width, height: sourceProbe.height })
        const ordered = wanted.toSorted((left, right) => left - right)
        // ONE decoding pass of the source for every wanted frame; each frame goes to disk as it arrives.
        const pass = this.selectedFrames(source.path, ordered, sourceProbe.width, sourceProbe.height, join(work, `select-source-${[...sourceNeeds.keys()].indexOf(artifactId)}.txt`), decoders, request.signal)
        for (const sourceFrame of ordered) {
          const stepped = await pass.next()
          if (stepped.done) throw new DomainError('RENDER_OUTPUT_INVALID', 'The MP4 critic could not decode every requested frame')
          const buffer = stepped.value
          const id = `s-${[...sourceNeeds.keys()].indexOf(artifactId)}-${String(sourceFrame).padStart(6, '0')}`
          const file = `${id}.png`
          await sharp(buffer, { raw: { width: sourceProbe.width, height: sourceProbe.height, channels: 3 } }).png({ compressionLevel: 1 }).toFile(join(work, file))
          sourcePng.set(`${artifactId}:${sourceFrame}`, { id, file, sha256: createHash('sha256').update(buffer).digest('hex') })
        }
        if (!(await pass.next()).done) throw new DomainError('RENDER_OUTPUT_INVALID', 'The MP4 critic decoded more frames than requested')
      }
      // ---- the oracle, in batches that keep every registration's two frames together ----
      const analyses: PixelOracleAnalysis[] = []
      const frameResult = new Map<string, PixelOracleFrameResult>()
      const registrationOf = new Map<string, PixelOracleRegistration>()
      const outputId = (frame: number) => `o-${String(frame).padStart(6, '0')}`
      let batchFrames: Array<{ id: string; file: string }> = []
      let batchPairs: Array<{ id: string; sourceId: string; outputId: string }> = []
      const oracleFailures: string[] = []
      const flush = async () => {
        if (batchFrames.length === 0) return
        try {
          const analysis = await this.options.oracle.analyze({ framesDirectory: work, frames: batchFrames, pairs: batchPairs, ...(request.signal ? { signal: request.signal } : {}) })
          analyses.push(analysis)
          for (const result of analysis.frames) frameResult.set(result.id, result)
          for (const registration of analysis.registrations) registrationOf.set(registration.id, registration)
        } catch (error) {
          // An oracle that cannot run leaves its frames unknown: the ink checks (safe area, clipping, density) do not need it and still stand.
          if (request.signal?.aborted) throw error
          oracleFailures.push(error instanceof DomainError ? error.message.slice(0, 160) : 'ORACLE_FAILED')
        }
        batchFrames = []; batchPairs = []
      }
      for (const frame of sampleFrames) {
        const key = sourceKeyOf(frame)
        const source = key ? sourcePng.get(`${key.artifactId}:${key.sourceFrame}`) : undefined
        const ids = new Set(batchFrames.map((entry) => entry.id))
        const additions = [{ id: outputId(frame), file: `${outputId(frame)}.png` }, ...(source ? [{ id: source.id, file: source.file }] : [])].filter((entry) => !ids.has(entry.id))
        if (batchFrames.length + additions.length > PIXEL_ORACLE_MAX_FRAMES_PER_BATCH) await flush()
        const present = new Set(batchFrames.map((entry) => entry.id))
        batchFrames.push(...additions.filter((entry) => !present.has(entry.id)))
        if (source) batchPairs.push({ id: `p-${String(frame).padStart(6, '0')}`, sourceId: source.id, outputId: outputId(frame) })
      }
      await flush()
      // ---- facts of every sample ----
      const facts: Mp4SampleFacts[] = []
      const perSample: Mp4OracleReceipt['perSample'][number][] = []
      for (const frame of sampleFrames) {
        const entry = captures.get(frame)!
        const pts = probe.ptsTicks[frame]!
        const sampleId = `${deliveredSha.slice(0, 16)}:f${frame}:t${pts}:${frameShas[frame]!.slice(0, 16)}`
        const output = frameResult.get(outputId(frame))
        const outputUnion = output && output.status === 'ok' ? unionOracleReadings(output.readings) : null
        const key = sourceKeyOf(frame)
        const source = key ? sourcePng.get(`${key.artifactId}:${key.sourceFrame}`) : undefined
        const sourceResult = source ? frameResult.get(source.id) : undefined
        const sourceUnion = sourceResult && sourceResult.status === 'ok' ? unionOracleReadings(sourceResult.readings) : null
        const registration = registrationOf.get(`p-${String(frame).padStart(6, '0')}`)
        const measurement: RegistrationMeasurement | null = registration ? registration : null
        const subject = measureSubject({
          sourceFrameAvailable: Boolean(source),
          sourceOracle: !source ? 'absent' : sourceUnion && sourceUnion.status === 'observed' ? 'observed' : 'unknown',
          sourceFaces: sourceUnion?.faces.map((face) => face.box) ?? [],
          registration: measurement,
          sourceDimensions: key ? (sourceDims.get(key.artifactId) ?? null) : null,
          outputDimensions: { width, height },
          outputFaces: outputUnion?.faces.map((face) => face.box) ?? [],
        })
        const regions: ProtectedRegionFacts[] = []
        const countIn = (box: ProtectedRegionFacts['box']) => {
          const rect = pixelRectOf(box, width, height, policy.faceMarginPixels)
          return { caption: countPackedMaskInRect(entry.captionMask, width, rect), cta: countPackedMaskInRect(entry.ctaMask, width, rect) }
        }
        for (const face of outputUnion?.faces ?? []) {
          const counts = countIn(face.box)
          regions.push(Object.freeze({ origin: regionOriginOf(face.models[0]!), box: face.box, captionInkPixels: counts.caption, ctaInkPixels: counts.cta }))
        }
        for (const [position, box] of subject.projectedSourceFaces.entries()) {
          const counts = countIn(box)
          const sourceFace = sourceUnion?.faces[subject.projectedSourceFaceIndices[position]!]
          regions.push(Object.freeze({
            origin: 'source-projection' as const, box, captionInkPixels: counts.caption, ctaInkPixels: counts.cta,
            sourceModels: Object.freeze((sourceFace?.models ?? []).map((model) => regionOriginOf(model))),
          }))
        }
        facts.push(Object.freeze({
          sampleId, frameIndex: frame, ptsTicks: pts, frameSha256: frameShas[frame]!,
          caption: entry.caption, cta: entry.cta, inkDensity: (entry.caption.pixels + entry.cta.pixels) / (width * height),
          oracle: Object.freeze({
            state: outputUnion ? outputUnion.status : 'unknown' as const, outputFaceCount: outputUnion?.faces.length ?? 0, sourceFaceCount: sourceUnion?.faces.length ?? 0,
            outputReads: modelReadStatuses(output && output.status === 'ok' ? output.readings : []),
            sourceReads: source ? modelReadStatuses(sourceResult && sourceResult.status === 'ok' ? sourceResult.readings : []) : null,
            registrationStatus: measurement ? (registrationFacts(measurement).usable ? 'ok' as const : 'failed' as const) : 'not-attempted' as const,
            mappedSourceFaces: subject.mappedSourceFaces,
          }),
          registration: subject.registration, protectedRegions: Object.freeze(regions), subject: subject.subject,
        }))
        const raws = (result: PixelOracleFrameResult | undefined) => Object.freeze(Object.fromEntries((result?.readings ?? []).map((reading) => [reading.modelId, reading.rawOutputSha256])) as Record<PixelOracleModelId, string | null>)
        perSample.push(Object.freeze({ sampleId, outputRawSha256: raws(output), sourceRawSha256: source ? raws(sourceResult) : null, sourceFrameSha256: source?.sha256 ?? null }))
      }
      const noiseSorted = noise.toSorted((left, right) => left - right)
      const noiseProbe: Mp4NoiseProbe = noiseSorted.length === 0 ? null : Object.freeze({
        framesProbed: noiseSorted.length, maxChangedPixels: noiseSorted.at(-1)!, medianChangedPixels: noiseSorted[Math.floor(noiseSorted.length / 2)]!,
        p95ChangedPixels: noiseSorted[Math.min(noiseSorted.length - 1, Math.floor(noiseSorted.length * 0.95))]!,
      })
      const receipt = analyses[0]?.receipt
      const artifact: Mp4ArtifactIdentity = Object.freeze({
        sha256: deliveredSha, byteSize: deliveredStat.size, container: probe.formatName, videoCodec: probe.codec, pixelFormat: probe.pixelFormat, width, height,
        frameRate: probe.frameRate, timeBase: probe.timeBase, frameCount: totalFrames, durationTicks: probe.durationTicks,
      })
      const report = createMp4QualityReport({
        identity: request.identity, artifact,
        decode: Object.freeze({
          status: decodeComplete ? 'complete' as const : 'failed' as const, framesExpected: totalFrames, framesDecoded: decoded,
          frameListSha256: createHash('sha256').update(frameLines.join('\n')).digest('hex'),
          stderrSha256: createHash('sha256').update(stderrs.join('\n---\n')).digest('hex'), ffmpegBinarySha256: this.options.ffmpegBinarySha256 ?? null,
        }),
        outputSpec: Object.freeze({ width, height, safeArea: outputSpec.safeArea }),
        controls: Object.freeze(controlReceipts.toSorted((left, right) => left.kind.localeCompare(right.kind))),
        oracle: Object.freeze({
          protocol: receipt?.protocol ?? PIXEL_ORACLE_PROTOCOL, models: pixelOracleModelPins(), bridgeSha256: receipt?.bridgeSha256 ?? '', pythonSha256: receipt?.pythonSha256 ?? '',
          runtime: receipt?.runtime ?? {}, registration: policy.registration, failures: Object.freeze([...oracleFailures]), perSample: Object.freeze(perSample),
        }),
        samples: facts, noiseProbe, samplingPolicy,
      })
      return Object.freeze({ report, issues: report.issues })
    } finally {
      for (const entry of decoders) if (entry.child.exitCode === null) entry.child.kill('SIGKILL')
      await rm(work, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
