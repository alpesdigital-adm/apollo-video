import { createHash } from 'node:crypto'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import type {
  AsyncMediaProviderAdapter,
  ProviderCapabilities,
  ProviderSubmitContext,
} from '../../application/ports/async-media-provider.ts'
import { calculateCanonicalHash } from '../../domain/canonical-hash.ts'
import { assertDomain } from '../../domain/errors.ts'
import {
  ProviderAdapterError,
  PROVIDER_STATUS_VALUES,
  type ProviderEstimate,
  type ProviderStatus,
  type ProviderSubmissionResult,
} from '../../domain/provider-contract.ts'
import type { HttpTransformationResult } from './http-transformation-provider.ts'

/**
 * MCP transport for a transformation provider.
 *
 * This is a provider *exposed through* MCP — Apollo is the client. It is not
 * the Apollo public MCP server (`src/v2/mcp/server.ts`), which is the opposite
 * direction: there Apollo is the server and an agent is the client. Confusing
 * the two is how an MCP session ends up believed to be a source of state.
 *
 * The load-bearing property here is that **the session is only the wire**.
 * Every call opens a session and closes it in `finally`; nothing about a
 * submitted job survives in the client. Once `submit` returns a
 * `providerJobId`, that identifier is in PostgreSQL and the durable job owns
 * its own future: a disconnected session, a restarted worker or a different
 * process can carry it forward, and closing the session that submitted the work
 * neither cancels it nor loses it.
 *
 * That is why this adapter never holds a long-lived `Client`. A pooled session
 * would quietly become the thing the job depends on, and the first network blip
 * would look like a job failure.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESULT_BYTES = 256 * 1024 * 1024

export interface McpTransformationProviderConfig {
  id: string
  adapterVersion: string
  endpoint: string
  apiKey: string
  modes: readonly string[]
  modelRef?: string
  timeoutMs?: number
  maxResultBytes?: number
  supportsCancellation?: boolean
  priceFixedMinorUnits?: number
  pricePerSecondMinorUnits?: number
  currency?: string
  /** Reports the session id of every call, so the durable job can record it. */
  onSession?: (sessionId: string | undefined) => void
}

function toolFailure(name: string, error: unknown): ProviderAdapterError {
  if (error instanceof ProviderAdapterError) return error
  // MCP transport failures are retryable by default: the durable deadline, not
  // an optimistic guess here, decides when to stop trying.
  return new ProviderAdapterError('PROVIDER_MCP_CALL_FAILED', true, undefined, `Provider MCP tool ${name} did not complete`)
}

function structuredResult(result: unknown, tool: string): Record<string, unknown> {
  const envelope = result as { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }>; isError?: boolean }
  if (envelope?.isError) {
    throw new ProviderAdapterError('PROVIDER_MCP_TOOL_ERROR', false, undefined, `Provider MCP tool ${tool} reported an error`)
  }
  if (envelope?.structuredContent && typeof envelope.structuredContent === 'object') {
    return envelope.structuredContent as Record<string, unknown>
  }
  const text = envelope?.content?.find((entry) => entry?.type === 'text')?.text
  if (typeof text !== 'string') {
    throw new ProviderAdapterError('PROVIDER_MALFORMED_RESPONSE', false, undefined, `Provider MCP tool ${tool} returned no readable payload`)
  }
  try {
    const parsed = JSON.parse(text) as unknown
    assertDomain(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), 'INVALID_ARGUMENT', 'payload must be an object')
    return parsed as Record<string, unknown>
  } catch {
    throw new ProviderAdapterError('PROVIDER_MALFORMED_RESPONSE', false, undefined, `Provider MCP tool ${tool} returned malformed JSON`)
  }
}

