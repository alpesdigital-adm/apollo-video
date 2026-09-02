import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import * as z from 'zod/v4'

import { signProviderCallback } from '../../src/v2/domain/provider-job-callback.ts'
import { HttpTransformationProviderAdapter } from '../../src/v2/infrastructure/transformation/http-transformation-provider.ts'
import { McpTransformationProviderAdapter } from '../../src/v2/infrastructure/transformation/mcp-transformation-provider.ts'

const context = Object.freeze({ operationId: 'operation-transformation-adapter', idempotencyKey: 'transformation-adapter-key' })
const media = Buffer.from('controlled-transformation-video')
const mediaSha256 = createHash('sha256').update(media).digest('hex')

function httpAdapter(fetchImplementation, completion = 'polling', callbackSecret) {
  return new HttpTransformationProviderAdapter({
    id: 'controlled-http-transformation', adapterVersion: '1.0.0', baseUrl: 'http://127.0.0.1:4317',
    apiKey: 'controlled-http-key', completion, callbackSecret, modes: ['background-replacement'],
    supportsCancellation: true, timeoutMs: 1_000, fetchImplementation,
  })
}

test('T-FR-113 HTTP adapter normalizes synchronous, polling, webhook and bounded failures', async () => {
  const calls = []
  const polling = httpAdapter(async (url, init) => {
    calls.push({ url, method: init.method, key: new Headers(init.headers).get('x-api-key') })
    if (url.endsWith('/transformations')) return new Response(JSON.stringify({ providerJobId: 'provider-job-http' }), { status: 202 })
    if (url.endsWith('/result')) return new Response(JSON.stringify({ mediaBase64: media.toString('base64'), mediaSha256 }), { status: 200 })
    if (url.endsWith('/cancel')) return new Response('{}', { status: 200 })
    return new Response(JSON.stringify({ status: 'completed' }), { status: 200 })
  })
  assert.deepEqual(await polling.submit({ durationFrames: 90, fps: 30 }, context), { kind: 'accepted', providerJobId: 'provider-job-http' })
  assert.equal(await polling.getStatus('provider-job-http'), 'completed')
  assert.deepEqual(Buffer.from((await polling.retrieve('provider-job-http')).mediaBytes), media)
  await polling.cancel('provider-job-http')
  assert.equal(calls.length, 4)
  assert.equal(calls.every((call) => call.key === 'controlled-http-key'), true)

  const synchronous = httpAdapter(async () => new Response(JSON.stringify({
    providerJobId: 'provider-job-sync', mediaBase64: media.toString('base64'), mediaSha256,
    observedCost: { currency: 'BRL', costMinorUnits: 19 }, completedAt: '2029-05-01T00:00:00.000Z',
  }), { status: 200 }), 'synchronous')
  const completed = await synchronous.submit({ durationFrames: 90, fps: 30 }, context)
  assert.equal(completed.kind, 'completed')
  assert.equal(completed.bundle.observedCost.costMinorUnits, 19)

  const limited = httpAdapter(async () => new Response('{}', { status: 429, headers: { 'retry-after': '2' } }))
  await assert.rejects(() => limited.submit({}, context), (error) => error.code === 'PROVIDER_RATE_LIMITED' && error.retryable && error.retryAfterMs === 2_000)
  const missing = httpAdapter(async () => new Response(JSON.stringify({}), { status: 200 }))
  await assert.rejects(() => missing.retrieve('provider-job-missing'), (error) => error.code === 'PROVIDER_MALFORMED_RESPONSE')
  const timedOut = httpAdapter(async (_url, init) => await new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })))
  await assert.rejects(() => timedOut.getStatus('provider-job-timeout'), (error) => error.code === 'PROVIDER_TIMEOUT' && error.retryable)

  const callbackSecret = Buffer.alloc(32, 7)
  const webhook = httpAdapter(async () => new Response('{}'), 'webhook', callbackSecret)
  const rawBody = Buffer.from(JSON.stringify({ providerJobId: 'provider-job-webhook', status: 'completed', occurredAt: new Date().toISOString() }))
  const headers = signProviderCallback({ secret: callbackSecret, eventId: 'provider-event-webhook', rawBody, timestamp: new Date() })
  const event = await webhook.verifyWebhook({ rawBody, headers, job: { id: 'job-webhook', workspaceId: 'workspace-webhook', providerId: webhook.id, providerJobId: 'provider-job-webhook', terminal: false } })
  assert.equal(event.providerJobId, 'provider-job-webhook')
  await assert.rejects(() => webhook.verifyWebhook({ rawBody: Buffer.from(`${rawBody} `), headers, job: { id: 'job-webhook', workspaceId: 'workspace-webhook', providerId: webhook.id, providerJobId: 'provider-job-webhook', terminal: false } }), /failed verification/)
})

