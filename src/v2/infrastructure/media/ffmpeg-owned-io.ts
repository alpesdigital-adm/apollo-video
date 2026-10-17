import * as disk from 'node:fs/promises'
import { createReadStream, type ReadStream, type MakeDirectoryOptions } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { FileHandle } from 'node:fs/promises'
import { DomainError } from '../../domain/errors.ts'

export type OwnedIoPhase = 'work' | 'archive' | 'cleanup'
export interface OwnedIoKey { runId: string; operation: string; executionId: string }
interface IoRecord {
  actionPromise: Promise<unknown> | null; key: Readonly<OwnedIoKey>; kind: 'io' | 'observation'; phase: OwnedIoPhase; deadline: number; expired: boolean; actionSettled: boolean
  resources: Set<object>; destroyers: Set<() => void>; errors: Error[]; primaryIoError: Error | null; valueSettled: boolean
}
const records = new Map<string, IoRecord>()
const asError = (value: unknown): Error => value instanceof Error ? value : new Error(String(value))
export class OwnedIoAdmissionFailure extends DomainError { readonly noIoStarted = true }
export class OwnedIoInconclusive extends DomainError {
  readonly ownerKey: Readonly<OwnedIoKey>
  readonly ioSettled = false
  readonly closeObserved = false
  get processCloseObserved(): boolean { return this.#record.kind === 'observation' }
  get observationSettled(): false | null { return this.#record.kind === 'observation' ? false : null }
  readonly ioFailures: readonly Error[]
  readonly #record: IoRecord
  get primaryIoError(): Error | null { return this.#record.primaryIoError }
  constructor(record: IoRecord) {
    super('RENDER_EXECUTION_FAILED', 'Owned IO settlement or close is inconclusive')
    this.ownerKey = record.key; this.ioFailures = record.errors; this.#record = record
  }
  recordIoFailure(error: unknown): void { (this.ioFailures as Error[]).push(asError(error)) }
}
export function pendingOwnedIo(): readonly Readonly<{ ownerKey: Readonly<OwnedIoKey>; ioSettled: false; closeObserved: false; processCloseObserved: boolean; observationSettled: false | null }>[] {
  return Object.freeze([...records.values()].filter((item) => item.expired && (!item.actionSettled || item.resources.size))
    .map((item) => Object.freeze({ ownerKey: item.key, ioSettled: false as const, closeObserved: false as const, processCloseObserved: item.kind === 'observation', observationSettled: item.kind === 'observation' ? false as const : null })))
}
export function assertOwnedIoAdmission(): void {
  if (pendingOwnedIo().length) throw new OwnedIoAdmissionFailure('RENDER_EXECUTION_FAILED', 'Previous owned IO still lacks settlement or close')
}
// A late observer is contractually synchronous/memory-only. If an invalid
// callback returns an already-started promise, retain it without authorizing
// further IO or renewing its expired deadline. No handle escapes this ledger.
export function retainUnexpectedLateObservation(key: Readonly<OwnedIoKey>, promise: PromiseLike<unknown>, deadline: number, errors: Error[]): void {
  const record: IoRecord = { actionPromise: null, key, kind: 'observation', phase: 'archive', deadline, expired: true,
    actionSettled: false, resources: new Set(), destroyers: new Set(), errors, primaryIoError: null, valueSettled: false }
  records.set(key.executionId, record)
  record.actionPromise = Promise.resolve(promise).then(() => { record.valueSettled = true }, (error) => { record.errors.push(asError(error)) })
    .finally(() => { record.actionSettled = true; records.delete(key.executionId) })
}
interface IoContext {
  ensure: () => void
  track: (resource: object) => void
  closed: (resource: object) => void
  destroy: (callback: () => void) => void
  error: (error: unknown) => void
}
interface IoDependencies {
  open?: typeof disk.open; mkdir?: typeof disk.mkdir; stat?: typeof disk.stat
  realpath?: typeof disk.realpath; rm?: typeof disk.rm; stream?: typeof createReadStream
}
/** Private retained operations, not cancellable promise fiction. The caller is
 * bounded; underlying promises/handles remain in the ledger until settlement and
 * real close. A late open can only close, and never begins a late read or write.
 * No new evidence write is authorized after hardEnd; late facts stay in memory. */
export class OwnedDeadlineIo {
  readonly #runId: string
  readonly #workEnd: number
  readonly #hardEnd: number
  readonly #signal: AbortSignal | undefined
  readonly #otherAdmission: (() => void) | undefined
  readonly #dependencies: IoDependencies
  readonly #history: IoRecord[] = []
  #failed = false
  constructor(input: { runId: string; workEndMonotonicMs: number; hardEndMonotonicMs: number;
    signal?: AbortSignal; otherAdmission?: () => void; dependencies?: IoDependencies }) {
    const admittedAt = performance.now()
    if (!Number.isFinite(admittedAt) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.runId) || !Number.isFinite(input.workEndMonotonicMs) ||
      !Number.isFinite(input.hardEndMonotonicMs) || input.hardEndMonotonicMs <= input.workEndMonotonicMs || input.hardEndMonotonicMs > input.workEndMonotonicMs + 5000 ||
      input.hardEndMonotonicMs > admittedAt + 180000)
      throw new OwnedIoAdmissionFailure('INVALID_RENDER_INPUT', 'Owned IO requires predeclared work and hard deadlines')
    this.#runId = input.runId; this.#workEnd = input.workEndMonotonicMs; this.#hardEnd = input.hardEndMonotonicMs
    this.#signal = input.signal; this.#otherAdmission = input.otherAdmission; this.#dependencies = input.dependencies ?? {}
  }
  facts() {
    return this.#history.map((record) => ({ ownerKey: record.key, phase: record.phase, processCloseObserved: record.kind === 'observation', observationSettled: record.kind === 'observation' ? record.actionSettled : null, deadlineMonotonicMs: record.deadline,
      expired: record.expired, actionSettled: record.actionSettled, closeObserved: record.resources.size === 0,
      outcome: record.expired ? 'failed' : record.valueSettled && !record.errors.length ? 'settled' : 'failed',
      errors: record.errors.map((error) => ({ name: error.name, messageSha256: createHash('sha256').update(error.message).digest('hex'),
        messageBytes: Buffer.byteLength(error.message) })) }))
  }
  isRetained(): boolean { return this.#failed || this.hasPending() }
  async observe(operation: string, callback: () => void | Promise<void>): Promise<void> {
    return this.#run(operation, async () => callback(), 'archive', 'observation')
  }
  async wait<T>(operation: string, promise: Promise<T>, phase: OwnedIoPhase = 'archive'): Promise<T> {
    return this.#run(operation, async () => promise, phase)
  }
  hasPending(): boolean { return this.#history.some((item) => !item.actionSettled || item.resources.size > 0) }
  assertCleanup(): void {
    assertOwnedIoAdmission()
    if (this.#failed || this.hasPending()) throw new OwnedIoAdmissionFailure('RENDER_EXECUTION_FAILED', 'Owned IO cleanup is retained')
  }
  async #run<T>(operation: string, action: (context: IoContext) => Promise<T>, phase: OwnedIoPhase, kind: 'io' | 'observation' = 'io'): Promise<T> {
    const deadline = phase === 'work' ? this.#workEnd : this.#hardEnd
    assertOwnedIoAdmission()
    if (phase !== 'archive') this.#otherAdmission?.()
    if (this.#failed || this.#signal?.aborted || performance.now() >= deadline)
      throw new OwnedIoAdmissionFailure('RENDER_EXECUTION_FAILED', 'Owned IO admission expired or is retained')
    const record: IoRecord = { actionPromise: null, kind, key: Object.freeze({ runId: this.#runId, operation, executionId: randomUUID() }), phase, deadline,
      expired: false, actionSettled: false, resources: new Set(), destroyers: new Set(), errors: [], primaryIoError: null, valueSettled: false }
    this.#history.push(record); records.set(record.key.executionId, record)
    return new Promise<T>((resolve, reject) => {
      let callerSettled = false
      const release = () => { if (record.actionSettled && !record.resources.size) records.delete(record.key.executionId) }
      const expire = () => {
        if (callerSettled) return
        record.expired = true; this.#failed = true; callerSettled = true
        for (const destroy of record.destroyers) { try { destroy() } catch (error) { record.errors.push(asError(error)) } }
        reject(new OwnedIoInconclusive(record))
      }
      const timer = setTimeout(expire, Math.max(0, deadline - performance.now()))
      this.#signal?.addEventListener('abort', expire, { once: true })
      const context: IoContext = {
        ensure: () => {
          if (record.expired || this.#signal?.aborted || performance.now() >= deadline) {
            expire(); throw new OwnedIoAdmissionFailure('RENDER_EXECUTION_FAILED', 'No continuation IO is authorized after its deadline')
          }
        },
        track: (resource) => { record.resources.add(resource) },
        closed: (resource) => { record.resources.delete(resource); release() },
        destroy: (callback) => { record.destroyers.add(callback); if (record.expired) callback() },
        error: (error) => { const value = asError(error); record.primaryIoError ??= value; record.errors.push(value) },
      }
      // Handler stays attached after timeout. It never writes evidence or turns
      // the expired result green; no abandoned Promise.race exists here.
      const finish = (value: T | undefined, error: unknown, failed: boolean) => {
        if (failed) context.error(error)
        if (!callerSettled && performance.now() >= deadline) expire()
        record.actionSettled = true; record.valueSettled = !failed
        clearTimeout(timer); this.#signal?.removeEventListener('abort', expire)
        if (record.resources.size && !callerSettled) { record.expired = true; this.#failed = true; callerSettled = true; reject(new OwnedIoInconclusive(record)) }
        release()
        if (!callerSettled) { callerSettled = true; if (failed) reject(error); else resolve(value as T) }
      }
      record.actionPromise = Promise.resolve().then(() => { context.ensure(); return action(context) })
        .then((value) => finish(value, null, false), (error) => finish(undefined, error, true))
        .catch((error) => { context.error(error); expire() })
    })
  }
  async mkdir(path: string, options: MakeDirectoryOptions, phase: OwnedIoPhase = 'work'): Promise<void> {
    await this.#run('mkdir', async (context) => { context.ensure(); await (this.#dependencies.mkdir ?? disk.mkdir)(path, options) }, phase)
  }
  async stat(path: string, phase: OwnedIoPhase = 'work') { return this.#run('stat', async (context) => { context.ensure(); return (this.#dependencies.stat ?? disk.stat)(path, { bigint: true }) }, phase) }
  async realpath(path: string, phase: OwnedIoPhase = 'work'): Promise<string> { return this.#run('realpath', async (context) => { context.ensure(); return (this.#dependencies.realpath ?? disk.realpath)(path) }, phase) }
  async rm(path: string, phase: OwnedIoPhase = 'cleanup'): Promise<void> {
    this.assertCleanup(); await this.#run('rm', async (context) => { context.ensure(); await (this.#dependencies.rm ?? disk.rm)(path, { recursive: true, force: false }) }, phase)
  }
  async #close(handle: FileHandle, context: IoContext): Promise<void> {
    // Closing an already admitted handle is containment, even after hardEnd.
    try { await handle.close(); context.closed(handle) } catch (error) { context.error(error); throw error }
  }
  async writeExclusive(path: string, bytes: Buffer | string, phase: OwnedIoPhase = 'work'): Promise<void> {
    await this.#run('write', async (context) => {
      const handle = await (this.#dependencies.open ?? disk.open)(path, 'wx', 0o600); context.track(handle)
      let primary: unknown
      try { context.ensure(); await handle.writeFile(bytes) } catch (error) { primary = error; context.error(error) }
      try { await this.#close(handle, context) } catch (error) { primary ??= error }
      if (primary !== undefined) throw primary
    }, phase)
  }
  async readBounded(path: string, maxBytes: number, phase: OwnedIoPhase = 'work'): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new OwnedIoAdmissionFailure('INVALID_RENDER_INPUT', 'Owned read bound is invalid')
    return this.#run('read', async (context) => {
      const handle = await (this.#dependencies.open ?? disk.open)(path, 'r'); context.track(handle)
      let primary: unknown, value = Buffer.alloc(0)
      try {
        context.ensure(); const chunks: Buffer[] = []; let size = 0
        while (true) {
          context.ensure(); const buffer = Buffer.alloc(Math.min(65536, maxBytes + 1 - size))
          const result = await handle.read(buffer, 0, buffer.length, null)
          if (!result.bytesRead) break
          size += result.bytesRead
          if (size > maxBytes) throw new DomainError('INVALID_RENDER_INPUT', 'Owned read exceeded its byte bound')
          chunks.push(buffer.subarray(0, result.bytesRead))
        }
        context.ensure(); value = Buffer.concat(chunks)
      } catch (error) { primary = error; context.error(error) }
      try { await this.#close(handle, context) } catch (error) { primary ??= error }
      if (primary !== undefined) throw primary
      return value
    }, phase)
  }
  async hashFile(path: string, maxBytes: number): Promise<{ sha256: string; byteSize: number }> {
    // Empty archived stdout/stderr has a legitimate exact zero-byte pin.
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new OwnedIoAdmissionFailure('INVALID_RENDER_INPUT', 'Owned hash bound is invalid')
    return this.#run('hash', async (context) => {
      const stream: ReadStream = (this.#dependencies.stream ?? createReadStream)(path); context.track(stream)
      let resolveClose!: () => void
      const closed = new Promise<void>((resolve) => { resolveClose = resolve })
      stream.once('close', () => { context.closed(stream); resolveClose() })
      context.destroy(() => stream.destroy())
      const digest = createHash('sha256'); let size = 0
      try {
        for await (const chunk of stream) {
          context.ensure(); const bytes = Buffer.from(chunk); size += bytes.length
          if (size > maxBytes) throw new DomainError('INVALID_RENDER_INPUT', 'Owned hash exceeded its byte bound')
          digest.update(bytes)
        }
        context.ensure(); return { sha256: digest.digest('hex'), byteSize: size }
      } catch (error) { context.error(error); throw error } finally { stream.destroy(); await closed }
    }, 'work')
  }
}
