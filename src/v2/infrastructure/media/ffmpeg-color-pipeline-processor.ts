import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'

import { calculateCanonicalHash } from '../../domain/canonical-hash.ts'
import type { ColorPipelineCompilation } from '../../domain/color-pipeline-compilation.ts'
import type { ColorMetadata, ColorTransform } from '../../domain/color-and-export.ts'
import { DomainError } from '../../domain/errors.ts'
import { calculateFileSha256 } from './local-artifact-manifest.ts'
import { probeVideo } from './video-probe.ts'

const require = createRequire(import.meta.url)
const ffmpegStatic = require('ffmpeg-static') as string | null
const execFileAsync = promisify(execFile)

function escapeFilterPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

function assertCompilation(value: Readonly<ColorPipelineCompilation>) {
  const { compilationHash, ...content } = value
  const { pipelineHash, manifestKey: _manifestKey, ...pipelineContent } = value.pipeline
  if (
    calculateCanonicalHash(content) !== compilationHash ||
    calculateCanonicalHash(pipelineContent) !== pipelineHash ||
    value.pipeline.stages.length !== 4 ||
    value.pipeline.stages.map((stage) => stage.kind).join('>') !==
      'technical>match>creative-lut>output'
  ) {
    throw new DomainError('INVALID_RENDER_INPUT', 'Color pipeline compilation failed integrity validation')
  }
}

function zscaleMetadata(metadata: Readonly<ColorMetadata>, prefix = '') {
  const primaries = metadata.primaries
  const transfer = metadata.transfer
  const matrix = metadata.matrix
  const range = metadata.range
  for (const [field, value] of Object.entries({ primaries, transfer, matrix, range })) {
    if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(value)) {
      throw new DomainError('INVALID_RENDER_INPUT', `Unsupported ${prefix}${field}`)
    }
  }
  return { primaries, transfer, matrix, range }
}

function zscale(stage: Readonly<ColorTransform>) {
  if (stage.implementation.provider !== 'ffmpeg-zscale') {
    throw new DomainError('INVALID_RENDER_INPUT', `${stage.kind} requires ffmpeg-zscale`)
  }
  const parameters = stage.implementation.parameters
  if (
    Object.keys(parameters).some((key) => !['mode', 'dither'].includes(key)) ||
    !['identity', 'convert'].includes(String(parameters.mode ?? 'convert'))
  ) {
    throw new DomainError('INVALID_RENDER_INPUT', `${stage.kind} has unsupported zscale parameters`)
  }
  if (!stage.enabled) return 'null'
  const input = zscaleMetadata(stage.input, 'input ')
  const output = zscaleMetadata(stage.output, 'output ')
  const dither = stage.implementation.parameters.dither === true
    ? ':dither=error_diffusion'
    : ''
  return `zscale=pin=${input.primaries}:tin=${input.transfer}:min=${input.matrix}:rin=${input.range}:p=${output.primaries}:t=${output.transfer}:m=${output.matrix}:r=${output.range}${dither}`
}

function match(stage: Readonly<ColorTransform>) {
  if (stage.implementation.provider !== 'apollo-match') {
    throw new DomainError('INVALID_RENDER_INPUT', 'match requires apollo-match')
  }
  const parameters = stage.implementation.parameters
  if (Object.keys(parameters).some((key) =>
    !['mode', 'brightness', 'contrast', 'saturation'].includes(key))) {
    throw new DomainError('INVALID_RENDER_INPUT', 'match has unsupported parameters')
  }
  if (!stage.enabled) {
    if (parameters.mode !== 'bypass') {
      throw new DomainError('INVALID_RENDER_INPUT', 'disabled match must be an explicit bypass')
    }
    return 'null'
  }
  if (parameters.mode !== 'adjust') {
    throw new DomainError('INVALID_RENDER_INPUT', 'enabled match must declare adjust mode')
  }
  const brightness = Number(parameters.brightness ?? 0)
  const contrast = Number(parameters.contrast ?? 1)
  const saturation = Number(parameters.saturation ?? 1)
  if (
    !Number.isFinite(brightness) || brightness < -1 || brightness > 1 ||
    !Number.isFinite(contrast) || contrast < 0.1 || contrast > 3 ||
    !Number.isFinite(saturation) || saturation < 0 || saturation > 3
  ) {
    throw new DomainError('INVALID_RENDER_INPUT', 'match parameters are outside safe bounds')
  }
  return `eq=brightness=${brightness.toFixed(6)}:contrast=${contrast.toFixed(6)}:saturation=${saturation.toFixed(6)}`
}

