import assert from 'node:assert/strict'
import { Socket } from 'node:net'

export const OBSERVER_ABI = 'apollo-perception-observer/v1'
export const OBSERVER_FRAME_LIMIT = 65_536
const own = (value, key) => Object.hasOwn(value, key)

export function encodeObserverFrame(document) {
  const body = Buffer.from(JSON.stringify(document), 'utf8')
  assert.ok(body.length > 0 && body.length <= OBSERVER_FRAME_LIMIT, 'Observer frame exceeds bound')
  const frame = Buffer.allocUnsafe(4 + body.length)
  frame.writeUInt32BE(body.length); body.copy(frame, 4)
  return frame
}

export function decodeObserverFrames(buffer) {
  assert.ok(Buffer.isBuffer(buffer) && buffer.length <= OBSERVER_FRAME_LIMIT + 4, 'Observer buffer exceeds bound')
  if (buffer.length < 4) return { remaining: buffer }
  const size = buffer.readUInt32BE()
  assert.ok(size > 0 && size <= OBSERVER_FRAME_LIMIT, 'Invalid observer frame size')
  if (buffer.length < size + 4) return { remaining: buffer }
  assert.equal(buffer.length, size + 4, 'Observer pipelining is prohibited')
  const body = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(4))
  const document = JSON.parse(body)
  assert.ok(document && typeof document === 'object' && !Array.isArray(document), 'Invalid observer document')
  return { document, remaining: Buffer.alloc(0) }
}

export function validateObserverIdentity(document, expectedPid) {
  assert.ok(document && Number.isSafeInteger(document.pid) && document.pid > 0 && document.pid === expectedPid)
  assert.match(document.starttime, /^\d+$/)
  assert.match(document.state, /^[RSDZTtWXxIKP]$/)
  for (const name of ['ppid', 'sessionId', 'processGroupId']) assert.ok(Number.isSafeInteger(document[name]) && document[name] >= 0)
  for (const name of ['uids', 'gids']) {
    assert.ok(Array.isArray(document[name]) && document[name].length === 4 &&
      document[name].every((value) => Number.isSafeInteger(value) && value >= 0), 'Invalid observer credentials')
  }
  assert.equal(document.uid, document.uids[0]); assert.equal(document.gid, document.gids[0])
  for (const name of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) assert.match(document[name], /^[0-9a-f]{16}$/)
  assert.ok(document.NoNewPrivs === 0 || document.NoNewPrivs === 1)
  assert.ok(Number.isSafeInteger(document.inodeUid) && document.inodeUid >= 0)
  assert.ok(Number.isSafeInteger(document.environInodeUid) && document.environInodeUid >= 0)
  assert.match(document.environMode, /^0o[0-7]{1,4}$/)
  assert.ok(Array.isArray(document.groups) && document.groups.length <= 256 &&
    document.groups.every((value) => Number.isSafeInteger(value) && value >= 0))
  assert.deepEqual(Object.keys(document).sort(), ['pid', 'starttime', 'state', 'ppid', 'processGroupId', 'sessionId',
    'uids', 'gids', 'uid', 'gid', 'CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb', 'NoNewPrivs',
    'inodeUid', 'environInodeUid', 'environMode', 'groups'].sort(), 'Unknown observer identity field')
  return document
}

export function validateMarkerAttestation(document, expected) {
  assert.ok(document && typeof document.runMarked === 'boolean' && typeof document.knownMarker === 'boolean')
  assert.equal(document.attestation, 'privileged-proc-environ-identity-recheck/v1')
  validateObserverIdentity(document.identity, expected.pid)
  assert.equal(document.identity.starttime, expected.starttime, 'Observer marker identity changed')
  assert.deepEqual(document.identity.uids, expected.uids, 'Observer marker credentials changed')
  assert.deepEqual(document.identity.gids, expected.gids, 'Observer marker credentials changed')
  // No fabricated /proc/environ Buffer exists on this ABI.
  assert.deepEqual(Object.keys(document).sort(), ['attestation', 'identity', 'knownMarker', 'runMarked'])
  return document
}

