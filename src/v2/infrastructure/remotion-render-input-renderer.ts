import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'

import { compileApolloVideoRenderProps } from '../application/compile-apollo-video-render-props.ts'
import type {
  CommittedRenderReceipt,
  RenderInputRenderer,
  StagedRender,
  StagedRenderReceipt,
} from '../application/ports/render-input-renderer.ts'
import { DomainError } from '../domain/errors.ts'
import type { MaterializedRenderInputV1 } from '../domain/render-input.ts'
import { calculateFileSha256 } from './media/local-artifact-manifest.ts'
import { probeVideo } from './media/video-probe.ts'

const DEFAULT_TIMEOUT_MS = 20 * 60_000
const MAX_WORKER_OUTPUT_BYTES = 1024 * 1024

function contained(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return (
    child.length > 0 &&
    child !== '..' &&
    !child.startsWith(`..\\`) &&
    !child.startsWith('../') &&
    !isAbsolute(child)
  )
}

function portableOutputKey(value: string): string {
  const normalized = value.trim()
  const segments = normalized.split('/')
  if (
    normalized.length === 0 ||
    normalized.length > 512 ||
    !normalized.endsWith('.mp4') ||
    normalized.startsWith('/') ||
    normalized.includes('\\') ||
    /^[a-zA-Z]:/.test(normalized) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new DomainError('INVALID_ARGUMENT', 'Render output key is invalid')
  }
  return normalized
}

function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      shell: false,
    })
  } else {
    child.kill('SIGKILL')
  }
}

