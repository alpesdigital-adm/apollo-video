// A local stand-in for the provider of the briefing interpreter, for the suites that run the real OpenAI adapter without a network, a credential
// or a real model (ADR-160 F6; a real call is only ever made by the opt-in tests/v2/brief-interpreter.live.mjs).
//
// It speaks the one endpoint the adapter calls (POST <base>/chat/completions) and answers with what the suite scripted for the briefing it was
// sent (or with `fallback`: an answer that maps nothing). The environment a suite hands to a server it starts is `standIn.environment`: the
// configuration is the deployment's own variables (model, key and base URL), pointed at this server.
import { createServer } from 'node:http'

// Dynamic import: a suite run under tsx loses the names of a static named import of a .ts module from an .mjs file.
const { briefingSentences } = await import('../../../src/v2/domain/editorial-request.ts')

export const NOTHING_MAPPED = Object.freeze({ directives: [], unsupported: [], questions: [], coverage: [] })

/**
 * What a model that finds nothing to ask of the video says about a briefing: every sentence is a statement of context. A reading that left a sentence out would
 * ask the owner about it and block the Director (ADR-160), so a stand-in that must not block says what each sentence is instead of returning nothing.
 */
export const EVERY_SENTENCE_IS_CONTEXT = (briefing) => ({
  directives: [], unsupported: [], questions: [],
  // (A sentence with fewer than two letters or digits cannot be cited at all; it stays unsaid, and the reading asks about it.)
  coverage: briefingSentences(briefing).filter((sentence) => (sentence.text.match(/[\p{L}\p{N}]/gu) ?? []).length >= 2).map((sentence) => ({ topic: 'context', quote: sentence.text })),
})

export async function startBriefInterpreterStandIn({ fallback = EVERY_SENTENCE_IS_CONTEXT } = {}) {
  const calls = []
  const script = new Map()
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const briefing = JSON.parse(body.messages[1].content).briefing
      calls.push({ path: request.url, authorized: request.headers.authorization?.startsWith('Bearer ') === true, body, briefing })
      const answer = script.has(briefing) ? script.get(briefing) : typeof fallback === 'function' ? fallback(briefing) : fallback
      response.setHeader('content-type', 'application/json')
      if (answer === undefined) { response.statusCode = 500; response.end('{}'); return }
      response.end(JSON.stringify({
        id: 'stand-in', model: 'stand-in-resolved', usage: { prompt_tokens: 100, completion_tokens: 20 },
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(answer) } }],
      }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/v1`
  return Object.freeze({
    calls, script, url,
    environment: Object.freeze({
      APOLLO_V2_BRIEF_INTERPRETER_PROVIDER: 'openai-api',
      APOLLO_V2_BRIEF_INTERPRETER_MODEL: 'stand-in-model',
      OPENAI_API_KEY: 'stand-in-credential-not-a-real-key',
      APOLLO_V2_BRIEF_INTERPRETER_BASE_URL: url,
    }),
    close: () => new Promise((resolve) => server.close(resolve)),
  })
}
