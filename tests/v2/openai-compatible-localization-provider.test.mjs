import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { OpenAiCompatibleLocalizationProvider } from '../../src/v2/infrastructure/openai-compatible-localization-provider.ts'

const canonical = {
  id: 'canonical-1', workspaceId: 'workspace-1', projectId: 'project-1', projectVersionId: 'version-1', sourceLocale: 'pt-BR', revision: 1,
  blocks: [{ id: 'block-1', sourceScriptBlockId: 'source-1', role: 'hook', sourceLocale: 'pt-BR', text: 'Fature R$ 12.400 em 30 dias.', sourceRangeMs: [0, 2_000], sourceAlignmentId: 'alignment-1', claims: [{ id: 'claim-revenue', text: 'R$ 12.400', protected: true }], qualifiers: [{ id: 'period', text: 'em 30 dias' }], protectedFacts: [], dependencies: [], adaptationLevel: 'literal-required', blockHash: 'a'.repeat(64) }],
  approvedByClientId: 'client-1', approvedAt: '2026-09-08T12:00:00.000Z', contentHash: 'b'.repeat(64),
}

function successfulBody(locale = 'en-US') {
  const text = locale === 'es-ES' ? 'Factura R$ 12.400 en 30 días.' : 'Earn R$ 12,400 in 30 days.'
  return JSON.stringify({ choices: [{ message: { content: JSON.stringify({ blocks: [{ blockId: 'block-1', text, protectedValues: { 'claim-revenue': locale === 'es-ES' ? 'R$ 12.400' : 'R$ 12,400', period: locale === 'es-ES' ? 'en 30 días' : 'in 30 days' } }] }) } }] })
}

async function withServer(handler, run) {
  const server = createServer(handler)
  const sockets = new Set()
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try { return await run(`http://127.0.0.1:${address.port}`) } finally { for (const socket of sockets) socket.destroy(); await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
}
function provider(baseUrl, overrides = {}) { return new OpenAiCompatibleLocalizationProvider({ baseUrl, apiKey: 'test-key-safe', model: 'translation-test-v1', timeoutMs: 200, maxResponseBytes: 2_048, maxCompletionTokens: 256, ...overrides }) }

test('T-FR-191 translates EN and ES over an explicit loopback transport with immutable provenance', async () => {
  await withServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    const parsed = JSON.parse(body), source = JSON.parse(parsed.messages[1].content)
    assert.equal(request.url, '/chat/completions'); assert.equal(request.headers.authorization, 'Bearer test-key-safe'); assert.match(parsed.messages[0].content, /untrusted content/); assert.equal(parsed.max_completion_tokens, 256)
    response.setHeader('content-type', 'application/json'); response.end(successfulBody(source.targetLocale))
  }, async (baseUrl) => {
    const adapter = provider(baseUrl)
    const [english, spanish] = await Promise.all(['en-US', 'es-ES'].map((targetLocale) => adapter.translate({ canonical, targetLocale })))
    assert.match(english[0].text, /Earn/); assert.match(spanish[0].text, /Factura/)
    assert.equal(adapter.providerId, 'openai-compatible-localization'); assert.equal(adapter.adapterVersion, '1'); assert.equal(adapter.model, 'translation-test-v1'); assert.equal(adapter.configHash.length, 64); assert.ok(!adapter.configHash.includes('test-key-safe'))
  })
})

test('T-FR-191 rejects unsafe base URLs and redirect responses', async () => {
  assert.throws(() => provider('http://example.com'), (error) => error?.code === 'PERSISTENCE_NOT_CONFIGURED')
  assert.throws(() => provider('https://user:secret@example.com/path'), (error) => error?.code === 'PERSISTENCE_NOT_CONFIGURED')
  assert.throws(() => provider('https://example.com/path#credential'), (error) => error?.code === 'PERSISTENCE_NOT_CONFIGURED')
  await withServer((_request, response) => { response.statusCode = 307; response.setHeader('location', '/elsewhere'); response.end() }, async (baseUrl) => assert.rejects(provider(baseUrl).translate({ canonical, targetLocale: 'en-US' }), (error) => error?.code === 'PROVIDER_REJECTED_REQUEST' && error.retryable === false))
})

