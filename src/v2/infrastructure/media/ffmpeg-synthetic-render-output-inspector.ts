import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { isAbsolute, relative, resolve } from 'node:path'
import { open, realpath, stat } from 'node:fs/promises'

import type { SyntheticRenderOutputInspector } from '../../application/ports/synthetic-render-output-inspector.ts'
import { terminateChild } from '../../application/worker-lifecycle.ts'
import { DomainError } from '../../domain/errors.ts'
import { sniffMediaInput } from '../../domain/media-input.ts'
import { calculateFileSha256 } from './local-artifact-manifest.ts'
import { resolveFfmpegBinary, resolveFfprobeBinaryPath } from './ffmpeg-binary.ts'
import { probeVideo } from './video-probe.ts'

const require = createRequire(import.meta.url)
const ffprobeStatic = require('ffprobe-static') as { path?: string }
const MAX_OUTPUT_BYTES = 1024 * 1024
const TIMEOUT_MS = 120_000

function resolveInspectionBinary(kind: 'ffmpeg' | 'ffprobe', environment: NodeJS.ProcessEnv): string {
  return kind === 'ffmpeg'
    ? resolveFfmpegBinary(undefined, environment)
    : resolveFfprobeBinaryPath(ffprobeStatic?.path, undefined, environment)
}

function contained(root: string, candidate: string): boolean {
  const value = relative(root, candidate)
  return value.length > 0 && value !== '..' && !value.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(value)
}

async function runOwnedProcess(input: {
  binary: 'ffmpeg' | 'ffprobe'
  args: readonly string[]
  environment: NodeJS.ProcessEnv
  signal?: AbortSignal
}): Promise<Readonly<{ stdout: string; stderr: string }>> {
  return new Promise((resolvePromise, reject) => {
    if (input.signal?.aborted) {
      reject(new DomainError('RENDER_EXECUTION_FAILED', 'Synthetic render inspection was cancelled'))
      return
    }
    const child = spawn(
      resolveInspectionBinary(input.binary, input.environment), input.args,
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let processError: Error | null = null
    let aborted = false
    let timedOut = false
    let outputExceeded = false
    let termination: Promise<unknown> | null = null
    const stop = () => {
      termination ??= terminateChild(child, { graceMs: 1_000 }).catch((error) => { processError = error as Error })
    }
    const onAbort = () => { aborted = true; stop() }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => { timedOut = true; stop() }, TIMEOUT_MS)
    timer.unref?.()
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > MAX_OUTPUT_BYTES) { outputExceeded = true; stop(); return }
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > MAX_OUTPUT_BYTES) { outputExceeded = true; stop(); return }
      stderr += chunk
    })
    child.once('error', (error) => { processError = error })
    child.once('close', async (code, killedBySignal) => {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', onAbort)
      if (termination) await termination
      if (aborted) return reject(new DomainError('RENDER_EXECUTION_FAILED', 'Synthetic render inspection was cancelled'))
      if (timedOut) return reject(new DomainError('RENDER_OUTPUT_INVALID', 'Synthetic render inspection timed out'))
      if (outputExceeded) return reject(new DomainError('RENDER_OUTPUT_INVALID', 'Synthetic render inspection output exceeded its limit'))
      if (processError || code !== 0 || killedBySignal) {
        return reject(new DomainError('RENDER_OUTPUT_INVALID', `Synthetic render full decode failed${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ''}`))
      }
      resolvePromise(Object.freeze({ stdout, stderr }))
    })
  })
}