export function validateObserverAuthority(authority, uid, gid) {
  validateObserverIdentity(authority.init, 1)
  validateObserverIdentity(authority.guardian, authority.guardian.pid)
  assert.deepEqual(authority.init.uids, [0, 0, 0, 0])
  assert.deepEqual(authority.guardian.uids, Array(4).fill(uid))
  assert.deepEqual(authority.guardian.gids, Array(4).fill(gid))
  assert.deepEqual(authority.guardian.groups, [])
  for (const [value, mask] of [[authority.init, '0000000000080024'], [authority.guardian, '0000000000000020']]) {
    for (const name of ['CapEff', 'CapPrm', 'CapBnd']) assert.equal(value[name], mask)
    for (const name of ['CapInh', 'CapAmb']) assert.equal(value[name], '0000000000000000')
    assert.equal(value.NoNewPrivs, 1)
  }
  assert.equal(authority.initParentDeathSignal, 9)
  assert.equal(authority.guardianFlags.keepCaps, 0)
  assert.equal(authority.guardianFlags.parentDeathSignal, 9)
  assert.match(authority.namespace.pid, /^pid:\[\d+\]$/)
  assert.match(authority.namespace.mount, /^mnt:\[\d+\]$/)
  assert.deepEqual(authority.order, ['private-propagation-and-proc-mounted', 'normal-bootstrap-dropped-and-measured',
    'init-minimal-capabilities-measured', 'guardian-minimal-capabilities-measured',
    'normal-node-bootstrap-exec-observed', 'normal-node-product-main-released'])
  return authority
}

export function createObserverClient({ socket, runId, deadlineAt, timeoutMs = 2500 }) {
  assert.match(runId, /^perception-namespace-[a-z0-9-]{1,100}$/)
  assert.ok(Number.isSafeInteger(deadlineAt) && deadlineAt > Date.now())
  let sequence = 0, pending, buffer = Buffer.alloc(0), failed
  const fail = (error) => {
    failed ??= error
    if (pending) { clearTimeout(pending.timer); pending.reject(failed); pending = undefined }
    socket.destroy()
  }
  socket.on('data', (chunk) => {
    try {
      assert.ok(pending, 'Unsolicited observer response')
      const decoded = decodeObserverFrames(Buffer.concat([buffer, chunk]))
      buffer = decoded.remaining
      if (!decoded.document) return
      const document = decoded.document
      assert.equal(document.abi, OBSERVER_ABI); assert.equal(document.runId, runId)
      assert.equal(document.seq, sequence, 'Observer response sequence mismatch')
      assert.deepEqual(Object.keys(document).sort(), document.ok === true
        ? ['abi', 'ok', 'result', 'runId', 'seq'] : ['abi', 'error', 'ok', 'runId', 'seq'])
      assert.equal(typeof document.ok, 'boolean')
      if (!document.ok) {
        assert.ok(document.error && Object.keys(document.error).length === 1)
        assert.match(document.error.code, /^[A-Z0-9_]{1,32}$/)
      }
      const current = pending; clearTimeout(current.timer); pending = undefined
      if (document.ok) current.resolve(document.result)
      else {
        current.reject(Object.assign(new Error(`Observer ${document.error.code}`), { code: document.error.code }))
      }
    } catch (error) { fail(error) }
  })
  socket.on('error', fail)
  socket.on('end', () => fail(new Error(buffer.length ? 'Truncated observer response' : 'Observer IPC closed')))
  socket.on('close', () => fail(new Error('Observer IPC closed')))
  return {
    runId,
    async request(op, values = {}) {
      if (failed) throw failed
      assert.ok(!pending, 'Observer requests must be serial')
      const remaining = deadlineAt - Date.now()
      assert.ok(remaining > 0, 'Observer deadline exhausted before request')
      assert.ok(!['abi', 'runId', 'seq', 'op'].some((name) => own(values, name)), 'Reserved observer request field')
      sequence += 1
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(new Error('Observer request deadline exceeded')), Math.min(timeoutMs, remaining))
        pending = { resolve, reject, timer }
        try { socket.write(encodeObserverFrame({ abi: OBSERVER_ABI, runId, seq: sequence, op, ...values })) }
        catch (error) { fail(error) }
      })
    },
    close() { socket.destroy() },
    async controlledFailure(kind) {
      assert.ok(['ipc-death', 'ipc-truncated', 'ipc-oversized'].includes(kind))
      assert.ok(!pending && !failed, 'Controlled IPC fault requires a healthy idle channel')
      const remaining = deadlineAt - Date.now()
      assert.ok(remaining > 0, 'Controlled IPC budget exhausted before send')
      const bytes = kind === 'ipc-truncated' ? Buffer.from([0, 0]) : Buffer.alloc(kind === 'ipc-oversized' ? 4 : 0)
      if (kind === 'ipc-oversized') bytes.writeUInt32BE(OBSERVER_FRAME_LIMIT + 1)
      let timer
      try {
        await new Promise((_, reject) => {
          timer = setTimeout(() => { const error = new Error('Controlled IPC send deadline'); fail(error); reject(error) },
            Math.min(timeoutMs, remaining))
          socket.end(bytes, () => reject(new Error(`Controlled namespace ${kind}`)))
        })
      } finally { clearTimeout(timer) }
    },
  }
}

