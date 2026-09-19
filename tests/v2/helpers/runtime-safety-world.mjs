import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// `fileURLToPath`, not `.pathname`: the latter keeps the leading slash of a Windows
// drive and leaves %20 in any path with a space, and this value is the `cwd` of every
// process this suite spawns.
export const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/**
 * The world for Wave 23 slice E: real workers, real FFmpeg, real PostgreSQL.
 *
 * Everything here is either the product under test or a boundary the test owns
 * outright — a throwaway cluster, a fixture ops-state directory, a spawned process
 * it holds the handle for. Nothing scans the machine, nothing touches a shared
 * server, and every process the run starts is remembered by PID so the postflight
 * can prove it is gone.
 *
 * Two facts this file is built around. The PostgreSQL 16 service on 5432 belongs to
 * other projects and is never touched: the cluster here is created by `initdb` on a
 * high port inside the session scratchpad. And `application_name` is how the
 * postflight recognises this run's own backends, so every URL carries one.
 */
export const RUNTIME_SAFETY_ENABLED = process.env.APOLLO_RUNTIME_SAFETY_E2E === '1'
export const RUNTIME_SAFETY_SKIP_REASON =
  'set APOLLO_RUNTIME_SAFETY_E2E=1 (a throwaway PostgreSQL 16 is started by the suite, or supply a migrated V2_DATABASE_URL)'

const PG_BIN_CANDIDATES = [
  process.env.APOLLO_E2E_PG_BIN,
  'C:/Program Files/PostgreSQL/16/bin',
  '/usr/lib/postgresql/16/bin',
  '/usr/local/opt/postgresql@16/bin',
].filter(Boolean)

/**
 * The PostgreSQL CLI to run, or the bare name for `PATH` to resolve.
 *
 * The first version returned the first candidate without checking it existed, so on
 * Linux it would have handed back a `C:/Program Files/...` path. It is never reached
 * in CI — the compose job supplies its database, so no cluster is created — but a
 * helper that only works where it is never used is a trap for the next run.
 */
function pgCommand(name) {
  const suffix = process.platform === 'win32' ? '.exe' : ''
  for (const directory of PG_BIN_CANDIDATES) {
    const candidate = join(directory, `${name}${suffix}`)
    if (existsSync(candidate)) return candidate
  }
  return name
}

/**
 * Runs one PostgreSQL CLI and waits for IT, not for whatever it leaves running.
 *
 * `execFile`'s promise settles on exit AND stream EOF. `pg_ctl start` launches a
 * postmaster that inherits those pipes and holds them open for its whole life, so the
 * await never returned even though `pg_ctl` itself had exited seconds earlier and the
 * server was accepting connections: the first two attempts at this suite spent their
 * entire 600 s test timeout inside a cluster start that had already succeeded.
 *
 * `detach: true` here means "give this command no pipes to leak", not a detached
 * process group — nothing is spawned with `detached`, which the architecture lint
 * forbids. Diagnostics for a failed start come from the server log file instead.
 */
function runPgCommand(name, args, { detach = false, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(pgCommand(name), args, {
      stdio: detach ? 'ignore' : ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: false,
    })
    let output = ''
    child.stdout?.on('data', (chunk) => { output += String(chunk) })
    child.stderr?.on('data', (chunk) => { output += String(chunk) })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    timer.unref?.()
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(output)
      else reject(new Error(`${name} exited ${code}: ${output.slice(-1_000)}`))
    })
  })
}

/**
 * The database URL rules AGENTS.md makes binding for every E2E run.
 *
 * Asserted rather than trusted: a suite that would happily point at a shared server
 * is one misconfigured environment away from deleting somebody else's rows, and the
 * 29 July 2026 incident started with exactly that shape.
 */
