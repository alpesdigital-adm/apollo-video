import assert from 'node:assert/strict'
import test from 'node:test'

import { interpretBriefService } from '../../src/v2/application/interpret-brief.ts'
import { createOpenAiApiBriefInterpreterModelFromEnvironment as createBriefInterpreterModelFromEnvironment, OpenAiBriefInterpreterModel } from '../../src/v2/infrastructure/brief/openai-brief-interpreter-model.ts'

// A dummy credential of the right length: nothing here ever reaches a network.
const KEY = 'test-credential-not-a-real-key'
const answer = (content, extra = {}) => ({ id: 'x', model: 'resolved-model-1', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 120, completion_tokens: 30 }, ...extra })
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const adapter = (respond, extra = {}) => {
  const requests = []
  const instance = new OpenAiBriefInterpreterModel({
    apiKey: KEY, model: 'configured-model', fetch: async (url, init) => { requests.push({ url, init }); return respond(url, init) }, ...extra,
  })
  return { instance, requests }
}
const request = { promptVersion: 'brief-interpreter/v1', system: 'standing instruction', user: '{"briefing":"one two"}', responseSchema: { name: 'brief_interpretation', schema: { type: 'object' } } }
const empty = JSON.stringify({ directives: [], unsupported: [], questions: [], coverage: [] })

test('one chat completion with a strict JSON Schema; the briefing travels only in the user turn', async () => {
  const { instance, requests } = adapter(() => json(answer(empty)))
  const response = await instance.interpret(request)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://api.openai.com/v1/chat/completions')
  assert.equal(requests[0].init.method, 'POST')
  assert.equal(requests[0].init.redirect, 'error')
  assert.equal(requests[0].init.headers.authorization, `Bearer ${KEY}`)
  const body = JSON.parse(requests[0].init.body)
  assert.equal(body.model, 'configured-model')
  assert.deepEqual(body.messages, [{ role: 'system', content: 'standing instruction' }, { role: 'user', content: '{"briefing":"one two"}' }])
  assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'brief_interpretation', strict: true, schema: { type: 'object' } } })
  assert.ok(!('temperature' in body), 'no sampling parameter is imposed on the model')
  // modelInputHash is the hash of the exact request body: what entered the model.
  assert.match(response.modelInputHash, /^[a-f0-9]{64}$/)
  assert.deepEqual({ ...response, modelInputHash: undefined }, { text: empty, usage: { inputTokens: 120, outputTokens: 30 }, resolvedModel: 'resolved-model-1', modelInputHash: undefined })
})

test('provider failures are typed, transient ones say so, and the credential never appears in an error', async () => {
  for (const [status, pattern] of [[429, /temporarily unavailable/], [500, /temporarily unavailable/], [503, /temporarily unavailable/], [401, /rejected the credential/], [403, /rejected the credential/], [400, /rejected the request/]]) {
    const { instance } = adapter(() => new Response('{"error":"nope"}', { status }))
    await assert.rejects(instance.interpret(request), (error) => error.code === 'RENDER_EXECUTION_FAILED' && pattern.test(error.message) && !error.message.includes(KEY), String(status))
  }
  const network = adapter(() => { throw new TypeError(`fetch failed for ${KEY}`) })
  await assert.rejects(network.instance.interpret(request), (error) => error.code === 'RENDER_EXECUTION_FAILED' && !JSON.stringify(error).includes(KEY))
})

test('an unreadable or incomplete provider answer is refused', async () => {
  for (const body of [
    new Response('not json', { status: 200 }),
    json({ choices: [] }),
    json(answer(empty, { choices: [{ finish_reason: 'stop', message: { content: '' } }] })),
    json(answer(empty, { choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'I cannot help with that' } }] })),
    json(answer(empty, { choices: [{ finish_reason: 'length', message: { content: empty } }] })),
    json(answer(empty, { choices: [{ message: { content: empty } }, { message: { content: empty } }] })),
  ]) {
    const { instance } = adapter(() => body)
    await assert.rejects(instance.interpret(request), (error) => error.code === 'RENDER_OUTPUT_INVALID')
  }
})

test('the response size is bounded', async () => {
  const { instance } = adapter(() => json(answer('x'.repeat(5_000))), { maxResponseBytes: 1_024 })
  await assert.rejects(instance.interpret(request), (error) => error.code === 'RENDER_OUTPUT_INVALID')
})

test('a caller that aborts is not turned into a provider failure', async () => {
  const controller = new AbortController()
  const { instance } = adapter((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))))
  const pending = instance.interpret({ ...request, signal: controller.signal })
  controller.abort(new Error('caller gave up'))
  await assert.rejects(pending, /caller gave up/)
})

