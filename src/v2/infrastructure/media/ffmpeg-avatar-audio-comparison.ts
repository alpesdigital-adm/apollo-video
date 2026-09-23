import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { TransformationAudioPreservationEvaluator } from '../../application/ports/transformation-critic-evaluator.ts'
import { compareAvatarAudioPcm } from '../../domain/avatar-output-speech-evidence.ts'
import { DomainError, assertDomain } from '../../domain/errors.ts'
import { resolveFfmpegBinary } from './ffmpeg-binary.ts'

const execFileAsync = promisify(execFile)
const MAX_PCM_BYTES = 64 * 1024 * 1024

function pcm16(bytes: Buffer): Int16Array {
  assertDomain(bytes.length > 0 && bytes.length % 2 === 0, 'RENDER_OUTPUT_INVALID', 'Decoded avatar PCM is invalid')
  const samples = new Int16Array(bytes.length / 2)
  for (let index = 0; index < samples.length; index += 1) samples[index] = bytes.readInt16LE(index * 2)
  return samples
}

export class FfmpegAvatarAudioComparison implements TransformationAudioPreservationEvaluator {
  private readonly environment: NodeJS.ProcessEnv
  private readonly decoder?: (path: string, range: Readonly<{ startMs: number; durationMs: number }> | null, signal?: AbortSignal) => Promise<Int16Array>

  constructor(
    environment: NodeJS.ProcessEnv = process.env,
    decoder?: (path: string, range: Readonly<{ startMs: number; durationMs: number }> | null, signal?: AbortSignal) => Promise<Int16Array>,
  ) {
    this.environment = environment
    this.decoder = decoder
  }

  private async decode(path: string, range: Readonly<{ startMs: number; durationMs: number }> | null, signal?: AbortSignal) {
    try {
      const { stdout } = await execFileAsync(resolveFfmpegBinary(undefined, this.environment), [
        '-nostdin', '-hide_banner', '-v', 'error',
        ...(range ? ['-ss', (range.startMs / 1_000).toFixed(6), '-t', (range.durationMs / 1_000).toFixed(6)] : []),
        '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 's16le', '-',
      ], { windowsHide: true, timeout: 120_000, maxBuffer: MAX_PCM_BYTES, signal, encoding: 'buffer' })
      return pcm16(stdout)
    } catch (error) {
      if (error instanceof DomainError) throw error
      throw new DomainError('RENDER_OUTPUT_INVALID', 'Avatar audio PCM could not be decoded')
    }
  }

  async compare(input: Parameters<TransformationAudioPreservationEvaluator['compare']>[0]) {
    assertDomain(Number.isSafeInteger(input.sourceStartMs) && input.sourceStartMs >= 0 && Number.isSafeInteger(input.sourceDurationMs) && input.sourceDurationMs > 0, 'INVALID_ARGUMENT', 'Avatar source audio range is invalid')
    const decode = this.decoder ?? this.decode.bind(this)
    const [sourceResult, outputResult] = await Promise.allSettled([
      decode(input.sourcePath, { startMs: input.sourceStartMs, durationMs: input.sourceDurationMs }, input.signal),
      decode(input.resultPath, null, input.signal),
    ])
    if (sourceResult.status === 'rejected') throw sourceResult.reason
    if (outputResult.status === 'rejected') throw outputResult.reason
    return compareAvatarAudioPcm({ source: sourceResult.value, output: outputResult.value })
  }
}
