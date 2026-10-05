import { execFile, spawn } from 'node:child_process'
import { mkdir, realpath, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import sharp from 'sharp'
import type { MediaLibraryPreviewProcessor } from '../../application/create-media-library-previews.ts'
import { DomainError } from '../../domain/errors.ts'
import { resolveFfmpegBinary } from './ffmpeg-binary.ts'
import { calculateFileSha256 } from './local-artifact-manifest.ts'
import { probeVideo } from './video-probe.ts'

type ProcessObservation = { operationId: string; pid: number; state: 'started' | 'exited' }
const inspectVersion = promisify(execFile)
const tools = new Map<string, Promise<Readonly<{ id: 'ffmpeg'; version: string; digest: string }>>>()

async function identifyBinary() {
  const binary = await realpath(resolveFfmpegBinary())
  if (!isAbsolute(binary)) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Preview FFmpeg binary must be absolute')
  const metadata = await stat(binary)
  const key = `${binary}:${metadata.size}:${metadata.mtimeMs}`
  let pending = tools.get(key)
  if (!pending) {
    pending = (async () => {
      const [digest, result] = await Promise.all([
        calculateFileSha256(binary),
        inspectVersion(binary, ['-version'], { windowsHide: true, timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 }),
      ])
      const version = /^ffmpeg version (\S+)/m.exec(result.stdout)?.[1]
      if (!version) throw new DomainError('RENDER_OUTPUT_INVALID', 'Preview FFmpeg version cannot be identified')
      return Object.freeze({ id: 'ffmpeg' as const, version, digest })
    })()
    tools.set(key, pending)
    pending.catch(() => { if (tools.get(key) === pending) tools.delete(key) })
  }
  return { binary, tool: await pending }
}

async function execute(binary: string, args: string[], signal?: AbortSignal, observe?: (state: 'started' | 'exited', pid: number) => void) {
  if (signal?.aborted) throw new DomainError('RENDER_EXECUTION_FAILED', 'Preview generation was cancelled')
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let error: string | undefined, bytes = 0
    const stop = (reason: string) => { error ??= reason; child.kill('SIGKILL') }
    const abort = () => stop('Preview generation was cancelled')
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
    const timer = setTimeout(() => stop('Preview generation timed out'), 120_000)
    child.once('spawn', () => { if (child.pid) observe?.('started', child.pid) })
    child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) stop('Preview generation diagnostics exceeded their bound') })
    child.once('error', () => { error ??= 'Preview generation failed to start' })
    child.once('close', (code) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (child.pid) observe?.('exited', child.pid)
      if (error || code !== 0) reject(new DomainError('RENDER_EXECUTION_FAILED', error ?? 'Preview generation failed'))
      else resolvePromise()
    })
  })
}
export class FfmpegLibraryPreviewProcessor implements MediaLibraryPreviewProcessor {
  private readonly root: string
  private readonly observe?: (event: ProcessObservation) => void
  constructor(root: string, observe?: (event: ProcessObservation) => void) { this.root = resolve(root); this.observe = observe }
  private directory(id: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(id)) throw new DomainError('INVALID_ARGUMENT', 'Preview operation identity is invalid')
    const path = resolve(this.root, id); const rel = relative(this.root, path)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new DomainError('INVALID_ARGUMENT', 'Preview path escaped its root')
    return path
  }
  async generate(input: Parameters<MediaLibraryPreviewProcessor['generate']>[0]) {
    if (!isAbsolute(input.sourcePath) || input.signal?.aborted) throw new DomainError('RENDER_EXECUTION_FAILED', 'Preview generation cannot start')
    const { binary, tool } = await identifyBinary()
    if (input.signal?.aborted) throw new DomainError('RENDER_EXECUTION_FAILED', 'Preview generation was cancelled')
    const directory = this.directory(input.operationId); await mkdir(directory, { recursive: true })
    const outputs: Awaited<ReturnType<MediaLibraryPreviewProcessor['generate']>>[number][] = []
    const run = async (kind: 'thumbnail' | 'waveform', args: string[]) => {
      const path = join(directory, `${kind}.png`)
      await execute(binary, ['-hide_banner', '-loglevel', 'error', '-y', '-threads', '1', '-i', input.sourcePath, ...args, '-threads', '1', path], input.signal, (state, pid) => { try { this.observe?.({ operationId: input.operationId, state, pid }) } catch { /* Diagnostics cannot strand a child process. */ } })
      if (input.signal?.aborted) throw new DomainError('RENDER_EXECUTION_FAILED', 'Preview generation was cancelled')
      const [metadata, bytes, sha256] = await Promise.all([sharp(path).metadata(), stat(path), calculateFileSha256(path)])
      if (!metadata.width || !metadata.height || bytes.size < 1) throw new DomainError('RENDER_OUTPUT_INVALID', 'Preview image is invalid')
      outputs.push(Object.freeze({ kind, path, sha256, byteSize: bytes.size, width: metadata.width, height: metadata.height, tool }))
    }
    if (input.mediaType === 'video') await run('thumbnail', ['-map', '0:v:0', '-vf', 'scale=320:320:force_original_aspect_ratio=decrease', '-frames:v', '1'])
    if (input.signal?.aborted) throw new DomainError('RENDER_EXECUTION_FAILED', 'Preview generation was cancelled')
    const hasAudio = input.mediaType === 'audio' || Boolean((await probeVideo(input.sourcePath, { requireAudio: false })).audioCodec)
    if (input.signal?.aborted) throw new DomainError('RENDER_EXECUTION_FAILED', 'Preview generation was cancelled')
    if (hasAudio) await run('waveform', ['-filter_complex', 'aformat=channel_layouts=mono,showwavespic=s=640x120:colors=0xd0a43a', '-frames:v', '1'])
    return Object.freeze(outputs)
  }
  async cleanup(operationId: string) { await rm(this.directory(operationId), { recursive: true, force: true }) }
}
