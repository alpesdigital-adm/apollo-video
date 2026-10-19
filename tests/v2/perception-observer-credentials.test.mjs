import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadPidfdBinding } from '../../scripts/validation/perception-pidfd.mjs'
import { parseLinuxProcessStat, readLinuxProcessIdentity } from '../../scripts/validation/run-perception-ci.mjs'

// Kernel credential/framing tests use normal UID Python only. They neither
// launch the namespace warden nor obtain sudo, capabilities or product access.
const CONTROLLED_IPC = String.raw`
import os, sys, signal, socket, struct, json, time, importlib.util, select
# No import of the observer or fork workload before birth+identity ACK.
bootstrap_deadline = time.monotonic() + 3
if not select.select([0], [], [], max(0, bootstrap_deadline - time.monotonic()))[0]:
    sys.exit(125)
if time.monotonic() >= bootstrap_deadline or os.read(0, 1) != b'G':
    sys.exit(126)
os.close(0)
if os.getuid() == 0:
    raise RuntimeError('ordinary UID is mandatory for IPC unit tests')
signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError('controlled IPC deadline')))
signal.setitimer(signal.ITIMER_REAL, 4)
spec = importlib.util.spec_from_file_location('observer_boundary', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
# Root bootstrap is a stream: minted and ready may coalesce in one read.
# Consume pending frames before waiting again; malformed tails remain errors.
frame = lambda item: struct.pack('!I', len(item)) + item
valid = lambda stage: frame(json.dumps({'stage': stage}).encode())
buffer = bytearray(valid('init-minted') + valid('init-ready'))
assert module.buffered_packet(buffer)['stage'] == 'init-minted'
assert module.buffered_packet(buffer)['stage'] == 'init-ready'
assert not buffer
for malformed in [struct.pack('!I', module.FRAME_LIMIT + 1), frame(b'\xff'), frame(b'{"a":1,"a":2}')]:
    try:
        module.buffered_packet(bytearray(malformed))
        raise AssertionError('invalid root framing accepted')
    except (ValueError, RuntimeError, UnicodeError):
        pass
read_fd, write_fd = os.pipe()
os.write(write_fd, b'\x00\x00'); os.close(write_fd)
tail = bytearray()
assert module.packet_read(read_fd, tail) is None
try:
    module.packet_read(read_fd, tail)
    raise AssertionError('truncated root stream accepted')
except RuntimeError:
    pass
os.close(read_fd)
mode = sys.argv[2]
server, client = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
gate_r, gate_w = os.pipe()
owner_pid = os.fork()
if owner_pid == 0:
    try:
        server.close()
        os.close(gate_w)
        if os.read(gate_r, 1) != b'G':
            os._exit(126)
        os.close(gate_r)
        document = {'abi': module.ABI, 'runId': 'perception-namespace-kernel-unit', 'seq': 1, 'op': 'hello'}
        if mode == 'sequence':
            document['seq'] = 2
        if mode == 'run-id':
            document['runId'] = 'wrong'
        raw = json.dumps(document).encode()
        frame = struct.pack('!I', len(raw)) + raw
        if mode == 'credentials-change-fragment':
            client.sendall(frame[:4])
            substitute = os.fork()
            if substitute == 0:
                client.sendall(frame[4:])
                os._exit(0)
            os.waitpid(substitute, 0)
        elif mode == 'truncated':
            client.sendall(frame[:3])
        elif mode == 'oversized':
            client.sendall(struct.pack('!I', module.FRAME_LIMIT + 1))
        elif mode == 'timeout':
            time.sleep(2)
        else:
            for fragment in (frame[:2], frame[2:4], frame[4:]):
                client.sendall(fragment)
                time.sleep(0.02)
        client.close()
        os._exit(0)
    except BaseException:
        os._exit(126)
client.close()
os.close(gate_r)
owner = module.verified_metadata(owner_pid)
channel = module.OwnerChannel(server, owner, os.getuid(), os.getgid(), 'perception-namespace-kernel-unit', time.monotonic() + 0.5)
os.write(gate_w, b'G'); os.close(gate_w)
outcome = {'mode': mode, 'uid': os.getuid(), 'accepted': False, 'owner': {'pid': owner['pid'], 'starttime': owner['starttime']}}
try:
    result = channel.receive()
    outcome['accepted'] = True
    outcome['sequence'] = result['seq']
except Exception as error:
    outcome['error'] = type(error).__name__
finally:
    server.close()
    # Only the actual forked identity may be signaled; signaling is not proof.
    current = module.identity(owner_pid)
    if current and module.key(current) == module.key(owner) and current['state'] not in module.TERMINAL:
        module.pidfd_signal(owner, signal.SIGKILL, time.monotonic() + 1)
    waited, status = os.waitpid(owner_pid, 0)
    outcome['closeObserved'] = waited == owner_pid
    outcome['terminal'] = module.identity(owner_pid) is None
    signal.setitimer(signal.ITIMER_REAL, 0)
print(json.dumps(outcome))
`

