import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import type { EditorialProxyRenderer } from '../../application/ports/editorial-proxy-renderer.ts'
import { DomainError } from '../../domain/errors.ts'
import { calculateFileSha256 } from './local-artifact-manifest.ts'
import { probeVideo } from './video-probe.ts'

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
  const fontSize = Math.max(32, Math.min(72, Math.round(input.width * 0.059)))
  const marginHorizontal = Math.round(input.width * 0.07)
  const marginVertical = Math.round(input.height * 0.075)
  const events = input.cues.map((cue) =>
    `Dialogue: 0,${assTimestamp(cue.startFrame, input.fps)},${assTimestamp(cue.endFrame, input.fps)},Default,,0,0,0,,${wrapAssText(cue.text)}`,
  )
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

  constructor(options: { workRoot: string; ffmpegPath?: string }) {
    this.workRoot = resolve(options.workRoot)
    this.ffmpegPath = options.ffmpegPath?.trim() || ffmpegStatic || 'ffmpeg'
  }

  private directory(operationId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(operationId)) throw new DomainError('INVALID_ARGUMENT', 'operationId is invalid')
    const directory = join(this.workRoot, operationId)
    assertContained(this.workRoot, directory)
    return directory
  }

  async render(input: Parameters<EditorialProxyRenderer['render']>[0]) {
    if (!isAbsolute(input.sourcePath) || !Number.isFinite(input.fps) || input.fps <= 0 || input.clips.length < 1) throw new DomainError('INVALID_RENDER_INPUT', 'Editorial proxy render input is invalid')
    const dimensions = input.renderKind === 'final' && input.outputSpec
      ? [input.outputSpec.width, input.outputSpec.height] as const
      : FORMAT_DIMENSIONS[input.format]
    if (!dimensions) throw new DomainError('INVALID_RENDER_INPUT', 'Editorial proxy format is not supported')
    if (
      input.renderKind === 'final' && (
        !input.outputSpec || input.outputSpec.fps !== input.fps ||
        !Number.isSafeInteger(input.outputSpec.width) || input.outputSpec.width <= 0 || input.outputSpec.width % 2 !== 0 ||
        !Number.isSafeInteger(input.outputSpec.height) || input.outputSpec.height <= 0 || input.outputSpec.height % 2 !== 0
      )
    ) throw new DomainError('INVALID_RENDER_INPUT', 'Final editorial output spec is invalid')
    const directory = this.directory(input.operationId)
    const outputPath = join(directory, input.renderKind === 'final' ? 'editorial-final.mp4' : 'editorial-proxy.mp4')
    const subtitlePath = join(directory, 'captions.ass')
    await mkdir(directory, { recursive: true })
    await rm(outputPath, { force: true })
    const filters: string[] = []
    input.clips.forEach((clip, index) => {
      const start = clip.sourceInFrame / input.fps
      const end = clip.sourceOutFrame / input.fps
      filters.push(`[0:v:0]trim=start_frame=${clip.sourceInFrame}:end_frame=${clip.sourceOutFrame},setpts=PTS-STARTPTS[v${index}]`)
      const duration = end - start
      const before = input.transitions?.find((transition) => transition.toClipId === clip.id)
      const after = input.transitions?.find((transition) => transition.fromClipId === clip.id)
      const fadeIn = before ? Math.min(duration / 4, before.audioFadeMs / 1000) : 0
      const fadeOut = after ? Math.min(duration / 4, after.audioFadeMs / 1000) : 0
      const audioFilters = [`atrim=start=${start.toFixed(6)}:end=${end.toFixed(6)}`, 'asetpts=PTS-STARTPTS']
      if (fadeIn > 0) audioFilters.push(`afade=t=in:st=0:d=${fadeIn.toFixed(6)}`)
      if (fadeOut > 0) audioFilters.push(`afade=t=out:st=${Math.max(0, duration - fadeOut).toFixed(6)}:d=${fadeOut.toFixed(6)}`)
      filters.push(`[0:a:0]${audioFilters.join(',')}[a${index}]`)
    })
    const concatInputs = input.clips.map((_, index) => `[v${index}][a${index}]`).join('')
    filters.push(`${concatInputs}concat=n=${input.clips.length}:v=1:a=1[joinedv][outa]`)
    const [width, height] = dimensions
    filters.push(`[joinedv]split=2[background0][foreground0]`)
    filters.push(`[background0]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=28[background]`)
    filters.push(`[foreground0]scale=${width}:${height}:force_original_aspect_ratio=decrease[foreground]`)
    filters.push(`[background][foreground]overlay=(W-w)/2:(H-h)/2:shortest=1,format=yuv420p[composed]`)
    if (input.subtitleCues?.length) {
      await writeFile(subtitlePath, buildAssSubtitles({ width, height, fps: input.fps, cues: input.subtitleCues }), 'utf8')
      filters.push(`[composed]subtitles=filename='${escapeSubtitleFilterPath(subtitlePath)}'[outv]`)
    } else filters.push('[composed]null[outv]')
    try {
      await execFileAsync(this.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', input.sourcePath,
        '-filter_complex', filters.join(';'), '-map', '[outv]', '-map', '[outa]',
        '-r', String(input.fps), '-c:v', 'libx264', '-preset', input.renderKind === 'final' ? 'medium' : 'veryfast', '-crf', input.renderKind === 'final' ? '18' : '23',
        '-c:a', 'aac', '-b:a', input.renderKind === 'final' ? '192k' : '160k', '-ar', '48000', '-movflags', '+faststart', outputPath,
      ], { windowsHide: true, timeout: 30 * 60_000, maxBuffer: 2 * 1024 * 1024, signal: input.signal })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      throw new DomainError('RENDER_EXECUTION_FAILED', code === 'ABORT_ERR' ? 'Editorial proxy render was cancelled' : 'Editorial proxy render failed')
    }
    const [metadata, sha256, probe] = await Promise.all([stat(outputPath), calculateFileSha256(outputPath), probeVideo(outputPath, { signal: input.signal })])
    const expectedFrames = input.clips.reduce((total, clip) => total + clip.sourceOutFrame - clip.sourceInFrame, 0)
    if (!metadata.isFile() || metadata.size <= 0 || Math.abs(probe.duration * input.fps - expectedFrames) > 3 || probe.width !== width || probe.height !== height) {
      throw new DomainError('RENDER_OUTPUT_INVALID', 'Editorial proxy failed timing or dimension verification')
    }
    return Object.freeze({ outputPath, sha256, byteSize: metadata.size, probe })
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
