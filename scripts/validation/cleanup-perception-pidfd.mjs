import assert from 'node:assert/strict'
import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertOwnedRoot, readRegistry, registryLock, writeRegistry, digest, jsonDigest,
  readAuthorityIdentitySync, identityKey, sourceFingerprint, budget,
  namespaceEmptyProof, assessLockLeftover, parseLockLeftoverName, reclaimAdmissionLock, reclaimAdmissionMutex } from './perception-addon-registry.mjs'
import { readLinuxProcessIdentity } from './run-perception-ci.mjs'
import { prepareCgroupCleanup, removeArchivedCgroups, cgroupControlledCaseAccepted } from './perception-consumer-cgroup.mjs'

export function assertArchivePaths(root, archiveParent, archive, runnerTemp) {
  const paths = [root, archiveParent, archive, runnerTemp].map((value) => {
    assert.ok(typeof value === 'string' && value.startsWith('/'), 'Absolute Linux archive paths required')
    return posix.resolve(value)
  })
  const [source, parent, destination, temporary] = paths
  assert.ok(parent.startsWith(temporary + '/') && destination.startsWith(parent + '/'), 'Archive escapes runner temp or parent')
  for (const target of [parent, destination])
    assert.ok(target !== source && !target.startsWith(source + '/'), 'Archive cannot be source root or its subtree')
  assert.ok(!source.startsWith(destination + '/'), 'Archive destination cannot contain source root')
  return paths
}

export function planArchive({ root, archiveParent, runnerTemp, runId, rootIdentity, uid },
  io = { lstat: lstatSync, realpath: realpathSync }) {
  assert.match(runId, /^pidfd-build-[a-f0-9-]+$/)
  const [source, parent, archive, temporary] = assertArchivePaths(root, archiveParent, posix.join(archiveParent, runId), runnerTemp)
  const metadata = io.lstat(source)
  assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.uid === uid &&
    metadata.dev === rootIdentity.dev && metadata.ino === rootIdentity.ino, 'Source root identity changed before archive')
  const physicalSource = io.realpath(source), physicalTemporary = io.realpath(temporary)
  assert.equal(physicalSource, source, 'Source root ancestor symlink forbidden')
  assert.equal(physicalTemporary, temporary, 'Runner temp ancestor symlink forbidden')
  let anchor = parent
  while (true) {
    try {
      const existing = io.lstat(anchor)
      assert.ok(existing.isDirectory() && !existing.isSymbolicLink() && existing.uid === uid, 'Archive ancestor owner/link invalid')
      assert.equal(io.realpath(anchor), anchor, 'Archive ancestor symlink forbidden')
      break
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      assert.notEqual(anchor, temporary, 'Runner temp missing')
      anchor = posix.dirname(anchor)
    }
  }
  const physicalParent = posix.join(io.realpath(anchor), posix.relative(anchor, parent))
  assertArchivePaths(physicalSource, physicalParent, posix.join(physicalParent, runId), physicalTemporary)
  try { io.lstat(archive); assert.fail('Archive destination already exists') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  return { archiveParent: parent, archive, physicalSource }
}

