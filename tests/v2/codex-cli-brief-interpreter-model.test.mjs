import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { BRIEF_INTERPRETER_RESPONSE_SCHEMA, interpretBriefService } from '../../src/v2/application/interpret-brief.ts'
import { createBriefInterpreterModelFromEnvironment } from '../../src/v2/infrastructure/brief/brief-interpreter-factory.ts'
import { CODEX_DISABLED_FEATURES, CodexCliBriefInterpreterModel } from '../../src/v2/infrastructure/brief/codex-cli-brief-interpreter-model.ts'
import { installFakeCodex } from './helpers/install-fake-codex.mjs'

// The briefings are synthetic placeholders; the binary is a stand-in script (the real one is only run by the opt-in tests/v2/brief-interpreter.live.mjs).
const BRIEFING = '<texto do pedido> alpha beta'
const answerOf = (quote, extra = {}) => ({ directives: [{ kind: 'cta', value: 'none', param: null, quote }], unsupported: [], questions: [], coverage: [], ...extra })
const leftovers = (root) => readdirSync(root).filter((name) => name.startsWith('apollo-brief-interpreter-'))

function adapter(fake, extra = {}) {
  return new CodexCliBriefInterpreterModel({ binary: fake.binary, model: 'configured-model', workRoot: fake.directory, ...extra }, { ...process.env, OPENAI_API_KEY: 'must-not-reach-the-child', CODEX_API_KEY: 'must-not-reach-the-child' })
}

test('the child is closed: read-only sandbox, approval never, no user configuration, no tool, no secret, prompt by stdin, its own directory', async () => {
  const fake = installFakeCodex({ answers: { [BRIEFING]: answerOf('alpha') } })
  try {
    const { interpretation, audit } = await interpretBriefService({ model: adapter(fake) })({ briefing: BRIEFING })
    const [run] = fake.executions()
    const args = run.args
    const after = (name) => args[args.indexOf(name) + 1]
    assert.equal(after('-s'), 'read-only')
    assert.ok(args.includes('approval_policy="never"') && args.includes('web_search="disabled"'))
    for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--json']) assert.ok(args.includes(flag), flag)
    assert.deepEqual(args.flatMap((arg, index) => (arg === '--disable' ? [args[index + 1]] : [])), [...CODEX_DISABLED_FEATURES])
    assert.equal(after('-m'), 'configured-model')
    assert.equal(args.at(-1), '-', 'the prompt is read from standard input')
    assert.ok(!args.includes('--search') && !args.some((arg) => /danger|bypass|workspace-write/u.test(arg)))
    // The briefing and the instruction are never process arguments.
    assert.ok(args.every((arg) => !arg.includes('alpha') && !arg.includes('You read the briefing')))
    assert.ok(run.stdin.includes('You read the briefing of ONE video editing request') && run.stdin.includes(JSON.stringify({ briefing: BRIEFING })))
    // Its own directory: it held the response schema and nothing else, and it is gone.
    assert.equal(run.cwd, after('-C'))
    assert.deepEqual(run.listing, ['response-schema.json'])
    assert.equal(existsSync(run.cwd), false)
    assert.deepEqual(leftovers(fake.directory), [])
    // The schema it was given is the one the Apollo validates against.
    assert.equal(run.schemaExists, true)
    // No secret crosses: an allowlist, no API key of any kind.
    assert.ok(!run.environmentKeys.includes('OPENAI_API_KEY') && !run.environmentKeys.includes('CODEX_API_KEY'))
    // What came back went through the same checks as any answer.
    assert.equal(interpretation.directives[0].excerpt.text, 'alpha')
    assert.deepEqual([audit.provider, audit.model, audit.providerVersion, audit.costBasis, audit.costMinorUnits], ['codex-cli', 'configured-model', 'codex-cli 0.0.0-fake', 'subscription', null])
    assert.deepEqual(audit.usage, { inputTokens: 1200, outputTokens: 40 })
    assert.equal(audit.resolvedModel, null)
    assert.match(audit.responseHash, /^[a-f0-9]{64}$/)
    assert.deepEqual(BRIEF_INTERPRETER_RESPONSE_SCHEMA.schema.required, ['directives', 'unsupported', 'questions', 'coverage'])
  } finally { fake.remove() }
})

test('a citation the briefing does not contain is refused whatever the provider is; a tool in the stream is refused too', async () => {
  const fake = installFakeCodex({ answers: { [BRIEFING]: answerOf('words that are nowhere in the briefing') } })
  try {
    await assert.rejects(interpretBriefService({ model: adapter(fake) })({ briefing: BRIEFING }), (error) => error.code === 'RENDER_OUTPUT_INVALID')
    fake.configure({ tool: true, answers: { [BRIEFING]: answerOf('alpha') } })
    await assert.rejects(interpretBriefService({ model: adapter(fake) })({ briefing: BRIEFING }), (error) => error.code === 'RENDER_OUTPUT_INVALID' && /tool/.test(error.message))
    fake.configure({ noAnswerFile: true })
    await assert.rejects(interpretBriefService({ model: adapter(fake) })({ briefing: BRIEFING }), (error) => error.code === 'RENDER_OUTPUT_INVALID')
    fake.configure({ fail: true })
    await assert.rejects(interpretBriefService({ model: adapter(fake) })({ briefing: BRIEFING }), (error) => error.code === 'RENDER_EXECUTION_FAILED')
    assert.deepEqual(leftovers(fake.directory), [])
  } finally { fake.remove() }
})