export function runtimeSafetyDatabaseUrl(baseUrl, caseName) {
  assert.match(caseName, /^[a-z0-9-]+$/, 'a case name becomes part of application_name')
  const url = new URL(baseUrl)
  url.searchParams.set('application_name', `apollo-video-e2e-runtime-safety-${caseName}`)
  url.searchParams.set('connection_limit', '5')
  url.searchParams.set('pool_timeout', '10')
  url.searchParams.set('connect_timeout', '10')
  assertIsolatedRuntimeSafetyDatabase(url.toString())
  return url.toString()
}

export function assertIsolatedRuntimeSafetyDatabase(databaseUrl) {
  const url = new URL(databaseUrl)
  assert.ok(
    ['localhost', '127.0.0.1', '::1'].includes(url.hostname),
    'the runtime-safety journeys are restricted to a disposable local PostgreSQL',
  )
  assert.match(
    url.searchParams.get('application_name') ?? '',
    /^apollo-video-e2e-runtime-safety-[a-z0-9-]+$/,
  )
  for (const [name, maximum] of [['connection_limit', 5], ['pool_timeout', 10], ['connect_timeout', 10]]) {
    const value = Number(url.searchParams.get(name))
    assert.ok(
      Number.isInteger(value) && value >= 1 && value <= maximum,
      `${name} must be an integer between 1 and ${maximum}`,
    )
  }
  assert.match(url.pathname.slice(1), /(?:^|_)e2e(?:_|$)/, 'the database name must say e2e')
  return url
}

/**
 * A PostgreSQL 16 cluster this run owns, or the one the CI job already provides.
 *
 * In the "Isolated Compose infrastructure" job `V2_DATABASE_URL` is already set and
 * migrated, so nothing is started and `stop()` is a no-op — the compose service is
 * not ours to shut down. Locally there is no Docker, so `initdb`/`pg_ctl` create a
 * cluster in the scratchpad on a port checked free first.
 *
 * `-m immediate` on the way out, and the data directory removed: the cluster is
 * disposable by construction: it is never dropped, because the whole data directory
 * goes instead, and state between journeys resets by deleting the run's own rows.
 */
export async function startRuntimeSafetyCluster({ scratchDir, runId }) {
  // Deliberately NOT `V2_DATABASE_URL`: the suite is launched with
  // `--env-file-if-exists=.env`, and the checked-in `.env` names a port nothing is
  // listening on. Taking it would make the suite fail against a server that does not
  // exist instead of starting the cluster it is supposed to own. The compose job
  // opts in explicitly.
  const provided = process.env.APOLLO_RUNTIME_SAFETY_DATABASE_URL?.trim()
  if (provided) {
    return {
      owned: false,
      baseUrl: provided,
      port: Number(new URL(provided).port || 5432),
      dataDirectory: null,
      async stop() { return { stopped: false, reason: 'the compose service is not owned by this run' } },
    }
  }

  const port = await findFreePort()
  const dataDirectory = join(scratchDir, `pgdata-${runId}`)
  await rm(dataDirectory, { recursive: true, force: true })
  await runPgCommand('initdb', [
    '-D', dataDirectory, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--locale=C',
  ], { timeoutMs: 180_000 })
  // `detach: true`: the postmaster this starts must not inherit a pipe of ours.
  await runPgCommand('pg_ctl', [
    '-D', dataDirectory,
    '-l', join(dataDirectory, 'server.log'),
    '-o', `-p ${port} -c listen_addresses=127.0.0.1 -c fsync=off`,
    '-w', 'start',
  ], { detach: true, timeoutMs: 120_000 })

  /**
   * Ends the cluster and does not claim to have, unless it has.
   *
   * The first version reported `stopped: true` after a `pg_ctl stop` it had
   * swallowed with `.catch()`, which is how a failed start left a listener behind
   * for a coordinator to find. `pg_ctl` is retried until the port stops answering,
   * and `fast` is tried before `immediate` so a live client gets a chance to
   * disconnect cleanly; the directory is only removed once the port is actually free.
   */
  let stopped = false
  const stop = async () => {
    if (stopped) return { stopped: true, alreadyStopped: true, port }
    const attempts = []
    for (const mode of ['fast', 'immediate', 'immediate', 'immediate']) {
      if (!(await isPortListening(port))) break
      const result = await runPgCommand(
        'pg_ctl', ['-D', dataDirectory, '-m', mode, 'stop'], { timeoutMs: 60_000 },
      ).then(() => ({ mode, ok: true }), (error) => ({ mode, ok: false, error: String(error).slice(0, 200) }))
      attempts.push(result)
      await delay(500)
    }
    const free = !(await isPortListening(port))
    stopped = free
    if (free) await rm(dataDirectory, { recursive: true, force: true }).catch(() => undefined)
    return { stopped: free, port, portFree: free, dataDirectory: free ? null : dataDirectory, attempts }
  }

  try {
    // `pg_ctl -w start` returning is NOT proof the server accepts connections: on
    // Windows it answered while the postmaster was still coming up, `createdb` got
    // ECONNREFUSED, and the failure path then left the cluster listening. Readiness
    // is asked of the server itself until it answers or the deadline passes.
    const readyBy = Date.now() + 60_000
    let ready = false
    let lastReadyError = null
    while (Date.now() < readyBy) {
      const probe = await runPgCommand(
        'pg_isready', ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres'],
        { timeoutMs: 15_000 },
      ).then(() => ({ ok: true }), (error) => ({ ok: false, error: String(error).slice(0, 200) }))
      if (probe.ok) { ready = true; break }
      lastReadyError = probe.error
      await delay(500)
    }
    if (!ready) throw new Error(`the throwaway cluster on ${port} never became ready: ${lastReadyError}`)

    await runPgCommand('createdb', [
      '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', 'apollo_v2_e2e',
    ], { timeoutMs: 60_000 })
  } catch (error) {
    const teardown = await stop()
    if (!teardown.stopped) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
        `AND the cluster could not be stopped: ${JSON.stringify(teardown)}`,
      )
    }
    throw error
  }

  return {
    owned: true,
    port,
    dataDirectory,
    baseUrl: `postgresql://postgres@127.0.0.1:${port}/apollo_v2_e2e?schema=public`,
    stop,
  }
}

