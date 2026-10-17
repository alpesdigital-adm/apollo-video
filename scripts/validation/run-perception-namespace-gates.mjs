import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runNamespaceSuite } from './run-perception-ci-namespace.mjs'
import { runOuterHostDeath, verifyOuterHostDeath } from './perception-outer-host-death.mjs'

const SUITE = 'tests/v2/perception-namespace-observer.integration.mjs'
async function boundedFile(action) {
  const remaining = Number(process.env.APOLLO_PERCEPTION_JOB_DEADLINE_MS) - Date.now()
  assert.ok(Number.isSafeInteger(remaining) && remaining > 0, 'Composed receipt budget exhausted before IO')
  let timer
  try { return await Promise.race([action(), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Composed receipt IO deadline')), Math.min(2000, remaining))
  })]) } finally { clearTimeout(timer) }
}
export const REQUIRED_NAMESPACE_FAILURES = Object.freeze([
  'guardian-stop', 'init-stop', 'node-owner-death', 'ipc-death', 'ipc-truncated', 'ipc-oversized', 'deadline',
])
const requiredNormal = (value, uid, gid) => {
  assert.deepEqual(value.uids, Array(4).fill(uid)); assert.deepEqual(value.gids, Array(4).fill(gid))
  assert.equal(value.noNewPrivs, 1); assert.equal(value.groups, '')
  for (const mask of Object.values(value.caps)) assert.equal(mask, '0000000000000000')
}

export function verifyComposedPositive(report, facts, uid, gid) {
  assert.equal(report.success, true, 'Real composed namespace proof failed')
  assert.equal(report.innerReceipt.success, true)
  assert.equal(report.innerReceipt.passed, 3); assert.equal(report.innerReceipt.skipped, 0)
  assert.equal(report.externalIdentities.length, 5)
  assert.ok(report.externalIdentities.every((value) => value.terminal))
  assert.equal(report.postflight.backendCount, 0)
  assert.equal(report.rootReceipts.length, 2)
  for (const value of Object.values(facts)) assert.equal(value.runId, report.runId)
  requiredNormal(facts.node.node, uid, gid); requiredNormal(facts.nondumpable.child, uid, gid)
  requiredNormal(facts.orphan.child, uid, gid)
  assert.equal(facts.nondumpable.observation, 'real-nondumpable-child/raw-environ-eacces')
  assert.equal(facts.nondumpable.environInodeUid, 0); assert.equal(facts.nondumpable.environMode, '0o400')
  const observed = report.innerReceipt.observedProcesses.find((value) =>
    value.pid === facts.nondumpable.identity.pid && value.starttime === facts.nondumpable.identity.starttime)
  assert.ok(observed?.runMarked === true, 'Privileged observer must attest the exact real nondumpable identity')
  assert.equal(observed.uid, uid)
  assert.equal(observed.environInodeUid, 0); assert.equal(observed.environMode, '0o400')
  const orphan = report.innerReceipt.observedProcesses.find((value) =>
    value.pid === facts.orphan.identity.pid && value.starttime === facts.orphan.identity.starttime)
  assert.ok(orphan?.runMarked === true)
  assert.equal(facts.orphan.child.ppid, 1)
  assert.equal(orphan.sessionId, facts.orphan.identity.pid)
  assert.equal(report.rootReceipts[1].initFinal.nodeCloseObserved, true)
  assert.equal(report.rootReceipts[1].initFinal.cleanup.namespaceEmpty, true)
  assert.equal(report.innerReceipt.inventoryInconclusive, false)
  assert.doesNotMatch(JSON.stringify(report), /private-environment-/,
    'Environment sentinel bytes must never appear in observer or receipts')
}

export function verifyComposedFailure(report, expectedCase) {
  assert.equal(report.controlledFault, expectedCase, 'Controlled fault must actually execute, never silently be omitted')
  assert.equal(report.success, false, 'Expected infrastructure failure must remain an outer FAIL')
  assert.equal(report.childCloseObserved, true)
  assert.equal(report.externalIdentities.length, 5, 'Every minted external identity needs independent terminality')
  assert.ok(report.externalIdentities.every((value) => value.terminal), 'Fault left a live or inconclusive owned identity')
  assert.equal(report.postflight.backendCount, 0)
  assert.ok(report.errors.length > 0 || report.innerReceipt?.success === false)
  assert.equal(report.faultEvidence?.kind, expectedCase, 'A configured label cannot replace an observed fault')
  if (expectedCase === 'guardian-stop') {
    assert.equal(report.guardianStoppedObserved, true)
    assert.equal(report.guardianContainment.signal, 'SIGKILL')
    assert.equal(report.guardianContainment.result, 'signaled')
    assert.ok(!report.rootReceipts.some((value) => value.stage === 'guardian-final'), 'Killed guardian must not fabricate a final')
    assert.equal(report.innerReceipt, undefined, 'Gated bootstrap killed before exec must not fabricate an inner receipt')
  }
  if (expectedCase === 'init-stop') {
    assert.ok(['T', 't'].includes(report.faultEvidence.observedIdentity.state))
    assert.equal(report.faultEvidence.nodeGateReleased, false)
    assert.equal(report.innerReceipt, undefined)
  }
  if (expectedCase === 'node-owner-death') {
    assert.equal(report.faultEvidence.nodeExitCode, -9)
    assert.equal(report.faultEvidence.nodeCloseObserved, true)
    assert.equal(report.innerReceipt, undefined)
  }
  for (const [fault, code] of [['ipc-death', 'IPC_EOF'], ['ipc-truncated', 'IPC_TRUNCATED'], ['ipc-oversized', 'IPC_FRAME_SIZE']]) {
    if (expectedCase === fault) assert.equal(report.faultEvidence.code, code)
  }
  if (expectedCase === 'ipc-truncated') assert.equal(report.faultEvidence.bufferedBytes, 2)
  if (expectedCase === 'ipc-oversized') assert.equal(report.faultEvidence.declaredBytes, 65537)
  if (expectedCase === 'deadline') {
    assert.equal(report.faultEvidence.deadlineMs, 2000)
    assert.ok(Number.isSafeInteger(report.faultEvidence.innerRootPid))
    assert.equal(report.faultEvidence.nodeCloseObserved, true)
    assert.equal(report.innerReceipt.success, false)
    assert.equal(report.innerReceipt.activeSurvivors.length, 0)
    assert.equal(report.rootReceipts[1].initFinal.nodeCloseObserved, true)
    assert.equal(report.rootReceipts[1].initFinal.cleanup.namespaceEmpty, true)
  }
  assert.doesNotMatch(JSON.stringify(report), /private-environment-/)
}