async function countDecodedFrames(path: string, environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<number> {
  const result = await runOwnedProcess({
    binary: 'ffprobe',
    environment,
    args: ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type,nb_read_frames', '-of', 'json', path],
    ...(signal ? { signal } : {}),
  })
  try {
    const parsed = JSON.parse(result.stdout) as { streams?: Array<{ codec_type?: unknown; nb_read_frames?: unknown }> }
    const stream = parsed.streams?.find((entry) => entry.codec_type === 'video')
    const frames = Number(stream?.nb_read_frames)
    if (!Number.isSafeInteger(frames) || frames <= 0) throw new Error('invalid')
    return frames
  } catch {
    throw new DomainError('RENDER_OUTPUT_INVALID', 'Synthetic render decoded frame count is invalid')
  }
}

async function assertMp4Signature(path: string, byteSize: number): Promise<void> {
  const handle = await open(path, 'r')
  try {
    const bytes = Buffer.alloc(64)
    const read = await handle.read(bytes, 0, bytes.length, 0)
    const media = sniffMediaInput({
      filename: 'synthetic-render.mp4',
      declaredMime: 'video/mp4',
      bytes: bytes.subarray(0, read.bytesRead),
      byteSize,
    })
    if (media.kind !== 'video' || media.mimeType !== 'video/mp4' || media.extension !== 'mp4') {
      throw new DomainError('RENDER_OUTPUT_INVALID', 'Synthetic render signature is not MP4')
    }
  } catch (error) {
    if (error instanceof DomainError && error.code === 'RENDER_OUTPUT_INVALID') throw error
    throw new DomainError('RENDER_OUTPUT_INVALID', 'Synthetic render signature is not MP4')
  } finally {
    await handle.close()
  }
}

export class FfmpegSyntheticRenderOutputInspector implements SyntheticRenderOutputInspector {
  private readonly outputRoot: string
  private readonly environment: NodeJS.ProcessEnv

  constructor(options: { outputRoot: string; environment?: NodeJS.ProcessEnv }) {
    this.outputRoot = options.outputRoot.trim()
    this.environment = options.environment ?? process.env
    if (!isAbsolute(this.outputRoot)) {
      throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Synthetic render output root must be absolute')
    }
  }

  async inspect(input: { outputKey: string; expectedSha256: string; expectedByteSize: number; signal?: AbortSignal }) {
    if (input.outputKey.includes('..') || input.outputKey.includes('\\') || input.outputKey.startsWith('/')) {
      throw new DomainError('RENDER_OUTPUT_INVALID', 'Synthetic render output key is unsafe')
    }
    const root = await realpath(this.outputRoot)
    const path = await realpath(resolve(root, ...input.outputKey.split('/')))
    if (!contained(root, path)) {
      throw new DomainError('RENDER_OUTPUT_INVALID', 'Synthetic render output escaped owned storage')
    }
    const initial = await stat(path)
    if (!initial.isFile()) throw new DomainError('RENDER_OUTPUT_INVALID', 'Synthetic render output is not a regular file')
    const inspected = await Promise.allSettled([
      probeVideo(path, { environment: this.environment, requireAudio: true, ...(input.signal ? { signal: input.signal } : {}) }),
      calculateFileSha256(path),
      stat(path),
      countDecodedFrames(path, this.environment, input.signal),
      assertMp4Signature(path, initial.size),
    ])
    const failed = inspected.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw failed.reason
    const [metadata, sha256, size, frames] = inspected.map((result) =>
      (result as PromiseFulfilledResult<unknown>).value) as [
        Awaited<ReturnType<typeof probeVideo>>, string, Awaited<ReturnType<typeof stat>>, number, void,
      ]
    if (sha256 !== input.expectedSha256 || size.size !== input.expectedByteSize) {
      throw new DomainError('RENDER_OUTPUT_CONFLICT', 'Synthetic render bytes changed after commit')
    }
    await runOwnedProcess({
      binary: 'ffmpeg',
      environment: this.environment,
      args: ['-nostdin', '-hide_banner', '-v', 'error', '-xerror', '-i', path, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'],
      ...(input.signal ? { signal: input.signal } : {}),
    })
    const [decodedSha256, decodedSize] = await Promise.all([calculateFileSha256(path), stat(path)])
    if (!decodedSize.isFile() || decodedSha256 !== input.expectedSha256 || decodedSize.size !== input.expectedByteSize) {
      throw new DomainError('RENDER_OUTPUT_CONFLICT', 'Synthetic render bytes changed during inspection')
    }
    const containers = metadata.container.split(',').map((value) => value.trim().toLowerCase())
    if (!containers.includes('mp4')) {
      throw new DomainError('RENDER_OUTPUT_INVALID', 'Synthetic render container is not MP4')
    }
    return Object.freeze({
      width: metadata.width,
      height: metadata.height,
      fps: metadata.fps,
      durationInFrames: frames,
      codec: metadata.codec,
      audioCodec: metadata.audioCodec,
      container: 'mp4',
      decodable: true,
    })
  }
}
