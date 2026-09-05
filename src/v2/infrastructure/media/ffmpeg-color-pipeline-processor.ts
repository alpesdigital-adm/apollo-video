import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'

import { calculateCanonicalHash } from '../../domain/canonical-hash.ts'
import type { ColorPipelineCompilation } from '../../domain/color-pipeline-compilation.ts'
import type { ColorMetadata, ColorTransform, resolveColorPlan } from '../../domain/color-and-export.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  MATCH_PARAMETER_BOUNDS,
  MATCH_PROVIDER,
  MATCH_PROVIDER_VERSIONS,
  MATCH_WHITE_BALANCE_PARAMETERS,
  type MatchProviderVersion,
} from '../../domain/multicam-match-plan.ts'
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

export type ResolvedColorPipelineExecution = Readonly<{
  pipeline: Readonly<ReturnType<typeof resolveColorPlan>>
  executionHash: string
}>

function assertResolvedExecution(value: ResolvedColorPipelineExecution) {
  const { pipelineHash, manifestKey: _manifestKey, ...pipelineContent } = value.pipeline
  if (
    !/^[a-f0-9]{64}$/.test(value.executionHash) ||
    calculateCanonicalHash(pipelineContent) !== pipelineHash ||
    value.pipeline.stages.length !== 4 ||
    value.pipeline.stages.map((stage) => stage.kind).join('>') !==
      'technical>match>creative-lut>output'
  ) {
    throw new DomainError('INVALID_RENDER_INPUT', 'Resolved color pipeline failed integrity validation')
  }
}