/**
 * Applies the real migrations, with stdin closed and a deadline.
 *
 * Both details are scars. Run through `execFile` with an inherited stdin, the Prisma
 * CLI under the test runner blocked and the suite spent its entire 600 s timeout in
 * setup with no error and no child left to point at — a hang, not a failure. Stdin is
 * `ignore`d so nothing can wait on a prompt, and the deadline turns a stall into a
 * message that names the step.
 */
export async function migrateRuntimeSafetyCluster(databaseUrl, { timeoutMs = 240_000 } = {}) {
  const child = spawn(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', '--silent', 'db:v2:migrate:deploy'],
    {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, V2_DATABASE_URL: databaseUrl, CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      windowsHide: true,
    },
  )
  let output = ''
  child.stdout.on('data', (chunk) => { output += String(chunk) })
  child.stderr.on('data', (chunk) => { output += String(chunk) })

  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
  timer.unref?.()
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  clearTimeout(timer)

  assert.equal(code, 0, `db:v2:migrate:deploy exited ${code}: ${output.slice(-2_000)}`)
  assert.match(output, /migrations have been successfully applied|No pending migrations/, output.slice(-2_000))
  return output.slice(-500)
}

async function isPortListening(port) {
  const { createConnection } = await import('node:net')
  return await new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const done = (listening) => {
      socket.destroy()
      resolve(listening)
    }
    socket.setTimeout(750)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function findFreePort() {
  for (let port = 55_571; port <= 55_599; port += 1) {
    if (!(await isPortListening(port))) return port
  }
  throw new Error('no free port between 55571 and 55599 for a throwaway cluster')
}

/**
 * The artifact storage the journeys write through.
 *
 * Local driver by default; the compose job sets `APOLLO_V2_ARTIFACT_STORAGE_DRIVER=s3`
 * with MinIO and the S3 variables the capture journeys already use, and those are
 * passed straight through rather than re-derived, so the two environments cannot
 * drift apart on which bucket a render lands in.
 */
export function runtimeSafetyStorageEnvironment({ artifactRoot }) {
  const driver = process.env.APOLLO_V2_ARTIFACT_STORAGE_DRIVER?.trim() || 'local'
  // The names the compose job actually exports, read from its own step env rather
  // than guessed: the first list invented `APOLLO_V2_ARTIFACT_S3_*`/`AWS_*`, which
  // exist nowhere. A spawned worker inherits `process.env` anyway, so this list is
  // the explicit contract, not the only route — but a wrong one documents a lie.
  const passthrough = [
    'APOLLO_V2_S3_BUCKET',
    'APOLLO_V2_S3_REGION',
    'APOLLO_V2_S3_ENDPOINT',
    'APOLLO_V2_S3_ACCESS_KEY_ID',
    'APOLLO_V2_S3_SECRET_ACCESS_KEY',
    'APOLLO_V2_S3_FORCE_PATH_STYLE',
    'APOLLO_V2_S3_ALLOW_INSECURE_HTTP',
  ]
  const environment = { APOLLO_V2_ARTIFACT_STORAGE_DRIVER: driver, APOLLO_V2_ARTIFACT_ROOT: artifactRoot }
  for (const name of passthrough) {
    if (process.env[name] !== undefined) environment[name] = process.env[name]
  }
  return environment
}

/**
 * Everything the real render worker refuses to start without.
 *
 * Discovered by starting it: the source-cleanup branch demands its own work root and
 * the proxy branch demands an artifact root, so a journey that omitted either would
 * "prove" a gate closed when the process had actually died at import time.
 * `APOLLO_V2_RENDER_OUTPUT_ROOT` is deliberately left unset, which makes the
 * artifact-render branch the script's own no-op — the proxy branch is what these
 * journeys interrupt.
 */
export function renderWorkerEnvironment({ databaseUrl, artifactRoot, workRoot, opsStateDir, pollMs = 200, suffix }) {
  return {
    V2_DATABASE_URL: databaseUrl,
    APOLLO_API_ENVIRONMENT: 'production',
    APOLLO_V2_SOURCE_CLEANUP_WORK_ROOT: workRoot,
    APOLLO_PROTECTED_PAYLOAD_KEY_ID: `runtime-safety-${suffix}`,
    APOLLO_PROTECTED_PAYLOAD_KEY: Buffer.alloc(32, 7).toString('base64url'),
    APOLLO_V2_WORKER_POLL_MS: String(pollMs),
    ...(opsStateDir ? { APOLLO_OPS_STATE_DIR: opsStateDir } : {}),
    ...runtimeSafetyStorageEnvironment({ artifactRoot }),
  }
}

/**
 * A process this run owns: label, run id, PID, deadline and cleanup, per AGENTS.md.
 *
 * Nothing is fire-and-forget. The deadline is armed at spawn and kills the child if
 * the journey wedges, because an E2E that hangs is how orphans are born, and the
 * handle is kept so the postflight can assert on the PID rather than on a name.
 */
export function spawnSupervised({ script, environment, runId, label, deadlineMs = 120_000, args = [] }) {
  const child = spawn(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', script, ...args],
    {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Never detached: the architecture lint forbids it, and a detached child is one
      // this run could no longer prove it had ended.
      detached: false,
    },
  )

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })

  let exit = null
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exit = { code, signal }
      resolve(exit)
    })
  })

  const deadline = setTimeout(() => {
    if (exit === null) child.kill('SIGKILL')
  }, deadlineMs)
  deadline.unref?.()

  return {
    label,
    runId,
    pid: child.pid,
    child,
    get exit() { return exit },
    stdout: () => stdout,
    stderr: () => stderr,
    /**
     * Resolves once the process has proved it is running, rejects if it dies first.
     *
     * Without this a worker that threw at import looked exactly like a worker that
     * was simply slow: the journey polled an in-memory array, nothing was left
     * referenced, and the run was torn down with an event-loop message that named
     * neither the process nor its error. Here the child's own stderr is the message.
     */
    async waitForFirstEvent({ timeoutMs = 60_000, matches = () => true } = {}) {
      const startedAt = Date.now()
      while (Date.now() - startedAt < timeoutMs) {
        const seen = `${stdout}\n${stderr}`
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.startsWith('{'))
          .map((line) => { try { return JSON.parse(line) } catch { return null } })
          .filter((entry) => entry && typeof entry.event === 'string')
        if (seen.some(matches)) return seen
        if (exit !== null) {
          throw new Error(
            `${label} (pid ${child.pid}) exited ${JSON.stringify(exit)} before it logged anything.\n` +
            `stdout:\n${stdout.slice(-2_000)}\nstderr:\n${stderr.slice(-4_000)}`,
          )
        }
        await delay(100)
      }
      throw new Error(
        `${label} (pid ${child.pid}) logged no matching event within ${timeoutMs}ms.\n` +
        `stdout:\n${stdout.slice(-2_000)}\nstderr:\n${stderr.slice(-4_000)}`,
      )
    },
    /** Throws with the process's own output if it has already exited. */
    assertStillRunning(context) {
      if (exit === null) return
      throw new Error(
        `${label} (pid ${child.pid}) exited ${JSON.stringify(exit)} during ${context}.\n` +
        `stdout:\n${stdout.slice(-2_000)}\nstderr:\n${stderr.slice(-4_000)}`,
      )
    },
    /** Structured log lines the worker printed, parsed. Unparseable lines are ignored. */
    events: () => `${stdout}\n${stderr}`
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{'))
      .map((line) => { try { return JSON.parse(line) } catch { return null } })
      .filter((entry) => entry && typeof entry.event === 'string'),
    async waitExit() {
      const result = await exited
      clearTimeout(deadline)
      return result
    },
    /** SIGTERM, then SIGKILL after the grace window, always awaiting the real exit. */
    async terminate({ graceMs = 30_000, signal = 'SIGTERM' } = {}) {
      clearTimeout(deadline)
      if (exit !== null) return { ...exit, escalated: false, alreadyExited: true }
      const { terminateChild } = await import('../../../src/v2/application/worker-lifecycle.ts')
      const result = await terminateChild(child, { graceMs, signal })
      return { ...(exit ?? {}), ...result }
    },
  }
}