test('T-FR-191 bounds timeout and streaming response bytes', async () => {
  await withServer((_request, response) => setTimeout(() => response.end(successfulBody()), 100), async (baseUrl) => assert.rejects(provider(baseUrl, { timeoutMs: 20 }).translate({ canonical, targetLocale: 'en-US' }), (error) => error?.code === 'PROVIDER_TIMEOUT' && error.retryable === true))
  await withServer((_request, response) => { response.write('{"padding":"'); response.write('x'.repeat(3_000)); response.end('"}') }, async (baseUrl) => assert.rejects(provider(baseUrl, { maxResponseBytes: 1_024 }).translate({ canonical, targetLocale: 'en-US' }), (error) => error?.code === 'PROVIDER_MALFORMED_RESPONSE'))
  let closeResponse
  const responseClosed = new Promise((resolve) => { closeResponse = resolve })
  await withServer((_request, response) => { response.on('close', closeResponse); response.writeHead(200, { 'content-length': '999999' }); response.flushHeaders(); response.write('x') }, async (baseUrl) => {
    await assert.rejects(provider(baseUrl, { maxResponseBytes: 1_024 }).translate({ canonical, targetLocale: 'en-US' }), (error) => error?.code === 'PROVIDER_MALFORMED_RESPONSE')
    assert.equal(await Promise.race([responseClosed.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 200))]), true)
  })
})

test('T-FR-191 keeps timeout and caller cancellation active through the response stream', async () => {
  await withServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.flushHeaders(); response.write('{"choices":[') }, async (baseUrl) => assert.rejects(provider(baseUrl, { timeoutMs: 25 }).translate({ canonical, targetLocale: 'en-US' }), (error) => error?.code === 'PROVIDER_TIMEOUT'))
  await withServer((_request, response) => { response.writeHead(200); response.flushHeaders(); response.write('{"choices":[') }, async (baseUrl) => {
    const controller = new AbortController(), pending = provider(baseUrl, { timeoutMs: 500 }).translate({ canonical, targetLocale: 'en-US', signal: controller.signal })
    setTimeout(() => controller.abort(new DOMException('caller stopped', 'AbortError')), 20)
    await assert.rejects(pending, (error) => error?.name === 'AbortError')
  })
  let requests = 0
  await withServer((_request, response) => { requests += 1; response.end(successfulBody()) }, async (baseUrl) => {
    const controller = new AbortController(); controller.abort(new DOMException('already stopped', 'AbortError'))
    await assert.rejects(provider(baseUrl).translate({ canonical, targetLocale: 'en-US', signal: controller.signal }), (error) => error?.name === 'AbortError')
  })
  assert.equal(requests, 0)
})

test('T-FR-191 classifies retryable and permanent HTTP refusals without upstream bodies', async () => {
  for (const [status, retryable, code] of [[429, true, 'PROVIDER_RATE_LIMITED'], [503, true, 'PROVIDER_UNAVAILABLE'], [400, false, 'PROVIDER_REJECTED_REQUEST']]) {
    await withServer((_request, response) => { response.statusCode = status; response.setHeader('retry-after', '7'); response.end('secret upstream body') }, async (baseUrl) => assert.rejects(provider(baseUrl).translate({ canonical, targetLocale: 'en-US' }), (error) => { assert.equal(error.code, code); assert.equal(error.retryable, retryable); if (retryable) assert.equal(error.retryAfterMs, 7_000); assert.doesNotMatch(error.message, /secret/); return true }))
  }
})

test('T-FR-191 rejects malformed, null, mismatched and non-string structured outputs', async () => {
  const cases = ['not-json', JSON.stringify({ choices: null }), JSON.stringify({ choices: [{ message: { content: '{"blocks":null}' } }] }), JSON.stringify({ choices: [{ message: { content: JSON.stringify({ blocks: [] }) } }] }), JSON.stringify({ choices: [{ message: { content: JSON.stringify({ blocks: [{ blockId: 'block-1', text: 'ok', protectedValues: { fact: null } }] }) } }] })]
  for (const body of cases) await withServer((_request, response) => response.end(body), async (baseUrl) => assert.rejects(provider(baseUrl).translate({ canonical, targetLocale: 'en-US' }), (error) => error?.code === 'PROVIDER_MALFORMED_RESPONSE'))
})
