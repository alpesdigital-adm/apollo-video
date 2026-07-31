import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import type { EditorialProxyRenderer } from '../../application/ports/editorial-proxy-renderer.ts'
import { DomainError } from '../../domain/errors.ts'
import { buildRenderElementMap } from '../../domain/review-system.ts'
import { calculateFileSha256 } from './local-artifact-manifest.ts'
import { probeVideo } from './video-probe.ts'
import { FfmpegColorPipelineProcessor } from './ffmpeg-color-pipeline-processor.ts'

const require = createRequire(import.meta.url)
const ffmpegStatic = require('ffmpeg-static') as string | null
const execFileAsync = promisify(execFile)

const FORMAT_DIMENSIONS: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  '9:16': [540, 960] as const,
  '16:9': [960, 540] as const,
  '4:5': [640, 800] as const,
  '1:1': [720, 720] as const,
  '21:9': [1050, 450] as const,
})

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new DomainError('PERSISTENCE_CONFLICT', 'Editorial render work path escaped its root')
}

function assTimestamp(frame: number, fps: number): string {
  const centiseconds = Math.max(0, Math.round(frame / fps * 100))
  const hours = Math.floor(centiseconds / 360_000)
  const minutes = Math.floor(centiseconds % 360_000 / 6_000)
  const seconds = Math.floor(centiseconds % 6_000 / 100)
  const fraction = centiseconds % 100
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(fraction).padStart(2, '0')}`
}

function wrapAssText(value: string, maxCharacters = 20): string {
  const lines: string[] = []
  let line = ''
  for (const word of value.replace(/[{}\\]/g, '').split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word
    if (line && candidate.length > maxCharacters && lines.length === 0) {
      lines.push(line)
      line = word
    } else line = candidate
  }
  if (line) lines.push(line)
  return lines.slice(0, 2).join('\\N')
}

function buildAssSubtitles(input: {
  width: number
  height: number
  fps: number
  cues: NonNullable<Parameters<EditorialProxyRenderer['render']>[0]['subtitleCues']>
}): string {
  const fontSize = Math.max(
    32,
    Math.min(
      72,
      Math.round(Math.min(input.width * 0.059, input.height * 0.067)),
    ),
  )
  const marginHorizontal = Math.round(input.width * 0.07)
  const marginVertical = Math.round(input.height * 0.075)
  const events = input.cues.map((cue) => {
    const anchor = cue.anchor ?? 'bottom'
    const override = anchor === 'bottom' ? ''
      : anchor === 'lower-third' ? `{\\an2\\pos(${Math.round(input.width / 2)},${Math.round(input.height * 0.76)})}`
        : anchor === 'center' ? `{\\an5\\pos(${Math.round(input.width / 2)},${Math.round(input.height * 0.5)})}`
          : anchor === 'upper-third' ? `{\\an8\\pos(${Math.round(input.width / 2)},${Math.round(input.height * 0.3)})}`
            : `{\\an8\\pos(${Math.round(input.width / 2)},${Math.round(input.height * 0.08)})}`
    return `Dialogue: 0,${assTimestamp(cue.startFrame, input.fps)},${assTimestamp(cue.endFrame, input.fps)},Default,,0,0,0,,${override}${wrapAssText(cue.text)}`
  })
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${input.width}`,
    `PlayResY: ${input.height}`,
    '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    `Style: Default,Arial,${fontSize},&H00FFFFFF,&H0038AFE1,&H00111111,&H78000000,-1,0,0,0,100,100,0,0,3,1,0,2,${marginHorizontal},${marginHorizontal},${marginVertical},1`,
    '',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
    ...events,
    '',
  ].join('\n')
}

function escapeSubtitleFilterPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

export class FfmpegEditorialProxyRenderer implements EditorialProxyRenderer {
  private readonly workRoot: string
  private readonly ffmpegPath: string
  private readonly colorProcessor: FfmpegColorPipelineProcessor