test('not signed in, or no binary: there is no interpreter and a briefing with text fails closed, never empty', async () => {
  const fake = installFakeCodex({ loggedIn: false })
  try {
    const unavailable = (error) => error.code === 'PRECONDITION_REQUIRED' && error.details.reason === 'brief-interpreter-unavailable'
    await assert.rejects(interpretBriefService({ model: adapter(fake) })({ briefing: BRIEFING }), unavailable)
    assert.equal(fake.executions().length, 0, 'nothing was run without a sign-in')
    await assert.rejects(interpretBriefService({ model: adapter({ ...fake, binary: `${fake.directory}/absent-codex.exe` }) })({ briefing: BRIEFING }), unavailable)
    assert.deepEqual(leftovers(fake.directory), [])
  } finally { fake.remove() }
})

test('a run that does not finish is killed with its tree at the timeout and at the abort, and leaves nothing behind', async () => {
  const fake = installFakeCodex({ hang: true })
  try {
    const started = Date.now()
    await assert.rejects(interpretBriefService({ model: adapter(fake, { timeoutMs: 600 }) })({ briefing: BRIEFING }), (error) => error.code === 'RENDER_EXECUTION_FAILED' && /in time/.test(error.message))
    assert.ok(Date.now() - started < 20_000)
    const controller = new AbortController()
    const pending = interpretBriefService({ model: adapter(fake) })({ briefing: BRIEFING, signal: controller.signal })
    setTimeout(() => controller.abort(new Error('caller gave up')), 700)
    await assert.rejects(pending, /caller gave up/)
    assert.deepEqual(leftovers(fake.directory), [])
  } finally { fake.remove() }
})

test('configuration has no default and refuses what cannot be run: a shell shim, a relative path, an unknown provider', () => {
  const fake = installFakeCodex()
  try {
    assert.equal(createBriefInterpreterModelFromEnvironment({}), null)
    assert.equal(createBriefInterpreterModelFromEnvironment({ APOLLO_V2_BRIEF_INTERPRETER_MODEL: 'm', APOLLO_V2_CODEX_BIN: fake.binary }), null, 'no provider chosen: none')
    assert.equal(createBriefInterpreterModelFromEnvironment({ APOLLO_V2_BRIEF_INTERPRETER_PROVIDER: 'codex-cli', APOLLO_V2_BRIEF_INTERPRETER_MODEL: 'm' }), null)
    assert.equal(createBriefInterpreterModelFromEnvironment({ APOLLO_V2_BRIEF_INTERPRETER_PROVIDER: 'codex-cli', APOLLO_V2_CODEX_BIN: fake.binary }), null)
    const model = createBriefInterpreterModelFromEnvironment({ APOLLO_V2_BRIEF_INTERPRETER_PROVIDER: 'codex-cli', APOLLO_V2_BRIEF_INTERPRETER_MODEL: 'm', APOLLO_V2_CODEX_BIN: fake.binary })
    assert.deepEqual([model.provider, model.model, model.costBasis], ['codex-cli', 'm', 'subscription'])
    const configured = (extra) => () => createBriefInterpreterModelFromEnvironment({ APOLLO_V2_BRIEF_INTERPRETER_PROVIDER: 'codex-cli', APOLLO_V2_BRIEF_INTERPRETER_MODEL: 'm', APOLLO_V2_CODEX_BIN: fake.binary, ...extra })
    assert.throws(configured({ APOLLO_V2_CODEX_BIN: `${fake.directory}/codex.cmd` }), (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED')
    assert.throws(configured({ APOLLO_V2_CODEX_BIN: 'codex' }), (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED')
    assert.throws(configured({ APOLLO_V2_BRIEF_INTERPRETER_TIMEOUT_MS: '-1' }), (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED')
    assert.throws(() => createBriefInterpreterModelFromEnvironment({ APOLLO_V2_BRIEF_INTERPRETER_PROVIDER: 'something-else' }), (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED')
    const api = createBriefInterpreterModelFromEnvironment({ APOLLO_V2_BRIEF_INTERPRETER_PROVIDER: 'openai-api', APOLLO_V2_BRIEF_INTERPRETER_MODEL: 'm', OPENAI_API_KEY: 'a-credential-of-length' })
    assert.deepEqual([api.provider, api.costBasis], ['openai', 'api-metered'])
    assert.equal(createBriefInterpreterModelFromEnvironment({ APOLLO_V2_BRIEF_INTERPRETER_PROVIDER: 'openai-api', APOLLO_V2_BRIEF_INTERPRETER_MODEL: 'm' }), null)
    assert.ok(tmpdir().length > 0)
  } finally { fake.remove() }
})
