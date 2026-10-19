import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { DomainError } from '../../domain/errors.ts'
import { assertOwnedIoAdmission, OwnedIoAdmissionFailure, OwnedDeadlineIo, retainUnexpectedLateObservation } from './ffmpeg-owned-io.ts'

export const INSPECTOR_PROCESS_TIMEOUT_MS = 120_000
export const INSPECTOR_PROCESS_MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_TERMINATION_RESERVE_MS = 1_000
export interface OwnedFfmpegOwnerKey { runId: string; operation: string; executionId: string }
export interface OwnedFfmpegProcessObservation {
  runId: string; operation: string; ownerKey: Readonly<OwnedFfmpegOwnerKey>; pid: number | null
  spawnObserved: boolean; closeObserved: boolean; exitCode: number | null; signal: NodeJS.Signals | null
  stdoutBytes: number; stderrBytes: number; capturedStdoutBytes: number; capturedStderrBytes: number
  stdout: Buffer; stderr: Buffer
  aborted: boolean; timedOut: boolean; outputExceeded: boolean
}
export interface OwnedFfmpegProcessOptions {
  executable: string; args: readonly string[]
  owner: Readonly<{ runId: string; operation: string }>
  signal?: AbortSignal
  deadlineMonotonicMs?: number
  timeoutMs?: number; maxOutputBytes?: number
  environment?: NodeJS.ProcessEnv
  /** Late close: synchronous memory-only diagnostics; never starts IO. */
  observeLateClose?: (result: Readonly<OwnedFfmpegProcessObservation>) => void
  observe?: (result: Readonly<OwnedFfmpegProcessObservation>) => void | Promise<void>
  messages?: Readonly<{ cancelled: string; timeout: string; overflow: string; failed: string }>
}
export interface OwnedFfmpegExecutor {
  execute(input: OwnedFfmpegProcessOptions): Promise<Readonly<OwnedFfmpegProcessObservation>>
}
export class OwnedFfmpegProcessFailure extends DomainError {
  readonly observation: Readonly<OwnedFfmpegProcessObservation>
  readonly primaryProcessError: Error | null
  readonly ioFailures: readonly Error[]
  recordIoFailure(error: unknown): void { (this.ioFailures as Error[]).push(asError(error)) }
  constructor(code: 'RENDER_EXECUTION_FAILED' | 'RENDER_OUTPUT_INVALID', message: string,
    observation: Readonly<OwnedFfmpegProcessObservation>, primaryProcessError: Error | null = null, ioFailures: readonly Error[] = []) {
    super(code, message); this.observation = observation; this.primaryProcessError = primaryProcessError; this.ioFailures = ioFailures
  }
}
export class OwnedFfmpegAdmissionFailure extends DomainError { readonly noChildStarted = true }
export class OwnedFfmpegTerminalInconclusive extends DomainError {
  readonly closeObserved = false
  readonly ownerKey: Readonly<OwnedFfmpegOwnerKey>
  readonly primaryProcessError: Error
  readonly ioFailures: readonly Error[]
  constructor(ownerKey: Readonly<OwnedFfmpegOwnerKey>, primaryProcessError: Error, ioFailures: readonly Error[]) {
    super('RENDER_EXECUTION_FAILED', 'Owned process terminal close is inconclusive')
    this.ownerKey = ownerKey; this.primaryProcessError = primaryProcessError; this.ioFailures = ioFailures
  }
  recordIoFailure(error: unknown): void { (this.ioFailures as Error[]).push(asError(error)) }
}
interface OwnedChildRecord {
  key: Readonly<OwnedFfmpegOwnerKey>; child: ChildProcess; closePromise: Promise<void>
  resolveClose: () => void; inconclusive: boolean; closed: boolean
}
// This registry spans every executor instance in this Node owner/harness. Handles
// and close promises never escape through a diagnostic owner key. No rescue API,
// bare-PID signal, adopted process or exit-based release exists.
const ownedChildren = new Map<string, OwnedChildRecord>()
export function pendingOwnedFfmpegTerminations(): readonly Readonly<{ ownerKey: Readonly<OwnedFfmpegOwnerKey>; closeObserved: false }>[] {
  return Object.freeze([...ownedChildren.values()].filter((record) => record.inconclusive && !record.closed)
    .map((record) => Object.freeze({ ownerKey: record.key, closeObserved: false as const })))
}
export function assertOwnedFfmpegAdmission(): void {
  try { assertOwnedIoAdmission() } catch (error) {
    if (error instanceof OwnedIoAdmissionFailure) throw new OwnedFfmpegAdmissionFailure('RENDER_EXECUTION_FAILED', 'Previous owned IO blocks process admission')
    throw error
  }
  if (pendingOwnedFfmpegTerminations().length) throw new OwnedFfmpegAdmissionFailure(
    'RENDER_EXECUTION_FAILED', 'A previous owned process still lacks terminal close')
}
const asError = (value: unknown): Error => value instanceof Error ? value : new Error(String(value))

