import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import net from 'node:net'
import { resolve } from 'node:path'

const delay = (ms) => new Promise((done) => setTimeout(done, ms))

export async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close((error) => (error ? reject(error) : resolvePort(port)))
    })
  })
}

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Next production server exited with ${child.exitCode}`)
    try { if ((await fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(1_000) })).ok) return } catch { /* not yet */ }
    await delay(250)
  }
  throw new Error('Next production server did not become ready within 60 seconds')
}

/** SIGTERM, grace, SIGKILL, and refuse to pretend it stopped. */
export async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((done) => { child.once('exit', () => done(true)); child.once('error', () => done(true)) })
  child.kill('SIGTERM')
  const graceful = await Promise.race([exited, delay(5_000).then(() => false)])
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    if (!(await Promise.race([exited, delay(5_000).then(() => false)]))) throw new Error(`Next production server PID ${child.pid} ignored SIGKILL`)
  }
}

/** `next start` of the checkout's production build, wired to the world's database, artifact root and UI login. */
export async function startServer({ appRoot, environment }) {
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], {
    cwd: appRoot, env: { ...process.env, ...environment, NODE_ENV: 'production', __NEXT_PROCESSED_ENV: 'true' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  const logs = { text: '' }
  child.stdout.on('data', (chunk) => { logs.text += String(chunk) })
  child.stderr.on('data', (chunk) => { logs.text += String(chunk) })
  await waitForServer(baseUrl, child)
  return { baseUrl, child, logs, stop: () => stopChild(child) }
}

export function chromeExecutable() {
  const found = [
    process.env.PLAYWRIGHT_CHROME_EXECUTABLE,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((candidate) => candidate && existsSync(candidate))
  if (!found) throw new Error('set PLAYWRIGHT_CHROME_EXECUTABLE to a Chromium executable')
  return resolve(found)
}

/** A bearer-authenticated JSON call to the running server. */
export function apiClient(baseUrl, token) {
  return async function call(method, path, { body, key, headers = {} } = {}) {
    const response = await fetch(new URL(path, baseUrl), {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}), accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key ? { 'idempotency-key': key } : {}), ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      // A server that never answers is a failure with a name, not a run that is killed by the clock.
      signal: AbortSignal.timeout(90_000),
    })
    const payload = await response.json().catch(() => null)
    return { status: response.status, body: payload, data: payload?.data ?? null, error: payload?.error ?? null }
  }
}
