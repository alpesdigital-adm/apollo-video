#!/usr/bin/env node
// A stand-in for the Codex CLI, for the suites that run the real adapter without an account, a network or a model (ADR-160 F6).
// It is started the way the adapter starts the real one (`node fake-codex.mjs <args>` for a .mjs binary) and speaks the part of the CLI the
// adapter uses: `--version`, `login status` and `exec ... -o <file> --output-schema <file> --json -C <dir> -` with the prompt on stdin.
//
// Its behaviour is the JSON file next to it (`<this file>.config.json`, written by the suite through `installFakeCodex`):
//   { loggedIn, answers: { "<briefing text>": <answer object> }, fallback, delayMs, hang, tool, fail, noAnswerFile, usage }
// Every invocation is appended to `<this file>.log.jsonl` with what it saw: arguments, the directory listing at start, the keys of its
// environment and the whole standard input, so a suite can prove what the adapter passed and what it did not.
import { fileURLToPath } from 'node:url'
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'

const decoded = fileURLToPath(import.meta.url)
const config = JSON.parse(readFileSync(`${decoded}.config.json`, 'utf8'))
const log = (entry) => appendFileSync(`${decoded}.log.jsonl`, `${JSON.stringify(entry)}\n`)
const args = process.argv.slice(2)

if (args[0] === '--version') { process.stdout.write(`${config.version ?? 'codex-cli 0.154.0'}\n`); process.exit(0) }
if (args[0] === 'login' && args[1] === 'status') {
  log({ command: 'login-status' })
  if (config.loggedIn === false) { process.stderr.write('Not logged in\n'); process.exit(1) }
  process.stdout.write('Logged in using ChatGPT\n')
  process.exit(0)
}
if (args[0] !== 'exec') { process.stderr.write('unsupported\n'); process.exit(2) }

const flag = (name) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1] }
const chunks = []
process.stdin.on('data', (chunk) => chunks.push(chunk))
process.stdin.on('end', async () => {
  const stdin = Buffer.concat(chunks).toString('utf8')
  const cwd = process.cwd()
  log({ command: 'exec', args, cwd, listing: readdirSync(cwd).sort(), environmentKeys: Object.keys(process.env).sort(), codexHome: process.env.CODEX_HOME ?? null, stdin, schemaExists: existsSync(flag('--output-schema') ?? '') })
  if (config.hang) { setInterval(() => undefined, 1_000); return }
  if (config.delayMs) await new Promise((resolve) => setTimeout(resolve, config.delayMs))
  const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`)
  emit({ type: 'thread.started', thread_id: 'fake-thread' })
  emit({ type: 'turn.started' })
  if (config.routerError) process.stderr.write('2026-10-23T02:27:38.357966Z ERROR codex_core::tools::router: error=code-mode host is disabled\n')
  if (config.fail) { emit({ type: 'turn.failed', error: { message: 'refused' } }); process.exit(1) }
  if (config.toolThenHang) { emit({ type: 'item.started', item: { id: 'item_0', type: 'collab_tool_call', tool: 'wait' } }); setInterval(() => undefined, 1_000); return }
  if (config.tool) emit({ type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'whoami' } })
  const briefing = JSON.parse(stdin.slice(stdin.lastIndexOf('{"briefing":'))).briefing
  const answer = Object.hasOwn(config.answers ?? {}, briefing) ? config.answers[briefing] : (config.fallback ?? { directives: [], unsupported: [], questions: [], coverage: [] })
  const text = typeof answer === 'string' ? answer : JSON.stringify(answer)
  if (!config.noAnswerFile) writeFileSync(flag('-o'), text)
  emit({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text } })
  emit({ type: 'turn.completed', usage: config.usage ?? { input_tokens: 1200, cached_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 0 } })
  process.exit(0)
})
