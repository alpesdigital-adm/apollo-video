import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import type {
  PixelOracle, PixelOracleAnalysis, PixelOracleFrameResult, PixelOracleRegistration,
} from '../../application/ports/mp4-pixel-critic.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  decodeRetail0004Output, decodeV9Output, PIXEL_ORACLE_MODELS, PIXEL_ORACLE_PROTOCOL, type OracleModelReading,
} from '../../domain/pixel-face-oracle.ts'

/**
 * Node side of the W67 pixel oracle: one bounded child process per batch (no shell, no network), the bridge and the interpreter hashed
 * before the run and again by the bridge itself. The response is distrusted: every box is recomputed here from the raw tensors with the
 * TypeScript twin of the V9 policy, and a response that names other model digests than the pinned ones is refused.
 */
export const PIXEL_ORACLE_MAX_FRAMES_PER_BATCH = 120
const MAX_FRAMES_PER_BATCH = PIXEL_ORACLE_MAX_FRAMES_PER_BATCH
const MAX_RESPONSE_BYTES = 12_000_000
const MAX_STDERR_BYTES = 64_000
const SHA = /^[a-f0-9]{64}$/
const FRAME_FILE = /^[A-Za-z0-9._-]{1,76}\.png$/

export type OpenvinoPixelOracleConfig = Readonly<{
  pythonExecutable: string
  pythonExecutableSha256: string
  /** Private package root holding openvino, opencv and numpy (PYTHONPATH of the child). */
  pythonModulePath: string
  v9ModelDirectory: string
  retailModelDirectory: string
  bridgePath: string
  bridgeSha256: string
  timeoutMs?: number
  /** Optional pinned inventory of `pythonModulePath` (see FaceRuntimeInventory); verified before every batch. */
  runtimeInventory?: Readonly<{ verify: () => Promise<void>; manifestSha256: string }>
}>

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
const denied = (code: string): never => { throw new DomainError('RENDER_OUTPUT_INVALID', `Pixel oracle refused: ${code}`) }

type BridgeFrame = Readonly<{
  id: string; sha256: string; status: 'ok' | 'error'; reason: string | null; width: number | null; height: number | null
  v9?: Readonly<{ rawOutputBase64: string | null; rawOutputSha256: string | null; reason?: string }>
  retail?: Readonly<{ rawOutputBase64: string | null; rawOutputSha256: string | null; reason?: string }>
}>

export class OpenvinoPixelOracle implements PixelOracle {
  readonly models = Object.freeze([{ id: PIXEL_ORACLE_MODELS.v9.id }, { id: PIXEL_ORACLE_MODELS.retail.id }])
  private readonly config: OpenvinoPixelOracleConfig

  constructor(config: OpenvinoPixelOracleConfig) {
    for (const path of [config.pythonExecutable, config.pythonModulePath, config.v9ModelDirectory, config.retailModelDirectory, config.bridgePath]) {
      if (typeof path !== 'string' || !isAbsolute(path)) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Pixel oracle paths must be absolute')
    }
    if (!SHA.test(config.pythonExecutableSha256) || !SHA.test(config.bridgeSha256)) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Pixel oracle hashes are invalid')
    this.config = Object.freeze({ ...config })
  }

  /** One bounded batch: the caller (the critic) keeps each registration's two frames in the same batch. */
  async analyze(request: Parameters<PixelOracle['analyze']>[0]): Promise<Readonly<PixelOracleAnalysis>> {
    return this.runBatch(request.framesDirectory, request.frames, request.pairs, request.signal)
  }

