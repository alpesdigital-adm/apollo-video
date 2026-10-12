// Fixed CI namespace bootstrap: standard library only until the product ACK.
// It runs after BOTH Python authorities were reduced/measured. Never spawn,
// require addon, import the product, or alter dumpability/capabilities here.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync, createReadStream, fstatSync, readFileSync, readlinkSync, writeSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function bootstrapReadback({ status, stat, pid, uid, gid, namespace }) {
  assert.ok(Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid > 0)
  assert.ok(status.length <= 65536 && stat.length <= 8192)
  const end = stat.lastIndexOf(')'), fields = stat.slice(end + 2).trim().split(/\s+/)
  assert.ok(stat.startsWith(`${pid} (`) && stat.slice(end, end + 2) === ') ' && fields.length >= 50)
  assert.match(fields[0], /^[RSDZTtWXxIKP]$/); assert.match(fields[19], /^\d+$/)
  assert.ok(fields.slice(1).every((value) => /^-?\d+$/.test(value)))
  assert.equal(Number(fields[1]), 1, 'Namespace bootstrap must be init direct child')
  assert.ok(!['Z', 'X', 'x'].includes(fields[0])); assert.match(namespace, /^pid:\[\d+\]$/)
  const credentials = (name, expected) => {
    const values = new RegExp(`^${name}:\\s+([\\d\\s]+)$`, 'm').exec(status)?.[1].trim().split(/\s+/).map(Number)
    assert.deepEqual(values, Array(4).fill(expected)); return values
  }
  const caps = Object.fromEntries(['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].map((name) => {
    const value = new RegExp(`^${name}:\\s+([0-9a-f]{16})$`, 'm').exec(status)?.[1]
    assert.equal(value, '0000000000000000'); return [name, value]
  }))
  assert.match(status, /^NoNewPrivs:\s+1$/m); assert.match(status, /^Groups:\s*$/m)
  return { identity: { pid, starttime: fields[19], state: fields[0], ppid: 1,
    processGroupId: Number(fields[2]), sessionId: Number(fields[3]) },
    uids: credentials('Uid', uid), gids: credentials('Gid', gid), caps, noNewPrivs: 1, groups: [], namespace }
}

async function main() {
  assert.equal(process.platform, 'linux')
  assert.equal(process.env.APOLLO_OBSERVER_FD, '3')
  assert.equal(process.env.APOLLO_NAMESPACE_GATE_FD, '4'); assert.equal(process.env.APOLLO_NAMESPACE_READY_FD, '5')
  assert.ok(fstatSync(3).isSocket() && fstatSync(4).isFIFO() && fstatSync(5).isFIFO(),
    'Only explicit RPC/gate/readiness descriptors may be inherited')
  assert.ok(!Object.keys(process.env).some((name) => /^(?:LD_|PYTHON|NODE_OPTIONS$)/.test(name)))
  assert.equal(process.getuid(), Number(process.env.APOLLO_NAMESPACE_UID))
  assert.equal(process.getgid(), Number(process.env.APOLLO_NAMESPACE_GID))
  const facts = bootstrapReadback({ status: readFileSync('/proc/self/status', 'utf8'), stat: readFileSync('/proc/self/stat', 'utf8'),
    pid: process.pid, uid: process.getuid(), gid: process.getgid(), namespace: readlinkSync('/proc/self/ns/pid') })
  const packet = { stage: 'normal-node-bootstrap-ready', runId: process.env.APOLLO_OBSERVER_RUN_ID, ...facts,
    productGateReleased: false, descriptors: { rpc: 3, gate: 4, ready: 5 },
    bootstrapSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex') }
  assert.match(packet.runId ?? '', /^perception-namespace-[a-f0-9-]+$/)
  const body = Buffer.from(JSON.stringify(packet))
  assert.ok(body.length <= 4096)
  const frame = Buffer.alloc(4 + body.length); frame.writeUInt32BE(body.length); body.copy(frame, 4)
  assert.equal(writeSync(5, frame), frame.length); closeSync(5)
  const gate = createReadStream(null, { fd: 4, autoClose: false, highWaterMark: 2 })
  let timer
  try {
    await new Promise((done, reject) => {
      const cleanup = () => { gate.removeAllListeners('data'); gate.removeAllListeners('end'); gate.removeAllListeners('error') }
      gate.once('data', (bytes) => { cleanup(); gate.pause()
        bytes.length === 1 && bytes[0] === 71 ? done() : reject(new Error('Invalid product gate ACK')) })
      gate.once('end', () => { cleanup(); reject(new Error('Product gate EOF before ACK')) })
      gate.once('error', (error) => { cleanup(); reject(error) })
      timer = setTimeout(() => { cleanup(); gate.pause(); reject(new Error('Product gate total 5s deadline')) }, 5000)
    })
  } finally { clearTimeout(timer); gate.destroy(); closeSync(4) }
  for (const name of ['APOLLO_NAMESPACE_GATE_FD', 'APOLLO_NAMESPACE_READY_FD', 'APOLLO_NAMESPACE_UID', 'APOLLO_NAMESPACE_GID']) delete process.env[name]
  const { main: runInner } = await import('./run-perception-ci.mjs') // FIXED import AFTER G.
  await runInner(process.argv.slice(2)) // Same PID/starttime, no product subprocess substitution.
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await main() } catch (error) { process.stderr.write(`Namespace normal bootstrap failed: ${error.message}\n`); process.exitCode = 1 }
}
