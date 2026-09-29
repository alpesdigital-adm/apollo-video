import { spawn } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TIME_LIMIT_MS = 100_000 // Whole suite: intended for ~40 s unit checks and ~10 s Linux smoke.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const gate = join(root, 'scripts/ops/disposable-test-gate.py')
const suites = join(root, 'tests/ops')

function isFile(path) {
  try { return statSync(path).isFile() } catch { return false }
}

function isDirectory(path) {
  try { return statSync(path).isDirectory() } catch { return false }
}

function stopTree(child) {
  if (!child.pid) return Promise.resolve()
  if (process.platform === 'win32') {
    // taskkill's request is not proof that descendants have exited.
    return new Promise((done) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, shell: false })
      killer.once('error', () => done())
      killer.once('close', () => done())
    })
  }
  try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
  return Promise.resolve()
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/ops/run-disposable-validation-tests.mjs [--require-linux]')
    console.log('Runs tests/ops/test_*.py using PYTHON or python (Windows) / python3 (Unix). Python >=3.12 required.')
    console.log('Local-only, no network or environment files. Hard limit: 100 seconds for the entire Python suite.')
    return 0
  }
  if (args.some((arg) => arg !== '--require-linux') || args.length > 1) {
    console.error('Usage: node scripts/ops/run-disposable-validation-tests.mjs [--require-linux]')
    return 2
  }
  if (args[0] === '--require-linux' && process.platform !== 'linux') {
    console.error('Linux required; no tests executed.')
    return 1
  }
  if (!isFile(gate) || !isDirectory(suites) || !readdirSync(suites).some((name) => /^test_.*\.py$/.test(name) && isFile(join(suites, name)))) {
    console.error('Disposable gate or canonical test suite missing.')
    return 1
  }

  const temporary = [process.env.TMPDIR, process.env.RUNNER_TEMP, tmpdir()].find((path) => path && isDirectory(path))
  if (!temporary) {
    console.error('No valid temporary directory for disposable tests.')
    return 1
  }
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  const child = spawn(python, ['-W', 'error::ResourceWarning', gate, ...args], {
    cwd: root, stdio: 'inherit', shell: false, windowsHide: true,
    detached: process.platform !== 'win32',
    env: { ...process.env, TMPDIR: temporary, TEMP: temporary, TMP: temporary, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' },
  })
  let timedOut = false
  let interrupted = false
  let termination = Promise.resolve()
  const timer = setTimeout(() => {
    timedOut = true
    termination = stopTree(child)
  }, TIME_LIMIT_MS)
  const interrupt = () => {
    interrupted = true
    termination = stopTree(child)
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  const status = await new Promise((done) => {
    child.once('error', () => done(1))
    child.once('close', (code) => done(code ?? 1))
  })
  clearTimeout(timer)
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
  await termination
  if (timedOut) {
    console.error('Disposable test suite exceeded the 100-second limit; termination requested. Confirm process and descendants exited before retry.')
    return 124
  }
  if (interrupted) return 130
  if (status !== 0) console.error('Disposable test gate failed; see counts above (no automatic retry).')
  return status
}

process.exitCode = await main()
