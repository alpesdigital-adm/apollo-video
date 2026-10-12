import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildPublicationAllowed } from '../../scripts/validation/build-perception-pidfd.mjs'
import { awaitBootstrapGate } from '../../scripts/validation/perception-ci-child-bootstrap.mjs'
import { fixedConsumer, consumerTerminalProof } from '../../scripts/validation/run-perception-addon-consumer.mjs'
import { namespaceOwnerClosed, assertArchivePaths, planArchive } from '../../scripts/validation/cleanup-perception-pidfd.mjs'
import { verifyOuterHostDeath } from '../../scripts/validation/perception-outer-host-death.mjs'
import { loadPidfdBinding } from '../../scripts/validation/perception-pidfd.mjs'
import { bootstrapReadback } from '../../scripts/validation/perception-namespace-node-bootstrap.mjs'
import { CI_PIDFD_SOURCE_PATHS, digest, initializeRegistry, readRegistry, registryLock,
  registerAddonConsumer, writeRegistry, sourceFingerprint } from '../../scripts/validation/perception-addon-registry.mjs'

test('fixed CI consumer permits literal npm test, eight named namespaces and infrastructure gate only', () => {
  assert.equal(fixedConsumer('unit', []).at(-1), 'unit')
  assert.equal(fixedConsumer('gates', ['tests/v2/perception-namespace-observer.integration.mjs']).at(-2), 'gates')
  const face = 'tests/v2/prisma-face-producer.integration.mjs'
  assert.deepEqual(fixedConsumer('namespace', [face, 'publish-race|face control']).slice(-2), [face, 'publish-race|face control'])
  for (const [mode, args] of [['exec', ['/bin/true']], ['unit', ['--skip']], ['gates', ['ignored']],
    ['namespace', ['tests/v2/arbitrary.integration.mjs']], ['namespace', [face, 'face']]]) {
    assert.throws(() => fixedConsumer(mode, args))
  }
})

test('build publication requires compiler success, actual close and every observed identity terminal', () => {
  const valid = { errors: [], interruptedBy: null, childCloseObserved: true, compilerExitCode: 0,
    childSignal: null, observed: [{ pid: 7, starttime: '10' }], terminality: [{ terminal: true }] }
  assert.equal(buildPublicationAllowed(valid), true)
  for (const patch of [{ compilerExitCode: 1 }, { compilerExitCode: 124 }, { compilerExitCode: 137 },
    { childCloseObserved: false }, { childSignal: 'SIGKILL' }, { interruptedBy: 'SIGTERM' },
    { errors: ['inventory unknown'] }, { observed: [] }, { terminality: [] }, { terminality: [{ terminal: false }] }]) {
    assert.equal(buildPublicationAllowed({ ...valid, ...patch }), false)
  }
  assert.equal(consumerTerminalProof({ childCloseObserved: true, observed: valid.observed, terminality: valid.terminality }), true)
  assert.equal(consumerTerminalProof({ childCloseObserved: false, observed: valid.observed, terminality: valid.terminality }), false)
})

test('fixed bootstrap denies EOF, malformed ACK and total deadline before workload release', async () => {
  const good = new PassThrough(), success = awaitBootstrapGate(good, 100); good.end('G'); await success
  const eof = new PassThrough(), missing = awaitBootstrapGate(eof, 100); eof.end()
  await assert.rejects(missing, /EOF/)
  const bad = new PassThrough(), invalid = awaitBootstrapGate(bad, 100); bad.end('GG')
  await assert.rejects(invalid, /Invalid/)
  const silent = new PassThrough()
  await assert.rejects(awaitBootstrapGate(silent, 10), /deadline/); silent.destroy()
})