/**
 * The PIDs whose parent is `pid`, asked of the operating system by parent id.
 *
 * Never a name or pattern scan: on a shared machine "every ffmpeg" includes other
 * people's, and the only processes this run may speak about are its own descendants.
 * Windows has no `ps`, so CIM is asked the same question.
 */
/**
 * System PIDs Windows reports as the parent of orphans. Never a child of ours.
 *
 * Asked for the children of a PID that has exited, `Win32_Process` answered 0, 4,
 * 140, 184 and 720 — Idle, System and kernel service hosts. Counting those as
 * survivors of a render worker is how a postflight "finds" orphans that never
 * existed, so the query now requires a plausible PID and a creation time after the
 * process this run spawned.
 */
const WINDOWS_SYSTEM_PID_CEILING = 8

/**
 * The media binaries a render worker may start. Nothing else it spawns is work.
 *
 * Journey 1 asks "did the latched worker start rendering?", and on Windows spawning
 * any console process also creates a `conhost.exe` child — an artifact of the
 * operating system, not of admission. Asserting "no children at all" therefore failed
 * for a reason that has nothing to do with the gate, so the question is asked of the
 * processes that would actually mean work had begun. This is not a machine-wide name
 * scan: the candidate set is already restricted to this worker's own children.
 */
const MEDIA_CHILD_PATTERN = /ffmpeg|ffprobe|remotion|chrome|chromium/i

