import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'

import { DomainError } from '../../domain/errors.ts'
import { evaluateMediaProbe, sniffMediaInput, type MediaIngestDecision } from '../../domain/media-input.ts'
import type { MediaUpload } from '../../domain/media-transfer.ts'
import type {
  DetectedMediaColor,
} from '../../domain/color-and-export.ts'
import { calculateFileSha256 } from './local-artifact-manifest.ts'
import { resolveFfprobeBinaryPath } from './ffmpeg-binary.ts'

const require = createRequire(import.meta.url)
const ffprobeStatic = require('ffprobe-static') as { path?: string }
const execFileAsync = promisify(execFile)
const DEFAULT_TIMEOUT_MS = 60_000
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const producerCache = new Map<string, Promise<Readonly<{
  provider: 'ffprobe'
  version: 'json-v1'
  binaryDigest: string
}>>>()

export interface VideoProbeResult {
  width: number
  height: number
  fps: number
  duration: number
  codec: string
  audioCodec: string
  container: string
  color: DetectedMediaColor
  producer: Readonly<{
    provider: 'ffprobe'
    version: 'json-v1'
    binaryDigest: string
  }>
}

function parseRate(value: unknown): number {
  if (typeof value !== 'string' || !value.trim()) return 0
  const [numerator, denominator = '1'] = value.split('/')
  const top = Number(numerator)
  const bottom = Number(denominator)
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0) return 0
  return top / bottom
}

function positiveNumber(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function token(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9._/-]{0,127}$/.test(normalized)
    ? normalized
    : undefined
}

function bitDepth(stream: Record<string, unknown>): number | undefined {
  const declared = Number(stream.bits_per_raw_sample)
  if (
    Number.isSafeInteger(declared) &&
    declared >= 8 &&
    declared <= 32
  ) return declared
  const pixelFormat = token(stream.pix_fmt)
  const matched = pixelFormat?.match(/(?:p|le|be)(\d{2})(?:le|be)?$/)
  if (matched) {
    const parsed = Number(matched[1])
    if (parsed >= 8 && parsed <= 32) return parsed
  }
  return pixelFormat ? 8 : undefined
}

function detectedColor(
  video: Record<string, unknown>,
): DetectedMediaColor {
  const matrix = token(video.color_space)
  const transfer = token(video.color_transfer)
  const primaries = token(video.color_primaries)
  const pixelFormat = token(video.pix_fmt)
  const depth = bitDepth(video)
  const rawRange = token(video.color_range)
  const range = rawRange === 'pc' || rawRange === 'jpeg'
    ? 'full' as const
    : rawRange === 'tv' || rawRange === 'mpeg'
      ? 'limited' as const
      : undefined
  const missing = [
    ...(!matrix ? ['missing-matrix'] : []),
    ...(!transfer ? ['missing-transfer'] : []),
    ...(!primaries ? ['missing-primaries'] : []),
    ...(!range ? ['missing-range'] : []),
    ...(!depth ? ['missing-bit-depth'] : []),
    ...(!pixelFormat ? ['missing-pixel-format'] : []),
  ]
  if (
    missing.length ||
    !matrix ||
    !transfer ||
    !primaries ||
    !range ||
    !depth ||
    !pixelFormat
  ) {
    return Object.freeze({
      state: 'unavailable' as const,
      ...(pixelFormat ? { pixelFormat } : {}),
      reasons: Object.freeze(missing),
    })
  }
  const colorSpace = primaries === 'bt709'
    ? 'rec709'
    : primaries.startsWith('bt2020')
      ? 'rec2020'
      : primaries === 'smpte432'
        ? 'display-p3'
        : `primaries-${primaries}`
  const hdrMode = transfer === 'smpte2084'
    ? 'pq' as const
    : transfer === 'arib-std-b67'
      ? 'hlg' as const
      : 'sdr' as const
  return Object.freeze({
    state: 'ready' as const,
    metadata: Object.freeze({
      colorSpace,
      transfer,
      primaries,
      matrix,
      range,
      bitDepth: depth,
    }),
    pixelFormat,
    hdrMode,
  })
}