export class McpTransformationProviderAdapter
implements AsyncMediaProviderAdapter<Readonly<Record<string, unknown>>, HttpTransformationResult> {
  readonly id: string
  readonly adapterVersion: string
  readonly modelRef?: string
  readonly configHash: string

  private readonly endpoint: URL
  private readonly apiKey: string
  private readonly modes: readonly string[]
  private readonly timeoutMs: number
  private readonly maxResultBytes: number
  private readonly cancellable: boolean
  private readonly priceFixedMinorUnits: number
  private readonly pricePerSecondMinorUnits: number
  private readonly currency: string
  private readonly onSession?: (sessionId: string | undefined) => void

  constructor(config: McpTransformationProviderConfig) {
    const endpoint = new URL(config.endpoint)
    const loopback = LOOPBACK_HOSTS.has(endpoint.hostname)
    assertDomain(
      (endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && loopback)) &&
        !endpoint.username && !endpoint.password && !endpoint.hash,
      'PERSISTENCE_NOT_CONFIGURED',
      'Transformation provider MCP endpoint is invalid',
    )
    assertDomain(config.apiKey.trim().length >= 8, 'PERSISTENCE_NOT_CONFIGURED', 'Transformation provider credential is invalid')
    assertDomain(config.modes.length > 0, 'PERSISTENCE_NOT_CONFIGURED', 'Transformation provider declares no modes')
    this.id = config.id
    this.adapterVersion = config.adapterVersion
    this.modelRef = config.modelRef
    this.endpoint = endpoint
    this.apiKey = config.apiKey.trim()
    this.modes = Object.freeze([...config.modes])
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxResultBytes = config.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES
    this.cancellable = config.supportsCancellation ?? true
    this.priceFixedMinorUnits = config.priceFixedMinorUnits ?? 0
    this.pricePerSecondMinorUnits = config.pricePerSecondMinorUnits ?? 100
    this.currency = config.currency ?? 'USD'
    this.onSession = config.onSession
    this.configHash = calculateCanonicalHash({
      schemaVersion: 'mcp-transformation-provider-config/v1',
      id: this.id,
      adapterVersion: this.adapterVersion,
      endpoint: `${endpoint.origin}${endpoint.pathname}`,
      transport: 'mcp',
      modes: this.modes,
      modelRef: this.modelRef ?? null,
      timeoutMs: this.timeoutMs,
      maxResultBytes: this.maxResultBytes,
      supportsCancellation: this.cancellable,
      price: { currency: this.currency, fixedMinorUnits: this.priceFixedMinorUnits, perSecondMinorUnits: this.pricePerSecondMinorUnits },
    })
  }

  /**
   * Open a session, make one call, close it. The `finally` is the point: an
   * MCP session is a resource with an owner and a lifetime, and leaking one
   * would leave a socket nobody is responsible for.
   */
  private async withSession<T>(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const transport = new StreamableHTTPClientTransport(this.endpoint, {
      requestInit: { headers: { 'x-api-key': this.apiKey } },
    })
    const client = new Client({ name: 'apollo-transformation-client', version: this.adapterVersion })
    try {
      await client.connect(transport)
      this.onSession?.(transport.sessionId)
      const result = await client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: this.timeoutMs,
        ...(signal ? { signal } : {}),
      })
      return structuredResult(result, tool) as T
    } catch (error) {
      throw toolFailure(tool, error)
    } finally {
      // Closing here is exactly what proves the durability claim: the job
      // outlives every session that ever touched it.
      await client.close().catch(() => undefined)
      await transport.close().catch(() => undefined)
    }
  }

  async getCapabilities(signal?: AbortSignal): Promise<Readonly<ProviderCapabilities>> {
    const payload = await this.withSession<Record<string, unknown>>('describe_capabilities', {}, signal)
    const now = Date.now()
    return Object.freeze({
      operations: Object.freeze(['video-to-video', 'background-replace', 'camera-motion'] as const),
      inputFormats: Object.freeze(['mp4']),
      outputFormats: Object.freeze(['mp4']),
      duration: Object.freeze({
        minSeconds: typeof payload.minSeconds === 'number' ? payload.minSeconds : 1,
        maxSeconds: typeof payload.maxSeconds === 'number' ? payload.maxSeconds : 60,
      }),
      identityReference: 'video',
      supportsSeed: true,
      supportsIdempotency: true,
      supportsCancellation: this.cancellable,
      // An MCP provider is polled: the session that submitted is gone by the
      // time the work finishes, so there is nothing to push a result back into.
      completion: 'polling',
      fetchedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 10 * 60_000).toISOString(),
    })
  }

  async estimate(input: Readonly<Record<string, unknown>>): Promise<Readonly<ProviderEstimate>> {
    const durationFrames = typeof input.durationFrames === 'number' ? input.durationFrames : 0
    const fps = typeof input.fps === 'number' && input.fps > 0 ? input.fps : 30
    const seconds = Math.max(1, Math.ceil(durationFrames / fps))
    return Object.freeze({
      currency: this.currency,
      costMinorUnits: this.priceFixedMinorUnits + this.pricePerSecondMinorUnits * seconds,
      estimatedLatencyMs: seconds * 2_000,
    })
  }

  async submit(
    input: Readonly<Record<string, unknown>>,
    context: Readonly<ProviderSubmitContext>,
  ): Promise<Readonly<ProviderSubmissionResult<HttpTransformationResult>>> {
    const payload = await this.withSession<Record<string, unknown>>('submit_transformation', {
      input,
      operationId: context.operationId,
      idempotencyKey: context.idempotencyKey,
    }, context.signal)
    if (typeof payload.providerJobId !== 'string' || payload.providerJobId.length === 0) {
      throw new ProviderAdapterError('PROVIDER_MALFORMED_RESPONSE', false, undefined, 'Provider MCP tool did not return a job identifier')
    }
    return Object.freeze({ kind: 'accepted' as const, providerJobId: payload.providerJobId })
  }

  async getStatus(providerJobId: string, signal?: AbortSignal): Promise<ProviderStatus> {
    const payload = await this.withSession<Record<string, unknown>>('get_transformation_status', { providerJobId }, signal)
    if (typeof payload.status !== 'string' || !PROVIDER_STATUS_VALUES.includes(payload.status as ProviderStatus)) {
      throw new ProviderAdapterError('PROVIDER_MALFORMED_RESPONSE', false, undefined, 'Provider MCP tool returned an unsupported status')
    }
    return payload.status as ProviderStatus
  }

  async retrieve(providerJobId: string, signal?: AbortSignal): Promise<Readonly<HttpTransformationResult>> {
    const payload = await this.withSession<Record<string, unknown>>('get_transformation_result', { providerJobId }, signal)
    if (typeof payload.mediaBase64 !== 'string' || payload.mediaBase64.length === 0) {
      throw new ProviderAdapterError('PROVIDER_MALFORMED_RESPONSE', false, undefined, 'Provider MCP result carried no media')
    }
    const mediaBytes = Buffer.from(payload.mediaBase64, 'base64')
    if (mediaBytes.byteLength === 0 || mediaBytes.byteLength > this.maxResultBytes) {
      throw new ProviderAdapterError('PROVIDER_MALFORMED_RESPONSE', false, undefined, 'Provider MCP result media size is out of bounds')
    }
    const mediaSha256 = createHash('sha256').update(mediaBytes).digest('hex')
    if (typeof payload.mediaSha256 === 'string' && payload.mediaSha256 !== mediaSha256) {
      throw new ProviderAdapterError('PROVIDER_RESULT_CORRUPTED', false, undefined, 'Provider MCP result checksum does not match its bytes')
    }
    const cost = payload.observedCost as { currency?: unknown; costMinorUnits?: unknown } | undefined
    return Object.freeze({
      providerJobId,
      mediaBytes,
      mediaSha256,
      mediaByteSize: mediaBytes.byteLength,
      container: 'mp4' as const,
      mediaType: 'video' as const,
      ...(cost && typeof cost.currency === 'string' && Number.isSafeInteger(cost.costMinorUnits)
        ? { observedCost: Object.freeze({ currency: cost.currency, costMinorUnits: cost.costMinorUnits as number }) }
        : {}),
    })
  }

  async cancel(providerJobId: string, signal?: AbortSignal): Promise<void> {
    if (!this.cancellable) {
      throw new ProviderAdapterError('PROVIDER_CANCELLATION_UNSUPPORTED', false, undefined, 'Provider does not support cancellation')
    }
    await this.withSession('cancel_transformation', { providerJobId }, signal)
  }
}
