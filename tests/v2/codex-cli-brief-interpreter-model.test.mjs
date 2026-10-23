import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { BRIEF_INTERPRETER_RESPONSE_SCHEMA, interpretBriefService } from '../../src/v2/application/interpret-brief.ts'
import { createBriefInterpreterModelFromEnvironment } from '../../src/v2/infrastructure/brief/brief-interpreter-factory.ts'
import { CODEX_CONFIGURATION, CODEX_DISABLED_FEATURES, CodexCliBriefInterpreterModel } from '../../src/v2/infrastructure/brief/codex-cli-brief-interpreter-model.ts'
import { installFakeCodex } from './helpers/install-fake-codex.mjs'

// The briefings are synthetic placeholders; the binary is a stand-in script (the real one is only run by the opt-in tests/v2/brief-interpreter.live.mjs).
const BRIEFING = '<texto do pedido> alpha beta'
const answerOf = (quote, extra = {}) => ({ directives: [{ kind: 'cta', value: 'none', param: null, quote }], unsupported: [], questions: [], coverage: [], ...extra })
const leftovers = (root) => readdirSync(root).filter((name) => name.startsWith('apollo-brief-interpreter-'))

function adapter(fake, extra = {}) {
  return new CodexCliBriefInterpreterModel({ binary: fake.binary, codexHome: fake.codexHome, model: 'configured-model', workRoot: fake.directory, systemConfigPath: join(fake.directory, 'absent-system-config.toml'), ...extra }, { ...process.env, OPENAI_API_KEY: 'must-not-reach-the-child', CODEX_API_KEY: 'must-not-reach-the-child' })
}

