// A local stand-in for the provider of the briefing interpreter, for the suites that run the real OpenAI adapter without a network, a credential
// or a real model (ADR-160 F6; a real call is only ever made by the opt-in tests/v2/brief-interpreter.live.mjs).
//
// It speaks the one endpoint the adapter calls (POST <base>/chat/completions) and answers with what the suite scripted for the briefing it was
// sent (or with `fallback`: an answer that maps nothing). The environment a suite hands to a server it starts is `standIn.environment`: the
// configuration is the deployment's own variables (model, key and base URL), pointed at this server.
import { createServer } from 'node:http'

export const NOTHING_MAPPED = Object.freeze({ directives: [], unsupported: [], questions: [], coverage: [] })

export async function startBriefInterpreterStandIn({ fallback = NOTHING_MAPPED } = {}) {
  const calls = []
  const script = new Map()
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const briefing = JSON.parse(body.messages[1].content).briefing
      calls.push({ path: request.url, authorized: request.headers.authorization?.startsWith('Bearer ') === true, body, briefing })
      const answer = script.has(briefing) ? script.get(briefing) : fallback
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
      APOLLO_V2_BRIEF_INTERPRETER_MODEL: 'stand-in-model',
      OPENAI_API_KEY: 'stand-in-credential-not-a-real-key',
      APOLLO_V2_BRIEF_INTERPRETER_BASE_URL: url,
    }),
    close: () => new Promise((resolve) => server.close(resolve)),
  })
}