function toolPayload(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

test('T-FR-113 MCP adapter uses the official wire and survives a fresh session for every durable stage', async () => {
  const app = createMcpExpressApp()
  const invoked = []
  app.use((request, response, next) => {
    if (request.headers['x-api-key'] !== 'controlled-mcp-key') return response.status(401).end()
    next()
  })
  app.post('/mcp', async (request, response) => {
    const server = new McpServer({ name: 'controlled-transformation-provider', version: '1.0.0' })
    const register = (name, schema, result) => server.registerTool(name, { inputSchema: schema }, async (args) => {
      invoked.push({ name, args })
      return toolPayload(typeof result === 'function' ? result(args) : result)
    })
    register('describe_capabilities', {}, { minSeconds: 1, maxSeconds: 12 })
    register('submit_transformation', { input: z.record(z.string(), z.unknown()), operationId: z.string(), idempotencyKey: z.string() }, { providerJobId: 'provider-job-mcp' })
    register('get_transformation_status', { providerJobId: z.string() }, { status: 'completed' })
    register('get_transformation_result', { providerJobId: z.string() }, { mediaBase64: media.toString('base64'), mediaSha256, observedCost: { currency: 'BRL', costMinorUnits: 23 } })
    register('cancel_transformation', { providerJobId: z.string() }, {})
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    try {
      await server.connect(transport)
      await transport.handleRequest(request, response, request.body)
    } finally {
      response.on('close', () => { void transport.close(); void server.close() })
    }
  })
  app.get('/mcp', (_request, response) => response.status(405).end())
  app.delete('/mcp', (_request, response) => response.status(405).end())
  const listener = await new Promise((resolve) => {
    const active = app.listen(0, '127.0.0.1', () => resolve(active))
  })
  try {
    const address = listener.address()
    assert.equal(typeof address, 'object')
    const adapter = new McpTransformationProviderAdapter({
      id: 'controlled-mcp-transformation', adapterVersion: '1.0.0', endpoint: `http://127.0.0.1:${address.port}/mcp`,
      apiKey: 'controlled-mcp-key', modes: ['background-replacement'], supportsCancellation: true,
    })
    assert.equal((await adapter.getCapabilities()).completion, 'polling')
    assert.deepEqual(await adapter.submit({ durationFrames: 90, fps: 30 }, context), { kind: 'accepted', providerJobId: 'provider-job-mcp' })
    assert.equal(await adapter.getStatus('provider-job-mcp'), 'completed')
    const result = await adapter.retrieve('provider-job-mcp')
    assert.deepEqual(Buffer.from(result.mediaBytes), media)
    assert.equal(result.observedCost.costMinorUnits, 23)
    await adapter.cancel('provider-job-mcp')
    assert.deepEqual(invoked.map((entry) => entry.name), ['describe_capabilities', 'submit_transformation', 'get_transformation_status', 'get_transformation_result', 'cancel_transformation'])
  } finally {
    await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()))
  }
})