export async function connectNamespaceObserver(env = process.env) {
  assert.equal(process.platform, 'linux', 'Namespace observer requires Linux')
  assert.match(env.APOLLO_OBSERVER_FD ?? '', /^\d+$/)
  const fd = Number(env.APOLLO_OBSERVER_FD)
  assert.ok(Number.isSafeInteger(fd) && fd >= 3, 'Invalid inherited observer descriptor')
  const client = createObserverClient({ socket: new Socket({ fd, readable: true, writable: true }),
    runId: env.APOLLO_OBSERVER_RUN_ID, deadlineAt: Number(env.APOLLO_PERCEPTION_JOB_DEADLINE_MS) })
  try {
    const attestation = await client.request('hello')
    assert.equal(attestation.abi, OBSERVER_ABI)
    validateObserverIdentity(attestation.owner, process.pid)
    assert.deepEqual(attestation.owner.uids, Array(4).fill(process.getuid()))
    assert.deepEqual(attestation.owner.gids, Array(4).fill(process.getgid()))
    assert.deepEqual(attestation.owner.groups, [])
    for (const name of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
      assert.equal(attestation.owner[name], '0000000000000000', 'Product Node must have no capabilities')
    }
    assert.equal(attestation.owner.NoNewPrivs, 1)
    validateObserverAuthority(attestation.authority, process.getuid(), process.getgid())
    let inventory = new Map()
    const read = async (pid) => {
      const result = await client.request('identity', { pid })
      return result === null ? null : validateObserverIdentity(result, pid)
    }
    const io = {
      async entries() {
        inventory = new Map()
        let token = null
        do {
          const page = await client.request('snapshot', { token })
          assert.ok(Array.isArray(page.entries) && page.entries.length <= 64)
          for (const item of page.entries) {
            assert.ok(Number.isSafeInteger(item.pid) && item.pid > 0 && !inventory.has(item.pid))
            assert.ok(item.error === null || typeof item.error === 'string')
            if (item.identity !== null) validateObserverIdentity(item.identity, item.pid)
            inventory.set(item.pid, item)
          }
          assert.ok(inventory.size <= 4096, 'Observer inventory bound exceeded')
          token = page.nextToken
          assert.ok(token === null || typeof token === 'string')
        } while (token !== null)
        return [...inventory.keys()].map(String)
      },
      identity: read,
      async owner(pid) {
        const item = inventory.get(pid)
        if (item?.error) throw Object.assign(new Error(`Observer metadata ${item.error}`), { code: item.error })
        const result = await read(pid)
        if (!result) throw Object.assign(new Error('Observer identity absent'), { code: 'ENOENT' })
        return result
      },
      async markerFacts(pid, runId) {
        assert.equal(runId, client.runId, 'Observer marker binding is immutable')
        const expected = await read(pid)
        if (!expected) throw Object.assign(new Error('Observer marker identity absent'), { code: 'ENOENT' })
        const result = await client.request('markers', { pid, starttime: expected.starttime })
        if (!result) throw Object.assign(new Error('Observer marker identity absent'), { code: 'ENOENT' })
        return validateMarkerAttestation(result, expected)
      },
    }
    return { client, io, readIdentity: read, runId: client.runId, attestation }
  } catch (error) { client.close(); throw error }
}