function resolveBinary(environment: NodeJS.ProcessEnv): string {
  // Shared with ffmpeg, and for the same reason: ffprobe-static computes its
  // path from `__dirname`, so a bundled server was probing a binary inside
  // `.next/server/chunks` that was never copied there.
  return resolveFfprobeBinaryPath(ffprobeStatic?.path, undefined, environment)
}

function describeProducer(binary: string) {
  const cached = producerCache.get(binary)
  if (cached) return cached
  const pending = (async () => {
    const binaryDigest = isAbsolute(binary)
      ? await calculateFileSha256(binary)
      : createHash('sha256')
          .update((await execFileAsync(binary, ['-version'], {
            windowsHide: true,
            timeout: 30_000,
            maxBuffer: MAX_OUTPUT_BYTES,
            encoding: 'utf8',
          })).stdout)
          .digest('hex')
    return Object.freeze({
      provider: 'ffprobe' as const,
      version: 'json-v1' as const,
      binaryDigest,
    })
  })()
  producerCache.set(binary, pending)
  pending.catch(() => producerCache.delete(binary))
  return pending
}

/**
 * Measures the duration of an audio-only file with real ffprobe. Fails
 * closed when the file has no audio stream or no positive duration.
 */
export async function probeAudioDurationSeconds(
  filePath: string,
  options: { timeoutMs?: number; signal?: AbortSignal; environment?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  if (!isAbsolute(filePath)) {
    throw new DomainError('INVALID_ARGUMENT', 'Audio probe path must be absolute')
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const binary = resolveBinary(options.environment ?? process.env)
  let stdout: string
  try {
    ({ stdout } = await execFileAsync(binary, [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_type,codec_name,duration',
      '-of', 'json',
      filePath,
    ], { windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, signal: options.signal, encoding: 'utf8' }))
  } catch {
    throw new DomainError('RENDER_OUTPUT_INVALID', 'Audio probe failed')
  }
  let payload: { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> }
  try {
    payload = JSON.parse(stdout) as typeof payload
  } catch {
    throw new DomainError('RENDER_OUTPUT_INVALID', 'Audio probe returned invalid JSON')
  }
  const audio = payload.streams?.find((stream) => stream.codec_type === 'audio')
  const duration = positiveNumber(payload.format?.duration) || positiveNumber(audio?.duration)
  if (!audio || !duration) {
    throw new DomainError('RENDER_OUTPUT_INVALID', 'Audio probe found no measurable audio stream')
  }
  return duration
}

export async function probeVideo(
  filePath: string,
  options: {
    timeoutMs?: number
    signal?: AbortSignal
    environment?: NodeJS.ProcessEnv
    requireAudio?: boolean
  } = {},
): Promise<Readonly<VideoProbeResult>> {
  if (!isAbsolute(filePath)) {
    throw new DomainError('INVALID_ARGUMENT', 'Video probe path must be absolute')
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10 * 60_000) {
    throw new DomainError('INVALID_ARGUMENT', 'Video probe timeout is invalid')
  }
  if (options.signal?.aborted) {
    throw new DomainError('RENDER_EXECUTION_FAILED', 'Video probe was cancelled')
  }

  let stdout: string
  let producer: Awaited<ReturnType<typeof describeProducer>>
  const binary = resolveBinary(options.environment ?? process.env)
  try {
    const [result, descriptor] = await Promise.all([
      execFileAsync(binary, [
        '-v', 'error',
        '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,duration,pix_fmt,bits_per_raw_sample,color_space,color_transfer,color_primaries,color_range',
        '-of', 'json',
        filePath,
      ], {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        signal: options.signal,
        encoding: 'utf8',
      }),
      describeProducer(binary),
    ])
    stdout = result.stdout
    producer = descriptor
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const message = code === 'ABORT_ERR'
      ? 'Video probe was cancelled'
      : code === 'ETIMEDOUT'
        ? 'Video probe exceeded its timeout'
        : 'Video probe failed'
    throw new DomainError('RENDER_OUTPUT_INVALID', message)
  }

  let payload: {
    streams?: Array<Record<string, unknown>>
    format?: Record<string, unknown>
  }
  try {
    payload = JSON.parse(stdout) as typeof payload
  } catch {
    throw new DomainError('RENDER_OUTPUT_INVALID', 'Video probe returned invalid JSON')
  }
  const video = payload.streams?.find((stream) => stream.codec_type === 'video')
  const audio = payload.streams?.find((stream) => stream.codec_type === 'audio')
  const width = positiveNumber(video?.width)
  const height = positiveNumber(video?.height)
  const fps = parseRate(video?.avg_frame_rate) || parseRate(video?.r_frame_rate)
  const duration = positiveNumber(payload.format?.duration) || positiveNumber(video?.duration)
  const codec = typeof video?.codec_name === 'string' ? video.codec_name.trim() : ''
  const audioCodec = typeof audio?.codec_name === 'string' ? audio.codec_name.trim() : ''
  const formatName = typeof payload.format?.format_name === 'string'
    ? payload.format.format_name.trim()
    : ''
  const requireAudio = options.requireAudio ?? true
  if (
    !width ||
    !height ||
    !fps ||
    !duration ||
    !codec ||
    (requireAudio && !audioCodec) ||
    !formatName
  ) {
    throw new DomainError('RENDER_OUTPUT_INVALID', 'Video probe metadata is incomplete')
  }
  return Object.freeze({
    width,
    height,
    fps,
    duration,
    codec,
    audioCodec,
    container: formatName,
    color: detectedColor(video!),
    producer,
  })
}

export interface UploadedMediaInspection extends MediaIngestDecision {
  sourcePath: string
}

export async function inspectUploadedMedia(
  filePath: string,
  upload: Readonly<MediaUpload>,
  options: { signal?: AbortSignal; environment?: NodeJS.ProcessEnv } = {},
): Promise<Readonly<UploadedMediaInspection>> {
  if (!isAbsolute(filePath)) throw new DomainError('INVALID_ARGUMENT', 'Media inspection path must be absolute')
  let handle
  try {
    handle = await open(filePath, 'r')
    const prefix = Buffer.alloc(64)
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0)
    const media = sniffMediaInput({
      filename: upload.fileName ?? `upload.${upload.mimeType.split('/')[1] ?? 'bin'}`,
      declaredMime: upload.mimeType,
      bytes: prefix.subarray(0, bytesRead),
      byteSize: Number(upload.byteSize),
    })
    let probe
    if (media.kind === 'video') {
      const video = await probeVideo(filePath, { signal: options.signal, environment: options.environment, requireAudio: true })
      probe = { codec: video.codec, duration: video.duration, width: video.width, height: video.height }
    } else {
      const binary = resolveBinary(options.environment ?? process.env)
      const { stdout } = await execFileAsync(binary, [
        '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,duration', '-of', 'json', filePath,
      ], { windowsHide: true, timeout: DEFAULT_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, signal: options.signal, encoding: 'utf8' })
      const payload = JSON.parse(stdout) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> }
      const stream = payload.streams?.find((item) => item.codec_type === (media.kind === 'audio' ? 'audio' : 'video'))
      probe = media.kind === 'audio'
        ? { codec: token(stream?.codec_name) ?? '', duration: positiveNumber(payload.format?.duration) || positiveNumber(stream?.duration) }
        : { codec: token(stream?.codec_name) ?? '', width: positiveNumber(stream?.width), height: positiveNumber(stream?.height) }
    }
    const decision = evaluateMediaProbe(media, probe)
    return Object.freeze({ ...decision, sourcePath: filePath })
  } catch (error) {
    if (error instanceof DomainError && error.code === 'INVALID_ARGUMENT') {
      return Object.freeze({
        status: 'quarantined' as const,
        sourcePath: filePath,
        media: Object.freeze({ kind: upload.kind, mimeType: upload.mimeType, extension: upload.fileName?.split('.').pop()?.toLowerCase() ?? 'unknown' }),
        error: Object.freeze({
          code: 'CORRUPT_OR_MISMATCHED_MEDIA',
          message: 'A assinatura, a extensão e o MIME do arquivo não correspondem ou o conteúdo está corrompido.',
          action: 'Reexporte o arquivo no formato indicado pela extensão e tente novamente.',
        }),
      })
    }
    if ((error as NodeJS.ErrnoException).name === 'AbortError') throw error
    return Object.freeze({
      status: 'quarantined' as const,
      sourcePath: filePath,
      media: Object.freeze({ kind: upload.kind, mimeType: upload.mimeType, extension: upload.fileName?.split('.').pop()?.toLowerCase() ?? 'unknown' }),
      error: Object.freeze({
        code: 'MEDIA_PROBE_FAILED',
        message: 'Não foi possível validar codec, duração ou dimensões da mídia.',
        action: 'Reexporte o arquivo com um codec suportado e tente novamente.',
      }),
    })
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

import { type OwnedFfmpegExecutor } from './ffmpeg-owned-process.ts'
import type { OwnedDeadlineIo } from './ffmpeg-owned-io.ts'
import { decimalSeconds, validateOutputObservedProbeV3, type OutputObservedProbeV3 } from '../../domain/output-materialization.ts'

/** Full source sequence. The existing lightweight probe API stays unchanged.
 * No native-frame ordinal is synthesized from avg_frame_rate. */

export interface OwnedMediaProbeObservationV3 {
  probe:Readonly<OutputObservedProbeV3>
  executable:string
  argv:readonly string[]
  spawnObserved:true
  closeObserved:true
  exitCode:0
}
export async function observeMediaFramesV3(filePath:string,input:Readonly<{
  mediaType:'video'|'audio';operationId:string;executor:OwnedFfmpegExecutor;io:OwnedDeadlineIo;deadlineMonotonicMs:number;
  signal?:AbortSignal;environment?:NodeJS.ProcessEnv
}>):Promise<Readonly<OwnedMediaProbeObservationV3>> {
  if(!isAbsolute(filePath))throw new DomainError('INVALID_ARGUMENT','Observed source path must be absolute')
  const binary=resolveBinary(input.environment??process.env)
  if(!isAbsolute(binary))throw new DomainError('PERSISTENCE_NOT_CONFIGURED','Observed probe needs an exact binary file')
  const before=await input.io.hashFile(binary,256*1024*1024)
  const argv=['-v','error','-show_entries',
    'format=start_time,duration,format_name:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,time_base,start_pts,start_time,duration_ts,duration,sample_rate,channels,pix_fmt,bits_per_raw_sample,color_space,color_transfer,color_primaries,color_range:stream_tags=rotate:stream_side_data=rotation,displaymatrix:frame=media_type,stream_index,best_effort_timestamp,duration,pkt_duration,nb_samples',
    '-show_streams','-show_frames','-show_format','-of','json',filePath]
  const result=await input.executor.execute({executable:binary,args:argv,
    owner:{runId:input.operationId,operation:'normalization-frame-probe'},signal:input.signal,
    deadlineMonotonicMs:input.deadlineMonotonicMs,timeoutMs:60000,maxOutputBytes:64*1024*1024})
  const after=await input.io.hashFile(binary,256*1024*1024)
  if(before.sha256!==after.sha256||before.byteSize!==after.byteSize)
    throw new DomainError('PERSISTENCE_CONFLICT','Observed probe binary changed during execution')
  const rawJson=result.stdout.toString('utf8')
  const raw=JSON.parse(rawJson) as {streams:Record<string,unknown>[];frames:Record<string,unknown>[];format:{start_time:string}}
  const candidates=raw.streams?.filter(s=>s.codec_type===input.mediaType)
  if(!candidates?.length)throw new DomainError('RENDER_OUTPUT_INVALID','Observed source stream missing')
  const stream=candidates[0],selected=raw.frames?.filter(f=>f.media_type===input.mediaType&&f.stream_index===stream.index)
  if(!selected?.length)throw new DomainError('RENDER_OUTPUT_INVALID','Observed source frame sequence missing')
  const split=(value:unknown)=>{if(typeof value!=='string'||!/^\d+\/\d+$/.test(value))
    throw new DomainError('RENDER_OUTPUT_INVALID','Observed source rational missing')
    const [numerator,denominator]=value.split('/');return {numerator,denominator}}
  const timeBase=split(stream.time_base),fps=input.mediaType==='video'?split(stream.avg_frame_rate):null
  const rotations=(stream.side_data_list as {rotation?:unknown}[]|undefined)?.filter(s=>s.rotation!==undefined).map(s=>Number(s.rotation))??[]
  const rotateTag=(stream.tags as {rotate?:unknown}|undefined)?.rotate
  if(rotateTag!==undefined)rotations.push(Number(rotateTag))
  const frames=selected.map((f,frame)=>{
    if(typeof f.best_effort_timestamp==='number'&&!Number.isSafeInteger(f.best_effort_timestamp))
      throw new DomainError('RENDER_OUTPUT_INVALID','Observed PTS is unsafe after JSON decoding')
    return {frame,pts:String(f.best_effort_timestamp),timeBase}
  })
  const frameEndPts=selected.map((f,i)=>{
    const duration=f.duration??f.pkt_duration
    if(typeof duration==='number'&&!Number.isSafeInteger(duration)||!/^\d+$/.test(String(duration))||BigInt(String(duration))<=BigInt(0))
      throw new DomainError('RENDER_OUTPUT_INVALID','Observed frame duration missing or unsafe')
    return (BigInt(frames[i]!.pts)+BigInt(String(duration))).toString()
  })
  const last=selected[selected.length-1],duration=last.duration??last.pkt_duration
  if(typeof duration==='number'&&!Number.isSafeInteger(duration)||!/^\d+$/.test(String(duration)))
    throw new DomainError('RENDER_OUTPUT_INVALID','Observed last-frame duration missing or unsafe')
  const probe=validateOutputObservedProbeV3({schemaVersion:'output-observed-probe/v3',binarySha256:before.sha256,
    rawJson,rawSha256:createHash('sha256').update(result.stdout).digest('hex'),streamIndex:Number(stream.index),
    mediaType:input.mediaType,sampleRateHz:input.mediaType==='audio'?Number(stream.sample_rate):null,
    channels:input.mediaType==='audio'?Number(stream.channels):null,
    originSource:typeof raw.format?.start_time==='string'?'format-start-time':'stream-start-time',
    originSeconds:decimalSeconds(typeof raw.format?.start_time==='string'?raw.format.start_time:stream.start_time as string),
    width:input.mediaType==='video'?Number(stream.width):0,height:input.mediaType==='video'?Number(stream.height):0,
    fps,rotationDegrees:rotations[0]??0,timeBase,frames,frameEndPts,endPts:(BigInt(frames[frames.length-1].pts)+BigInt(String(duration))).toString()})
  if(!result.spawnObserved||!result.closeObserved||result.exitCode!==0||result.signal)
    throw new DomainError('RENDER_OUTPUT_INVALID','Observed probe did not close successfully')
  return Object.freeze({probe,executable:binary,argv:Object.freeze(argv),spawnObserved:true,closeObserved:true,exitCode:0})
}

export function videoMetadataFromObservedProbeV3(observed:Readonly<OutputObservedProbeV3>):Readonly<VideoProbeResult> {
  const raw=JSON.parse(observed.rawJson) as {streams:Record<string,unknown>[];format?:Record<string,unknown>}
  const video=raw.streams.find(s=>s.index===observed.streamIndex)!,audio=raw.streams.find(s=>s.codec_type==='audio')
  const duration=positiveNumber(raw.format?.duration)||positiveNumber(video.duration)
  const codec=token(video.codec_name),audioCodec=token(audio?.codec_name)
  const container=typeof raw.format?.format_name==='string'?raw.format.format_name.trim():''
  if(!duration||!codec||!audioCodec||!container)throw new DomainError('RENDER_OUTPUT_INVALID','Observed ingest metadata incomplete')
  return Object.freeze({width:observed.width,height:observed.height,fps:Number(observed.fps!.numerator)/Number(observed.fps!.denominator),
    duration,codec,audioCodec,container,color:detectedColor(video),
    producer:{provider:'ffprobe' as const,version:'json-v1' as const,binaryDigest:observed.binarySha256}})
}

/** Audio shares the exact same full ffprobe stdout already authenticated by the
 * observed video record. This projects a different stream, not another clock or
 * a guessed duration and does not launch another process. */
export function observedAudioFromVideoProbeV3(video:Readonly<OutputObservedProbeV3>):Readonly<OutputObservedProbeV3>|null {
  const raw=JSON.parse(video.rawJson) as {streams:Record<string,unknown>[];frames:Record<string,unknown>[];format?:{start_time?:string}}
  const stream=raw.streams.find(s=>s.codec_type==='audio')
  if(!stream)return null
  const frameData=raw.frames.filter(f=>f.media_type==='audio'&&f.stream_index===stream.index)
  if(!frameData.length)throw new DomainError('RENDER_OUTPUT_INVALID','Observed audio stream has no full frame sequence')
  const tb=String(stream.time_base).split('/')
  const timeBase={numerator:tb[0],denominator:tb[1]},last=frameData[frameData.length-1],duration=last.duration??last.pkt_duration
  if(typeof duration==='number'&&!Number.isSafeInteger(duration)||!/^\d+$/.test(String(duration)))
    throw new DomainError('RENDER_OUTPUT_INVALID','Observed audio terminal duration unsafe')
  const frames=frameData.map((f,frame)=>{
    if(typeof f.best_effort_timestamp==='number'&&!Number.isSafeInteger(f.best_effort_timestamp))
      throw new DomainError('RENDER_OUTPUT_INVALID','Observed audio timestamp unsafe')
    return {frame,pts:String(f.best_effort_timestamp),timeBase}
  })
  const frameEndPts=frameData.map((f,i)=>{
    const duration=f.duration??f.pkt_duration
    if(typeof duration==='number'&&!Number.isSafeInteger(duration)||!/^\d+$/.test(String(duration))||BigInt(String(duration))<=BigInt(0))
      throw new DomainError('RENDER_OUTPUT_INVALID','Observed audio frame duration unsafe')
    return (BigInt(frames[i]!.pts)+BigInt(String(duration))).toString()
  })
  return validateOutputObservedProbeV3({schemaVersion:'output-observed-probe/v3',binarySha256:video.binarySha256,
    rawJson:video.rawJson,rawSha256:video.rawSha256,streamIndex:Number(stream.index),mediaType:'audio',
    sampleRateHz:Number(stream.sample_rate),channels:Number(stream.channels),fps:null,width:0,height:0,rotationDegrees:0,
    originSource:typeof raw.format?.start_time==='string'?'format-start-time':'stream-start-time',
    originSeconds:decimalSeconds(typeof raw.format?.start_time==='string'?raw.format.start_time:stream.start_time as string),
    timeBase,frames,frameEndPts,endPts:(BigInt(frames[frames.length-1].pts)+BigInt(String(duration))).toString()})
}
