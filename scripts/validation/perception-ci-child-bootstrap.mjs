import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { isAbsolute, join, dirname, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const MODES = new Set(['compile', 'unit', 'namespace', 'gates', 'outer-launcher'])
export async function awaitBootstrapGate(input = process.stdin, milliseconds = 5000) {
  let timer
  try {
    await new Promise((done, reject) => {
      const cleanup = () => { input.removeListener('data', data); input.removeListener('end', eof); input.removeListener('error', error) }
      const data = (bytes) => { cleanup(); bytes.length === 1 && bytes[0] === 71 ? done() : reject(new Error('Invalid fixed bootstrap ACK')) }
      const eof = () => { cleanup(); reject(new Error('Fixed bootstrap EOF before ACK')) }
      const error = (value) => { cleanup(); reject(value) }
      input.once('data', data); input.once('end', eof); input.once('error', error)
      timer = setTimeout(() => { cleanup(); reject(new Error('Fixed bootstrap ACK deadline')) }, milliseconds)
      input.resume()
    })
  } finally { clearTimeout(timer); input.pause() }
}
async function main() {
  const [mode, ...args] = process.argv.slice(2)
  assert.equal(process.platform, 'linux'); assert.ok(process.getuid() > 0)
  assert.ok(MODES.has(mode), 'No arbitrary bootstrap command')
  await awaitBootstrapGate()
  if (mode === 'compile') {
    const [compiler, timeout, headers, source, root] = args
    assert.equal(args.length, 5); for (const path of args) assert.ok(isAbsolute(path))
    assert.equal(source, join(ROOT, 'scripts/validation/perception-pidfd.c'))
    const script = 'set -euo pipefail; "$1" --version >"$5/compiler.version"; "$1" -std=c11 -O2 -shared -fPIC -Wall -Wextra -Werror -I "$2" "$3" -o "$4" -lm'
    const child = spawn(timeout, ['--signal=TERM', '--kill-after=5s', '55s', '/usr/bin/bash', '-c', script,
      'apollo-fixed-compiler', compiler, headers, source, join(root, 'perception-pidfd.node'), root],
    { cwd: ROOT, env: process.env, stdio: ['ignore', 'inherit', 'inherit'] })
    let primary
    const outcome = await new Promise((done) => {
      child.once('error', (error) => { primary = error }); child.once('close', (code, signal) => done({ code, signal }))
    })
    if (primary) throw primary
    process.exitCode = outcome.code === 0 && outcome.signal === null ? 0 : 1
  } else if (mode === 'unit') {
    assert.equal(args.length, 0)
    const npm = realpathSync(join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'))
    const child = spawn(process.execPath, [npm, 'test'], { cwd: ROOT, env: process.env, stdio: ['ignore', 'inherit', 'inherit'] })
    let primary
    const result = await new Promise((done) => {
      child.once('error', (error) => { primary = error }); child.once('close', (code, signal) => done({ code, signal }))
    })
    if (primary) throw primary
    process.exitCode = result.code === 0 && result.signal === null ? 0 : 1
  } else if (mode === 'gates') {
    assert.deepEqual(args, ['tests/v2/perception-namespace-observer.integration.mjs'])
    const { runNamespaceGates } = await import('./run-perception-namespace-gates.mjs')
    await runNamespaceGates()
  } else if (mode === 'outer-launcher') {
    assert.equal(args.length, 0)
    const { runParentGatedNamespaceLauncher } = await import('./run-perception-ci-namespace.mjs')
    await runParentGatedNamespaceLauncher()
  } else {
    const { runNamespaceSuite, assertPerceptionSuite } = await import('./run-perception-ci-namespace.mjs')
    assertPerceptionSuite(args[0], args[1] ?? null)
    const report = await runNamespaceSuite({ suite: args[0], pattern: args[1] ?? null })
    if (!report.success) process.exitCode = 1
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main() } catch (error) { process.stderr.write(`Fixed bootstrap failed: ${error.message}\n`); process.exitCode = 1 }
}