export async function runNamespaceGates() {
  assert.equal(process.platform, 'linux')
  assert.ok(process.getuid() > 0 && process.getgid() > 0)
  const evidence = process.env.APOLLO_LIBRARY_EVIDENCE_ROOT
  const receipts = { schemaVersion: 'perception-namespace-composed-gate/v1',
    sourceCommit: process.env.GITHUB_SHA, proofScope: 'infrastructure-controlled-mechanics',
    coverageScope: 'namespace-positive-and-eight-fixed-negatives', infrastructureAcceptance: 'pending',
    pendingGates: ['outer-host-death'], success: false, cases: [], pending: [...REQUIRED_NAMESPACE_FAILURES] }
  try {
    const directory = join(evidence, 'namespace-gates', 'positive')
    const report = await runNamespaceSuite({ suite: SUITE,
      env: { ...process.env, APOLLO_LIBRARY_EVIDENCE_ROOT: directory } })
    receipts.activeCase = { kind: 'positive', runId: report.runId, receiptPath: report.receiptPath }
    const facts = {}
    for (const [name, file] of [['node', 'namespace-composed-node.json'],
      ['nondumpable', 'namespace-composed-nondumpable.json'], ['orphan', 'namespace-composed-orphan.json']]) {
      facts[name] = JSON.parse(await boundedFile(() => readFile(join(directory, file), 'utf8')))
    }
    verifyComposedPositive(report, facts, process.getuid(), process.getgid())
    receipts.cases.push({ kind: 'positive', runId: report.runId, receiptPath: report.receiptPath, success: true })
    for (const fault of REQUIRED_NAMESPACE_FAILURES) {
      const controlled = await runNamespaceSuite({ suite: SUITE, controlledFault: fault,
        env: { ...process.env, APOLLO_LIBRARY_EVIDENCE_ROOT: join(evidence, 'namespace-gates', fault) } })
      receipts.activeCase = { kind: fault, runId: controlled.runId, receiptPath: controlled.receiptPath }
      verifyComposedFailure(controlled, fault)
      receipts.cases.push({ kind: fault, runId: controlled.runId, receiptPath: controlled.receiptPath,
        observedRunSuccess: false, success: true })
      receipts.pending = receipts.pending.filter((value) => value !== fault)
    }
    assert.deepEqual(receipts.pending, [])
    const outerDeath = await runOuterHostDeath(process.env)
    receipts.activeCase = { kind: 'outer-host-death', runId: outerDeath.runId, receiptPath: outerDeath.receiptPath }
    verifyOuterHostDeath(outerDeath)
    receipts.cases.push({ kind: 'outer-host-death', runId: outerDeath.runId, receiptPath: outerDeath.receiptPath,
      observedRunSuccess: false, containmentTerminal: true, success: true })
    receipts.pendingGates = []
    receipts.success = true
    delete receipts.activeCase
  } catch (error) {
    receipts.error = { name: error.name, message: String(error.message).slice(0, 512) }
    process.exitCode = 1
  } finally {
    const path = join(evidence, 'namespace-composed-gate.json')
    try { await boundedFile(() => writeFile(path, JSON.stringify(receipts, null, 2))) }
    catch (error) { receipts.success = false; process.exitCode = 1;
      receipts.receiptError = { name: error.name, message: String(error.message).slice(0, 512) }
      process.stderr.write(`${JSON.stringify({ path, ...receipts })}\n`) }
    process.stdout.write(`Namespace gate: ${receipts.success ? 'PASS' : 'FAIL'}; receipt=${path}\n`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.deepEqual(process.argv.slice(2), [SUITE], 'CI composed suite must be explicit and fixed')
  await runNamespaceGates()
}