test('configuration is validated and has no default for the model or the key', () => {
  assert.equal(createBriefInterpreterModelFromEnvironment({}), null)
  assert.equal(createBriefInterpreterModelFromEnvironment({ OPENAI_API_KEY: KEY }), null)
  assert.equal(createBriefInterpreterModelFromEnvironment({ APOLLO_V2_BRIEF_INTERPRETER_MODEL: 'configured-model' }), null)
  assert.equal(createBriefInterpreterModelFromEnvironment({ APOLLO_V2_BRIEF_INTERPRETER_MODEL: '  ', OPENAI_API_KEY: KEY }), null)
  const configured = createBriefInterpreterModelFromEnvironment({ APOLLO_V2_BRIEF_INTERPRETER_MODEL: ' configured-model ', OPENAI_API_KEY: KEY,
    APOLLO_V2_BRIEF_INTERPRETER_COST_MINOR_UNITS_PER_MILLION_INPUT_TOKENS: '250', APOLLO_V2_BRIEF_INTERPRETER_COST_MINOR_UNITS_PER_MILLION_OUTPUT_TOKENS: '1000' })
  assert.deepEqual([configured.provider, configured.model], ['openai', 'configured-model'])
  assert.deepEqual(configured.pricing, { inputMinorUnitsPerMillionTokens: 250, outputMinorUnitsPerMillionTokens: 1000 })
  // Only one side of the price stated: the cost stays unknown.
  assert.equal(createBriefInterpreterModelFromEnvironment({ APOLLO_V2_BRIEF_INTERPRETER_MODEL: 'm', OPENAI_API_KEY: KEY, APOLLO_V2_BRIEF_INTERPRETER_COST_MINOR_UNITS_PER_MILLION_INPUT_TOKENS: '250' }).pricing, undefined)
  const base = { APOLLO_V2_BRIEF_INTERPRETER_MODEL: 'm', OPENAI_API_KEY: KEY }
  for (const bad of [
    { ...base, APOLLO_V2_BRIEF_INTERPRETER_BASE_URL: 'http://example.com/v1' },
    { ...base, APOLLO_V2_BRIEF_INTERPRETER_BASE_URL: 'https://user:pass@example.com/v1' },
    { ...base, APOLLO_V2_BRIEF_INTERPRETER_BASE_URL: 'not a url' },
    { ...base, APOLLO_V2_BRIEF_INTERPRETER_TIMEOUT_MS: '-1' },
    { ...base, APOLLO_V2_BRIEF_INTERPRETER_MAX_COMPLETION_TOKENS: 'x' },
    { ...base, APOLLO_V2_BRIEF_INTERPRETER_COST_MINOR_UNITS_PER_MILLION_INPUT_TOKENS: '-5', APOLLO_V2_BRIEF_INTERPRETER_COST_MINOR_UNITS_PER_MILLION_OUTPUT_TOKENS: '1' },
  ]) assert.throws(() => createBriefInterpreterModelFromEnvironment(bad), (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED' && !error.message.includes(KEY))
  // A loopback http endpoint is allowed (a local stand-in for tests); nothing else is.
  assert.ok(createBriefInterpreterModelFromEnvironment({ ...base, APOLLO_V2_BRIEF_INTERPRETER_BASE_URL: 'http://127.0.0.1:4010/v1' }))
  assert.throws(() => new OpenAiBriefInterpreterModel({ apiKey: 'short', model: 'm' }), (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED')
})

test('end to end through the service: the adapter answer is checked against the briefing like any other', async () => {
  const good = adapter(() => json(answer(JSON.stringify({ directives: [{ kind: 'movement', value: 'none', param: null, quote: 'one' }], unsupported: [], questions: [], coverage: [] }))))
  const { interpretation, audit } = await interpretBriefService({ model: good.instance })({ briefing: 'one two' })
  assert.equal(interpretation.directives[0].excerpt.text, 'one')
  assert.deepEqual(audit.usage, { inputTokens: 120, outputTokens: 30 })
  assert.equal(audit.resolvedModel, 'resolved-model-1')
  const lying = adapter(() => json(answer(JSON.stringify({ directives: [{ kind: 'movement', value: 'none', param: null, quote: 'three' }], unsupported: [], questions: [], coverage: [] }))))
  await assert.rejects(interpretBriefService({ model: lying.instance })({ briefing: 'one two' }), (error) => error.code === 'RENDER_OUTPUT_INVALID')
})