export function mediaChildren(children) {
  return children.filter((child) => MEDIA_CHILD_PATTERN.test(child.name ?? ''))
}

export async function childProcessIds(pid, options = {}) {
  return (await childProcessDetails(pid, options)).map((child) => child.pid)
}

export async function childProcessDetails(pid, { since } = {}) {
  if (!Number.isInteger(pid) || pid <= WINDOWS_SYSTEM_PID_CEILING) return []
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ` +
        'ForEach-Object { "{0}|{1}|{2}" -f $_.ProcessId, $_.Name, ' +
        '$_.CreationDate.ToUniversalTime().ToString("o") }',
      ], { maxBuffer: 4 * 1024 * 1024 })
      return stdout.split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [id, name, created] = line.split('|')
          return { pid: Number(id), name, created: Date.parse(created) }
        })
        .filter((entry) => Number.isInteger(entry.pid) && entry.pid > WINDOWS_SYSTEM_PID_CEILING)
        // A PID recycled after our process died would otherwise be reported as its
        // child: only something started after we spawned it can be ours.
        .filter((entry) => !since || !Number.isFinite(entry.created) || entry.created >= since - 1_000)
        .map((entry) => ({ pid: entry.pid, name: entry.name }))
    }
    const { stdout } = await execFileAsync('ps', ['-o', 'pid=,comm=', '--ppid', String(pid)], {
      maxBuffer: 4 * 1024 * 1024,
    })
    return stdout.split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [id, ...rest] = line.split(/\s+/)
        return { pid: Number(id), name: rest.join(' ') }
      })
      .filter((child) => Number.isInteger(child.pid) && child.pid > 1)
  } catch {
    // No children is the ordinary answer on both platforms: `ps --ppid` exits 1 when
    // it matches nothing, which is not an error about this run.
    return []
  }
}

/** Every descendant PID of `pid`, breadth-first, so a wrapper's grandchild still counts. */
export async function descendantProcessIds(pid, { depth = 3, since } = {}) {
  const found = new Set()
  let frontier = [pid]
  for (let level = 0; level < depth && frontier.length; level += 1) {
    const next = []
    for (const parent of frontier) {
      for (const child of await childProcessIds(parent, { since })) {
        if (found.has(child) || child === pid) continue
        found.add(child)
        next.push(child)
      }
    }
    frontier = next
  }
  return [...found]
}

/**
 * Whether this platform can deliver a signal a process may handle.
 *
 * Node on Windows maps `child.kill('SIGTERM')` onto `TerminateProcess`: the child is
 * ended outright and never runs a handler, which the exit codes prove — every worker
 * stopped here reports `{ code: null, signal: 'SIGTERM' }` rather than the 0 its own
 * shutdown path would produce. Journeys whose subject IS the graceful path therefore
 * cannot be measured on Windows, and a suite that asserted them anyway would be
 * reporting the platform, not the product.
 */
export const GRACEFUL_SIGNALS_AVAILABLE = process.platform !== 'win32'
export const GRACEFUL_SIGNALS_REASON =
  'not-executed on win32: Node maps child.kill("SIGTERM") to TerminateProcess, so the worker never runs its shutdown path; measured in the Linux CI job'

export async function processIsAlive(pid) {
  if (!Number.isInteger(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Backends belonging to this run, counted with the retry loop the CI language uses.
 *
 * A single reading of `pg_stat_activity` is not proof a client has gone: the backend
 * outlives the socket by a moment. The count is retried until it settles at zero or
 * the window closes, and the last reading is what the postflight reports.
 */
export async function backendsFor(prisma, applicationName, { attempts = 20, intervalMs = 250 } = {}) {
  let last = -1
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const rows = await prisma.$queryRawUnsafe(
      'SELECT count(*)::int AS backends FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()',
      applicationName,
    )
    last = rows[0]?.backends ?? 0
    if (last === 0) return 0
    await delay(intervalMs)
  }
  return last
}

/**
 * A referenced sleep. Never `unref` a timer that is the only thing resolving an await.
 *
 * The first Linux CI run died with "Promise resolution is still pending but the event
 * loop has already resolved": this timer was unref'd, so whenever nothing else was
 * ref'd — between two polls of an in-memory value — Node decided it had no work left
 * and tore the run down mid-journey. An unref'd timer is only ever safe as the loser
 * of a race against something referenced, which is why the deadline timers below keep
 * theirs and this one does not.
 */
export function delay(milliseconds, { unref = false } = {}) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    if (unref) timer.unref?.()
  })
}

/**
 * Polls until `read()` satisfies `until`, then answers the value that satisfied it.
 *
 * The failure message carries the last value seen, because "timed out" alone cannot
 * tell a worker that never claimed from a worker that claimed and failed.
 */
export async function pollUntil({
  read, until, what, timeoutMs = 60_000, intervalMs = 150, whileAlive,
}) {
  const startedAt = Date.now()
  let last
  while (Date.now() - startedAt < timeoutMs) {
    last = await read()
    if (until(last)) return last
    // A process that has died will never satisfy the condition, and waiting out the
    // whole timeout only replaces its error message with a stopwatch.
    whileAlive?.(`waiting for ${what}`)
    await delay(intervalMs)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}; last reading: ${JSON.stringify(last)}`)
}