test('the child is closed: read-only sandbox, approval never, no user configuration, no tool, no secret, prompt by stdin, its own directory', async () => {
  const fake = installFakeCodex({ answers: { [BRIEFING]: answerOf('alpha') } })
  try {
    const { interpretation, audit } = await interpretBriefService({ model: adapter(fake) })({ briefing: BRIEFING })
    const [run] = fake.executions()
    const args = run.args
    const after = (name) => args[args.indexOf(name) + 1]
    assert.equal(after('-s'), 'read-only')
    for (const setting of CODEX_CONFIGURATION) assert.ok(args.includes(setting), setting)
    for (const feature of ['code_mode_host', 'view_image', 'multi_agent', 'shell_tool', 'hooks', 'plugins']) assert.ok(CODEX_DISABLED_FEATURES.includes(feature), feature)
    // Codex runs with the CODEX_HOME of the Apollo, not the operator's.
    assert.equal(run.codexHome, fake.codexHome)
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
    assert.match(audit.modelInputHash, /^[a-f0-9]{64}$/)
    assert.notEqual(audit.modelInputHash, audit.promptHash)
    assert.deepEqual([audit.provider, audit.model, audit.providerVersion, audit.costBasis, audit.costMinorUnits], ['codex-cli', 'configured-model', 'codex-cli 0.154.0', 'subscription', null])
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
    assert.equal(createBriefInterpreterModelFromEnvironment({ APOLLO_V2_BRIEF_INTERPRETER_MODEL: 'm', APOLLO_V2_CODEX_BIN: fake.binary, APOLLO_V2_CODEX_HOME: fake.codexHome }), null, 'no provider chosen: none')
    assert.equal(createBriefInterpreterModelFromEnvironment({ APOLLO_V2_BRIEF_INTERPRETER_PROVIDER: 'codex-cli', APOLLO_V2_BRIEF_INTERPRETER_MODEL: 'm' }), null)
    assert.equal(createBriefInterpreterModelFromEnvironment({ APOLLO_V2_BRIEF_INTERPRETER_PROVIDER: 'codex-cli', APOLLO_V2_CODEX_BIN: fake.binary, APOLLO_V2_CODEX_HOME: fake.codexHome }), null)
    assert.equal(createBriefInterpreterModelFromEnvironment({ APOLLO_V2_BRIEF_INTERPRETER_PROVIDER: 'codex-cli', APOLLO_V2_CODEX_BIN: fake.binary, APOLLO_V2_BRIEF_INTERPRETER_MODEL: 'm' }), null, 'no CODEX_HOME of its own: none')
    const model = createBriefInterpreterModelFromEnvironment({ APOLLO_V2_BRIEF_INTERPRETER_PROVIDER: 'codex-cli', APOLLO_V2_BRIEF_INTERPRETER_MODEL: 'm', APOLLO_V2_CODEX_BIN: fake.binary, APOLLO_V2_CODEX_HOME: fake.codexHome })
    assert.deepEqual([model.provider, model.model, model.costBasis], ['codex-cli', 'm', 'subscription'])
    const configured = (extra) => () => createBriefInterpreterModelFromEnvironment({ APOLLO_V2_BRIEF_INTERPRETER_PROVIDER: 'codex-cli', APOLLO_V2_BRIEF_INTERPRETER_MODEL: 'm', APOLLO_V2_CODEX_BIN: fake.binary, APOLLO_V2_CODEX_HOME: fake.codexHome, ...extra })
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

test('a tool the agent reached for is detected even when the event stream shows nothing, and the answer is refused', async () => {
  const fake = installFakeCodex({ routerError: true, answers: { [BRIEFING]: answerOf('alpha') } })
  try {
    await assert.rejects(interpretBriefService({ model: adapter(fake) })({ briefing: BRIEFING }), (error) => error.code === 'RENDER_OUTPUT_INVALID' && /tool/.test(error.message))
    assert.deepEqual(leftovers(fake.directory), [])
  } finally { fake.remove() }
})

test('the Apollo starts Codex only over a home and a system configuration that put nothing in front of the model', async () => {
  const fake = installFakeCodex({ answers: { [BRIEFING]: answerOf('alpha') } })
  try {
    const read = (model) => interpretBriefService({ model })({ briefing: BRIEFING })
    // The operator's instructions in the home of the Apollo: refused, nothing run.
    writeFileSync(join(fake.codexHome, 'AGENTS.md'), 'instructions the model must not get')
    await assert.rejects(read(adapter(fake)), (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED' && /AGENTS\.md/.test(error.message))
    assert.equal(fake.executions().length, 0)
    writeFileSync(join(fake.codexHome, 'AGENTS.md'), '')
    await assert.rejects(read(adapter(fake)), (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED')
    rmSync(join(fake.codexHome, 'AGENTS.md'))
    await read(adapter(fake))
    // A home that does not exist is "not signed in" for the Apollo: no interpreter.
    await assert.rejects(read(adapter(fake, { codexHome: join(fake.directory, 'no-such-home') })), (error) => error.code === 'PRECONDITION_REQUIRED' && error.details.reason === 'brief-interpreter-unavailable')
    // The system-wide configuration cannot be ignored by Codex: one that defines hooks, MCP servers, plugins or a notifier stops the start.
    const system = join(fake.directory, 'system-config.toml')
    for (const [text, refused] of [
      ['[features]\nmemories = false\n', false], ['[features]\ncodex_hooks = true\n', true], ['[features]\nhooks = true\n', true],
      ['[hooks]\nStop = []\n', true], ['[[hooks.Stop]]\ncommand = "x"\n', true], ['[mcp_servers.x]\ncommand = "x"\n', true],
      ['notify = ["x"]\n', true], ['[plugins]\nx = 1\n', true],
    ]) {
      writeFileSync(system, text)
      const attempt = read(adapter(fake, { systemConfigPath: system }))
      if (refused) await assert.rejects(attempt, (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED' && /system-wide/.test(error.message), text)
      else await attempt
    }
    // No CODEX_HOME of its own, no interpreter.
    assert.throws(() => new CodexCliBriefInterpreterModel({ binary: fake.binary, codexHome: 'relative', model: 'm' }), (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED')
  } finally { fake.remove() }
})

test('hooks anywhere Codex would load them stop the start: in the home of the Apollo, beside the system configuration, or switched on in it', async () => {
  const fake = installFakeCodex({ answers: { [BRIEFING]: answerOf('alpha') } })
  try {
    const read = (model) => interpretBriefService({ model })({ briefing: BRIEFING })
    const hooked = /hooks/
    // hooks.json and a hooks folder in the home of the Apollo
    writeFileSync(join(fake.codexHome, 'hooks.json'), '{}')
    await assert.rejects(read(adapter(fake)), (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED' && hooked.test(error.message))
    rmSync(join(fake.codexHome, 'hooks.json'))
    mkdirSync(join(fake.codexHome, 'hooks'))
    await assert.rejects(read(adapter(fake)), (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED' && hooked.test(error.message))
    rmSync(join(fake.codexHome, 'hooks'), { recursive: true })
    // hooks.json and a hooks folder beside the system-wide configuration (even with no config.toml at all)
    const system = join(fake.directory, 'system-codex')
    mkdirSync(system)
    const systemAdapter = () => adapter(fake, { systemConfigPath: join(system, 'config.toml') })
    await read(systemAdapter())
    writeFileSync(join(system, 'hooks.json'), '{"Stop":[]}')
    await assert.rejects(read(systemAdapter()), (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED' && /system-wide/.test(error.message) && hooked.test(error.message))
    rmSync(join(system, 'hooks.json'))
    mkdirSync(join(system, 'hooks'))
    await assert.rejects(read(systemAdapter()), (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED')
    rmSync(join(system, 'hooks'), { recursive: true })
    await read(systemAdapter())
    assert.deepEqual(leftovers(fake.directory), [])
  } finally { fake.remove() }
})

test('only the Codex version the detection was proven against is run', async () => {
  const fake = installFakeCodex({ version: 'codex-cli 0.155.0', answers: { [BRIEFING]: answerOf('alpha') } })
  try {
    const read = () => interpretBriefService({ model: adapter(fake) })({ briefing: BRIEFING })
    await assert.rejects(read(), (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED' && /exactly codex-cli 0\.154\.0/.test(error.message))
    fake.configure({ version: 'codex-cli 0.154.0-beta', answers: { [BRIEFING]: answerOf('alpha') } })
    await assert.rejects(read(), (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED')
    assert.equal(fake.executions().length, 0, 'nothing was run under another version')
    fake.configure({ answers: { [BRIEFING]: answerOf('alpha') } })
    await read()
    assert.equal(fake.executions().length, 1)
  } finally { fake.remove() }
})

test('the first thing that is not the agent\'s message stops the run: a worker is not held until the timeout', async () => {
  const fake = installFakeCodex({ toolThenHang: true })
  try {
    const started = Date.now()
    await assert.rejects(interpretBriefService({ model: adapter(fake, { timeoutMs: 120_000 }) })({ briefing: BRIEFING }), (error) => error.code === 'RENDER_OUTPUT_INVALID' && /tool/.test(error.message))
    assert.ok(Date.now() - started < 15_000, `held for ${Date.now() - started} ms`)
    assert.deepEqual(leftovers(fake.directory), [])
  } finally { fake.remove() }
})
