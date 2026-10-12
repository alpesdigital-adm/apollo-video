import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseLinuxProcessCredentials, parseLinuxProcessStat, readLinuxProcessIdentity } from './run-perception-ci.mjs'
import { OBSERVER_ABI, OBSERVER_FRAME_LIMIT } from './perception-observer-channel.mjs'
import { loadPidfdBinding, openObservedPidfd } from './perception-pidfd.mjs'

export const NAMESPACE_BUDGET_MS = 480_000
export const NAMESPACE_CONTROLLED_FAULTS = Object.freeze([
  'guardian-stop', 'init-stop', 'node-owner-death', 'ipc-death', 'ipc-truncated', 'ipc-oversized', 'deadline',
])
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const WARDEN = join(ROOT, 'scripts/validation/perception_namespace_warden.py')
const NORMAL_ENVIRONMENT = [
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'CI', 'RUNNER_TEMP',
  'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'NEXT_TELEMETRY_DISABLED',
  'APOLLO_API_ENVIRONMENT', 'V2_DATABASE_URL', 'APOLLO_LIBRARY_EVIDENCE_ROOT',
  'APOLLO_V2_ARTIFACT_STORAGE_DRIVER', 'APOLLO_V2_ARTIFACT_ROOT',
  'APOLLO_PROTECTED_PAYLOAD_KEY_ID', 'APOLLO_PROTECTED_PAYLOAD_KEY',
  'APOLLO_OCR_VIDEO_E2E', 'APOLLO_PERCEPTION_HTTP_E2E', 'APOLLO_TEMPORAL_VIDEO_E2E',
  'APOLLO_TEMPORAL_HTTP_E2E', 'APOLLO_OCR_TESSERACT', 'APOLLO_OCR_TESSDATA',
  'APOLLO_OCR_FFMPEG', 'APOLLO_TEMPORAL_FFMPEG', 'APOLLO_OCR_FFPROBE',
  'APOLLO_TEMPORAL_FFPROBE', 'FFMPEG_BIN', 'FFPROBE_BIN',
  'APOLLO_PERCEPTION_PIDFD_ADDON', 'APOLLO_PERCEPTION_PIDFD_PROVENANCE', 'APOLLO_PERCEPTION_PIDFD_SHA256',
  'APOLLO_PERCEPTION_PIDFD_ROOT', 'APOLLO_PERCEPTION_CONSUMER_RUN_ID',
]
export const COMPOSED_SUITE = 'tests/v2/perception-namespace-observer.integration.mjs'
export const PERCEPTION_SUITES = Object.freeze([
  'tests/v2/tesseract-ocr-video-adapter.integration.mjs',
  'tests/v2/ffmpeg-temporal-video-analyzer.integration.mjs',
  'tests/v2/prisma-perception-producer-admission.integration.mjs',
  'tests/v2/prisma-perception-producer-worker.integration.mjs',
  'tests/v2/prisma-perception-producer-http.integration.mjs',
  'tests/v2/prisma-director-ocr.integration.mjs',
  'tests/v2/prisma-temporal-producer.integration.mjs',
  'tests/v2/prisma-face-producer.integration.mjs',
])
export function assertPerceptionSuite(suite, pattern = null) {
  assert.ok(PERCEPTION_SUITES.includes(suite) || suite === COMPOSED_SUITE, 'Suite outside fixed perception allowlist')
  assert.ok(pattern === null || (suite === 'tests/v2/prisma-face-producer.integration.mjs' && pattern === 'publish-race|face control'))
}
const key = (value) => `${value.pid}:${value.starttime}`
const errorFact = (error) => ({ name: error.name, code: error.code ?? null,
  message: String(error.message).slice(0, 512) })

