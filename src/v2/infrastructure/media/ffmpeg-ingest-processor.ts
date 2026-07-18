import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import type { MediaIngestProcessor } from '../../application/ports/media-ingest.ts'
import { DomainError } from '../../domain/errors.ts'
import { calculateFileSha256 } from './local-artifact-manifest.ts'
import { probeVideo } from './video-probe.ts'

const require = createRequire(import.meta.url)
const ffmpegStatic = require('ffmpeg-static') as string | null
const execFileAsync = promisify(execFile)

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new DomainError('PERSISTENCE_CONFLICT', 'Ingest work path escaped its root')
}

export class FfmpegIngestProcessor implements MediaIngestProcessor {
  private readonly workRoot: string
  private readonly ffmpegPath: string

  constructor(options: { workRoot: string; ffmpegPath?: string }) {
    this.workRoot = resolve(options.workRoot)
    this.ffmpegPath = options.ffmpegPath?.trim() || ffmpegStatic || 'ffmpeg'
    if (!isAbsolute(this.workRoot)) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Ingest work root must be absolute')
  }

  private directory(operationId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(operationId)) throw new DomainError('INVALID_ARGUMENT', 'operationId is invalid')
    const directory = join(this.workRoot, operationId)
    assertContained(this.workRoot, directory)
    return directory
  }

  private async run(args: readonly string[], signal?: AbortSignal): Promise<void> {
    try {
      await execFileAsync(this.ffmpegPath, [...args], {
        windowsHide: true,
        timeout: 30 * 60_000,
        maxBuffer: 2 * 1024 * 1024,
        signal,
      })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      throw new DomainError('RENDER_EXECUTION_FAILED', code === 'ABORT_ERR' ? 'Media normalization was cancelled' : 'Media normalization failed')
    }
  }

  async normalize(input: { sourcePath: string; operationId: string; signal?: AbortSignal }) {
    if (!isAbsolute(input.sourcePath)) throw new DomainError('INVALID_ARGUMENT', 'Ingest source path must be absolute')
    const directory = this.directory(input.operationId)
    const proxyPath = join(directory, 'editing-proxy.mp4')
    const audioPath = join(directory, 'speech.flac')
    await mkdir(directory, { recursive: true })
    await rm(proxyPath, { force: true })
    await rm(audioPath, { force: true })
    await this.run([
      '-hide_banner', '-loglevel', 'error', '-y', '-i', input.sourcePath,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', 'scale=w=min(1280\\,iw):h=-2:flags=lanczos',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-movflags', '+faststart', proxyPath,
    ], input.signal)
    await this.run([
      '-hide_banner', '-loglevel', 'error', '-y', '-i', input.sourcePath,
      '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'flac', audioPath,
    ], input.signal)
    const [proxyMetadata, audioMetadata, probe, proxySha256] = await Promise.all([
      stat(proxyPath), stat(audioPath), probeVideo(proxyPath, { signal: input.signal }), calculateFileSha256(proxyPath),
    ])
    if (!proxyMetadata.isFile() || proxyMetadata.size <= 0 || !audioMetadata.isFile() || audioMetadata.size <= 0) {
      throw new DomainError('RENDER_OUTPUT_INVALID', 'Media normalization produced an empty derivative')
    }
    return Object.freeze({ proxyPath, audioPath, proxySha256, proxyByteSize: proxyMetadata.size, probe })
  }

  async cleanup(operationId: string): Promise<void> {
    await rm(this.directory(operationId), { recursive: true, force: true })
  }
}

export function createFfmpegIngestProcessorFromEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const artifactRoot = environment.APOLLO_V2_ARTIFACT_ROOT?.trim()
  if (!artifactRoot) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Artifact root is not configured')
  return new FfmpegIngestProcessor({
    workRoot: join(resolve(artifactRoot), '.work'),
    ...(environment.FFMPEG_PATH?.trim() ? { ffmpegPath: environment.FFMPEG_PATH.trim() } : {}),
  })
}
