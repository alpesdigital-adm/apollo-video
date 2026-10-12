import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, closeSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { awaitBootstrapGate } from '../../scripts/validation/perception-ci-child-bootstrap.mjs'
import { CI_ROOT, budget, digest, identityKey, liveIdentity, readAuthorityIdentitySync, registerAddonConsumer } from '../../scripts/validation/perception-addon-registry.mjs'
import { loadPidfdBinding, openObservedPidfd } from '../../scripts/validation/perception-pidfd.mjs'
import { readLinuxProcessIdentity } from '../../scripts/validation/run-perception-ci.mjs'
import { CGROUP_ABI, assertCgroupScope, openCgroupKill, readCgroupSnapshot, parseCgroupMembership,
  cgroupControlledCaseAccepted } from '../../scripts/validation/perception-consumer-cgroup.mjs'

// A plain fixed Node entrypoint, so the external driver births THIS process
// before any test runs. No test-runner child may appear ahead of the ACK.
if (process.platform === 'linux') await awaitBootstrapGate()

test('Linux cgroup real membership/containment and independent driver owner-death gates',
  { skip: process.platform !== 'linux' }, async () => {
    assert.ok(process.getuid() > 0 && process.getgid() > 0)
    const end = Number(process.env.APOLLO_CGROUP_GATE_DEADLINE_MS)
    assert.ok(Number.isSafeInteger(end) && end > Date.now() + 30000)
    const workEnd = end - 25000
    const runId = process.env.APOLLO_PERCEPTION_CONSUMER_RUN_ID
    const registration = await registerAddonConsumer()
    const { binding } = await loadPidfdBinding()
    const ownerFile = join(CI_ROOT, 'scripts/validation/perception-consumer-cgroup.mjs')
    assert.equal(digest(readFileSync(ownerFile)), registration.registry.sourceFiles.find((value) => value.path === 'scripts/validation/perception-consumer-cgroup.mjs').sha256)
    const ledger = { schemaVersion: 'perception-cgroup-controlled-cases/v1', runId, sourceCommit: process.env.GITHUB_SHA,
      observed: [readAuthorityIdentitySync(process.pid)], cases: [], errors: [] }
    let primary
    const safeError = (error) => ({ name: error.name, code: error.code ?? null,
      messageSha256: digest(String(error.message)), messageBytes: Buffer.byteLength(String(error.message)) })
    const expected = [
      { kind: 'member-exit', expectedFailure: null },
      { kind: 'wait', expectedFailure: 'owner-death' },
      { kind: 'guardian-stop-owner-death', expectedFailure: 'guardian-stopped-then-owner-death' },
      { kind: 'setsid-reparent', expectedFailure: 'owner-death-after-reparent' },
      { kind: 'zombie', expectedFailure: 'owner-death-with-zombie' },
    ]
    try {
      for (const declaration of expected) {
        const caseEnd = Math.min(workEnd, Date.now() + 40000)
        assert.ok(caseEnd > Date.now() + 30000, 'No new cgroup case starts without its admission/cleanup budget')
        const caseWorkEnd = caseEnd - 10000
        const facts = { ...declaration, startedAt: Date.now(), deadlineAt: caseEnd,
          assertionsPassed: false, containmentConclusive: false, ownerCloseObserved: false,
          workDeadlineAt: caseWorkEnd, primaryContainmentObserved: false, fallbackRequired: false,
          protocolComplete: false, terminality: [], observed: [], errors: [], innerFinalObserved: false }
        ledger.cases.push(facts)
        const held = new Map(), identities = new Map()
        let child, birthToken, closed = false, closePromise, scope, killFd, pending = '', bytes = 0, protocolError, original
        const packets = []
        const decoder = new TextDecoder('utf-8', { fatal: true })
        const stages = ['fixture-owner-ready', ...(['setsid-reparent', 'zombie'].includes(declaration.kind)
          ? ['fixture-descendant'] : []), 'fixture-owner-final']
        const hold = async (identity, role) => {
          if (identities.has(identityKey(identity))) return
          const current = await budget(() => readLinuxProcessIdentity(identity.pid), caseWorkEnd, 500, 'Fixture identity recheck')
          if (!current || identityKey(current) !== identityKey(identity) || !liveIdentity(current)) {
            assert.ok(!current || identityKey(current) !== identityKey(identity) || ['Z', 'X', 'x'].includes(current.state))
            identities.set(identityKey(identity), { ...identity, role })
            return
          }
          const token = await openObservedPidfd(identity, { binding, readIdentity: readLinuxProcessIdentity,
            deadlineAt: caseEnd, verifyDeadlineAt: Math.min(caseWorkEnd, Date.now() + 500) })
          held.set(identityKey(identity), token); identities.set(identityKey(identity), { ...current, role })
        }
        const packet = async (stage) => {
          while (!packets.some((value) => value.stage === stage) && !closed && !protocolError) {
            await budget(() => new Promise((done) => setTimeout(done, 10)), caseWorkEnd, 20, 'Fixture packet readiness')
          }
          if (protocolError) throw protocolError
          const found = packets.filter((value) => value.stage === stage)
          assert.equal(found.length, 1); return found[0]
        }
        try {
          assert.ok(Date.now() < caseWorkEnd, 'No fixture birth after work deadline')
          child = spawn(process.execPath, [ownerFile, '--fixture-owner', declaration.kind], { cwd: CI_ROOT,
            env: { ...process.env, APOLLO_PERCEPTION_JOB_DEADLINE_MS: String(caseEnd) }, stdio: ['pipe', 'pipe', 'pipe'] })
          try {
            assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0)
            birthToken = binding.open(child.pid) // SYNCHRONOUS direct birth, before any yield.
            const birth = readAuthorityIdentitySync(child.pid)
            assert.equal(birth.ppid, process.pid); assert.ok(liveIdentity(birth))
            identities.set(identityKey(birth), { ...birth, role: 'owner' })
          } finally {
            closePromise = new Promise((done) => child.once('close', (code, signal) => {
              try {
                pending += decoder.decode(); assert.equal(pending, '', 'Truncated fixture frame at close')
                if (protocolError) throw protocolError
                facts.protocolComplete = true
              } catch (error) { protocolError ??= error }
              closed = true; facts.ownerCloseObserved = true; facts.ownerCode = code; facts.ownerSignal = signal; done()
            }))
            child.once('error', (error) => { protocolError ??= error }); child.stdin.on('error', (error) => { if (!closed) protocolError ??= error })
            child.stderr.on('data', (chunk) => process.stderr.write(chunk))
            child.stdout.on('data', (chunk) => {
              try {
                bytes += chunk.length; assert.ok(bytes <= 1048576); pending += decoder.decode(chunk, { stream: true })
                let separator
                while ((separator = pending.indexOf('\n')) !== -1) {
                  const line = pending.slice(0, separator); pending = pending.slice(separator + 1)
                  const value = JSON.parse(line); assert.equal(value.abi, CGROUP_ABI)
                  assert.equal(value.stage, stages[packets.length], 'Ordered fixed fixture protocol only')
                  if (packets.length) assert.equal(value.runId, packets[0].runId)
                  assert.ok(packets.length < 8); packets.push(value)
                }
              } catch (error) { protocolError ??= error }
            })
          }
          const ready = await packet('fixture-owner-ready')
          assert.equal(ready.fixtureKind, declaration.kind)
          scope = assertCgroupScope(ready.scope); assert.equal(ready.runId, scope.runId)
          facts.scope = scope; facts.ready = ready
          const owner = [...identities.values()].find((value) => value.role === 'owner')
          assert.equal(identityKey(ready.owner), identityKey(owner))
          assert.deepEqual(ready.nodeReady.identity.uids, Array(4).fill(process.getuid()))
          assert.equal(ready.nodeReady.cgroupMembership, scope.membership); assert.equal(ready.nodeReady.killFdInherited, false)
          assert.equal(ready.guardian.credentials.NoNewPrivs, 1)
          for (const field of ['CapEff', 'CapPrm', 'CapInh', 'CapAmb']) assert.equal(BigInt('0x' + ready.guardian.credentials[field]), 0n)
          assert.equal(ready.guardian.parentDeathSignal, 'SIGCONT')
          killFd = openCgroupKill(scope, process.getuid())
          await hold(ready.nodeReady.identity, 'consumer')
          await hold(ready.guardian.identity, 'guardian')
          for (const actor of ready.actors) if (actor.identity) await hold(actor.identity, actor.role)
          // Live root sudo carriers are held/revalidated by identity too. The
          // driver never pretends it can signal UID0 or read its namespace inode.
          assert.equal(parseCgroupMembership(await budget(() => readFile(`/proc/${ready.nodeReady.identity.pid}/cgroup`,
            { encoding: 'utf8', signal: AbortSignal.timeout(500) }), caseWorkEnd, 500, 'Fixture membership read')), scope.membership)
          if (declaration.kind === 'guardian-stop-owner-death') {
            let guardian
            do {
              guardian = await budget(() => readLinuxProcessIdentity(ready.guardian.identity.pid), caseWorkEnd, 500, 'Guardian stop identity')
              assert.equal(identityKey(guardian), identityKey(ready.guardian.identity))
              if (guardian.state === 'T') break
              await budget(() => new Promise((done) => setTimeout(done, 10)), caseWorkEnd, 20, 'Guardian self-stop observation')
            } while (true)
            facts.guardianStopObserved = true
          }
          assert.ok(Date.now() < caseWorkEnd, 'No fixture release after work deadline')
          child.stdin.end('G')
          if (declaration.kind === 'setsid-reparent' || declaration.kind === 'zombie') {
            const descendant = await packet('fixture-descendant')
            assert.equal(descendant.runId, scope.runId); assert.equal(descendant.kind, declaration.kind)
            await hold(descendant.creator, 'creator'); await hold(descendant.victim, 'victim')
            let current
            do {
              current = await budget(() => readLinuxProcessIdentity(descendant.victim.pid), caseWorkEnd, 500, 'Descendant identity read')
              assert.equal(identityKey(current), identityKey(descendant.victim))
              if (declaration.kind === 'zombie' ? current.state === 'Z' : current.ppid !== descendant.creator.pid) break
              await budget(() => new Promise((done) => setTimeout(done, 10)), caseWorkEnd, 20, 'Descendant state observation')
            } while (true)
            facts.descendant = { ...current, procEntryObserved: true }
            if (declaration.kind === 'zombie') {
              const members = await readCgroupSnapshot(scope, caseWorkEnd)
              assert.equal(members.some((value) => value.pid === current.pid), false)
              facts.zombieExcludedFromLiveMembership = true
            } else {
              assert.equal(parseCgroupMembership(await budget(() => readFile(`/proc/${current.pid}/cgroup`,
                { encoding: 'utf8', signal: AbortSignal.timeout(500) }), caseWorkEnd, 500, 'Reparented membership read')), scope.membership)
              facts.reparentedMembershipObserved = true
            }
          }
          if (declaration.expectedFailure) {
            assert.ok(Date.now() < caseWorkEnd, 'No controlled owner signal after work deadline')
            binding.signal(birthToken, 'SIGKILL') // Real launcher/owner host death, own direct-child token.
            await budget(() => closePromise, caseWorkEnd, 5000, 'Controlled owner death close')
            assert.equal(facts.ownerSignal, 'SIGKILL')
            assert.equal(packets.some((value) => value.stage === 'fixture-owner-final'), false)
            facts.innerFinalObserved = false
          } else {
            await budget(() => closePromise, caseWorkEnd, 10000, 'Positive member exit close')
            const final = await packet('fixture-owner-final')
            assert.equal(final.report.success, true); assert.equal(facts.ownerCode, 0); assert.equal(facts.ownerSignal, null)
            assert.deepEqual(final.report.errors, [])
            facts.innerFinalObserved = true
            facts.innerFinalSuccess = final.report.success; facts.innerFinalErrors = final.report.errors
          }
          if (protocolError) throw protocolError
          assert.equal(facts.protocolComplete, true)
          // Prove the owner's/guardian's authority BEFORE any driver fallback.
          // The last 10s of the SAME case budget are reserved for safe cleanup.
          while (true) {
            assert.ok(Date.now() < caseWorkEnd, 'Primary guardian containment was not observed before work deadline')
            const terminality = []
            for (const expected of identities.values()) {
              const current = await budget(() => readLinuxProcessIdentity(expected.pid), caseWorkEnd, 500, 'Primary containment identity')
              terminality.push({ ...expected, terminal: !current || identityKey(current) !== identityKey(expected) || !liveIdentity(current),
                observation: !current ? 'absent' : identityKey(current) !== identityKey(expected) ? 'pid-recycled' : current.state })
            }
            const events = await budget(() => readFile(scope.path + '/cgroup.events',
              { encoding: 'utf8', signal: AbortSignal.timeout(500) }), caseWorkEnd, 500, 'Primary populated evidence')
            assert.ok(Buffer.byteLength(events) <= 65536)
            assert.equal(events.split('\n').filter((line) => line.startsWith('populated ')).length, 1)
            assert.match(events, /^populated [01]$/m)
            const members = await readCgroupSnapshot(scope, caseWorkEnd)
            facts.primaryContainment = { terminality, observedAt: Date.now(),
              empty: { populated: /^populated 0$/m.test(events) ? 0 : 1,
                liveMembershipEmpty: members.length === 0, zombieReapingEstablished: false } }
            if (terminality.every((value) => value.terminal) && facts.primaryContainment.empty.populated === 0 && !members.length) {
              facts.primaryContainmentObserved = true; break
            }
            await budget(() => new Promise((done) => setTimeout(done, 10)), caseWorkEnd, 20, 'Primary containment poll')
          }
        } catch (error) { original = error; facts.errors.push(safeError(error)) }
        finally {
          // Preserve the assertion/protocol error; attempt all known containment
          // even if a previous assertion/archival observation failed.
          facts.fallbackRequired = !facts.primaryContainmentObserved
          if (facts.fallbackRequired) {
            facts.fallbackStartedAt = Date.now()
            original ??= new Error('Primary containment was not established before driver fallback')
            if (killFd !== undefined) { try { writeFileSync(killFd, '1'); facts.fallbackKillFdWritten = true } catch (error) { facts.errors.push(safeError(error)); original ??= error } }
            if (birthToken && !closed) { try { binding.signal(birthToken, 'SIGKILL') } catch (error) { facts.errors.push(safeError(error)); original ??= error } }
            for (const [key, token] of held) {
              if (identities.get(key).role !== 'guardian') continue
              try {
                const expected = identities.get(key)
                const current = await budget(() => readLinuxProcessIdentity(expected.pid), caseEnd, 500, 'Fallback guardian identity')
                if (current && identityKey(current) === key && liveIdentity(current)) token.signal('SIGKILL')
              } catch (error) { facts.errors.push(safeError(error)); original ??= error }
            }
          }
          if (child && !closed) { try { await budget(() => closePromise, caseEnd, 5000, 'Case final owner close') } catch (error) { facts.errors.push(safeError(error)); original ??= error } }
          for (const [key, token] of held) {
            try {
              const expected = identities.get(key)
              let current
              do {
                current = await budget(() => readLinuxProcessIdentity(expected.pid), caseEnd, 500, 'Controller terminality')
                if (!current || identityKey(current) !== key || !liveIdentity(current)) break
                await budget(() => new Promise((done) => setTimeout(done, 10)), caseEnd, 20, 'Controller terminal poll')
              } while (true)
            } catch (error) { facts.errors.push(safeError(error)); original ??= error }
            finally { try { token.close() } catch (error) { facts.errors.push(safeError(error)); original ??= error } }
          }
          for (const expected of identities.values()) {
            try {
              const current = await budget(() => readLinuxProcessIdentity(expected.pid), caseEnd, 500, 'Case final identity')
              const terminal = !current || identityKey(current) !== identityKey(expected) || !liveIdentity(current)
              facts.terminality.push({ ...expected, terminal, observation: !current ? 'absent'
                : identityKey(current) !== identityKey(expected) ? 'pid-recycled' : current.state })
              assert.equal(terminal, true)
            } catch (error) { facts.errors.push(safeError(error)); original ??= error }
          }
          if (scope) {
            try {
              const events = await budget(() => readFile(scope.path + '/cgroup.events', 'utf8'), caseEnd, 500, 'Case populated evidence')
              assert.ok(Buffer.byteLength(events) <= 65536)
              assert.equal(events.split('\n').filter((line) => line.startsWith('populated ')).length, 1)
              assert.match(events, /^populated 0$/m); assert.deepEqual(await readCgroupSnapshot(scope, caseEnd), [])
              facts.empty = { populated: 0, liveMembershipEmpty: true, zombieReapingEstablished: false }
            } catch (error) { facts.errors.push(safeError(error)); original ??= error }
          }
          if (birthToken) { try { binding.close(birthToken) } catch (error) { facts.errors.push(safeError(error)); original ??= error } }
          if (killFd !== undefined) { try { closeSync(killFd) } catch (error) { facts.errors.push(safeError(error)); original ??= error } }
          if (protocolError) { facts.errors.push(safeError(protocolError)); original ??= protocolError }
          facts.observed = [...identities.values()]; ledger.observed.push(...facts.observed)
          facts.containmentConclusive = facts.ownerCloseObserved && facts.empty?.populated === 0 &&
            facts.terminality.length === facts.observed.length && facts.terminality.every((value) => value.terminal)
          facts.assertionsPassed = !original && cgroupControlledCaseAccepted(facts)
          facts.completedAt = Date.now()
        }
        if (original) throw original
        assert.equal(facts.assertionsPassed, true)
      }
    } catch (error) { primary = error; ledger.errors.push(safeError(error)); throw error }
    finally {
      const bytes = Buffer.from(JSON.stringify(ledger, null, 2))
      const path = join(process.env.APOLLO_PERCEPTION_PIDFD_ROOT, 'receipts', `${runId}.cases.json`)
      try {
        assert.ok(Date.now() < end && bytes.length <= 1048576)
        writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 })
        writeFileSync(path.replace(/\.json$/, '.sha256'), digest(bytes), { flag: 'wx', mode: 0o600 })
      } catch (error) {
        process.stderr.write(JSON.stringify({ kind: 'cgroup-case-ledger-write-failed', path, ...safeError(error) }) + '\n')
        if (!primary) throw error
      }
    }
})