/** Reads for at least `samples` polls and asserts the condition held in every one. */
export async function holdsAcross({ read, holds, samples, intervalMs, what }) {
  const readings = []
  for (let sample = 0; sample < samples; sample += 1) {
    const value = await read()
    readings.push(value)
    assert.ok(holds(value), `${what} broke on poll ${sample + 1}: ${JSON.stringify(value)}`)
    await delay(intervalMs)
  }
  return readings
}

/* ------------------------------------------------------------------------- *
 * The ops-state directory. CONTROLLED boundary: these files stand in for the
 * monitor's own writes so a journey can put the gate in a state on demand. The
 * reader under test is the product's.
 * ------------------------------------------------------------------------- */

export const OPS_GATE_SCHEMA = 'apollo-ops-gate/v1'
export const OPS_LATCH_SCHEMA = 'apollo-ops-latch/v1'

export async function createOpsStateDir(root, name) {
  const directory = join(root, `ops-state-${name}`)
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
  return directory
}

export async function writeLatch(directory, { runId, reason = 'stop-timeout', detail = 'controlled fixture latch' }) {
  const path = join(directory, 'latch.json')
  await writeFile(path, `${JSON.stringify({
    schemaVersion: OPS_LATCH_SCHEMA,
    engagedAtIso: new Date().toISOString(),
    runId,
    reason,
    detail,
    evidence: { journal: `journal/${runId}.ndjson`, lastSampleSeq: 1 },
  }, null, 2)}\n`)
  return path
}