  private async runBatch(
    framesDirectory: string,
    frames: Parameters<PixelOracle['analyze']>[0]['frames'],
    pairs: Parameters<PixelOracle['analyze']>[0]['pairs'],
    signal: AbortSignal | undefined,
  ): Promise<PixelOracleAnalysis> {
    if (!isAbsolute(framesDirectory) || frames.length < 1 || frames.length > MAX_FRAMES_PER_BATCH) denied('REQUEST_INVALID')
    for (const frame of frames) if (!FRAME_FILE.test(frame.file) || frame.id.length < 1 || frame.id.length > 80) denied('FRAME_ENTRY_INVALID')
    if (signal?.aborted) denied('CANCELLED')
    const [python, bridge] = await Promise.all([hashFile(this.config.pythonExecutable), hashFile(this.config.bridgePath)])
    if (python !== this.config.pythonExecutableSha256 || bridge !== this.config.bridgeSha256) denied('RUNTIME_HASH_MISMATCH')
    await this.config.runtimeInventory?.verify()
    const hashes = await Promise.all(frames.map((frame) => hashFile(join(framesDirectory, frame.file))))
    const payload = JSON.stringify({
      protocol: PIXEL_ORACLE_PROTOCOL, framesDirectory,
      frames: frames.map((frame, index) => ({ id: frame.id, file: frame.file, sha256: hashes[index] })),
      pairs: pairs.map((pair) => ({ id: pair.id, sourceId: pair.sourceId, outputId: pair.outputId })),
    })
    const child = spawn(this.config.pythonExecutable, [this.config.bridgePath, this.config.v9ModelDirectory, this.config.retailModelDirectory,
      this.config.bridgeSha256, this.config.pythonExecutableSha256], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONPATH: this.config.pythonModulePath, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
    })
    let failure: string | undefined
    const chunks: Buffer[] = []
    let outputBytes = 0, errorBytes = 0
    const stop = (reason: string) => { failure ??= reason; if (child.pid !== undefined) child.kill('SIGKILL') }
    const closed = new Promise<number | null>((resolve) => { child.once('error', () => { failure ??= 'PROCESS_ERROR' }); child.once('close', resolve) })
    child.stdout.on('data', (chunk: Buffer) => { outputBytes += chunk.byteLength; if (outputBytes > MAX_RESPONSE_BYTES) stop('RESPONSE_TOO_LARGE'); else chunks.push(chunk) })
    const stderrChunks: Buffer[] = []
    child.stderr.on('data', (chunk: Buffer) => { errorBytes += chunk.byteLength; if (errorBytes > MAX_STDERR_BYTES) stop('STDERR_TOO_LARGE'); else stderrChunks.push(chunk) })
    child.stdin.on('error', () => { /* an early bridge exit is reported by its close status */ })
    const cancel = () => stop('CANCELLED')
    signal?.addEventListener('abort', cancel, { once: true })
    const timeout = setTimeout(() => stop('TIMEOUT'), this.config.timeoutMs ?? 180_000)
    child.stdin.end(payload)
    let exitCode: number | null
    try { exitCode = await closed } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel) }
    if (failure) denied(failure)
    if (exitCode !== 0) {
      // The bridge names its refusal as `{ error: CODE }` on stdout; the code (never a path or a payload) is what an operator needs.
      let code = 'BRIDGE_EXIT_NONZERO'
      try { const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: unknown }; if (typeof parsed.error === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(parsed.error)) code = `BRIDGE_${parsed.error}` } catch { /* keep the generic code */ }
      if (code === 'BRIDGE_EXIT_NONZERO') code = `${code}:${Buffer.concat(stderrChunks).toString('utf8').trim().split(/\r?\n/).at(-1)?.trim().slice(0, 160) ?? ''}`
      denied(code)
    }
    let response: Record<string, unknown>
    try { response = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> } catch { return denied('RESPONSE_INVALID_JSON') }
    if (response.protocol !== PIXEL_ORACLE_PROTOCOL || response.bridgeSha256 !== this.config.bridgeSha256 || response.pythonSha256 !== this.config.pythonExecutableSha256) {
      denied('RESPONSE_IDENTITY_MISMATCH')
    }
    const models = response.models as Record<string, { xmlSha256?: string; binSha256?: string }> | undefined
    if (models?.v9?.xmlSha256 !== PIXEL_ORACLE_MODELS.v9.xmlSha256 || models?.v9?.binSha256 !== PIXEL_ORACLE_MODELS.v9.binSha256 ||
        models?.retail?.xmlSha256 !== PIXEL_ORACLE_MODELS.retail.xmlSha256 || models?.retail?.binSha256 !== PIXEL_ORACLE_MODELS.retail.binSha256) {
      denied('RESPONSE_MODEL_MISMATCH')
    }
    const bridgeFrames = response.frames as readonly BridgeFrame[]
    if (!Array.isArray(bridgeFrames) || bridgeFrames.length !== frames.length) denied('RESPONSE_FRAME_COUNT_MISMATCH')
    const results = bridgeFrames.map((frame, index): PixelOracleFrameResult => {
      if (frame.id !== frames[index]!.id || frame.sha256 !== hashes[index]) denied('RESPONSE_FRAME_MISMATCH')
      if (frame.status !== 'ok') {
        return Object.freeze({ id: frame.id, sha256: frame.sha256, status: 'error' as const, reason: frame.reason ?? 'FRAME_ERROR', width: null, height: null, readings: Object.freeze([]) })
      }
      const reading = (decode: (raw: Uint8Array) => OracleModelReading, part: BridgeFrame['v9'], modelId: OracleModelReading['modelId']): OracleModelReading => {
        if (!part || part.rawOutputBase64 === null) {
          return Object.freeze({ modelId, status: 'unknown' as const, reason: part?.reason ?? 'FACE_INFERENCE_FAILED', boxes: Object.freeze([]) as readonly [], rawOutputSha256: null })
        }
        const raw = new Uint8Array(Buffer.from(part.rawOutputBase64, 'base64'))
        const decoded = decode(raw)
        if (decoded.rawOutputSha256 !== part.rawOutputSha256) denied('RESPONSE_TENSOR_HASH_MISMATCH')
        return decoded
      }
      return Object.freeze({
        id: frame.id, sha256: frame.sha256, status: 'ok' as const, reason: null, width: frame.width, height: frame.height,
        readings: Object.freeze([reading(decodeV9Output, frame.v9, PIXEL_ORACLE_MODELS.v9.id), reading(decodeRetail0004Output, frame.retail, PIXEL_ORACLE_MODELS.retail.id)]),
      })
    })
    const registrations = ((response.registrations ?? []) as readonly Record<string, unknown>[]).map((entry): PixelOracleRegistration => Object.freeze({
      id: String(entry.id), sourceId: String(entry.sourceId), outputId: String(entry.outputId),
      status: entry.status === 'ok' ? 'ok' as const : 'failed' as const, reason: typeof entry.reason === 'string' ? entry.reason : null,
      matches: Number(entry.matches ?? 0), inliers: Number(entry.inliers ?? 0),
      matrix: Array.isArray(entry.matrix) ? (entry.matrix as [[number, number, number], [number, number, number]]) : null,
      medianResidualPixels: typeof entry.medianResidualPixels === 'number' ? entry.medianResidualPixels : null,
      scale: typeof entry.scale === 'number' ? entry.scale : null,
      rotationDegrees: typeof entry.rotationDegrees === 'number' ? entry.rotationDegrees : null,
    }))
    const runtime = (response.runtime ?? {}) as Record<string, string>
    return Object.freeze({
      receipt: Object.freeze({ protocol: PIXEL_ORACLE_PROTOCOL, bridgeSha256: bridge, pythonSha256: python, runtime: Object.freeze({ ...runtime }) }),
      frames: Object.freeze(results), registrations: Object.freeze(registrations),
    })
  }
}

export async function readFileSha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}