export function namespaceOwnerClosed(owner, reports) {
  const matching = reports.filter((report) => report.runId === owner.observerRunId &&
    report.namespaceBinding?.directlyObserved.namespace === owner.identity.namespace &&
    report.sourceCommit === owner.sourceCommit)
  assert.equal(matching.length, 1, 'Namespace owner has no unique authenticated host binding')
  const report = matching[0]
  const anchor = report.namespaceBinding.wardenAttested.localNodeIdentity
  assert.ok(BigInt(owner.identity.starttime) >= BigInt(anchor.starttime), 'Registered consumer predates the namespace anchor')
  if (owner.identity.pid === anchor.pid) assert.equal(owner.identity.starttime, anchor.starttime)
  assert.equal(report.childCloseObserved, true)
  assert.equal(report.rootReceipts?.at(-1)?.stage, 'guardian-final', 'Namespace register cannot infer a missing FINAL')
  assert.equal(report.rootReceipts.at(-1).initFinal?.nodeCloseObserved, true)
  assert.equal(report.rootReceipts.at(-1).initFinal?.cleanup?.namespaceEmpty, true)
  assert.equal(report.externalIdentities.length, 5)
  assert.ok(report.externalIdentities.every((value) => value.terminal))
  assert.equal(report.postflight?.backendCount, 0)
  return true
}
// Host-side proofs that a private PID namespace is EMPTY, from the supervisor's own authenticated
// receipts (the same evidence `namespaceOwnerClosed` demands of every namespace owner).
export function readNamespaceProofs(root, env = process.env) {
  const proofs = []
  let names
  try { names = readdirSync(join(root, 'receipts')) } catch { return proofs }
  for (const name of names) {
    if (proofs.length >= 64 || !/^namespace-perception-namespace-[a-f0-9-]+\.json$/.test(name)) continue
    try {
      const path = join(root, 'receipts', name), metadata = lstatSync(path)
      if (!metadata.isFile() || metadata.uid !== process.getuid() || metadata.size > 16777216) continue
      const bytes = readFileSync(path)
      const proof = namespaceEmptyProof(JSON.parse(bytes.toString('utf8')), { path: `receipts/${name}`, sha256: digest(bytes) }, { sourceCommit: env.GITHUB_SHA })
      if (proof) proofs.push(proof)
    } catch { /* An unreadable receipt is not a proof. */ }
  }
  return proofs
}
// Exact admission-lock artifacts (lock, reclaim mutex, link staging files, tombstones) are removed only when their
// creator is provably gone (dead here, or inside a namespace the host supervisor proved empty); otherwise the root is
// retained as evidence, as for any unknown file. Classification is read-only; removal happens only after the whole
// inventory passed (`removeLockLeftovers`). Returns null for names that are not admission-lock artifacts.
export function classifyLockLeftover(item, relative, metadata, { namespaceProofs = [], io = {} }) {
  const leftover = relative.includes('/') ? null : parseLockLeftoverName(relative)
  if (!leftover) return null
  const verdict = assessLockLeftover(item, leftover, io, { namespaceProofs })
  assert.equal(verdict.verdict, 'stale', `Admission-lock leftover ${relative} has no proof that its creator is gone (${verdict.reason}); retain evidence`)
  assert.ok(metadata.size <= 4096)
  return { item, relative, kind: leftover.kind, parsed: leftover, bytes: metadata.size, sha256: digest(readFileSync(item)), proof: verdict.proof }
}
// The lock and the reclaim mutex go through the reclaim protocol (mutex, intent receipt, tombstone, digest re-check,
// link restore): a contender may have reclaimed and republished since classification, and a live lock is never
// removed. Staging files and tombstones belong to a creator that is provably gone and are unlinked after the same
// proof is re-checked and the bytes still match.
export function removeLockLeftovers(root, pending, { namespaceProofs = [], report, io = {} }) {
  for (const entry of pending) {
    let outcome = { action: 'removed' }
    if (entry.kind === 'lock' || entry.kind === 'mutex') {
      const result = (entry.kind === 'lock' ? reclaimAdmissionLock : reclaimAdmissionMutex)(root, { io, namespaceProofs })
      // Already gone (an earlier reclaim in this pass removed an orphaned mutex together with the lock) is not a failure.
      if (result.assessment?.verdict === 'absent') outcome = { action: 'already-absent' }
      else {
        assert.equal(result.reclaimed, true, `Admission-lock leftover ${entry.relative} could not be reclaimed under proof (${result.assessment?.reason}); retain evidence`)
        outcome = { action: 'reclaimed', reclaimId: result.record.reclaimId }
      }
    } else {
      const again = assessLockLeftover(entry.item, entry.parsed, io, { namespaceProofs })
      assert.equal(again.verdict, 'stale', `Admission-lock leftover ${entry.relative} lost its proof (${again.reason}); retain evidence`)
      assert.equal(digest(readFileSync(entry.item)), entry.sha256, `Admission-lock leftover ${entry.relative} changed; retain evidence`)
      unlinkSync(entry.item)
    }
    ;(report.admissionLockLeftovers ??= []).push({ name: entry.relative, kind: entry.kind, bytes: entry.bytes, sha256: entry.sha256, proof: entry.proof, ...outcome })
  }
}
export async function cleanupPidfd(env = process.env) {
  assert.equal(process.platform, 'linux'); assert.ok(process.getuid() > 0)
  const root = env.APOLLO_PERCEPTION_PIDFD_ROOT
  const deadlineAt = Date.now() + 25000
  assert.ok(root, 'Missing build root; no glob discovery/deletion')
  const authority = assertOwnedRoot(root, env), registry = readRegistry(root, env)
  const report = { schemaVersion: 'perception-pidfd-cleanup/v1', buildRunId: registry.runId,
    sourceCommit: env.GITHUB_SHA, root: authority, cleanupOwner: readAuthorityIdentitySync(process.pid),
    success: false, removed: false, errors: [], owners: [], archivedFiles: [] }
  const fail = (error) => report.errors.push({ name: error.name, code: error.code ?? null, message: String(error.message).slice(0, 512),
    ...(error.admissionLockDiagnostic ? { admissionLockDiagnostic: error.admissionLockDiagnostic } : {}) })
  let preparedCgroups = []
  let namespaceProofs = []
  try {
    namespaceProofs = readNamespaceProofs(root, env)
    await registryLock(root, async () => {
      const current = readRegistry(root, env)
      current.admission = 'closed'; writeRegistry(root, current)
    }, { env, namespaceProofs })
    assert.deepEqual(sourceFingerprint(), registry.sourceFiles, 'Source changed since build')
    // Containment has its own authenticated scope even when a consumer's FAIL
    // prevents successful prerequisite deletion. Unknown scopes remain retained.
    preparedCgroups = await prepareCgroupCleanup(registry, env, deadlineAt, report)
    const receipt = JSON.parse(readFileSync(join(root, 'provenance.json'), 'utf8'))
    assert.equal(digest(readFileSync(join(root, 'provenance.json'))), registry.provenanceSha256)
    assert.equal(receipt.runId, registry.runId); assert.equal(receipt.sourceCommit, env.GITHUB_SHA)
    // Failed compiler remains FAIL, but evidence is still archived below.
    assert.equal(receipt.success, true); assert.equal(receipt.childCloseObserved, true)
    assert.ok(receipt.terminality.length > 0 && receipt.terminality.every((value) => value.terminal))
    for (const item of [receipt.compiler, receipt.timeout, receipt.node, receipt.source, receipt.addon, ...receipt.headers]) {
      assert.equal(digest(readFileSync(item.path)), item.sha256, 'Prerequisite input bytes changed')
    }
    const allFiles = [], pendingLeftovers = []
    let inventoryBytes = 0
    const walk = (path) => {
      assert.ok(Date.now() < deadlineAt, 'Cleanup inventory deadline')
      for (const name of readdirSync(path)) {
        const item = join(path, name), metadata = lstatSync(item)
        assert.ok(!metadata.isSymbolicLink() && metadata.uid === process.getuid(), 'Unknown cleanup path authority')
        if (metadata.isDirectory()) {
          assert.ok(['owners', 'receipts'].includes(item.slice(root.length + 1)), 'Unknown directory in build root')
          walk(item)
        }
        else {
          assert.ok(metadata.isFile() && metadata.size <= 16777216)
          const relative = item.slice(root.length + 1)
          const leftover = classifyLockLeftover(item, relative, metadata, { namespaceProofs })
          if (leftover) { pendingLeftovers.push(leftover); continue }
          assert.ok(/^(registry\.json|build-owner\.json|provenance\.json|compiler\.(stdout|stderr|version)|perception-pidfd\.node)$/.test(relative) ||
            /^owners\/[a-f0-9]{64}\.json$/.test(relative) ||
            /^receipts\/pidfd-consumer-cgroup-gates-[a-f0-9-]+\.cases\.(?:json|sha256)$/.test(relative) ||
            /^receipts\/admission-lock-reclaim-[a-f0-9-]+\.json$/.test(relative) ||
            /^receipts\/(?:pidfd-consumer-[a-z-]+-[a-f0-9-]+\.(?:json|sha256)|namespace-perception-namespace-[a-f0-9-]+\.json)$/.test(relative),
          'Unknown file in build root; retain evidence')
          allFiles.push(item)
          inventoryBytes += metadata.size
          assert.ok(allFiles.length <= 8192 && inventoryBytes <= 134217728, 'Cleanup inventory total bound')
        }
      }
    }
    walk(root); assert.ok(allFiles.length <= 8192)
    removeLockLeftovers(root, pendingLeftovers, { namespaceProofs, report })
    const namespaceReports = allFiles.filter((path) => path.includes('/receipts/namespace-') && path.endsWith('.json'))
      .map((path) => JSON.parse(readFileSync(path, 'utf8')))
    const selfNamespace = report.cleanupOwner.namespace
    const hostTerminal = async (identity) => {
      const current = await budget(() => readLinuxProcessIdentity(identity.pid), deadlineAt, 500, 'Cleanup host identity')
      assert.ok(!current || identityKey(current) !== identityKey(identity) || ['Z', 'X', 'x'].includes(current.state), 'Known host identity still live')
      return { pid: identity.pid, starttime: identity.starttime,
        observation: !current ? 'absent' : identityKey(current) !== identityKey(identity) ? 'pid-recycled' : current.state, terminal: true }
    }
    report.creatorTerminal = await hostTerminal(registry.creator)
    for (const identity of receipt.observed) await hostTerminal(identity)
    const owners = allFiles.filter((path) => path.includes('/owners/') && path.endsWith('.json'))
    assert.ok(owners.length > 0, 'No registered consumers')
    const consumerReceipts = allFiles.filter((path) => path.includes('/receipts/') && /pidfd-consumer-.*\.json$/.test(path) && !path.endsWith('.cases.json'))
      .map((path) => {
        const value = JSON.parse(readFileSync(path, 'utf8'))
        assert.equal(jsonDigest(value), readFileSync(path.replace(/\.json$/, '.sha256'), 'utf8'))
        assert.equal(value.buildRunId, registry.runId); assert.equal(value.sourceCommit, env.GITHUB_SHA)
        assert.equal(value.success, true, 'Failed or inconclusive fixed consumer retains the build root')
        assert.deepEqual(value.errors, [])
        assert.equal(value.childCloseObserved, true)
        assert.equal(value.terminality.length, value.observed.length)
        assert.ok(value.observed.length && value.terminality.every((entry) => entry.terminal))
        if (value.schemaVersion === 'perception-cgroup-owner-close/v1') {
          assert.equal(value.carrierCloseObserved, true); assert.equal(value.guardianCloseObserved, true)
          assert.ok(value.actors?.length >= 3 && value.actors.every((actor) => actor.closeObserved === true))
          assert.equal(value.empty?.populated, 0); assert.equal(value.empty?.liveMembershipEmpty, true)
          assert.equal(value.securitySandboxClaimed, false)
        }
        if (value.schemaVersion === 'perception-cgroup-controlled-driver/v1') {
          assert.deepEqual(value.cases.map((entry) => [entry.kind, entry.expectedFailure]), [
            ['member-exit', null], ['wait', 'owner-death'],
            ['guardian-stop-owner-death', 'guardian-stopped-then-owner-death'],
            ['setsid-reparent', 'owner-death-after-reparent'], ['zombie', 'owner-death-with-zombie'],
          ])
          assert.ok(value.cases.every((entry) => entry.assertionsPassed === true && cgroupControlledCaseAccepted(entry)))
          assert.ok(value.cases.slice(1).every((entry) => entry.innerFinalObserved === false && entry.ownerSignal === 'SIGKILL'))
          assert.equal(value.cases[0].innerFinalObserved, true)
          const path = join(root, 'receipts', `${value.runId}.cases.json`), bytes = readFileSync(path)
          assert.equal(digest(bytes), value.caseLedgerSha256)
          assert.equal(digest(bytes), readFileSync(path.replace(/\.json$/, '.sha256'), 'utf8'))
          const ledger = JSON.parse(bytes)
          assert.deepEqual(ledger.errors, []); assert.deepEqual(ledger.cases, value.cases)
        }
        return value
      })
    for (const path of owners) {
      const owner = JSON.parse(readFileSync(path, 'utf8'))
      assert.equal(owner.buildRunId, registry.runId); assert.equal(owner.sourceCommit, env.GITHUB_SHA)
      assert.equal(owner.addonSha256, registry.addonSha256); assert.equal(owner.provenanceSha256, registry.provenanceSha256)
      assert.deepEqual(owner.identity.uids, Array(4).fill(process.getuid()))
      assert.equal(owner.registrationIsNotProcessClose, true)
      const name = jsonDigest([owner.identity.namespace, owner.identity.pid, owner.identity.starttime])
      assert.equal(path, join(root, 'owners', `${name}.json`))
      const driver = consumerReceipts.find((value) => value.runId === owner.consumerRunId)
      assert.ok(driver, 'Unknown consumer has no supervised owner close receipt')
      let observation
      if (owner.identity.namespace === selfNamespace) {
        assert.ok(identityKey(driver.owner) === identityKey(owner.identity) ||
          driver.observed.some((value) => identityKey(value) === identityKey(owner.identity)),
        'Registered host consumer was not observed by its fixed driver')
        observation = await hostTerminal(owner.identity)
      } else {
        namespaceOwnerClosed(owner, namespaceReports)
        observation = { terminal: true, observation: 'authenticated-namespace-final-empty',
          namespace: owner.identity.namespace, localPid: owner.identity.pid, starttime: owner.identity.starttime }
      }
      report.owners.push({ path, consumerRunId: owner.consumerRunId, observation })
    }
    // Unknown or live new root users cannot register after this admission fence.
    assertOwnedRoot(root, env, authority)
  } catch (error) { fail(error) }
  try {
    const archiveParent = resolve(env.APOLLO_PERCEPTION_PIDFD_ARCHIVE_ROOT ?? join(env.RUNNER_TEMP, 'pidfd-archive'))
    const planned = planArchive({ root, archiveParent, runnerTemp: env.RUNNER_TEMP,
      runId: registry.runId, rootIdentity: authority, uid: process.getuid() })
    // Validate lexical/physical paths and source identity BEFORE any mkdir.
    mkdirSync(planned.archiveParent, { recursive: true, mode: 0o700 })
    const parentMetadata = lstatSync(planned.archiveParent)
    assert.ok(parentMetadata.isDirectory() && !parentMetadata.isSymbolicLink() && parentMetadata.uid === process.getuid())
    assert.equal(realpathSync(planned.archiveParent), planned.archiveParent)
    assertOwnedRoot(root, env, authority)
    const archive = planned.archive
    mkdirSync(archive, { mode: 0o700 }); report.archivePath = archive
    // Recheck the effective created destination and its parent immediately
    // before walking/copying; a changed/link target retains the source root.
    const createdParent = lstatSync(planned.archiveParent), createdArchive = lstatSync(archive)
    assert.ok(createdParent.isDirectory() && !createdParent.isSymbolicLink() && createdParent.uid === process.getuid() &&
      createdParent.dev === parentMetadata.dev && createdParent.ino === parentMetadata.ino)
    assert.ok(createdArchive.isDirectory() && !createdArchive.isSymbolicLink() && createdArchive.uid === process.getuid())
    assert.equal(realpathSync(planned.archiveParent), planned.archiveParent)
    assert.equal(realpathSync(archive), archive)
    assert.equal(realpathSync(root), planned.physicalSource)
    assertOwnedRoot(root, env, authority)
    assertArchivePaths(realpathSync(root), realpathSync(planned.archiveParent), realpathSync(archive), realpathSync(env.RUNNER_TEMP))
    const archiveWalk = (from, to) => {
      assert.ok(Date.now() < deadlineAt, 'Cleanup archive deadline')
      for (const name of readdirSync(from)) {
        const origin = join(from, name), target = join(to, name), metadata = lstatSync(origin)
        assert.ok(!metadata.isSymbolicLink() && metadata.uid === process.getuid())
        if (metadata.isDirectory()) { mkdirSync(target, { mode: 0o700 }); archiveWalk(origin, target) }
        else {
          assert.ok(metadata.isFile() && metadata.size <= 16777216)
          assert.ok(report.archivedFiles.length < 8192 &&
            report.archivedFiles.reduce((sum, item) => sum + item.bytes, 0) + metadata.size <= 134217728, 'Archive total bound')
          cpSync(origin, target, { errorOnExist: true, force: false })
          const sha256 = digest(readFileSync(origin)); assert.equal(digest(readFileSync(target)), sha256)
          report.archivedFiles.push({ path: origin.slice(root.length + 1), sha256, bytes: metadata.size })
        }
      }
    }
    archiveWalk(root, archive)
    report.success = report.errors.length === 0
    writeFileSync(join(archive, 'cleanup.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 })
    if (report.success) {
      // Root remove is fixed, source-pinned and has no exec/signal RPC. It runs
      // after the byte-exact archive, and never adopts a replacement cgroup/PID.
      await removeArchivedCgroups(preparedCgroups, registry, env, deadlineAt, report)
      report.success = report.errors.length === 0 && preparedCgroups.every(({ facts }) => facts.removed && facts.success)
      writeFileSync(join(archive, 'cleanup.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
    }
    if (report.success) {
      assertOwnedRoot(root, env, authority)
      assert.equal(readRegistry(root, env).admission, 'closed')
      // Only this exact authenticated root, after verified archival/terminality.
      rmSync(root, { recursive: true }); report.removed = true
      writeFileSync(join(archive, 'cleanup.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
    }
  } catch (error) { fail(error); report.success = false }
  if (!report.success) process.stderr.write(`${JSON.stringify(report)}\n`)
  return report
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!(await cleanupPidfd()).success) process.exitCode = 1 }
  catch (error) { process.stderr.write(`Pidfd cleanup refused: ${error.message}\n`); process.exitCode = 1 }
}