export async function removeLatch(directory) {
  await rm(join(directory, 'latch.json'), { force: true })
}

/**
 * Writes `gate.json`, optionally back-dated so an open gate reads as stale.
 *
 * Freshness is measured from the file's mtime on this host, so `utimes` is how a
 * dead monitor is simulated without waiting out a real TTL. Labelled controlled
 * wherever a journey uses it.
 */
export async function writeGate(directory, { state, reasons = [], ttlMs = 3_000, seq = 1, runId, ageMs = 0 }) {
  const path = join(directory, 'gate.json')
  await writeFile(path, `${JSON.stringify({
    schemaVersion: OPS_GATE_SCHEMA,
    state,
    reasons,
    seq,
    issuedAtIso: new Date(Date.now() - ageMs).toISOString(),
    issuedAtMonotonicMs: 1_000,
    ttlMs,
    owner: { runId, kind: 'monitor', pid: process.pid },
  }, null, 2)}\n`)
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs)
    await utimes(path, when, when)
  }
  return path
}

export function scratchRoot(runId) {
  // Outside the repository: build tracing must never see a run's logs, and an
  // `.apollo/` log is what a previous wave had to be told twice not to create.
  return join(tmpdir(), 'apollo-runtime-safety', runId)
}

export function newRunId() {
  return `runtime-safety-${new Date().toISOString().replaceAll(/[:.]/g, '').slice(0, 15)}-${randomUUID().slice(0, 8)}`
}