export function namespaceLaunchConfig({ suite, pattern = null, env = process.env,
  uid = process.getuid(), gid = process.getgid(), node = process.execPath, now = Date.now(), controlledFault = null }) {
  assertPerceptionSuite(suite, pattern)
  assert.ok(Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid > 0,
    'Namespace product must run with a normal UID/GID')
  assert.match(env.GITHUB_SHA ?? '', /^[0-9a-f]{40}$/, 'Owner source SHA is required')
  assert.match(env.APOLLO_PERCEPTION_JOB_DEADLINE_MS ?? '', /^\d+$/)
  assert.ok(Number.isSafeInteger(Number(env.APOLLO_PERCEPTION_JOB_DEADLINE_MS)) &&
    now + NAMESPACE_BUDGET_MS <= Number(env.APOLLO_PERCEPTION_JOB_DEADLINE_MS),
  'Insufficient aggregate job budget for namespace, inner cleanup and outer postflight')
  assert.ok(pattern === null || (suite === 'tests/v2/prisma-face-producer.integration.mjs' && pattern === 'publish-race|face control'))
  assert.ok(controlledFault === null || (suite === 'tests/v2/perception-namespace-observer.integration.mjs' &&
    NAMESPACE_CONTROLLED_FAULTS.includes(controlledFault)), 'Faults are fixed and restricted to the infrastructure composed gate')
  return { abi: OBSERVER_ABI, runId: `perception-namespace-${randomUUID()}`, uid, gid, node,
    suite, pattern, controlledFault, sourceCommit: env.GITHUB_SHA, deadlineAt: now + NAMESPACE_BUDGET_MS - 30_000,
    innerDeadlineAt: now + NAMESPACE_BUDGET_MS - 60_000,
    environment: Object.fromEntries(NORMAL_ENVIRONMENT.filter((name) => env[name] !== undefined).map((name) => [name, env[name]])) }
}

// Root receipts are sent on an inherited descriptor closed in the normal
// bootstrap. Stdout from the product cannot create a root receipt.
export function decodeRootPackets(buffer) {
  assert.ok(Buffer.isBuffer(buffer) && buffer.length <= 2 * (OBSERVER_FRAME_LIMIT + 4))
  const packets = []
  while (buffer.length >= 4) {
    const size = buffer.readUInt32BE()
    assert.ok(size > 0 && size <= OBSERVER_FRAME_LIMIT, 'Invalid root receipt frame')
    if (buffer.length < size + 4) break
    const packet = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(4, size + 4)))
    assert.ok(packet && typeof packet === 'object' && !Array.isArray(packet))
    packets.push(packet); buffer = buffer.subarray(size + 4)
  }
  return { packets, remaining: buffer }
}