function pipelineFrom(input: {
  compilation?: Readonly<ColorPipelineCompilation>
  execution?: ResolvedColorPipelineExecution
}) {
  if (Boolean(input.compilation) === Boolean(input.execution)) {
    throw new DomainError('INVALID_RENDER_INPUT', 'Exactly one color pipeline execution is required')
  }
  if (input.compilation) {
    assertCompilation(input.compilation)
    return input.compilation.pipeline
  }
  assertResolvedExecution(input.execution!)
  return input.execution!.pipeline
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

/**
 * `apollo-match`, both provider versions (F4.013).
 *
 * v1 is the `eq` filter this processor has always applied. v2 adds the three
 * per-channel white-balance gains the domain derives
 * (`multicam-match-plan.ts:66-100`) and renders them as a `colorchannelmixer`
 * placed BEFORE the `eq`, because a channel gain and a luma/contrast/saturation
 * adjustment do not commute: correcting the balance after the contrast curve
 * would balance a picture the eq had already reshaped.
 *
 * The two versions are kept apart by `implementation.version`, not by which
 * keys happen to be present. A v1 transform with a stray `red-gain` is a
 * refusal, not a silent upgrade: `parametersHash` and therefore `pipelineHash`
 * are computed over the whole parameter object, so a compilation that hashed as
 * v1 must keep rendering exactly what v1 rendered for ever.
 *
 * The stage order `technical > match > creative-lut > output` is untouched:
 * both versions return one link of the same chain, asserted four stages long by
 * `assertCompilation`/`assertResolvedExecution` above.
 *
 * Nothing below retypes the provider's vocabulary. The accepted parameter
 * names, the three gain keys and every bound are spread from the domain
 * constants that publish them (`multicam-match-plan.ts`), so a renamed key or a
 * widened bound cannot mean one thing in the plan and another in the filter.
 */
const MATCH_V2_GAIN_PARAMETERS: readonly string[] = Object.freeze(
  Object.values(MATCH_WHITE_BALANCE_PARAMETERS),
)
const MATCH_GAIN_BOUNDS = MATCH_PARAMETER_BOUNDS.gain

function match(stage: Readonly<ColorTransform>) {
  if (stage.implementation.provider !== MATCH_PROVIDER) {
    throw new DomainError('INVALID_RENDER_INPUT', `match requires ${MATCH_PROVIDER}`)
  }
  const version = stage.implementation.version
  if (!Object.hasOwn(MATCH_PROVIDER_VERSIONS, version)) {
    throw new DomainError('INVALID_RENDER_INPUT', `match provider version ${version} is unsupported`)
  }
  const allowed: readonly string[] = MATCH_PROVIDER_VERSIONS[version as MatchProviderVersion].parameters
  const parameters = stage.implementation.parameters
  if (Object.keys(parameters).some((key) => !allowed.includes(key))) {
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
  const within = (value: number, bounds: readonly [number, number]) =>
    Number.isFinite(value) && value >= bounds[0] && value <= bounds[1]
  if (
    !within(brightness, MATCH_PARAMETER_BOUNDS.brightness) ||
    !within(contrast, MATCH_PARAMETER_BOUNDS.contrast) ||
    !within(saturation, MATCH_PARAMETER_BOUNDS.saturation)
  ) {
    throw new DomainError('INVALID_RENDER_INPUT', 'match parameters are outside safe bounds')
  }
  const eq = `eq=brightness=${brightness.toFixed(6)}:contrast=${contrast.toFixed(6)}:saturation=${saturation.toFixed(6)}`
  if (version === MATCH_PROVIDER_VERSIONS.v1.version) return eq
  // A v2 transform that names no gain is not a white balance; it is a v1
  // transform wearing a newer version token, and letting it through would make
  // two different parameter objects render identically under two hashes.
  const gains = MATCH_V2_GAIN_PARAMETERS.map((key) => {
    const value = Number(parameters[key])
    if (
      parameters[key] === undefined || !Number.isFinite(value) ||
      value < MATCH_GAIN_BOUNDS[0] || value > MATCH_GAIN_BOUNDS[1]
    ) {
      throw new DomainError('INVALID_RENDER_INPUT', `match ${key} is missing or outside safe bounds`)
    }
    return value
  })
  const [red, green, blue] = gains as [number, number, number]
  return `colorchannelmixer=rr=${red.toFixed(6)}:gg=${green.toFixed(6)}:bb=${blue.toFixed(6)},${eq}`
}

function creative(
  stage: Readonly<ColorTransform>,
  lutPaths: Readonly<Record<string, string>>,
) {
  if (stage.implementation.provider !== 'apollo-lut') {
    throw new DomainError('INVALID_RENDER_INPUT', 'creative LUT requires apollo-lut')
  }
  const parameters = stage.implementation.parameters
  if (Object.keys(parameters).some((key) => !['mode', 'intensity'].includes(key))) {
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
  const intensity = Number(parameters.intensity)
  if (!Number.isFinite(intensity) || intensity < 0 || intensity > 1) {
    throw new DomainError('INVALID_RENDER_INPUT', 'creative LUT intensity is invalid')
  }
  const artifactId = stage.lut?.artifactId ?? ''
  const exactKey = `${artifactId}:${stage.implementation.parametersHash}`
  const path = lutPaths[exactKey] ?? lutPaths[artifactId]
  if (!path || !isAbsolute(path)) {
    throw new DomainError('INVALID_RENDER_INPUT', 'Creative LUT was not materialized')
  }
  return `lut3d=file='${escapeFilterPath(path)}':interp=tetrahedral`
}

export function buildFfmpegColorPipelineFilter(input: {
  compilation?: Readonly<ColorPipelineCompilation>
  execution?: ResolvedColorPipelineExecution
  lutPaths?: Readonly<Record<string, string>>
}) {
  const pipeline = pipelineFrom(input)
  const [technical, matching, creativeLut, output] = pipeline.stages
  const filters = [
    zscale(technical),
    match(matching),
    creative(creativeLut, input.lutPaths ?? {}),
    zscale(output),
  ]
  const bitDepth = pipeline.outputMetadata.bitDepth
  if (![8, 10].includes(bitDepth)) {
    throw new DomainError('INVALID_RENDER_INPUT', 'FFmpeg color output bit depth is unsupported')
  }
  filters.push(`format=${bitDepth === 10 ? 'yuv420p10le' : 'yuv420p'}`)
  return Object.freeze({
    filter: filters.join(','),
    outputMetadata: pipeline.outputMetadata,
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
    compilation?: Readonly<ColorPipelineCompilation>
    execution?: ResolvedColorPipelineExecution
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
      compilationHash: input.compilation?.compilationHash ?? input.execution!.executionHash,
      pipelineHash: input.compilation?.pipeline.pipelineHash ?? input.execution!.pipeline.pipelineHash,
    })
  }
}
