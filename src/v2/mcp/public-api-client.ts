import type { AgentToolDescriptor } from '../public-api/agent-tool-catalog.ts'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

export interface ApolloMcpApiClientOptions {
  baseUrl: string
  token: string
  fetchImplementation?: typeof fetch
  timeoutMs?: number
}

export interface ApolloMcpApiResult {
  ok: boolean
  status: number
  payload: unknown
}

function validatedBaseUrl(value: string): URL {
  const url = new URL(value)
  const localHttp =
    url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !localHttp) {
    throw new Error('APOLLO_API_BASE_URL must use HTTPS or loopback HTTP')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('APOLLO_API_BASE_URL cannot contain credentials, query or fragment')
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
  return url
}

function validatedToken(value: string): string {
  const token = value.trim()
  if (token !== value || token.length < 20 || token.length > 4096 || /\s/.test(token)) {
    throw new Error('APOLLO_API_TOKEN is invalid')
  }
  return token
}

function validatedTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 120_000) {
    throw new Error('MCP API timeout must be between 1000 and 120000 milliseconds')
  }
  return timeout
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error('Apollo Public API response exceeded the MCP adapter limit')
  }
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let byteSize = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    byteSize += value.byteLength
    if (byteSize > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error('Apollo Public API response exceeded the MCP adapter limit')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(byteSize)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const text = new TextDecoder().decode(bytes)
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Apollo Public API returned a non-JSON response')
  }
}

function toolList(payload: unknown): readonly AgentToolDescriptor[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Apollo tool catalog response is invalid')
  }
  const data = (payload as Record<string, unknown>).data
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('Apollo tool catalog data is invalid')
  }
  const tools = (data as Record<string, unknown>).tools
  if (!Array.isArray(tools)) throw new Error('Apollo tool catalog is missing tools')
  for (const tool of tools) {
    if (
      typeof tool !== 'object' || tool === null || Array.isArray(tool) ||
      typeof tool.name !== 'string' || typeof tool.description !== 'string' ||
      typeof tool.inputSchema !== 'object' || tool.inputSchema === null ||
      typeof tool.outputSchema !== 'object' || tool.outputSchema === null ||
      typeof tool.apollo !== 'object' || tool.apollo === null
    ) {
      throw new Error('Apollo tool descriptor is invalid')
    }
  }
  const deepFreeze = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
    for (const item of Object.values(value)) deepFreeze(item)
    return Object.freeze(value)
  }
  return Object.freeze(
    tools.map((tool) => deepFreeze(tool) as AgentToolDescriptor),
  )
}

function endpointUrl(
  baseUrl: URL,
  tool: AgentToolDescriptor,
  input: Record<string, unknown>,
): URL {
  const endpoint = tool.apollo.endpoint
  if (!endpoint || !endpoint.path.startsWith('/v1/') || endpoint.path.includes('..')) {
    throw new Error('Apollo tool endpoint is invalid')
  }
  const pathInput = input.path as Record<string, unknown> | undefined
  const path = endpoint.path.replace(/\{([^}]+)\}/g, (_placeholder: string, name: string) => {
    const value = pathInput?.[name]
    if (typeof value !== 'string') throw new Error(`Missing path argument: ${name}`)
    return encodeURIComponent(value)
  })
  const url = new URL(path.replace(/^\//, ''), baseUrl)
  const query = input.query as Record<string, unknown> | undefined
  for (const [name, value] of Object.entries(query ?? {})) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new Error(`Query argument ${name} must be scalar`)
    }
    url.searchParams.set(name, String(value))
  }
  return url
}

export class ApolloMcpPublicApiClient {
  private readonly baseUrl: URL
  private readonly token: string
  private readonly fetchImplementation: typeof fetch
  private readonly timeoutMs: number

  constructor(options: ApolloMcpApiClientOptions) {
    this.baseUrl = validatedBaseUrl(options.baseUrl)
    this.token = validatedToken(options.token)
    this.fetchImplementation = options.fetchImplementation ?? fetch
    this.timeoutMs = validatedTimeout(options.timeoutMs)
  }

  async listTools(): Promise<readonly AgentToolDescriptor[]> {
    const result = await this.request(new URL('v1/tools', this.baseUrl), { method: 'GET' })
    if (!result.ok) throw new Error('Apollo Public API rejected MCP tool discovery')
    return toolList(result.payload)
  }

  async callTool(
    tool: AgentToolDescriptor,
    input: Record<string, unknown>,
  ): Promise<ApolloMcpApiResult> {
    const endpoint = tool.apollo.endpoint
    if (!endpoint) throw new Error('Apollo tool does not declare an HTTP endpoint')
    const headers = new Headers()
    const toolHeaders = input.headers as Record<string, unknown> | undefined
    if (typeof toolHeaders?.idempotencyKey === 'string') {
      headers.set('Idempotency-Key', toolHeaders.idempotencyKey)
    }
    if (typeof toolHeaders?.ifMatch === 'string') headers.set('If-Match', toolHeaders.ifMatch)
    const body = Object.hasOwn(input, 'body') ? JSON.stringify(input.body) : undefined
    if (body !== undefined) headers.set('Content-Type', 'application/json')
    return this.request(endpointUrl(this.baseUrl, tool, input), {
      method: endpoint.method,
      headers,
      ...(body !== undefined ? { body } : {}),
    })
  }

  private async request(url: URL, init: RequestInit): Promise<ApolloMcpApiResult> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${this.token}`)
    headers.set('Accept', 'application/json')
    try {
      const response = await this.fetchImplementation(url, {
        ...init,
        headers,
        signal: controller.signal,
        redirect: 'error',
      })
      return Object.freeze({
        ok: response.ok,
        status: response.status,
        payload: await readBoundedJson(response),
      })
    } finally {
      clearTimeout(timeout)
    }
  }
}

export function apolloMcpApiClientFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const token = environment.APOLLO_API_TOKEN
  if (!token) throw new Error('APOLLO_API_TOKEN is required')
  return new ApolloMcpPublicApiClient({
    baseUrl: environment.APOLLO_API_BASE_URL ?? 'http://127.0.0.1:3333',
    token,
    timeoutMs: environment.APOLLO_MCP_API_TIMEOUT_MS
      ? Number(environment.APOLLO_MCP_API_TIMEOUT_MS)
      : undefined,
  })
}