function creative(
  stage: Readonly<ColorTransform>,
  lutPaths: Readonly<Record<string, string>>,
) {
  if (stage.implementation.provider !== 'apollo-lut') {
    throw new DomainError('INVALID_RENDER_INPUT', 'creative LUT requires apollo-lut')
  }
  const parameters = stage.implementation.parameters
  if (Object.keys(parameters).some((key) => key !== 'mode')) {
    throw new DomainError('INVALID_RENDER_INPUT', 'creative LUT has unsupported parameters')
  }
  if (!stage.enabled) {
    if (parameters.mode !== 'none') {
      throw new DomainError('INVALID_RENDER_INPUT', 'disabled creative LUT must be explicit none')
    }
    return 'null'
  }
  if (parameters.mode !== 'lut3d') {
    throw new DomainError('INVALID_RENDER_INPUT', 'enabled creative LUT must declare lut3d mode')
  }
  const artifactId = stage.lut?.artifactId ?? ''
  const path = lutPaths[artifactId]
  if (!path || !isAbsolute(path)) {
    throw new DomainError('INVALID_RENDER_INPUT', 'Creative LUT was not materialized')
  }
  return `lut3d=file='${escapeFilterPath(path)}':interp=tetrahedral`
}

export function buildFfmpegColorPipelineFilter(input: {
  compilation: Readonly<ColorPipelineCompilation>
  lutPaths?: Readonly<Record<string, string>>
}) {
  assertCompilation(input.compilation)
  const [technical, matching, creativeLut, output] = input.compilation.pipeline.stages
  const filters = [
    zscale(technical),
    match(matching),
    creative(creativeLut, input.lutPaths ?? {}),
    zscale(output),
  ]
  const bitDepth = input.compilation.pipeline.outputMetadata.bitDepth
  if (![8, 10].includes(bitDepth)) {
    throw new DomainError('INVALID_RENDER_INPUT', 'FFmpeg color output bit depth is unsupported')
  }
  filters.push(`format=${bitDepth === 10 ? 'yuv420p10le' : 'yuv420p'}`)
  return Object.freeze({
    filter: filters.join(','),
    outputMetadata: input.compilation.pipeline.outputMetadata,
    pixelFormat: bitDepth === 10 ? 'yuv420p10le' : 'yuv420p',
  })
}

export class FfmpegColorPipelineProcessor {
  private readonly ffmpegPath: string

  constructor(options: { ffmpegPath?: string } = {}) {
    this.ffmpegPath = options.ffmpegPath?.trim() || ffmpegStatic || 'ffmpeg'
  }

  async process(input: {
    sourcePath: string
    outputPath: string
    compilation: Readonly<ColorPipelineCompilation>
    lutPaths?: Readonly<Record<string, string>>
    signal?: AbortSignal
  }) {
    if (!isAbsolute(input.sourcePath) || !isAbsolute(input.outputPath)) {
      throw new DomainError('INVALID_RENDER_INPUT', 'Color pipeline paths must be absolute')
    }
    const compiled = buildFfmpegColorPipelineFilter(input)
    const metadata = compiled.outputMetadata
    try {
      await execFileAsync(this.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', input.sourcePath,
        '-vf', compiled.filter,
        '-map', '0:v:0', '-map', '0:a?',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12',
        '-pix_fmt', compiled.pixelFormat,
        '-color_primaries', metadata.primaries,
        '-color_trc', metadata.transfer,
        '-colorspace', metadata.matrix,
        '-color_range', metadata.range === 'full' ? 'pc' : 'tv',
        '-c:a', 'copy', '-movflags', '+faststart', input.outputPath,
      ], {
        windowsHide: true,
        timeout: 10 * 60_000,
        maxBuffer: 4 * 1024 * 1024,
        signal: input.signal,
      })
    } catch (error) {
      throw new DomainError(
        'RENDER_EXECUTION_FAILED',
        (error as NodeJS.ErrnoException).code === 'ABORT_ERR'
          ? 'Color pipeline render was cancelled'
          : 'Color pipeline render failed',
      )
    }
    const [file, sha256, probe] = await Promise.all([
      stat(input.outputPath),
      calculateFileSha256(input.outputPath),
      probeVideo(input.outputPath, { signal: input.signal, requireAudio: false }),
    ])
    if (
      !file.isFile() || file.size <= 0 ||
      probe.color.state !== 'ready' ||
      calculateCanonicalHash(probe.color.metadata) !==
        calculateCanonicalHash(metadata)
    ) {
      throw new DomainError('RENDER_OUTPUT_INVALID', 'Color pipeline output metadata diverged')
    }
    return Object.freeze({
      outputPath: input.outputPath,
      sha256,
      byteSize: file.size,
      probe,
      compilationHash: input.compilation.compilationHash,
      pipelineHash: input.compilation.pipeline.pipelineHash,
    })
  }
}
