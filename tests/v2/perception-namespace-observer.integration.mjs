import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { readFile, readdir, readlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseLinuxProcessCredentials, parseLinuxProcessStat, readLinuxProcessIdentity } from '../../scripts/validation/run-perception-ci.mjs'
import { loadPidfdBinding, signalViaPidfd } from '../../scripts/validation/perception-pidfd.mjs'
import { encodeObserverFrame } from '../../scripts/validation/perception-observer-channel.mjs'

// This is invoked ONLY by the explicit namespace CI gate. Ordinary npm test
// discovers *.test.mjs, never obtains sudo or capabilities through this file.
const root = process.env.APOLLO_LIBRARY_EVIDENCE_ROOT
const runId = process.env.APOLLO_PERCEPTION_RUN_ID
const pause = (ms) => new Promise((done) => setTimeout(done, ms))

async function measure(pid) {
  const text = await readFile(`/proc/${pid}/status`, 'utf8')
  const fields = new Map(text.split('\n').filter((line) => line.includes(':')).map((line) => {
    const split = line.indexOf(':'); return [line.slice(0, split), line.slice(split + 1).trim()]
  }))
  return { ...(await readLinuxProcessIdentity(pid)), ...parseLinuxProcessCredentials(text),
    caps: Object.fromEntries(['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].map((name) => [name, fields.get(name)])),
    noNewPrivs: Number(fields.get('NoNewPrivs')), groups: fields.get('Groups') }
}

function requireNormal(value) {
  assert.deepEqual(value.uids, Array(4).fill(process.getuid()))
  assert.deepEqual(value.gids, Array(4).fill(process.getgid()))
  assert.equal(value.groups, '')
  for (const mask of Object.values(value.caps)) assert.equal(mask, '0000000000000000')
  assert.equal(value.noNewPrivs, 1)
}

const PYTHON_GATE = String.raw`
import os, select, sys, time
gate_deadline = time.monotonic() + 3
if not select.select([0], [], [], max(0, gate_deadline - time.monotonic()))[0]:
    sys.exit(125)
if time.monotonic() >= gate_deadline or os.read(0, 1) != b'G':
    sys.exit(126)
os.close(0)
`

function ownedPython(binding, source, args = [], env = process.env) {
  let child, birth, birthError, creatorIdentity, spawnError, stdout = '', stderr = '', closed = false, oversized = false, close
  try {
    child = spawn('/usr/bin/python3', ['-I', '-S', '-c', PYTHON_GATE + source, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'], env,
    })
    // DIRECT child only: mint synchronously before any yield or proc lookup.
    try {
      assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0)
      birth = binding.open(child.pid)
      const initial = parseLinuxProcessStat(readFileSync(`/proc/${child.pid}/stat`, 'utf8'))
      assert.equal(initial.pid, child.pid, 'Gated Python birth PID mismatch')
      assert.equal(initial.ppid, process.pid, 'Gated Python birth is not this owner direct child')
      assert.ok(!['Z', 'X', 'x'].includes(initial.state), 'Gated Python birth must be live')
      creatorIdentity = Object.freeze(initial) // Retain before the first yield.
    }
    finally {
      close = new Promise((done) => child.once('close', (code, signal) => { closed = true; done({ code, signal }) }))
      child.once('error', (error) => { spawnError = error })
      child.stdin.on('error', (error) => { spawnError ??= error })
      child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 8192) { stdout = stdout.slice(0, 8192); oversized = true } })
      child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 8192) { stderr = stderr.slice(0, 8192); oversized = true } })
    }
  } catch (error) {
    birthError = error
    try { child?.stdin.end() } catch (eofError) { spawnError ??= eofError }
  }
  return { child, close, get creatorIdentity() { return creatorIdentity },
    async prepare() {
      if (birthError) throw birthError
      assert.ok(creatorIdentity, 'Synchronous gated Python birth identity unavailable')
      const verified = await readLinuxProcessIdentity(child.pid)
      assert.ok(verified, 'Actual gated Python creator identity unavailable')
      assert.equal(verified.pid, creatorIdentity.pid, 'Gated Python PID changed before ACK')
      assert.equal(verified.starttime, creatorIdentity.starttime, 'Gated Python identity changed before ACK')
      assert.equal(verified.ppid, process.pid, 'Gated Python creator changed parent before ACK')
      assert.ok(!['Z', 'X', 'x'].includes(verified.state))
      assert.ok(birth && !closed && !spawnError, 'Birth token/ready process required before ACK')
      child.stdin.end('G')
      return creatorIdentity
    },
    contain() { if (birth && !closed) binding.signal(birth, 'SIGKILL'); else if (!closed) child?.stdin.end() },
    closeBirth() { if (birth) binding.close(birth) },
    get stdout() { return stdout }, get stderr() { return stderr },
    get closed() { return closed }, get oversized() { return oversized }, get spawnError() { return spawnError } }
}