  constructor(options: { workRoot: string; ffmpegPath?: string }) {
    this.workRoot = resolve(options.workRoot)
    this.ffmpegPath = options.ffmpegPath?.trim() || ffmpegStatic || 'ffmpeg'
    this.colorProcessor = new FfmpegColorPipelineProcessor({ ffmpegPath: this.ffmpegPath })
  }

  private directory(operationId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(operationId)) throw new DomainError('INVALID_ARGUMENT', 'operationId is invalid')
    const directory = join(this.workRoot, operationId)
    assertContained(this.workRoot, directory)
    return directory
  }

  async render(input: Parameters<EditorialProxyRenderer['render']>[0]) {
    if (
      !Number.isFinite(input.fps) ||
      input.fps <= 0 ||
      input.clips.length < 1 ||
      input.sources.length < 1 ||
      input.sources.length > 128 ||
      new Set(input.sources.map((source) => source.artifactId)).size !== input.sources.length ||
      input.sources.some((source) =>
        !isAbsolute(source.path) ||
        !['video', 'audio'].includes(source.mediaType) ||
        (source.mediaType === 'video') !== Boolean(source.colorPipelineCompilation))
    ) throw new DomainError('INVALID_RENDER_INPUT', 'Editorial proxy render input is invalid')
    const directory = this.directory(input.operationId)
    await mkdir(directory, { recursive: true })
    const renderSources = await Promise.all(input.sources.map(async (source, index) => {
      if (source.mediaType !== 'video') return source
      const outputPath = join(directory, `color-source-${String(index).padStart(3, '0')}.mp4`)
      await rm(outputPath, { force: true })
      await this.colorProcessor.process({
        sourcePath: source.path,
        outputPath,
        compilation: source.colorPipelineCompilation!,
        lutPaths: input.lutPaths,
        signal: input.signal,
      })
      return Object.freeze({ ...source, path: outputPath })
    }))
    const sourceIndex = new Map(
      renderSources.map((source, index) => [source.artifactId, index]),
    )
    for (const clip of input.clips) {
      const video = renderSources[sourceIndex.get(clip.sourceArtifactId) ?? -1]
      const audioArtifactId = clip.audioSourceArtifactId ?? clip.sourceArtifactId
      const audio = renderSources[sourceIndex.get(audioArtifactId) ?? -1]
      const audioInFrame = clip.audioSourceInFrame ?? clip.sourceInFrame
      const audioOutFrame = clip.audioSourceOutFrame ?? clip.sourceOutFrame
      if (
        !video ||
        video.mediaType !== 'video' ||
        !audio ||
        !Number.isSafeInteger(clip.sourceInFrame) ||
        !Number.isSafeInteger(clip.sourceOutFrame) ||
        clip.sourceInFrame < 0 ||
        clip.sourceOutFrame <= clip.sourceInFrame ||
        !Number.isSafeInteger(audioInFrame) ||
        !Number.isSafeInteger(audioOutFrame) ||
        audioInFrame < 0 ||
        audioOutFrame <= audioInFrame ||
        audioOutFrame - audioInFrame !== clip.sourceOutFrame - clip.sourceInFrame
      ) {
        throw new DomainError(
          'INVALID_RENDER_INPUT',
          'Editorial clip source binding is invalid',
        )
      }
    }
    const dimensions = input.renderKind === 'final' && input.outputSpec
      ? [input.outputSpec.width, input.outputSpec.height] as const
      : FORMAT_DIMENSIONS[input.format]
    if (!dimensions) throw new DomainError('INVALID_RENDER_INPUT', 'Editorial proxy format is not supported')
    if (
      input.renderKind === 'final' && (
        !input.outputSpec ||
        Math.abs(input.outputSpec.fps - input.fps) > 0.01 ||
        !Number.isSafeInteger(input.outputSpec.width) || input.outputSpec.width <= 0 || input.outputSpec.width % 2 !== 0 ||
        !Number.isSafeInteger(input.outputSpec.height) || input.outputSpec.height <= 0 || input.outputSpec.height % 2 !== 0
      )
    ) throw new DomainError('INVALID_RENDER_INPUT', 'Final editorial output spec is invalid')
    const outputFps = input.renderKind === 'final'
      ? input.outputSpec!.fps
      : input.fps
    const videoSources = renderSources.filter(
      (source) => source.mediaType === 'video',
    )
    const videoProbes = await Promise.all(
      videoSources.map(async (source) => ({
        artifactId: source.artifactId,
        probe: await probeVideo(source.path, {
          signal: input.signal,
          requireAudio: false,
        }),
      })),
    )
    const stagingProbe = videoProbes.toSorted(
      (left, right) =>
        right.probe.width * right.probe.height -
        left.probe.width * left.probe.height,
    )[0]?.probe
    if (!stagingProbe) {
      throw new DomainError(
        'INVALID_RENDER_INPUT',
        'Editorial render requires at least one probed video source',
      )
    }
    const stagingWidth = stagingProbe.width
    const stagingHeight = stagingProbe.height
    const outputPath = join(directory, input.renderKind === 'final' ? 'editorial-final.mp4' : 'editorial-proxy.mp4')
    const subtitlePath = join(directory, 'captions.ass')
    await rm(outputPath, { force: true })
    const filters: string[] = []
    input.clips.forEach((clip, index) => {
      const videoIndex = sourceIndex.get(clip.sourceArtifactId)!
      const audioIndex = sourceIndex.get(
        clip.audioSourceArtifactId ?? clip.sourceArtifactId,
      )!
      const audioInFrame = clip.audioSourceInFrame ?? clip.sourceInFrame
      const audioOutFrame = clip.audioSourceOutFrame ?? clip.sourceOutFrame
      const audioStart = audioInFrame / input.fps
      const audioEnd = audioOutFrame / input.fps
      filters.push(
        `[${videoIndex}:v:0]trim=start_frame=${clip.sourceInFrame}:end_frame=${clip.sourceOutFrame},` +
        `setpts=PTS-STARTPTS,scale=${stagingWidth}:${stagingHeight}:force_original_aspect_ratio=decrease,` +
        `pad=${stagingWidth}:${stagingHeight}:(ow-iw)/2:(oh-ih)/2:color=black,` +
        `fps=${outputFps},setsar=1,format=yuv420p[v${index}]`,
      )
      const duration = audioEnd - audioStart
      const before = input.transitions?.find((transition) => transition.toClipId === clip.id)
      const after = input.transitions?.find((transition) => transition.fromClipId === clip.id)
      const fadeIn = before ? Math.min(duration / 4, before.audioFadeMs / 1000) : 0
      const fadeOut = after ? Math.min(duration / 4, after.audioFadeMs / 1000) : 0
      const audioFilters = [`atrim=start=${audioStart.toFixed(6)}:end=${audioEnd.toFixed(6)}`, 'asetpts=PTS-STARTPTS']
      if (fadeIn > 0) audioFilters.push(`afade=t=in:st=0:d=${fadeIn.toFixed(6)}`)
      if (fadeOut > 0) audioFilters.push(`afade=t=out:st=${Math.max(0, duration - fadeOut).toFixed(6)}:d=${fadeOut.toFixed(6)}`)
      filters.push(`[${audioIndex}:a:0]${audioFilters.join(',')}[a${index}]`)
    })
    const concatInputs = input.clips.map((_, index) => `[v${index}][a${index}]`).join('')
    filters.push(`${concatInputs}concat=n=${input.clips.length}:v=1:a=1[joinedv][joineda]`)
    filters.push(
      '[joineda]alimiter=limit=0.794328:attack=5:release=50:level=false:latency=true[outa]',
    )
    const [width, height] = dimensions
    filters.push(`[joinedv]split=2[background0][foreground0]`)
    filters.push(`[background0]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=28[background]`)
    const foregroundScale = input.composition?.foregroundScale ?? 1
    const verticalPosition = input.composition?.verticalPosition ?? 0.5
    filters.push(`[foreground0]scale=${width}:${height}:force_original_aspect_ratio=decrease,scale=iw*${foregroundScale.toFixed(4)}:ih*${foregroundScale.toFixed(4)}[foreground]`)
    filters.push(`[background][foreground]overlay=(W-w)/2:max(0\\,min(H-h\\,H*${verticalPosition.toFixed(4)}-h/2)):shortest=1,format=yuv420p[composed]`)
    if (input.subtitleCues?.length) {
      await writeFile(
        subtitlePath,
        buildAssSubtitles({
          width,
          height,
          fps: outputFps,
          cues: input.subtitleCues,
        }),
        'utf8',
      )
      filters.push(`[composed]subtitles=filename='${escapeSubtitleFilterPath(subtitlePath)}'[outv]`)
    } else filters.push('[composed]null[outv]')
    try {
      await execFileAsync(this.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y',
        ...renderSources.flatMap((source) => ['-i', source.path]),
        '-filter_complex', filters.join(';'), '-map', '[outv]', '-map', '[outa]',
        '-r', String(outputFps), '-c:v', 'libx264', '-preset', input.renderKind === 'final' ? 'medium' : 'veryfast', '-crf', input.renderKind === 'final' ? '18' : '23',
        '-c:a', 'aac', '-b:a', input.renderKind === 'final' ? '192k' : '160k', '-ar', '48000', '-movflags', '+faststart', outputPath,
      ], { windowsHide: true, timeout: 30 * 60_000, maxBuffer: 2 * 1024 * 1024, signal: input.signal })
    } catch (error) {
      const processError = error as NodeJS.ErrnoException & {
        stderr?: string | Buffer
        killed?: boolean
        signal?: NodeJS.Signals
      }
      const stderr = typeof processError.stderr === 'string'
        ? processError.stderr
        : Buffer.isBuffer(processError.stderr)
          ? processError.stderr.toString('utf8')
          : ''
      const diagnostic = stderr
        .replaceAll(this.workRoot, '<render-work-root>')
        .slice(-8_000)
      throw new DomainError(
        'RENDER_EXECUTION_FAILED',
        processError.code === 'ABORT_ERR'
          ? 'Editorial proxy render was cancelled'
          : 'Editorial proxy render failed',
        {
          processCode: String(processError.code ?? 'unknown'),
          killed: processError.killed === true,
          signal: processError.signal ?? null,
          ...(diagnostic ? { stderr: diagnostic } : {}),
        },
      )
    }
    const [metadata, sha256, probe] = await Promise.all([
      stat(outputPath),
      calculateFileSha256(outputPath),
      probeVideo(outputPath, { signal: input.signal }),
    ])
    const expectedFrames = input.clips.reduce((total, clip) => total + clip.sourceOutFrame - clip.sourceInFrame, 0)
    if (!metadata.isFile() || metadata.size <= 0 || Math.abs(probe.duration * input.fps - expectedFrames) > 3 || probe.width !== width || probe.height !== height) {
      throw new DomainError('RENDER_OUTPUT_INVALID', 'Editorial proxy failed timing or dimension verification')
    }
    const renderElementMap = buildRenderElementMap({
      proxyHash: sha256,
      fps: outputFps,
      durationFrames: expectedFrames,
      canvas: { width, height },
      source: { width: stagingProbe.width, height: stagingProbe.height },
      clips: input.clips,
      subtitleCues: input.subtitleCues,
      composition: input.composition,
    })
    return Object.freeze({ outputPath, sha256, byteSize: metadata.size, probe, renderElementMap })
  }

  async cleanup(operationId: string): Promise<void> {
    await rm(this.directory(operationId), { recursive: true, force: true })
  }
}

export function createFfmpegEditorialProxyRendererFromEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const root = environment.APOLLO_V2_ARTIFACT_ROOT?.trim()
  if (!root) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Artifact root is not configured')
  return new FfmpegEditorialProxyRenderer({ workRoot: join(resolve(root), '.work'), ...(environment.FFMPEG_PATH?.trim() ? { ffmpegPath: environment.FFMPEG_PATH.trim() } : {}) })
}