/** Defaults remain 120s/1MiB. Timeout settlement is now explicitly stricter:
 * work plus TERM/KILL/close reserve share min(process limit, absolute deadline).
 * If close is not observed by that boundary, return an inconclusive error while
 * retaining the child/listeners and denying subsequent spawns until real close. */
export class NodeOwnedFfmpegExecutor implements OwnedFfmpegExecutor {
  private readonly dependencies: { spawnChild?: typeof spawn }
  constructor(dependencies: { spawnChild?: typeof spawn } = {}) { this.dependencies = dependencies }
  async execute(input: OwnedFfmpegProcessOptions): Promise<Readonly<OwnedFfmpegProcessObservation>> {
    const timeout = input.timeoutMs ?? INSPECTOR_PROCESS_TIMEOUT_MS
    const maxOutputBytes = input.maxOutputBytes ?? INSPECTOR_PROCESS_MAX_OUTPUT_BYTES
    const now = performance.now(), deadline = Math.min(input.deadlineMonotonicMs ?? now + timeout, now + timeout)
    if (!input.owner || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.owner.runId) ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(input.owner.operation) || !Number.isSafeInteger(timeout) || timeout <= 0 ||
      !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || !Number.isFinite(deadline) ||
      typeof input.executable !== 'string' || !input.executable || input.executable.includes('\0') ||
      !Array.isArray(input.args) || input.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
      throw new OwnedFfmpegAdmissionFailure('INVALID_RENDER_INPUT', 'Owned process requires explicit owner and bounded arguments')
    }
    assertOwnedFfmpegAdmission()
    if (deadline - performance.now() < 2 || input.signal?.aborted) throw new OwnedFfmpegAdmissionFailure(
      'RENDER_EXECUTION_FAILED', 'Owned process admission expired or was cancelled')
    const reserve = Math.min(MAX_TERMINATION_RESERVE_MS, Math.floor((deadline - now) / 2)), workEnd = deadline - reserve
    const messages = input.messages ?? { cancelled: 'Synthetic render inspection was cancelled',
      timeout: 'Synthetic render inspection timed out', overflow: 'Synthetic render inspection output exceeded its limit',
      failed: 'Synthetic render full decode failed' }
    return new Promise((resolvePromise, reject) => {
      assertOwnedFfmpegAdmission()
      if (performance.now() >= workEnd || input.signal?.aborted) return reject(new OwnedFfmpegAdmissionFailure(
        'RENDER_EXECUTION_FAILED', 'Owned process admission expired or was cancelled'))
      let child: ChildProcess
      try { child = (this.dependencies.spawnChild ?? spawn)(input.executable, [...input.args], { windowsHide: true, shell: false,
        stdio: ['ignore', 'pipe', 'pipe'], ...(input.environment ? { env: input.environment } : {}) }) }
      catch (error) { return reject(new OwnedFfmpegAdmissionFailure('RENDER_EXECUTION_FAILED', 'Owned process spawn failed before child admission: ' + asError(error).name)) }
      const ownerKey = Object.freeze({ ...input.owner, executionId: randomUUID() })
      let resolveClose!: () => void
      const closePromise = new Promise<void>((resolve) => { resolveClose = resolve })
      const record: OwnedChildRecord = { key: ownerKey, child, closePromise, resolveClose, inconclusive: false, closed: false }
      ownedChildren.set(ownerKey.executionId, record)
      const stdout: Buffer[] = [], stderr: Buffer[] = [], ioFailures: Error[] = []
      let stdoutBytes = 0, stderrBytes = 0, capturedBytes = 0, spawned = false, exitObserved = false, settled = false
      let aborted = false, timedOut = false, outputExceeded = false, stopping = false
      let primaryProcessError: Error | null = null, killTimer: ReturnType<typeof setTimeout> | undefined
      const signal = (value: NodeJS.Signals) => {
        // Even a retained handle is never signalled after observed exit.
        if (!spawned || record.closed || exitObserved || performance.now() >= deadline) return
        try { if (!child.kill(value)) ioFailures.push(new Error('Owned child did not accept ' + value)) }
        catch (error) { ioFailures.push(asError(error)) }
      }
      const stop = () => {
        if (stopping || !spawned || record.closed) return
        stopping = true; signal('SIGTERM')
        const remaining = deadline - performance.now()
        if (remaining > 0) killTimer = setTimeout(() => signal('SIGKILL'), Math.min(500, Math.max(0, remaining / 2)))
      }
      const abort = () => { aborted = true; primaryProcessError ??= new DomainError('RENDER_EXECUTION_FAILED', messages.cancelled); stop() }
      const workTimer = setTimeout(() => { timedOut = true; primaryProcessError ??= new DomainError('RENDER_OUTPUT_INVALID', messages.timeout); stop() }, Math.max(0, workEnd - performance.now()))
      const endTimer = setTimeout(() => {
        if (record.closed || settled) return
        settled = true; record.inconclusive = true
        primaryProcessError ??= new DomainError('RENDER_OUTPUT_INVALID', messages.timeout)
        // Listeners, streams, handle and closePromise intentionally remain owned.
        reject(new OwnedFfmpegTerminalInconclusive(ownerKey, primaryProcessError, ioFailures))
      }, Math.max(0, deadline - performance.now()))
      input.signal?.addEventListener('abort', abort, { once: true })
      if (input.signal?.aborted) abort()
      child.once('spawn', () => { spawned = true; if (primaryProcessError) stop() })
      child.once('exit', () => { exitObserved = true })
      const append = (target: Buffer[], chunk: Buffer, stream: 'stdout' | 'stderr') => {
        if (stream === 'stdout') stdoutBytes += chunk.byteLength; else stderrBytes += chunk.byteLength
        const take = Math.min(chunk.byteLength, Math.max(0, maxOutputBytes - capturedBytes))
        if (take) { target.push(Buffer.from(chunk.subarray(0, take))); capturedBytes += take }
        if (stdoutBytes + stderrBytes > maxOutputBytes) {
          outputExceeded = true; primaryProcessError ??= new DomainError('RENDER_OUTPUT_INVALID', messages.overflow); stop()
        }
      }
      child.stdout?.on('data', (chunk: Buffer) => append(stdout, chunk, 'stdout'))
      child.stderr?.on('data', (chunk: Buffer) => append(stderr, chunk, 'stderr'))
      const ioError = (error: Error) => { ioFailures.push(error); stop() }
      child.stdout?.on('error', ioError); child.stderr?.on('error', ioError)
      child.on('error', (error) => { primaryProcessError ??= error; stop() })
      child.once('close', async (exitCode, closeSignal) => {
        if (performance.now() >= deadline) { timedOut = true; primaryProcessError ??= new DomainError('RENDER_OUTPUT_INVALID', messages.timeout) }
        record.closed = true; clearTimeout(workTimer); clearTimeout(endTimer); if (killTimer) clearTimeout(killTimer)
        input.signal?.removeEventListener('abort', abort)
        record.resolveClose(); ownedChildren.delete(ownerKey.executionId)
        const out = Buffer.concat(stdout), err = Buffer.concat(stderr)
        if (exitCode !== 0 || closeSignal || !spawned) primaryProcessError ??= new DomainError('RENDER_OUTPUT_INVALID', messages.failed)
        const observation = Object.freeze({ ...input.owner, ownerKey, pid: child.pid ?? null,
          spawnObserved: spawned, closeObserved: true, exitCode, signal: closeSignal,
          stdoutBytes, stderrBytes, capturedStdoutBytes: out.length, capturedStderrBytes: err.length,
          stdout: out, stderr: err, aborted, timedOut, outputExceeded })
        if (settled) {
          // No asynchronous observe begins after the process deadline.
          try {
            const returned: unknown = input.observeLateClose?.(observation)
            if (returned && typeof (returned as PromiseLike<unknown>).then === 'function') {
              ioFailures.push(new Error('Late close observer must be synchronous and memory-only'))
              retainUnexpectedLateObservation(ownerKey, returned as PromiseLike<unknown>, deadline, ioFailures)
            }
          } catch (error) { ioFailures.push(asError(error)) }
          return
        }
        try {
          if (input.observe !== undefined) {
          const observationIo = new OwnedDeadlineIo({ runId: input.owner.runId,
            workEndMonotonicMs: deadline - 1, hardEndMonotonicMs: deadline })
          await observationIo.observe('process-observation', () => input.observe?.(observation))
          }
        } catch (error) { ioFailures.push(asError(error)) }
        // A late real close releases admission, but never changes the earlier
        // terminal-inconclusive result into success or replaces its primary error.
        if (settled) return
        settled = true
        if (aborted || timedOut || outputExceeded || primaryProcessError || ioFailures.length || exitCode !== 0 || closeSignal || !spawned) {
          const code = aborted ? 'RENDER_EXECUTION_FAILED' : 'RENDER_OUTPUT_INVALID'
          const detail = err.toString('utf8').trim()
          const message = aborted ? messages.cancelled : timedOut ? messages.timeout : outputExceeded ? messages.overflow : messages.failed + (detail ? ': ' + detail.slice(0, 500) : '')
          return reject(new OwnedFfmpegProcessFailure(code, message, observation, primaryProcessError, ioFailures))
        }
        resolvePromise(observation)
      })
    })
  }
}