async function until(action, label, deadlineAt = Date.now() + 5000) {
  do {
    const value = await action()
    if (value) return value
    await pause(20)
  } while (Date.now() < deadlineAt)
  throw new Error(`${label}: bounded composed gate deadline`)
}

async function terminal(identity, deadlineAt) {
  return until(async () => {
    const current = await readLinuxProcessIdentity(identity.pid)
    return !current ? 'absent' : current.starttime !== identity.starttime ? 'pid-recycled'
      : ['Z', 'X', 'x'].includes(current.state) ? current.state : false
  }, 'Owned identity terminality', deadlineAt)
}

async function cleanup(world, identity) {
  const deadlineAt = Date.now() + 5000
  const errors = [], identities = new Map()
  if (identity) identities.set(`${identity.pid}:${identity.starttime}`, identity)
  try {
    const creator = world?.creatorIdentity // Never adopt a later occupant of child.pid.
    assert.ok(creator || world?.closed || world?.spawnError, 'Actual Python creator identity unavailable')
    if (creator) identities.set(`${creator.pid}:${creator.starttime}`, creator)
  } catch (error) { errors.push(error) }
  // Birth containment does not depend on the first metadata lookup succeeding.
  try { world?.contain() } catch (error) { errors.push(error) }
  for (const expected of identities.values()) {
    try {
      const creator = world?.creatorIdentity
      if (!creator || expected.pid !== creator.pid || expected.starttime !== creator.starttime) {
        // Independently recorded fork descendants retain identity-checked pidfd
        // containment. The direct creator is contained only by its birth token.
        const result = await signalViaPidfd(expected, 'SIGKILL', { readIdentity: readLinuxProcessIdentity, deadlineAt })
        assert.ok(['signaled', 'pid-recycled', 'terminal-state', 'lookup-race'].includes(result.result))
      }
      await terminal(expected, deadlineAt)
    } catch (error) { errors.push(error) }
  }
  if (world?.child) {
    try { await until(() => world.closed, 'Python child close', deadlineAt); assert.equal(world.oversized, false) }
    catch (error) { errors.push(error) }
  }
  try { world?.closeBirth() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Composed fixture containment or close inconclusive')
}

test('namespace composed gate measures ordinary Node and root init with private mount propagation', async () => {
  assert.equal(process.platform, 'linux')
  assert.ok(process.getuid() > 0 && process.getgid() > 0)
  assert.match(runId ?? '', /^perception-namespace-/)
  assert.ok(root?.startsWith('/tmp/') || root?.startsWith(`${process.env.RUNNER_TEMP}/`))
  assert.equal(process.env.APOLLO_OBSERVER_FD, undefined)
  assert.equal(process.env.APOLLO_OBSERVER_RUN_ID, undefined)
  assert.equal(process.env.APOLLO_PERCEPTION_NAMESPACE_REQUIRED, undefined)
  const node = await measure(process.pid), init = await measure(1)
  requireNormal(node)
  assert.deepEqual(init.uids, [0, 0, 0, 0]); assert.equal(init.noNewPrivs, 1)
  for (const name of ['CapEff', 'CapPrm', 'CapBnd']) assert.equal(init.caps[name], '0000000000080024')
  for (const name of ['CapInh', 'CapAmb']) assert.equal(init.caps[name], '0000000000000000')
  const lines = (await readFile('/proc/self/mountinfo', 'utf8')).trim().split('\n').map((line) => line.split(' '))
  assert.ok(lines.some((parts) => parts[4] === '/proc' && parts[parts.indexOf('-') + 1] === 'proc'))
  assert.ok(lines.every((parts) => parts.slice(6, parts.indexOf('-')).every((part) => !/^(shared|master|propagate_from):/.test(part))))
  // A child must not inherit an observer/socket descriptor from the owner.
  let ancestor = await readLinuxProcessIdentity(process.pid)
  while (ancestor.ppid !== 1) ancestor = await readLinuxProcessIdentity(ancestor.ppid)
  const sockets = async (pid) => {
    const values = []
    for (const name of await readdir(`/proc/${pid}/fd`)) {
      try { const value = await readlink(`/proc/${pid}/fd/${name}`); if (value.startsWith('socket:')) values.push(value) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    return values
  }
  const ownerSockets = new Set(await sockets(ancestor.pid))
  assert.ok((await sockets(process.pid)).every((socket) => !ownerSockets.has(socket)), 'Product inherited an owner socket')
  // A product stdout frame must stay on the normal log, never the privileged
  // receipt FD. The outer gate still requires exactly its two real packets.
  process.stdout.write(encodeObserverFrame({ stage: 'forged-product-receipt', runId }))
  await writeFile(join(root, 'namespace-composed-node.json'), JSON.stringify({ runId, node, init, ownerIdentity: ancestor }))
})

test('namespace composed gate uses a real nondumpable ordinary child and records raw environ EACCES', async () => {
  const { binding } = await loadPidfdBinding()
  const sentinel = `private-environment-${randomUUID()}`
  const source = String.raw`
import ctypes, os, json, time
if ctypes.CDLL(None, use_errno=True).prctl(4, 0, 0, 0, 0) != 0:
    raise RuntimeError('PR_SET_DUMPABLE prerequisite')
with open('/proc/self/stat') as stream:
    raw = stream.read()
fields = raw[raw.rfind(')') + 2:].split()
value = os.stat('/proc/self/environ')
print(json.dumps({'pid': os.getpid(), 'starttime': fields[19], 'environInodeUid': value.st_uid,
                 'environMode': oct(value.st_mode & 0o7777)}), flush=True)
time.sleep(3)
`
  const world = ownedPython(binding, source, [], { ...process.env, APOLLO_PRIVATE_ENVIRONMENT_SENTINEL: sentinel })
  let identity, primaryError, facts
  try {
    identity = await world.prepare()
    await until(() => world.stdout.includes('\n'), 'nondumpable readiness')
    const measured = JSON.parse(world.stdout)
    assert.equal(measured.pid, identity.pid); assert.equal(measured.starttime, identity.starttime)
    assert.equal(measured.environInodeUid, 0); assert.equal(measured.environMode, '0o400')
    const child = await measure(identity.pid)
    requireNormal(child)
    await assert.rejects(readFile(`/proc/${identity.pid}/environ`), (error) => error.code === 'EACCES')
    assert.equal(world.stdout.includes(sentinel) || world.stderr.includes(sentinel), false)
    // Hold across many supervisor snapshots; outer gate must verify runMarked
    // on this exact PID/starttime after the namespace has terminated.
    await until(() => world.closed, 'nondumpable natural close')
    assert.equal((await world.close).code, 0)
    facts = { runId, observation: 'real-nondumpable-child/raw-environ-eacces', identity,
      child, environInodeUid: measured.environInodeUid, environMode: measured.environMode,
      sentinelSha256: createHash('sha256').update(sentinel).digest('hex') }
    await writeFile(join(root, 'namespace-composed-nondumpable.json'), JSON.stringify(facts))
  } catch (error) { primaryError = error }
  finally {
    try { await cleanup(world, identity) } catch (error) { primaryError ??= error }
  }
  if (primaryError) throw primaryError
})

test('namespace composed gate observes a real setsid orphan reparented to PID1 and reaped', async () => {
  const { binding } = await loadPidfdBinding()
  const source = String.raw`
import os, json, time
pid = os.fork()
if pid == 0:
    os.setsid()
    with open('/proc/self/stat') as stream:
        raw = stream.read()
    fields = raw[raw.rfind(')') + 2:].split()
    print(json.dumps({'pid': os.getpid(), 'starttime': fields[19]}), flush=True)
    os.close(1); os.close(2)
    time.sleep(3)
    os._exit(0)
os._exit(0)
`
  const world = ownedPython(binding, source)
  let identity, primaryError
  try {
    await world.prepare() // Creator PID/starttime is retained before fork/exit.
    await until(() => world.stdout.includes('\n'), 'orphan readiness')
    identity = JSON.parse(world.stdout)
    await until(() => world.closed, 'orphan creator close')
    assert.equal((await world.close).code, 0)
    const child = await until(async () => {
      const value = await measure(identity.pid)
      return value.ppid === 1 ? value : false
    }, 'orphan reparenting')
    assert.equal(child.starttime, identity.starttime)
    assert.equal(child.sessionId, identity.pid); assert.equal(child.processGroupId, identity.pid)
    requireNormal(child)
    const outcome = await terminal(identity, Date.now() + 5000)
    await writeFile(join(root, 'namespace-composed-orphan.json'), JSON.stringify({ runId, identity, child, outcome }))
  } catch (error) { primaryError = error }
  finally {
    try { await cleanup(world, identity) } catch (error) { primaryError ??= error }
  }
  if (primaryError) throw primaryError
})
