import { spawn } from 'node:child_process'
import { mkdir, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import type { MediaSegmentExtractor } from '../../application/ports/media-segment-extractor.ts'
import { DomainError } from '../../domain/errors.ts'
import { calculateFileSha256 } from './local-artifact-manifest.ts'
import { probeAudioDurationSeconds, probeVideo } from './video-probe.ts'
import { resolveFfmpegBinary } from './ffmpeg-binary.ts'

type ProcessObservation = { operationId: string; pid: number; state: 'started' | 'exited' }

async function runOwnedFfmpeg(args: string[], signal?: AbortSignal, observe?: (state: 'started' | 'exited', pid: number) => void): Promise<void> {
  if (signal?.aborted) throw new DomainError('RENDER_EXECUTION_FAILED', 'Segment extraction was cancelled')
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(resolveFfmpegBinary(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let reason: string | undefined
    let stderrBytes = 0
    const stop = (message: string) => { reason ??= message; child.kill('SIGKILL') }
    const abort = () => stop('Segment extraction was cancelled')
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const timer = setTimeout(() => stop('Segment extraction timed out'), 10 * 60_000)
    child.once('spawn', () => { if (child.pid) observe?.('started', child.pid) })
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 4 * 1024 * 1024) stop('Segment extraction stderr exceeded its bound') })
    child.once('error', () => { reason ??= 'Segment extraction failed to start' })
    // AbortSignal's error event is not proof of exit. Settle only after close.
    child.once('close', (code) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (child.pid) observe?.('exited', child.pid)
      if (reason || code !== 0) reject(new DomainError('RENDER_EXECUTION_FAILED', reason ?? 'Segment extraction failed'))
      else resolvePromise()
    })
  })
}

export class FfmpegMediaSegmentExtractor implements MediaSegmentExtractor {
  private readonly root: string
  private readonly observe?: (event: ProcessObservation) => void
  constructor(root: string, observe?: (event: ProcessObservation) => void) { this.root = resolve(root); this.observe = observe }
  private directory(operationId: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId)) throw new DomainError('INVALID_ARGUMENT', 'Segment extraction operationId is invalid')
    const directory = resolve(this.root, operationId); const rel = relative(this.root, directory)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new DomainError('INVALID_ARGUMENT', 'Segment extraction path escaped its root')
    return directory
  }
  async extract(input: { operationId: string; sourcePath: string; mediaType: 'video' | 'audio'; startMs: number; endMs: number; signal?: AbortSignal }) {
    if (!isAbsolute(input.sourcePath) || !Number.isSafeInteger(input.startMs) || !Number.isSafeInteger(input.endMs) || input.startMs < 0 || input.endMs <= input.startMs) throw new DomainError('INVALID_ARGUMENT', 'Segment extraction input is invalid')
    if (input.mediaType !== 'video' && input.mediaType !== 'audio') throw new DomainError('INVALID_ARGUMENT', 'Segment media type is invalid')
    const directory = this.directory(input.operationId); await mkdir(directory, { recursive: true }); const outputPath = join(directory, input.mediaType === 'audio' ? 'segment.wav' : 'segment.mp4')
    const common = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', (input.startMs / 1000).toFixed(3), '-i', input.sourcePath, '-t', ((input.endMs - input.startMs) / 1000).toFixed(3)]
    const encoding = input.mediaType === 'audio'
      ? ['-map', '0:a:0', '-vn', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2']
      : ['-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart']
    await runOwnedFfmpeg([...common, ...encoding, outputPath], input.signal, (state, pid) => { try { this.observe?.({ operationId: input.operationId, pid, state }) } catch { /* A diagnostic observer cannot strand its process. */ } })
    if (input.signal?.aborted) throw new DomainError('RENDER_EXECUTION_FAILED', 'Segment extraction was cancelled')
    // A short probe finishes under its own deadline before cleanup; cancellation
    // is checked afterward rather than treating an early error event as exit.
    const [metadata, sha256, measured] = await Promise.all([stat(outputPath), calculateFileSha256(outputPath), input.mediaType === 'audio' ? probeAudioDurationSeconds(outputPath, { signal: input.signal }) : probeVideo(outputPath, { requireAudio: false, signal: input.signal })])
    if (input.signal?.aborted) throw new DomainError('RENDER_EXECUTION_FAILED', 'Segment extraction was cancelled')
    const expected = (input.endMs - input.startMs) / 1000
    const duration = typeof measured === 'number' ? measured : measured.duration
    const tolerance = typeof measured === 'number' ? 0.12 : Math.max(0.12, 2 / measured.fps)
    if (!metadata.isFile() || metadata.size < 1 || Math.abs(duration - expected) > tolerance) throw new DomainError('RENDER_OUTPUT_INVALID', 'Segment derivative duration is invalid')
    return Object.freeze({ outputPath, sha256, byteSize: metadata.size, ...(typeof measured === 'number' ? {} : { probe: Object.freeze({ width: measured.width, height: measured.height, duration: measured.duration, fps: measured.fps }) }) })
  }
  async cleanup(operationId: string) { await rm(this.directory(operationId), { recursive: true, force: true }) }
}
