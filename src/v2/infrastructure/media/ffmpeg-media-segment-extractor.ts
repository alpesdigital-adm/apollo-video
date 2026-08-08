import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import type { MediaSegmentExtractor } from '../../application/ports/media-segment-extractor.ts'
import { DomainError } from '../../domain/errors.ts'
import { calculateFileSha256 } from './local-artifact-manifest.ts'
import { probeVideo } from './video-probe.ts'

const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static') as string | null
const execFileAsync = promisify(execFile)

export class FfmpegMediaSegmentExtractor implements MediaSegmentExtractor {
  private readonly root: string
  constructor(root: string) { this.root = resolve(root) }
  private directory(operationId: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId)) throw new DomainError('INVALID_ARGUMENT', 'Segment extraction operationId is invalid')
    const directory = resolve(this.root, operationId); const rel = relative(this.root, directory)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new DomainError('INVALID_ARGUMENT', 'Segment extraction path escaped its root')
    return directory
  }
  async extract(input: { operationId: string; sourcePath: string; startMs: number; endMs: number; signal?: AbortSignal }) {
    if (!ffmpeg || !isAbsolute(input.sourcePath) || !Number.isSafeInteger(input.startMs) || !Number.isSafeInteger(input.endMs) || input.startMs < 0 || input.endMs <= input.startMs) throw new DomainError('INVALID_ARGUMENT', 'Segment extraction input is invalid')
    const directory = this.directory(input.operationId); await mkdir(directory, { recursive: true }); const outputPath = join(directory, 'segment.mp4')
    try {
      await execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', (input.startMs / 1000).toFixed(3), '-i', input.sourcePath, '-t', ((input.endMs - input.startMs) / 1000).toFixed(3), '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outputPath], { windowsHide: true, timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024, signal: input.signal })
    } catch (error) { throw new DomainError('RENDER_EXECUTION_FAILED', (error as NodeJS.ErrnoException).code === 'ABORT_ERR' ? 'Segment extraction was cancelled' : 'Segment extraction failed') }
    const [metadata, sha256, probe] = await Promise.all([stat(outputPath), calculateFileSha256(outputPath), probeVideo(outputPath, { signal: input.signal, requireAudio: false })])
    const expected = (input.endMs - input.startMs) / 1000
    if (!metadata.isFile() || metadata.size < 1 || Math.abs(probe.duration - expected) > Math.max(0.12, 1 / probe.fps * 2)) throw new DomainError('RENDER_OUTPUT_INVALID', 'Segment derivative duration is invalid')
    return Object.freeze({ outputPath, sha256, byteSize: metadata.size, probe: Object.freeze({ width: probe.width, height: probe.height, duration: probe.duration, fps: probe.fps }) })
  }
  async cleanup(operationId: string) { await rm(this.directory(operationId), { recursive: true, force: true }) }
}
