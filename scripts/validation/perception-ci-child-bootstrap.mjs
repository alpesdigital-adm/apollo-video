import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isAbsolute, join, dirname, resolve } from 'node:path'
import { readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const MODES = new Set(['compile', 'unit', 'namespace', 'gates', 'outer-launcher', 'cgroup-consumer', 'cgroup-fixture'])
export async function awaitBootstrapGate(input = process.stdin, milliseconds = 5000) {
  let timer
  try {
    await new Promise((done, reject) => {
      const cleanup = () => { input.removeListener('data', data); input.removeListener('end', eof); input.removeListener('error', error) }
      const data = (bytes) => {
        cleanup()
        if (bytes.length === 1 && bytes[0] === 71) done()
        else reject(new Error('Invalid fixed bootstrap ACK'))
      }
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
  if (mode === 'cgroup-consumer' || mode === 'cgroup-fixture') {
    const { fixedConsumer } = await import('./run-perception-addon-consumer.mjs')
    const { readAuthorityIdentitySync } = await import('./perception-addon-registry.mjs')
    const { assertCgroupScope, parseCgroupMembership, CGROUP_ABI, CGROUP_FIXTURES } = await import('./perception-consumer-cgroup.mjs')
    if (mode === 'cgroup-fixture') assert.ok(args.length === 1 && CGROUP_FIXTURES.includes(args[0]), 'Literal cgroup fixture enum only')
    else fixedConsumer(args[0], args.slice(1))
    const scope = assertCgroupScope(JSON.parse(process.env.APOLLO_PERCEPTION_CGROUP_SCOPE ?? 'null'))
    assert.equal(parseCgroupMembership(readFileSync('/proc/self/cgroup', 'utf8')), scope.membership)
    const status = readFileSync('/proc/self/status', 'utf8')
    assert.ok(Buffer.byteLength(status) <= 65536)
    const fields = Object.fromEntries(status.split('\n').filter((line) => line.includes(':')).map((line) => {
      const separator = line.indexOf(':'); return [line.slice(0, separator), line.slice(separator + 1).trim()]
    }))
    for (const key of ['CapEff', 'CapPrm', 'CapInh', 'CapAmb']) { assert.match(fields[key], /^[a-f0-9]{16}$/i); assert.equal(BigInt('0x' + fields[key]), 0n) }
    assert.equal(fields.NoNewPrivs, '0'); assert.match(fields.CapBnd, /^[a-f0-9]{16}$/i)
    const descriptors = readdirSync('/proc/self/fd'); assert.ok(descriptors.length <= 256)
    for (const descriptor of descriptors) {
      assert.match(descriptor, /^\d+$/)
      try { assert.notEqual(readlinkSync(`/proc/self/fd/${descriptor}`), join(scope.path, 'cgroup.kill'), 'Workload inherited kill authority') }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    process.stdout.write(JSON.stringify({ abi: CGROUP_ABI, runId: scope.runId, stage: 'normal-node-ready',
      identity: readAuthorityIdentitySync(process.pid), node: process.execPath,
      bootstrapSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
      cgroupMembership: scope.membership, killFdInherited: false,
      capabilities: Object.fromEntries(['CapEff', 'CapPrm', 'CapInh', 'CapAmb', 'CapBnd', 'NoNewPrivs', 'Groups'].map((name) => [name, fields[name]])) }) + '\n')
  }
  await awaitBootstrapGate()
  if (mode === 'cgroup-fixture') {
    if (args[0] === 'member-exit') return
    if (args[0] === 'wait' || args[0] === 'guardian-stop-owner-death') {
      await new Promise((done) => setTimeout(done, 20000))
      return
    }
    const { loadPidfdBinding } = await import('./perception-pidfd.mjs')
    const { readAuthorityIdentitySync, identityKey, liveIdentity } = await import('./perception-addon-registry.mjs')
    const { readLinuxProcessIdentity } = await import('./run-perception-ci.mjs')
    const { CGROUP_ABI } = await import('./perception-consumer-cgroup.mjs')
    const scope = JSON.parse(process.env.APOLLO_PERCEPTION_CGROUP_SCOPE)
    const { binding } = await loadPidfdBinding() // BEFORE creating the direct fixture child.
    const program = `import os,sys,time,select,json,signal
signal.alarm(25)
if not select.select([0],[],[],5)[0] or os.read(0,2)!=b'G': sys.exit(1)
kind=sys.argv[1]
pid=os.fork()
if pid==0:
 if kind=='setsid-reparent':
  os.setsid(); time.sleep(20)
 os._exit(0)
def identity(pid):
 text=open('/proc/%d/stat'%pid).read(8192); fields=text[text.rfind(')')+2:].split()
 return {'pid':pid,'starttime':fields[19],'state':fields[0],'ppid':int(fields[1])}
end=time.monotonic()+2
while True:
 child=identity(pid)
 if kind!='zombie' or child['state']=='Z': break
 if time.monotonic()>=end: sys.exit(1)
 time.sleep(.005)
print(json.dumps({'kind':kind,'creator':identity(os.getpid()),'victim':child}),flush=True)
if kind=='zombie': time.sleep(20)
`
    const child = spawn('/usr/bin/python3', ['-I', '-S', '-c', program, args[0]],
      { cwd: ROOT, env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let token, identity, closed = false, closePromise, primary, text = '', bytes = 0
    try {
      try {
        assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0)
        token = binding.open(child.pid)
        identity = readAuthorityIdentitySync(child.pid)
        assert.equal(identity.ppid, process.pid); assert.ok(liveIdentity(identity))
      } finally {
        closePromise = new Promise((done) => child.once('close', () => { closed = true; done() }))
        child.once('error', (error) => { primary ??= error }); child.stdin.on('error', (error) => { primary ??= error })
        child.stderr.on('data', (chunk) => process.stderr.write(chunk))
        child.stdout.on('data', (chunk) => {
          try {
            bytes += chunk.length; assert.ok(bytes <= 4096); text += chunk.toString('utf8')
            if (!text.endsWith('\n')) return
            const packet = JSON.parse(text)
            assert.equal(packet.kind, args[0]); assert.equal(identityKey(packet.creator), identityKey(identity))
            process.stdout.write(JSON.stringify({ abi: CGROUP_ABI, runId: scope.runId, stage: 'fixture-descendant', ...packet }) + '\n')
          } catch (error) { primary ??= error }
        })
      }
      const recheck = await readLinuxProcessIdentity(identity.pid)
      assert.equal(identityKey(recheck), identityKey(identity)); assert.equal(recheck.ppid, process.pid)
      child.stdin.end('G')
      await new Promise((done) => setTimeout(done, 20000))
      if (primary) throw primary
    } finally {
      if (token && !closed) {
        try { binding.signal(token, 'SIGKILL') }
        catch (error) {
          const current = identity ? await readLinuxProcessIdentity(identity.pid) : undefined
          if (!identity || (current && identityKey(current) === identityKey(identity) && liveIdentity(current))) primary ??= error
        }
      }
      if (child && !closed) {
        let timer
        try { await Promise.race([closePromise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cgroup fixture creator close deadline')), 5000) })]) }
        catch (error) { primary ??= error } finally { clearTimeout(timer) }
      }
      if (token) binding.close(token)
      if (primary) throw primary
    }
  } else if (mode === 'cgroup-consumer') {
    const { runAddonConsumer } = await import('./run-perception-addon-consumer.mjs')
    const report = await runAddonConsumer(args[0], args.slice(1))
    if (!report.success) process.exitCode = 1
  } else if (mode === 'compile') {
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