test('ordinary Linux kernel credentials authenticate every owner IPC fragment and reject mutation, EOF and timeout',
  { skip: process.platform !== 'linux', timeout: 30_000 }, async () => {
    assert.ok(process.getuid() > 0, 'npm test must run with normal UID')
    const { binding } = await loadPidfdBinding()
    const warden = fileURLToPath(new URL('../../scripts/validation/perception_namespace_warden.py', import.meta.url))
    for (const mode of ['valid', 'credentials-change-fragment', 'sequence', 'run-id', 'truncated', 'oversized', 'timeout']) {
      let child, birth, close
      let stdout = '', stderr = '', oversized = false, spawnError
      let closed = false, identity, code, primaryError
      let timer
      try {
        child = spawn('/usr/bin/python3', ['-I', '-S', '-c', CONTROLLED_IPC, warden, mode], {
          stdio: ['pipe', 'pipe', 'pipe'], env: { LANG: 'C.UTF-8' },
        })
        // Direct birth open BEFORE yielding. Listener registration still runs
        // if validation/open fails, and EOF never releases the workload.
        try {
          assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0)
          birth = binding.open(child.pid)
          const initial = parseLinuxProcessStat(readFileSync(`/proc/${child.pid}/stat`, 'utf8'))
          assert.equal(initial.pid, child.pid, 'IPC birth PID mismatch')
          assert.equal(initial.ppid, process.pid, 'IPC birth is not this owner direct child')
          assert.ok(!['Z', 'X', 'x'].includes(initial.state), 'IPC birth must be live')
          identity = Object.freeze(initial) // Retain before any asynchronous lookup.
        }
        finally {
          close = new Promise((done) => child.once('close', (exitCode) => { closed = true; done(exitCode) }))
          child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 8192) { stdout = stdout.slice(0, 8192); oversized = true } })
          child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 8192) { stderr = stderr.slice(0, 8192); oversized = true } })
          child.once('error', (error) => { spawnError = error })
          child.stdin.on('error', (error) => { spawnError ??= error })
        }
        assert.ok(identity, 'Synchronous IPC birth identity unavailable')
        const verified = await readLinuxProcessIdentity(child.pid)
        assert.ok(verified, 'Python IPC unit helper identity unavailable')
        assert.equal(verified.pid, identity.pid, 'IPC PID changed before ACK')
        assert.equal(verified.starttime, identity.starttime, 'IPC identity changed before ACK')
        assert.equal(verified.ppid, process.pid, 'IPC child parent changed before ACK')
        assert.ok(!['Z', 'X', 'x'].includes(verified.state) && !spawnError && !closed)
        child.stdin.end('G')
        code = await Promise.race([close, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Owned IPC unit helper deadline')), 5000)
        })])
      } catch (error) { primaryError = error }
      finally {
        clearTimeout(timer)
        try {
          if (child && !closed) {
            if (birth) binding.signal(birth, 'SIGKILL')
            else child.stdin.end() // Explicit EOF, no fake identity or PID kill.
          }
        } catch (error) { primaryError ??= error }
        try {
          let cleanupTimer
          try { if (child) await Promise.race([close, new Promise((_, reject) => {
            cleanupTimer = setTimeout(() => reject(new Error('IPC helper close inconclusive')), 4000)
          })]) } finally { clearTimeout(cleanupTimer) }
          if (Number.isSafeInteger(child?.pid)) {
            const current = await readLinuxProcessIdentity(child.pid)
            assert.ok(!current || (identity && current.starttime !== identity.starttime) ||
              (identity && ['Z', 'X', 'x'].includes(current.state)), 'IPC helper terminality inconclusive')
          }
        } catch (error) { primaryError ??= error }
        try { if (birth) binding.close(birth) } catch (error) { primaryError ??= error }
      }
      if (primaryError) throw primaryError
      assert.equal(spawnError, undefined)
      assert.equal(oversized, false)
      assert.equal(code, 0, `${mode}: ${stderr}`)
      const result = JSON.parse(stdout)
      assert.equal(result.uid, process.getuid())
      assert.equal(result.accepted, mode === 'valid', mode)
      assert.equal(result.closeObserved, true, mode)
      assert.equal(result.terminal, true, mode)
    }
  })