async function bounded(action, deadlineAt, limit, label) {
  const remaining = deadlineAt - Date.now()
  assert.ok(remaining > 0, `${label}: deadline exhausted before action`)
  let timer
  try {
    return await Promise.race([action(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded its deadline`)), Math.min(limit, remaining))
    })])
  } finally { clearTimeout(timer) }
}

export async function requireEmptyDatabase(env, runId, deadlineAt) {
  const { PrismaClient } = await bounded(() => import('../../generated/prisma-v2/index.js'), deadlineAt, 5000, 'Outer observer module')
  const url = new URL(env.V2_DATABASE_URL)
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.pathname, '/apollo_v2_perception')
  url.username = 'apollo_admin'
  url.searchParams.set('application_name', `apollo-video-e2e-perception-outer-${runId}`)
  url.searchParams.set('connection_limit', '1'); url.searchParams.set('pool_timeout', '10'); url.searchParams.set('connect_timeout', '10')
  const observer = new PrismaClient({ datasources: { db: { url: url.toString() } } })
  try {
    const rows = await bounded(() => observer.$queryRawUnsafe('SELECT application_name, count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() GROUP BY application_name'),
      deadlineAt - 5000, 12_000, 'Outer PostgreSQL pre/postflight')
    assert.deepEqual(rows, [], 'Namespace left PostgreSQL clients')
    return { backendCount: 0, checkedAt: new Date().toISOString() }
  } finally { await bounded(() => observer.$disconnect(), deadlineAt, 5000, 'Outer observer disconnect') }
}

export async function confirmTerminalIdentity(expected) {
  assert.ok(expected && Number.isSafeInteger(expected.pid) && expected.pid > 0)
  assert.match(expected.starttime, /^\d+$/)
  const current = await readLinuxProcessIdentity(expected.pid)
  return { pid: expected.pid, starttime: expected.starttime,
    observation: !current ? 'absent' : key(current) !== key(expected) ? 'pid-recycled' : current.state,
    terminal: !current || key(current) !== key(expected) || ['Z', 'X', 'x'].includes(current.state) }
}

async function verifyGuardianAncestry(guardian, sudoIdentity) {
  const current = await readLinuxProcessIdentity(guardian.pid)
  assert.ok(current && key(current) === key(guardian), 'Guardian identity changed before receipt verification')
  let parent = current
  for (let count = 0; count < 4; count += 1) {
    if (key(parent) === key(sudoIdentity)) return
    parent = await readLinuxProcessIdentity(parent.ppid)
    assert.ok(parent, 'Guardian ancestry unavailable')
  }
  assert.fail('Guardian is outside the spawned sudo ancestry')
}

export async function verifyGuardianBirth(packet, sudoIdentity) {
  const guardian = packet.guardianIdentity
  assert.ok(guardian, 'Guardian identity missing')
  await verifyGuardianAncestry(guardian, sudoIdentity)
  const credentials = parseLinuxProcessCredentials(await readFile(`/proc/${guardian.pid}/status`, 'utf8'))
  assert.deepEqual(credentials.uids, Array(4).fill(process.getuid()), 'Guardian must use normal owner UID')
  assert.deepEqual(credentials.gids, Array(4).fill(process.getgid()), 'Guardian must use normal owner GID')
  const status = await readFile(`/proc/${guardian.pid}/status`, 'utf8')
  for (const name of ['CapEff', 'CapPrm', 'CapBnd']) assert.match(status, new RegExp(`^${name}:\\s+0000000000000020$`, 'm'))
  for (const name of ['CapInh', 'CapAmb']) assert.match(status, new RegExp(`^${name}:\\s+0000000000000000$`, 'm'))
  assert.match(status, /^NoNewPrivs:\s+1$/m); assert.match(status, /^Groups:\s*$/m)
  assert.equal(packet.guardianFlags.keepCaps, 0); assert.equal(packet.guardianFlags.parentDeathSignal, 9)
  const node = packet.nodeHostIdentity
  assert.ok(node, 'Gated Node host identity missing')
  const currentNode = await readLinuxProcessIdentity(node.pid)
  assert.ok(currentNode && key(currentNode) === key(node) && currentNode.ppid === packet.initIdentity.pid,
    'Gated Node host identity/ancestry changed')
  const nodeStatus = await readFile(`/proc/${node.pid}/status`, 'utf8')
  const nodeCredentials = parseLinuxProcessCredentials(nodeStatus)
  assert.deepEqual(nodeCredentials.uids, Array(4).fill(process.getuid()))
  assert.deepEqual(nodeCredentials.gids, Array(4).fill(process.getgid()))
  for (const name of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) assert.match(nodeStatus, new RegExp(`^${name}:\\s+0000000000000000$`, 'm'))
  assert.match(nodeStatus, /^NoNewPrivs:\s+1$/m); assert.match(nodeStatus, /^Groups:\s*$/m)
  const namespacePids = /^NSpid:\s+([\d\s]+)$/m.exec(nodeStatus)?.[1].trim().split(/\s+/).map(Number)
  assert.deepEqual(namespacePids, packet.nodeNamespacePids)
  assert.equal(namespacePids[0], node.pid)
  assert.equal(namespacePids.at(-1), packet.initBootstrap.owner.pid)
  assert.equal(node.starttime, packet.initBootstrap.owner.starttime)
  assert.equal(packet.nodePidNamespace, packet.initBootstrap.namespace.pid)
  assert.equal(packet.initBootstrap.nodeBootstrap.stage, 'normal-node-bootstrap-ready')
  assert.equal(packet.initBootstrap.nodeBootstrap.runId, packet.runId)
  assert.equal(packet.initBootstrap.nodeBootstrap.productGateReleased, false)
  assert.deepEqual(packet.initBootstrap.nodeBootstrap.descriptors, { rpc: 3, gate: 4, ready: 5 })
  assert.equal(packet.initBootstrap.nodeBootstrap.bootstrapSha256,
    createHash('sha256').update(await readFile(join(ROOT, 'scripts/validation/perception-namespace-node-bootstrap.mjs'))).digest('hex'))
  const order = packet.initBootstrap.order
  for (const before of ['init-minimal-capabilities-measured', 'guardian-minimal-capabilities-measured'])
    assert.ok(order.indexOf(before) >= 0 && order.indexOf(before) < order.indexOf('normal-node-bootstrap-exec-observed'))
  // Read only the NORMAL gated Node host inode. Root init inode access is
  // neither assumed nor claimed by the outer normal owner.
  const directlyObservedNamespace = readlinkSync(`/proc/${node.pid}/ns/pid`)
  assert.equal(directlyObservedNamespace, packet.nodePidNamespace)
  const recheckedNode = await readLinuxProcessIdentity(node.pid)
  assert.ok(recheckedNode && key(recheckedNode) === key(node) && recheckedNode.ppid === packet.initIdentity.pid)
  return { directlyObserved: { nodeHostIdentity: recheckedNode, nodeNamespacePids: namespacePids,
    namespace: directlyObservedNamespace, uids: nodeCredentials.uids, gids: nodeCredentials.gids },
    wardenAttested: { initIdentity: packet.initIdentity, initNamespace: packet.initBootstrap.namespace.pid,
      localNodeIdentity: packet.initBootstrap.owner } }
}

export async function runNamespaceSuite({ suite, pattern = null, env = process.env, controlledFault = null, onReady } = {}) {
  assert.equal(process.platform, 'linux')
  const started = Date.now(), deadlineAt = started + NAMESPACE_BUDGET_MS
  const config = namespaceLaunchConfig({ suite, pattern, env, now: started, controlledFault })
  const name = suite.split('/').pop().replace('.integration.mjs', '')
  const evidence = env.APOLLO_LIBRARY_EVIDENCE_ROOT
  assert.ok(evidence?.startsWith('/tmp/') || (env.RUNNER_TEMP && evidence?.startsWith(env.RUNNER_TEMP + '/')))
  await mkdir(evidence, { recursive: true })
  const report = { abi: OBSERVER_ABI, runId: config.runId, suite, pattern, controlledFault,
    sourceCommit: config.sourceCommit, ciRunId: env.GITHUB_RUN_ID, ciRunAttempt: env.GITHUB_RUN_ATTEMPT,
    startedAt: new Date(started).toISOString(), deadlineAt: new Date(deadlineAt).toISOString(),
    proofScope: 'namespace-supervised-controlled-mechanics', success: false,
    errors: [], rootReceipts: [], externalIdentities: [], childCloseObserved: false }
  for (const path of [WARDEN, join(ROOT, 'scripts/validation/run-perception-ci.mjs'),
    join(ROOT, 'scripts/validation/perception-observer-channel.mjs'),
    join(ROOT, 'scripts/validation/perception-pidfd.c'), join(ROOT, 'scripts/validation/perception-pidfd.mjs'),
    join(ROOT, 'scripts/validation/build-perception-pidfd.sh'),
    join(ROOT, 'scripts/validation/perception-namespace-node-bootstrap.mjs')]) {
    report.sourceFiles ??= []
    report.sourceFiles.push({ path: path.slice(ROOT.length + 1), sha256: createHash('sha256').update(await readFile(path)).digest('hex') })
  }
  let child, sudoIdentity, heartbeat, receiptBuffer = Buffer.alloc(0), protocolError, interrupted
  let closed = false, closePromise, closeTimer, rootFinal, guardianBirthVerified = false, sudoBirthToken, binding
  const ownedPidfds = new Map()
  const abort = () => { if (child?.stdin.writable) child.stdin.write('A') }
  const handlers = ['SIGINT', 'SIGTERM'].map((name) => {
    const handler = () => { interrupted ??= name; report.interruptedBy = name; abort() }
    process.on(name, handler); return [name, handler]
  })
  try {
    const native = await loadPidfdBinding(env)
    binding = native.binding; report.pidfdAuthority = native.provenance
    report.preflight = await requireEmptyDatabase(env, config.runId, Math.min(deadlineAt, started + 20_000))
    child = spawn('/usr/bin/sudo', ['-n', '/usr/bin/python3', '-I', '-S', WARDEN, '--host'], {
      cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: { LANG: 'C.UTF-8' },
    })
    report.sudoPid = child.pid
    // This is the direct spawn birth, before callbacks can reap/reuse PID.
    // No metadata is adopted later if this capture fails.
    try {
      assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0)
      sudoBirthToken = binding.open(child.pid)
      sudoIdentity = parseLinuxProcessStat(readFileSync(`/proc/${child.pid}/stat`, 'utf8'))
      assert.equal(sudoIdentity.ppid, process.pid); assert.ok(!['Z', 'X', 'x'].includes(sudoIdentity.state))
      report.sudoIdentity = sudoIdentity
    } finally {
    // Install listeners before any await; close is a separate event from error.
    closePromise = new Promise((done) => {
      child.once('close', (code, terminationSignal) => {
        closed = true; report.childCloseObserved = true; report.code = code; report.terminationSignal = terminationSignal; done()
      })
    })
    child.once('error', (error) => { report.errors.push(errorFact(error)); abort() })
    child.stdin.on('error', (error) => { if (!closed) report.errors.push(errorFact(error)) })
    child.stderr.pipe(process.stderr, { end: false })
    child.stdout.on('data', (chunk) => {
      try {
        const decoded = decodeRootPackets(Buffer.concat([receiptBuffer, chunk]))
        receiptBuffer = decoded.remaining
        for (const packet of decoded.packets) {
          assert.equal(packet.abi, OBSERVER_ABI); assert.equal(packet.runId, config.runId)
          assert.equal(packet.sourceCommit, config.sourceCommit)
          assert.equal(packet.wardenSha256, report.sourceFiles[0].sha256, 'Root code provenance changed')
          assert.ok(['guardian-ready', 'guardian-final'].includes(packet.stage))
          assert.ok(report.rootReceipts.length < 2, 'Too many root receipts')
          assert.ok(!rootFinal, 'Root packet after final receipt')
          if (packet.stage === 'guardian-final') rootFinal = packet
          else {
            assert.equal(report.rootReceipts.length, 0, 'Duplicate root startup receipt')
          }
          report.rootReceipts.push(packet)
        }
      } catch (error) { protocolError ??= error; abort() }
    })
    }
    const sudoRecheck = await bounded(() => readLinuxProcessIdentity(sudoIdentity.pid), deadlineAt, 1000, 'sudo gated identity recheck')
    assert.equal(key(sudoRecheck), key(sudoIdentity)); assert.equal(sudoRecheck.ppid, process.pid)
    child.stdin.write(`${JSON.stringify(config)}\n`)
    closeTimer = setTimeout(abort, Math.max(1, config.deadlineAt - Date.now() + 5000))
    while (!closed) {
      if (protocolError) throw protocolError
      const birth = report.rootReceipts.find((packet) => packet.stage === 'guardian-ready')
      if (birth && !guardianBirthVerified) {
        // Retain containment authority for the proven spawned guardian even
        // if a later bootstrap attestation fails (including a stopped guard).
        await bounded(() => verifyGuardianAncestry(birth.guardianIdentity, sudoIdentity), deadlineAt, 1500, 'Guardian ancestry')
        const guardHandle = await openObservedPidfd(birth.guardianIdentity, { readIdentity: readLinuxProcessIdentity,
          deadlineAt, verifyDeadlineAt: Math.min(deadlineAt, Date.now() + 1500) })
        assert.equal(guardHandle.terminal, false)
        ownedPidfds.set(key(birth.guardianIdentity), guardHandle)
        report.namespaceBinding = await bounded(() => verifyGuardianBirth(birth, sudoIdentity), deadlineAt, 3000, 'Guardian birth verification')
        report.gatedPidfdAttestation = [{ pid: birth.guardianIdentity.pid,
          starttime: birth.guardianIdentity.starttime, pidfdOpenedAndRechecked: true }]
        for (const identity of [birth.nodeHostIdentity]) {
          const owned = await openObservedPidfd(identity, { readIdentity: readLinuxProcessIdentity, deadlineAt,
            verifyDeadlineAt: Math.min(deadlineAt, Date.now() + 1500) })
          assert.equal(owned.terminal, false, 'Gated identity already terminal')
          ownedPidfds.set(key(identity), owned)
          report.gatedPidfdAttestation.push({ pid: identity.pid, starttime: identity.starttime, pidfdOpenedAndRechecked: true })
        }
        guardianBirthVerified = true
        if (controlledFault === 'guardian-stop') {
          const stopDeadline = Math.min(deadlineAt, Date.now() + 1500)
          const stopped = await bounded(async () => {
            while (Date.now() < stopDeadline) {
              const current = await readLinuxProcessIdentity(birth.guardianIdentity.pid)
              assert.ok(current && key(current) === key(birth.guardianIdentity))
              if (['T', 't'].includes(current.state)) return current
              await new Promise((done) => setTimeout(done, 10))
            }
            assert.fail('Controlled guardian stop was not observed')
          }, stopDeadline, 1500, 'Controlled guardian stop')
          report.guardianStoppedObserved = true
          report.faultEvidence = { kind: controlledFault, observedIdentity: stopped, gateReleased: false }
          throw new Error('Controlled guardian stop requires retained pidfd containment')
        }
        if (onReady) await bounded(() => onReady({ packet: birth, sudoIdentity,
          config: Object.fromEntries(['abi', 'runId', 'sourceCommit', 'suite', 'pattern', 'controlledFault', 'uid', 'gid',
            'deadlineAt', 'innerDeadlineAt'].map((field) => [field, config[field]])),
          namespaceBinding: report.namespaceBinding, sourceFiles: report.sourceFiles }), deadlineAt, 3000, 'Independent parent gate')
        child.stdin.write('G'); report.productGateReleased = true
        heartbeat = setInterval(() => { if (child.stdin.writable) child.stdin.write('P') }, 1000)
      }
      await bounded(() => Promise.race([closePromise, new Promise((done) => setTimeout(done, 50))]),
        deadlineAt - 20_000, 1000, 'Namespace close polling')
    }
    assert.equal(receiptBuffer.length, 0, 'Truncated root receipt')
    assert.ok(guardianBirthVerified, 'Guardian birth was not independently verified')
    assert.ok(rootFinal?.success === true, 'Guardian or inner namespace proof failed')
    assert.equal(report.code, 0, 'Privileged launcher did not close successfully')
  } catch (error) { report.errors.push(errorFact(error)); abort() }
  finally {
    if (child && !closed) {
      const guardian = report.rootReceipts.find((packet) => packet.stage === 'guardian-ready')?.guardianIdentity
      if (guardian && ownedPidfds.has(key(guardian))) {
        try {
          const held = ownedPidfds.get(key(guardian))
          assert.ok(held, 'Guardian pidfd was not retained')
          held.signal('SIGKILL')
          report.guardianContainment = { pid: guardian.pid, starttime: guardian.starttime, signal: 'SIGKILL', result: 'signaled' }
        } catch (error) { report.errors.push(errorFact(error)) }
      }
      try { await bounded(() => closePromise, deadlineAt - 15_000, 30_000, 'Guardian abort close') }
      catch (error) { report.errors.push(errorFact(error)); report.inventoryInconclusive = true }
    }
    clearInterval(heartbeat); clearTimeout(closeTimer)
    for (const [name, handler] of handlers) process.removeListener(name, handler)
    const ready = report.rootReceipts.find((packet) => packet.stage === 'guardian-ready')
    report.faultEvidence ??= rootFinal?.faultEvidence ?? rootFinal?.initFinal?.faultEvidence
    for (const expected of [sudoIdentity, rootFinal?.guardianIdentity ?? ready?.guardianIdentity,
      rootFinal?.unshareIdentity ?? ready?.unshareIdentity, rootFinal?.initIdentity ?? ready?.initIdentity,
      rootFinal?.nodeHostIdentity ?? ready?.nodeHostIdentity].filter(Boolean)) {
      try {
        const identityDeadline = Math.min(deadlineAt, Date.now() + 1500)
        let observation
        do {
          observation = await bounded(() => confirmTerminalIdentity(expected), identityDeadline, 500, 'External identity terminality')
          if (observation.terminal) break
          if (Date.now() < identityDeadline) await new Promise((done) => setTimeout(done, Math.min(20, identityDeadline - Date.now())))
        } while (Date.now() < identityDeadline)
        report.externalIdentities.push(observation)
      }
      catch (error) { report.errors.push(errorFact(error)); report.inventoryInconclusive = true }
    }
    try { report.postflight = await requireEmptyDatabase(env, config.runId, deadlineAt - 5000) }
    catch (error) { report.errors.push(errorFact(error)) }
    try {
      report.innerReceipt = JSON.parse(await bounded(() => readFile(join(evidence, `${name}.json`), 'utf8'), deadlineAt, 2000, 'Inner receipt read'))
      assert.equal(report.innerReceipt.runId, config.runId, 'Inner receipt belongs to another invocation')
      assert.equal(report.innerReceipt.sourceCommit, config.sourceCommit)
      if (controlledFault === 'deadline' && report.innerReceipt.containmentRequired === true &&
        /Perception suite exceeded its deadline/.test(report.innerReceipt.error ?? '')) {
        report.faultEvidence = { kind: controlledFault, innerRootPid: report.innerReceipt.rootPid,
          deadlineMs: report.innerReceipt.controlledDeadlineMs, nodeCloseObserved: report.innerReceipt.childCloseObserved }
      }
      report.success = !interrupted && !report.errors.length && !report.inventoryInconclusive && report.childCloseObserved &&
        guardianBirthVerified && report.code === 0 && rootFinal?.success === true &&
        rootFinal.initFinal?.nodeCloseObserved === true && rootFinal.initFinal.cleanup?.namespaceEmpty === true &&
        rootFinal.mintedProcessesTerminal === true && report.externalIdentities.length === 5 &&
        report.externalIdentities.every((identity) => identity.terminal) && report.postflight?.backendCount === 0 &&
        report.innerReceipt.success === true
    } catch (error) { report.errors.push(errorFact(error)); report.success = false }
    report.completedAt = new Date().toISOString()
    for (const owned of ownedPidfds.values()) {
      try { owned.close() } catch (error) { report.success = false; report.errors.push(errorFact(error)) }
    }
    if (sudoBirthToken) { try { binding.close(sudoBirthToken) } catch (error) { report.success = false; report.errors.push(errorFact(error)) } }
    report.receiptPath = join(evidence, `${name}.namespace.json`)
    try { await bounded(() => writeFile(report.receiptPath, JSON.stringify(report, null, 2)), deadlineAt, 3000, 'Outer receipt write') }
    catch (error) { report.success = false; report.errors.push(errorFact(error)); process.stderr.write(`Outer receipt write failed\n${JSON.stringify(report)}\n`) }
    try {
      writeFileSync(join(env.APOLLO_PERCEPTION_PIDFD_ROOT, 'receipts', `namespace-${config.runId}.json`),
        JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 })
    } catch (error) { report.success = false; report.errors.push(errorFact(error)) }
    // Do not destroy pipes, unref a live launcher or force-exit to hide it.
    // A missing root close is an explicit inconclusive failure, never PASS.
  }
  return report
}

export async function runParentGatedNamespaceLauncher() {
  assert.equal(typeof process.send, 'function', 'Fixed parent-owned launcher requires inherited IPC')
  let ackResolve, ackReject, readySent = false
  const ack = new Promise((done, reject) => { ackResolve = done; ackReject = reject })
  const message = (value) => {
    if (!readySent || value?.kind !== 'parent-gate-ack' || Object.keys(value).length !== 1) ackReject(new Error('Invalid fixed parent ACK'))
    else ackResolve()
  }
  const disconnect = () => ackReject(new Error('Authenticated outer parent IPC death before ACK'))
  process.on('message', message); process.once('disconnect', disconnect)
  // Attach rejection handler immediately; rejection still propagates at gate.
  ack.catch(() => {})
  try {
    const report = await runNamespaceSuite({ suite: COMPOSED_SUITE, onReady: async (ready) => {
      readySent = true
      process.send({ kind: 'namespace-parent-ready', ready })
      await bounded(() => ack, Date.now() + 3000, 3000, 'Parent ACK')
    } })
    if (!report.success) process.exitCode = 1
  } finally { process.removeListener('message', message); process.removeListener('disconnect', disconnect); if (process.connected) process.disconnect() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [suite, pattern] = process.argv.slice(2)
  const report = await runNamespaceSuite({ suite, pattern: pattern ?? null })
  if (!report.success) process.exitCode = 1
}