test('normal namespace bootstrap refuses incomplete or elevated readback before product import', () => {
  const fields = ['S', '1', '2', '2', ...Array(46).fill('0')]; fields[19] = '99'
  const stat = `2 (node bootstrap) ${fields.join(' ')}`
  const status = ['Uid:\t600 600 600 600', 'Gid:\t700 700 700 700', 'Groups:\t', 'NoNewPrivs:\t1',
    ...['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].map((name) => `${name}:\t0000000000000000`)].join('\n')
  const input = { stat, status, pid: 2, uid: 600, gid: 700, namespace: 'pid:[77]' }
  assert.equal(bootstrapReadback(input).identity.starttime, '99')
  for (const changed of [status.replace('CapEff:\t0000000000000000', 'CapEff:\t0000000000000020'),
    status.replace('CapBnd:\t0000000000000000', ''), status.replace('NoNewPrivs:\t1', 'NoNewPrivs:\t0'),
    status.replace('Uid:\t600 600 600 600', 'Uid:\t600 0 600 600'), status.replace('Groups:\t', 'Groups:\t700')])
    assert.throws(() => bootstrapReadback({ ...input, status: changed }))
  assert.throws(() => bootstrapReadback({ ...input, stat: stat.replace(') S 1 ', ') S 9 ') }))
})

test('namespace cleanup binds local PID to observed host inode and actual FINAL; no local-to-host PID lookup', () => {
  const owner = { observerRunId: 'namespace-run', sourceCommit: 'a'.repeat(40),
    identity: { namespace: 'pid:[77]', pid: 3, starttime: '12' } }
  const report = { runId: owner.observerRunId, sourceCommit: owner.sourceCommit, childCloseObserved: true,
    namespaceBinding: { directlyObserved: { namespace: owner.identity.namespace },
      wardenAttested: { localNodeIdentity: { pid: 2, starttime: '11' } } },
    rootReceipts: [{ stage: 'guardian-final', initFinal: { nodeCloseObserved: true, cleanup: { namespaceEmpty: true } } }],
    externalIdentities: Array.from({ length: 5 }, () => ({ terminal: true })), postflight: { backendCount: 0 } }
  assert.equal(namespaceOwnerClosed(owner, [report]), true)
  for (const patch of [{ runId: 'other' }, { sourceCommit: 'b'.repeat(40) }, { childCloseObserved: false },
    { rootReceipts: [] }, { postflight: { backendCount: 1 } }, { externalIdentities: [{ terminal: true }] },
    { namespaceBinding: { ...report.namespaceBinding, directlyObserved: { namespace: 'pid:[78]' } } }]) {
    assert.throws(() => namespaceOwnerClosed(owner, [{ ...report, ...patch }]))
  }
  assert.throws(() => namespaceOwnerClosed({ ...owner, identity: { ...owner.identity, starttime: '10' } }, [report]))
  assert.throws(() => namespaceOwnerClosed(owner, [report, report]))
})

test('archive planning rejects source recursion, ancestor aliases and root identity drift before mutation', () => {
  const root = '/tmp/runner/apollo-ci-pidfd.run', temporary = '/tmp/runner', runId = 'pidfd-build-abc-123'
  const valid = { root, runnerTemp: temporary, archiveParent: temporary + '/archive', runId,
    rootIdentity: { dev: 4, ino: 9 }, uid: 600 }
  const directory = (ino = 9, symlink = false) => ({ uid: 600, dev: 4, ino,
    isDirectory: () => true, isSymbolicLink: () => symlink })
  const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }
  const io = { lstat(path) { return [root, temporary].includes(path) ? directory() : missing() }, realpath: (path) => path }
  assert.equal(planArchive(valid, io).archive, temporary + '/archive/' + runId)
  for (const archiveParent of [root, root + '/nested', root + '/../apollo-ci-pidfd.run/deeper'])
    assert.throws(() => planArchive({ ...valid, archiveParent }, io), /source root|subtree/)
  assert.throws(() => assertArchivePaths(root, temporary + '/archive', root, temporary))
  assert.throws(() => assertArchivePaths(root, '/elsewhere/archive', '/elsewhere/archive/' + runId, temporary))
  assert.throws(() => planArchive(valid, { ...io, lstat(path) { return path === root ? directory(10) : io.lstat(path) } }), /identity changed/)
  assert.throws(() => planArchive(valid, { ...io, realpath(path) { return path === root ? '/tmp/elsewhere' : path } }), /symlink/)
  const alias = temporary + '/alias'
  assert.throws(() => planArchive({ ...valid, archiveParent: alias }, {
    lstat(path) { return path === alias ? directory(11, true) : io.lstat(path) }, realpath(path) { return path === alias ? root : path },
  }), /owner\/link/)
  assert.throws(() => planArchive({ ...valid, archiveParent: alias + '/nested' }, {
    lstat(path) { return path === alias ? directory(11) : io.lstat(path) }, realpath(path) { return path === alias ? root : path },
  }), /symlink/)
  assert.throws(() => planArchive(valid, { ...io, lstat(path) {
    return path === temporary + '/archive/' + runId ? directory(12) : io.lstat(path)
  } }), /already exists/)
})

test('host launcher death requires actual SIGKILL close, five terminal births and PG0 without fabricated inner proof', () => {
  const valid = { kind: 'outer-host-death', launcherCloseObserved: true, launcherSignal: 'SIGKILL',
    launcherTerminal: { terminal: true }, productGateReleased: false, identities: Array.from({ length: 5 }, () => ({ terminal: true })),
    postflight: { backendCount: 0 }, errors: [], observedRunSuccess: false, innerReceiptPresent: false, outerReceiptPresent: false }
  verifyOuterHostDeath(valid)
  for (const patch of [{ launcherCloseObserved: false }, { launcherSignal: 'SIGTERM' }, { productGateReleased: true },
    { identities: [{ terminal: true }] }, { namespaceEmpty: true }, { nodeCloseObserved: true },
    { innerReceiptPresent: true }, { observedRunSuccess: true }, { errors: ['inconclusive'] }]) {
    assert.throws(() => verifyOuterHostDeath({ ...valid, ...patch }))
  }
})

test('CI source fingerprint explicitly includes new files without relying on tracked-only inventory', () => {
  const files = sourceFingerprint()
  assert.equal(new Set(files.map((value) => value.path)).size, CI_PIDFD_SOURCE_PATHS.length)
  for (const name of ['build-perception-pidfd.mjs', 'perception-addon-registry.mjs', 'cleanup-perception-pidfd.mjs',
    'run-perception-addon-consumer.mjs', 'perception-outer-host-death.mjs']) assert.ok(files.some((value) => value.path.endsWith('/' + name)))
  assert.ok(files.every((value) => /^[a-f0-9]{64}$/.test(value.sha256)))
})

test('normal Linux registry authenticates real self before invalid addon load and refuses closed admission',
  { skip: process.platform !== 'linux' }, async () => {
    assert.ok(process.getuid() > 0)
    const root = mkdtempSync(join(tmpdir(), 'apollo-ci-pidfd.')); chmodSync(root, 0o700)
    const env = { RUNNER_TEMP: tmpdir(), GITHUB_SHA: 'a'.repeat(40),
      APOLLO_PERCEPTION_PIDFD_ROOT: root, APOLLO_PERCEPTION_CONSUMER_RUN_ID: 'pidfd-consumer-unit-11111111-1111-1111-1111-111111111111',
      APOLLO_PERCEPTION_PIDFD_ADDON: join(root, 'perception-pidfd.node'), APOLLO_PERCEPTION_PIDFD_PROVENANCE: join(root, 'provenance.json') }
    try {
      const registry = initializeRegistry(root, 'pidfd-build-22222222-2222-2222-2222-222222222222', env)
      registry.sourceFiles = sourceFingerprint()
      writeFileSync(env.APOLLO_PERCEPTION_PIDFD_ADDON, 'invalid native bytes', { mode: 0o600 })
      writeFileSync(env.APOLLO_PERCEPTION_PIDFD_PROVENANCE, '{}', { mode: 0o600 })
      registry.addonSha256 = env.APOLLO_PERCEPTION_PIDFD_SHA256 = digest(readFileSync(env.APOLLO_PERCEPTION_PIDFD_ADDON))
      registry.provenanceSha256 = digest(readFileSync(env.APOLLO_PERCEPTION_PIDFD_PROVENANCE))
      registry.admission = 'closed'; writeRegistry(root, registry)
      await assert.rejects(loadPidfdBinding(env), /admission is closed/, 'Invalid addon cannot be required before registration')
      registry.admission = 'open'; writeRegistry(root, registry)
      const registered = await registerAddonConsumer(env)
      assert.equal(registered.entry.identity.pid, process.pid)
      assert.equal(registered.entry.registrationIsNotProcessClose, true)
      assert.equal(registered.entry.identity.namespace, registry.creator.namespace)
      assert.deepEqual(registered.entry.identity.uids, Array(4).fill(process.getuid()))
      assert.deepEqual(readRegistry(root, env).creator, registry.creator)
      const second = await registerAddonConsumer(env); assert.equal(second.path, registered.path)
      mkdirSync(join(root, 'admission.lock'), { mode: 0o700 })
      await assert.rejects(registryLock(root, () => assert.fail('Action must not run'), { env, deadlineAt: Date.now() + 10 }), /lock deadline/)
    } finally { rmSync(root, { recursive: true }) } // No processes/addon were created by this test.
})