async function runRenderWorker(input: {
  scriptPath: string
  workingDirectory: string
  request: Record<string, unknown>
  timeoutMs: number
  signal?: AbortSignal
}): Promise<void> {
  if (input.signal?.aborted) {
    throw new DomainError('RENDER_EXECUTION_FAILED', 'Render execution was cancelled')
  }
  await new Promise<void>((resolveProcess, rejectProcess) => {
    const child = spawn(process.execPath, [input.scriptPath], {
      cwd: input.workingDirectory,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let outputExceeded = false
    let cancelled = false

    const finish = (error?: DomainError) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      input.signal?.removeEventListener('abort', abort)
      if (error) rejectProcess(error)
      else resolveProcess()
    }
    const abort = () => {
      cancelled = true
      killProcessTree(child)
    }
    const timeout = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, input.timeoutMs)
    timeout.unref()
    input.signal?.addEventListener('abort', abort, { once: true })

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
      if (Buffer.byteLength(stdout) > MAX_WORKER_OUTPUT_BYTES) {
        outputExceeded = true
        killProcessTree(child)
      }
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
      if (Buffer.byteLength(stderr) > MAX_WORKER_OUTPUT_BYTES) {
        outputExceeded = true
        killProcessTree(child)
      }
    })
    child.once('error', () => {
      finish(new DomainError('RENDER_EXECUTION_FAILED', 'Render worker could not be started'))
    })
    child.once('close', (code) => {
      if (settled) return
      if (cancelled) {
        finish(new DomainError('RENDER_EXECUTION_FAILED', 'Render execution was cancelled'))
        return
      }
      if (timedOut) {
        finish(new DomainError('RENDER_EXECUTION_FAILED', 'Render execution exceeded its timeout'))
        return
      }
      if (outputExceeded) {
        finish(new DomainError('RENDER_EXECUTION_FAILED', 'Render worker exceeded its output limit'))
        return
      }
      let result: unknown
      try {
        result = JSON.parse(stdout)
      } catch {
        result = null
      }
      if (
        code !== 0 ||
        typeof result !== 'object' ||
        result === null ||
        !('ok' in result) ||
        result.ok !== true
      ) {
        finish(
          new DomainError('RENDER_EXECUTION_FAILED', 'Remotion render execution failed', {
            workerReportedFailure: stderr.length > 0,
          }),
        )
        return
      }
      finish()
    })
    child.stdin?.end(JSON.stringify(input.request))
  })
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export class RemotionRenderInputRenderer implements RenderInputRenderer {
  private readonly projectRoot: string
  private readonly outputRoot: string
  private readonly timeoutMs: number
  private readonly createId: () => string
  private readonly clock: () => Date

  constructor(options: {
    projectRoot: string
    outputRoot: string
    timeoutMs?: number
    createId?: () => string
    clock?: () => Date
  }) {
    this.projectRoot = options.projectRoot.trim()
    this.outputRoot = options.outputRoot.trim()
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.createId = options.createId ?? randomUUID
    this.clock = options.clock ?? (() => new Date())
    if (!isAbsolute(this.projectRoot) || !isAbsolute(this.outputRoot)) {
      throw new DomainError(
        'PERSISTENCE_NOT_CONFIGURED',
        'Remotion project and output roots must be absolute paths',
      )
    }
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new DomainError('INVALID_ARGUMENT', 'Render timeout must be a positive integer')
    }
  }

  async recover(
    input: MaterializedRenderInputV1,
    request: { outputKey: string },
  ): Promise<Readonly<CommittedRenderReceipt> | null> {
    compileApolloVideoRenderProps(input)
    const outputKey = portableOutputKey(request.outputKey)
    let root: string
    try {
      root = await realpath(this.outputRoot)
    } catch {
      throw new DomainError(
        'PERSISTENCE_NOT_CONFIGURED',
        'Render output storage root is unavailable',
      )
    }
    const requestedPath = resolve(root, ...outputKey.split('/'))
    let canonicalParent: string
    try {
      canonicalParent = await realpath(dirname(requestedPath))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const finalPath = resolve(canonicalParent, basename(requestedPath))
    if (!contained(root, finalPath)) {
      throw new DomainError('RENDER_OUTPUT_CONFLICT', 'Render output escaped its storage root')
    }
    let metadata
    try {
      metadata = await stat(finalPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    if (!metadata.isFile() || metadata.size <= 0 || !Number.isSafeInteger(metadata.size)) {
      throw new DomainError('RENDER_OUTPUT_INVALID', 'Committed render output is invalid')
    }
    const probe = await probeVideo(finalPath)
    const expectedDuration = input.output.durationInFrames / input.output.fps
    if (
      probe.width !== input.output.width ||
      probe.height !== input.output.height ||
      Math.abs(probe.fps - input.output.fps) > 0.01 ||
      Math.abs(probe.duration - expectedDuration) > Math.max(0.1, 1 / input.output.fps)
    ) {
      throw new DomainError(
        'RENDER_OUTPUT_INVALID',
        'Committed render output failed technical validation',
      )
    }
    const outputSha256 = await calculateFileSha256(finalPath)
    const verified = await stat(finalPath)
    if (
      verified.size !== metadata.size ||
      verified.mtimeMs !== metadata.mtimeMs ||
      verified.dev !== metadata.dev ||
      verified.ino !== metadata.ino
    ) {
      throw new DomainError('RENDER_OUTPUT_INVALID', 'Committed render changed during recovery')
    }
    return Object.freeze({
      schemaVersion: 'committed-render-receipt/v1',
      stageId: `recovered-${outputSha256.slice(0, 16)}`,
      inputHash: input.inputHash,
      outputSha256,
      byteSize: metadata.size,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      durationInFrames: input.output.durationInFrames,
      codec: 'h264',
      container: 'mp4',
      committedAt: metadata.mtime.toISOString(),
    })
  }

  async stage(
    input: MaterializedRenderInputV1,
    request: { outputKey: string; signal?: AbortSignal },
  ): Promise<StagedRender> {
    const inputProps = compileApolloVideoRenderProps(input)
    const outputKey = portableOutputKey(request.outputKey)
    let root: string
    try {
      root = await realpath(this.outputRoot)
    } catch {
      throw new DomainError(
        'PERSISTENCE_NOT_CONFIGURED',
        'Render output storage root is unavailable',
      )
    }
    const requestedPath = resolve(root, ...outputKey.split('/'))
    await mkdir(dirname(requestedPath), { recursive: true })
    const canonicalParent = await realpath(dirname(requestedPath))
    const finalPath = resolve(canonicalParent, basename(requestedPath))
    if (!contained(root, finalPath)) {
      throw new DomainError('RENDER_OUTPUT_CONFLICT', 'Render output escaped its storage root')
    }
    if (await exists(finalPath)) {
      throw new DomainError('RENDER_OUTPUT_CONFLICT', 'Render output already exists')
    }

    const stageId = this.createId().trim()
    if (!/^[A-Za-z0-9_-]{3,128}$/.test(stageId)) {
      throw new DomainError('INVALID_ARGUMENT', 'Render stage ID is invalid')
    }
    const partialPath = resolve(
      canonicalParent,
      `.${basename(finalPath, '.mp4')}.${stageId}.partial.mp4`,
    )
    const scriptPath = resolve(this.projectRoot, 'remotion', 'scripts', 'render-materialized.mjs')
    const workingDirectory = resolve(this.projectRoot, 'remotion')
    try {
      await runRenderWorker({
        scriptPath,
        workingDirectory,
        request: {
          schemaVersion: 'apollo-remotion-render-request/v1',
          outputPath: partialPath,
          width: input.output.width,
          height: input.output.height,
          fps: input.output.fps,
          durationInFrames: input.output.durationInFrames,
          inputProps,
        },
        timeoutMs: this.timeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
      })
      const metadata = await stat(partialPath)
      if (!metadata.isFile() || metadata.size <= 0 || !Number.isSafeInteger(metadata.size)) {
        throw new DomainError('RENDER_OUTPUT_INVALID', 'Remotion produced an invalid output')
      }
      const probe = await probeVideo(partialPath)
      const expectedDuration = input.output.durationInFrames / input.output.fps
      if (
        probe.width !== input.output.width ||
        probe.height !== input.output.height ||
        Math.abs(probe.fps - input.output.fps) > 0.01 ||
        Math.abs(probe.duration - expectedDuration) > Math.max(0.1, 1 / input.output.fps)
      ) {
        throw new DomainError('RENDER_OUTPUT_INVALID', 'Remotion output failed technical validation')
      }
      const outputSha256 = await calculateFileSha256(partialPath)
      const verifiedMetadata = await stat(partialPath)
      if (
        verifiedMetadata.size !== metadata.size ||
        verifiedMetadata.mtimeMs !== metadata.mtimeMs ||
        verifiedMetadata.dev !== metadata.dev ||
        verifiedMetadata.ino !== metadata.ino
      ) {
        throw new DomainError('RENDER_OUTPUT_INVALID', 'Render output changed during validation')
      }
      const receipt: Readonly<StagedRenderReceipt> = Object.freeze({
        schemaVersion: 'staged-render-receipt/v1',
        stageId,
        inputHash: input.inputHash,
        outputSha256,
        byteSize: metadata.size,
        width: probe.width,
        height: probe.height,
        fps: probe.fps,
        durationInFrames: input.output.durationInFrames,
        codec: 'h264',
        container: 'mp4',
      })
      let state: 'staged' | 'committed' | 'discarded' = 'staged'
      let committedReceipt: Readonly<CommittedRenderReceipt> | null = null
      const clock = this.clock
      return Object.freeze({
        receipt,
        async commit() {
          if (state === 'committed' && committedReceipt) return committedReceipt
          if (state !== 'staged') {
            throw new DomainError('RENDER_OUTPUT_CONFLICT', 'Staged render is no longer available')
          }
          if (await exists(finalPath)) {
            throw new DomainError('RENDER_OUTPUT_CONFLICT', 'Render output already exists')
          }
          const commitMetadata = await stat(partialPath)
          if (
            commitMetadata.size !== verifiedMetadata.size ||
            commitMetadata.mtimeMs !== verifiedMetadata.mtimeMs ||
            commitMetadata.dev !== verifiedMetadata.dev ||
            commitMetadata.ino !== verifiedMetadata.ino
          ) {
            throw new DomainError('RENDER_OUTPUT_INVALID', 'Render output changed before promotion')
          }
          const committedAt = clock()
          if (Number.isNaN(committedAt.getTime())) {
            throw new DomainError('RENDER_OUTPUT_INVALID', 'Render commit clock is invalid')
          }
          try {
            await rename(partialPath, finalPath)
          } catch {
            throw new DomainError(
              'RENDER_OUTPUT_PROMOTION_FAILED',
              'Render output could not be promoted',
            )
          }
          state = 'committed'
          committedReceipt = Object.freeze({
            ...receipt,
            schemaVersion: 'committed-render-receipt/v1',
            committedAt: committedAt.toISOString(),
          })
          return committedReceipt
        },
        async discard() {
          if (state !== 'staged') return
          try {
            await rm(partialPath, { force: true })
            state = 'discarded'
          } catch {
            throw new DomainError(
              'RENDER_OUTPUT_CLEANUP_FAILED',
              'Partial render output could not be removed',
            )
          }
        },
        toJSON() {
          return receipt
        },
      })
    } catch (error) {
      try {
        await rm(partialPath, { force: true })
      } catch {
        throw new DomainError(
          'RENDER_OUTPUT_CLEANUP_FAILED',
          'Partial render output could not be removed after failure',
        )
      }
      throw error
    }
  }
}
