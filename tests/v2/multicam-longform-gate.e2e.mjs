import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

/**
 * F4.016 — the phase gate against a real PostgreSQL.
 *
 * `multicam-longform-gate.test.mjs` proves the domain refuses what it should.
 * It cannot prove any of these, because a fake agrees with whatever the code
 * that wrote it believes:
 *
 * - **The gate approves when the world holds.** The second test writes the
 *   whole world — a synchronised podcast, a teacher-and-screen session, a
 *   session the evidence cannot resolve, a react map compiled into a plan, a
 *   direction cut by both rules, a 120 s synthesis, a match plan inside a
 *   colour plan, the critic's verdict and a promoted MP4 — through the
 *   repositories that own each aggregate, and asserts the REAL reader reaches
 *   10/10. Until this existed the only approved evaluation in the lane came
 *   from a reader double, and eight of the ten readers could have been rubber
 *   stamps.
 * - **Removing one row fails exactly one criterion.** Nine deletions, one per
 *   database-backed criterion, each asserted to move only its own.
 * - **Tampering is caught on the way out, and does not take the gate down.**
 *   Three rows are edited with raw SQL — a shot decision, a media artifact
 *   manifest and a renderable plan snapshot — and each has to reprove exactly
 *   one criterion while the record is still written.
 * - **The CHECK constraints are constraints.** Every one that encodes a domain
 *   invariant is offered a row that violates it.
 * - **The caller supplies nothing.** No evidence, no scope it does not hold,
 *   no workspace it does not belong to.
 */

const RUN = process.env.APOLLO_MULTICAM_GATE_E2E === '1'
const SKIP = RUN ? false : 'set APOLLO_MULTICAM_GATE_E2E=1 with a migrated V2_DATABASE_URL'

const at = (second) =>
  new Date(Date.parse('2029-06-01T10:00:00.000Z') + second * 1_000)
const sha = (character) => character.repeat(64)

/** The actor shape the gate service expects, built by the real factory. */
async function makeActor(clientId, workspaceId, scopes = ['projects:read', 'projects:write']) {
  const { createExternalAuditContext } = await import(
    '../../src/v2/application/authenticate-api-client.ts'
  )
  const auditContext = createExternalAuditContext({
    clientId,
    credentialId: `${clientId}-credential`,
    workspaceId,
    environment: 'sandbox',
  })
  return Object.freeze({
    ...auditContext,
    scopes: new Set(scopes),
    authenticationKind: 'bearer',
    clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active',
    workspaceAccessStatus: 'active',
    auditContext,
  })
}

test(
  'E2E-F4.016 the multicam long-form gate is evaluated, recorded and re-derived from PostgreSQL',
  { skip: SKIP },
  async (t) => {
    const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
    const { PrismaWorkspaceRepository } = await import(
      '../../src/v2/infrastructure/prisma/workspace-repository.ts'
    )
    const { PrismaMulticamDirectionRepository } = await import(
      '../../src/v2/infrastructure/prisma/multicam-direction-repository.ts'
    )
    const { PrismaMulticamLongformGateRepository } = await import(
      '../../src/v2/infrastructure/prisma/multicam-longform-gate-repository.ts'
    )
    const { ModuleGraphLegacyRuntimeAudit } = await import(
      '../../src/v2/infrastructure/audit/module-graph-legacy-runtime-audit.ts'
    )
    const {
      evaluateMulticamLongformGateService,
      explainMulticamLongformGateService,
      listMulticamLongformGatesService,
      readLatestMulticamLongformGateService,
      readMulticamLongformGateService,
    } = await import('../../src/v2/application/multicam-longform-gate.ts')
    const {
      MULTICAM_LONGFORM_CRITERIA,
      MULTICAM_LONGFORM_CRITERION_CHECKS,
    } = await import('../../src/v2/domain/multicam-longform-gate.ts')
    const { buildDirectionWorld } = await import('./wave20-fixtures.mjs')
    const { cleanGateWorld } = await import('./helpers/multicam-longform-gate-world.mjs')

    const client = new PrismaClient()
    const A = 'f4016-workspace-a'
    const B = 'f4016-workspace-b'
    const PROJECT_A = 'f4016-project-a'
    const PROJECT_B = 'f4016-project-b'
    const SESSION = 'f4016-session'
    const CLIENT_A = 'f4016-client-a'
    const CLIENT_B = 'f4016-client-b'
    const VERSION_A = 'f4016-version-a'
    const CHECK_TOTAL = MULTICAM_LONGFORM_CRITERIA.reduce(
      (total, criterion) =>
        total + MULTICAM_LONGFORM_CRITERION_CHECKS[criterion].length,
      0,
    )

    const clean = () => cleanGateWorld({ client, workspaceIds: [A, B] })

    t.after(async () => {
      // Reported, not rethrown: a cleanup failure that masks the assertion
      // turns one clear defect into two confusing ones.
      try {
        await clean()
      } catch (error) {
        console.error('cleanup failed:', error?.message ?? error)
      } finally {
        // The factory-built runtime below opens the process-wide client, which
        // is not this test's own: both have to be given back.
        const { disconnectV2PostgresClient } = await import(
          '../../src/v2/infrastructure/prisma-postgres/client.ts'
        )
        await disconnectV2PostgresClient()
        await client.$disconnect()
      }
    })

    await clean()

    const workspaces = new PrismaWorkspaceRepository(client)
    for (const id of [A, B]) {
      await workspaces.create(
        createWorkspace({
          id,
          slug: id,
          name: 'F4.016 gate',
          status: 'active',
          createdAt: at(0).toISOString(),
        }),
      )
    }
    for (const [id, workspaceId] of [[CLIENT_A, A], [CLIENT_B, B]]) {
      await client.v2ApiClient.create({
        data: {
          id,
          workspaceId,
          name: 'F4.016 gate client',
          allowedEnvironmentsJson: JSON.stringify(['sandbox']),
          scopeGrantsJson: JSON.stringify(['projects:read', 'projects:write']),
          createdBy: 'f4016-operator',
          createdAt: at(0),
          updatedAt: at(0),
        },
      })
    }
    for (const [id, workspaceId, createdById] of [
      [PROJECT_A, A, CLIENT_A],
      [PROJECT_B, B, CLIENT_B],
    ]) {
      await client.v2Project.create({
        data: {
          id,
          workspaceId,
          name: 'F4.016 gate',
          status: 'reviewing-proxy',
          objective: 'discovery',
          format: '16:9',
          locale: 'pt-BR',
          createdByType: 'api-client',
          createdById,
          createdAt: at(0),
          updatedAt: at(0),
        },
      })
    }
    for (const kind of ['brief', 'edit-plan', 'policies']) {
      await client.v2ProjectSnapshot.create({
        data: {
          id: `f4016-snapshot-${kind}`,
          workspaceId: A,
          projectId: PROJECT_A,
          kind,
          schemaVersion: 1,
          contentJson: JSON.stringify({ kind }),
          contentHash: sha('1'),
          createdAt: at(0),
        },
      })
    }
    await client.v2ProjectVersion.create({
      data: {
        id: VERSION_A,
        workspaceId: A,
        projectId: PROJECT_A,
        sequence: 1,
        briefSnapshotId: 'f4016-snapshot-brief',
        editPlanSnapshotId: 'f4016-snapshot-edit-plan',
        policiesSnapshotId: 'f4016-snapshot-policies',
        baseHash: sha('2'),
        createdBy: CLIENT_A,
        createdAt: at(0),
      },
    })
    await client.v2Project.update({
      where: { id: PROJECT_A },
      data: { currentVersionId: VERSION_A },
    })

    const repository = new PrismaMulticamLongformGateRepository(client)
    const legacyAudit = new ModuleGraphLegacyRuntimeAudit({ clock: () => at(0) })
    let issued = 0
    const evaluate = evaluateMulticamLongformGateService({
      repository,
      legacyAudit,
      clock: () => at(100),
      createId: () => `f4016-gate-${(issued += 1)}`,
    })
    const actorA = await makeActor(CLIENT_A, A)
    const run = async (key, overrides = {}) =>
      evaluate({
        workspaceId: A,
        projectId: PROJECT_A,
        actor: actorA,
        idempotencyKey: key,
        ...overrides,
      })
    const criterionOf = (gate, name) =>
      gate.report.criteria.find((item) => item.criterion === name)

    // -----------------------------------------------------------------------
    // A project with nothing in it: every criterion is still visible.
    // -----------------------------------------------------------------------
    const empty = await run('f4016-key-empty')
    assert.equal(empty.replayed, false)
    assert.equal(empty.gate.report.approved, false)
    assert.equal(empty.gate.report.total, 10)
    assert.equal(
      empty.gate.report.criteria.length,
      10,
      'a criterion with no rows vanished from the report',
    )
    // Criterion 10 is answered by the module graph, not by a table, so it is
    // the one criterion an empty project can satisfy.
    assert.equal(
      criterionOf(empty.gate, 'no-legacy-runtime-dependency').passed,
      true,
      'the module-graph scan did not run against the real tree',
    )
    assert.equal(empty.gate.report.satisfied, 1)
    assert.equal(empty.gate.report.evaluated, 1)
    assert.equal(
      empty.gate.sessionId,
      null,
      'a project with no capture session named one anyway',
    )
    for (const criterion of MULTICAM_LONGFORM_CRITERIA) {
      if (criterion === 'no-legacy-runtime-dependency') continue
      const item = criterionOf(empty.gate, criterion)
      assert.equal(item.passed, false, `${criterion} passed on an empty project`)
      assert.ok(
        item.checks.every((check) => check.failureReason === 'evidence-missing'),
        `${criterion} blamed something other than missing evidence`,
      )
    }

    const criterionRows = await client.v2MulticamLongformGateCriterion.findMany({
      where: { workspaceId: A, gateId: empty.gate.id },
      orderBy: { ordinal: 'asc' },
    })
    const checkRows = await client.v2MulticamLongformGateCheck.findMany({
      where: { workspaceId: A, gateId: empty.gate.id },
    })
    const evidenceRows = await client.v2MulticamLongformGateEvidence.findMany({
      where: { workspaceId: A, gateId: empty.gate.id },
    })
    assert.equal(criterionRows.length, 10, 'the criteria were not written as rows')
    assert.deepEqual(
      criterionRows.map((row) => row.criterion),
      [...MULTICAM_LONGFORM_CRITERIA],
      'the criterion rows are not in catalogue order',
    )
    assert.equal(checkRows.length, CHECK_TOTAL, 'a check went unrecorded')
    assert.equal(
      evidenceRows.length,
      3,
      'the only evidence an empty project has is the module-graph scan',
    )
    assert.ok(
      evidenceRows.every((row) => row.resourceType === 'module-graph-audit' && row.verified),
      'the module-graph reference was recorded unverified',
    )
    console.log(
      `[E2E-F4.016] empty project: ${criterionRows.length} criteria, ` +
      `${checkRows.length} checks, ${evidenceRows.length} evidence rows, ` +
      `satisfied ${empty.gate.report.satisfied}/10`,
    )

    // -----------------------------------------------------------------------
    // A real aggregate: the direction criterion starts answering.
    // -----------------------------------------------------------------------
    await client.v2CaptureSessionHead.create({
      data: {
        id: SESSION,
        workspaceId: A,
        projectId: PROJECT_A,
        sessionId: SESSION,
        version: 1,
        sessionHash: sha('3'),
        status: 'synced',
        createdAt: at(0),
        updatedAt: at(0),
      },
    })
    const world = buildDirectionWorld({
      workspaceId: A,
      sessionId: SESSION,
      projectId: PROJECT_A,
    })
    const directions = new PrismaMulticamDirectionRepository(client)
    await directions.persistEvidenceSet({ set: world.evidence, createdAt: at(1) })
    await directions.appendVersion({
      direction: world.direction,
      base: null,
      occurredAt: at(2),
    })

    const directed = await run('f4016-key-directed')
    const directedCriterion = criterionOf(
      directed.gate,
      'active-speaker-and-demonstration-directed',
    )
    assert.ok(
      directedCriterion.missingCheckCount < directedCriterion.checkCount,
      'the direction criterion still reads as never evaluated',
    )
    assert.equal(directed.gate.report.evaluated, 2)
    assert.equal(
      directed.gate.sessionId,
      SESSION,
      'the record does not name the session its criteria were read against',
    )
    assert.match(
      directedCriterion.checks[0].detail,
      /direction v1 of session/,
      'the recorded detail does not name what it read',
    )
    const directionEvidence = await client.v2MulticamLongformGateEvidence.findMany({
      where: { workspaceId: A, gateId: directed.gate.id, criterion: 'active-speaker-and-demonstration-directed' },
    })
    assert.ok(
      directionEvidence.some(
        (row) => row.resourceType === 'multicam-direction' && row.verified && row.resourceHash,
      ),
      'the direction was cited without a verified hash',
    )
    console.log(
      `[E2E-F4.016] directed: ${directionEvidence.length} evidence rows, ` +
      `${directedCriterion.failedCheckCount}/${directedCriterion.checkCount} checks refused, ` +
      `detail "${directedCriterion.checks[0].detail.slice(0, 80)}"`,
    )

    // -----------------------------------------------------------------------
    // Tampering: a shot's justification is rewritten under the product.
    // -----------------------------------------------------------------------
    const shot = await client.v2MulticamShotDecision.findFirst({
      where: { workspaceId: A },
      orderBy: { ordinal: 'asc' },
    })
    assert.ok(shot, 'the fixture wrote no shot to tamper with')
    await client.$executeRawUnsafe(
      'UPDATE "multicam_shot_decisions" SET "reason" = $1 WHERE "id" = $2',
      'edited underneath the product',
      shot.id,
    )
    const tampered = await run('f4016-key-tampered')
    const tamperedCriterion = criterionOf(
      tampered.gate,
      'active-speaker-and-demonstration-directed',
    )
    assert.equal(tamperedCriterion.passed, false)
    assert.ok(
      tamperedCriterion.checks.every(
        (check) => check.failureReason === 'evidence-unverified',
      ),
      'a rewritten shot did not reprove the criterion as unverified',
    )
    assert.ok(
      tamperedCriterion.unverifiedReferenceCount >= 1,
      'the unverified reference was not counted',
    )
    assert.equal(
      criterionOf(tampered.gate, 'no-legacy-runtime-dependency').passed,
      true,
      'one tampered row took an unrelated criterion down with it',
    )
    assert.equal(tampered.gate.report.approved, false)

    // -----------------------------------------------------------------------
    // Deleting a row is a different answer from editing one.
    // -----------------------------------------------------------------------
    await client.v2MulticamDirectionHead.deleteMany({ where: { workspaceId: A } })
    const deleted = await run('f4016-key-deleted')
    const deletedCriterion = criterionOf(
      deleted.gate,
      'active-speaker-and-demonstration-directed',
    )
    assert.ok(
      deletedCriterion.checks.every(
        (check) => check.failureReason === 'evidence-missing',
      ),
      'a deleted head was reported as tampering rather than as absence',
    )
    assert.equal(deletedCriterion.missingCheckCount, deletedCriterion.checkCount)
    assert.equal(deleted.gate.report.evaluated, 1)

    // -----------------------------------------------------------------------
    // Replay and replica.
    // -----------------------------------------------------------------------
    const replayed = await run('f4016-key-deleted')
    assert.equal(replayed.replayed, true, 'the same key did the work twice')
    assert.equal(replayed.gate.id, deleted.gate.id)
    assert.equal(replayed.gate.recordHash, deleted.gate.recordHash)

    const replica = await run('f4016-key-replica')
    assert.equal(replica.replayed, false)
    assert.notEqual(replica.gate.id, deleted.gate.id)
    assert.equal(
      replica.gate.reportFingerprint,
      deleted.gate.reportFingerprint,
      'the same rows evaluated twice produced two different reports',
    )
    assert.notEqual(
      replica.gate.recordHash,
      deleted.gate.recordHash,
      'two records with different ids collapsed to one hash',
    )

    await assert.rejects(
      run('f4016-key-replica', { sessionId: SESSION }),
      (error) => {
        assert.equal(error.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH')
        return true
      },
      'one key answered two different requests',
    )

    // A session this project does not have resolves to nothing, rather than
    // being echoed back into a record that then names a session nobody found.
    const absent = await run('f4016-key-absent-session', {
      sessionId: 'f4016-session-that-does-not-exist',
    })
    assert.equal(absent.gate.sessionId, null)
    const absentRow = await client.v2MulticamLongformGate.findUnique({
      where: { id: absent.gate.id },
    })
    assert.equal(absentRow.sessionId, null)

    // -----------------------------------------------------------------------
    // History, isolation and the read services.
    // -----------------------------------------------------------------------
    const read = readMulticamLongformGateService({ repository })
    const readLatest = readLatestMulticamLongformGateService({ repository })
    const list = listMulticamLongformGatesService({ repository })
    const explain = explainMulticamLongformGateService({ repository })

    const firstAgain = await read({
      workspaceId: A,
      projectId: PROJECT_A,
      gateId: empty.gate.id,
    })
    assert.equal(
      firstAgain.reportFingerprint,
      empty.gate.reportFingerprint,
      'the first evaluation was rewritten by a later one',
    )
    assert.equal(firstAgain.report.evaluated, 1)
    const history = await list({ workspaceId: A, projectId: PROJECT_A })
    assert.equal(history.length, 6, 'the history lost or duplicated an evaluation')
    assert.equal(
      new Set(history.map((gate) => gate.id)).size,
      6,
      'the history returned one record twice',
    )
    const latest = await readLatest({ workspaceId: A, projectId: PROJECT_A })
    assert.equal(latest.id, history[0].id)

    const explanation = await explain({ workspaceId: A, projectId: PROJECT_A })
    assert.equal(explanation.approved, false)
    assert.equal(explanation.outstanding.length, 9)
    assert.ok(
      explanation.outstanding.every((item) => item.statement.length >= 40),
      'the explanation cannot tell an operator what is missing',
    )

    await assert.rejects(
      read({ workspaceId: B, projectId: PROJECT_B, gateId: empty.gate.id }),
      (error) => {
        assert.equal(error.code, 'MULTICAM_LONGFORM_GATE_NOT_FOUND')
        return true
      },
      'workspace B read workspace A gate by id',
    )
    assert.deepEqual(
      [...(await list({ workspaceId: B, projectId: PROJECT_B }))],
      [],
      'workspace B listed workspace A history',
    )
    await assert.rejects(
      readLatest({ workspaceId: B, projectId: PROJECT_B }),
      (error) => {
        assert.equal(error.code, 'MULTICAM_LONGFORM_GATE_NOT_FOUND')
        return true
      },
    )

    // -----------------------------------------------------------------------
    // The record's own columns, edited under the product.
    // -----------------------------------------------------------------------
    await client.$executeRawUnsafe(
      'UPDATE "multicam_longform_gates" SET "reportJson" = replace("reportJson", $1, $2) WHERE "id" = $3',
      'no multicam direction exists for this project',
      'a multicam direction exists for this project',
      replica.gate.id,
    )
    await assert.rejects(
      read({ workspaceId: A, projectId: PROJECT_A, gateId: replica.gate.id }),
      (error) => {
        assert.equal(error.code, 'PERSISTENCE_CONFLICT')
        return true
      },
      'an edited gate report was handed back as if it had been evaluated',
    )

    // `evaluatedAt` is the ordering key of readLatest and list. It is not
    // inside the hashed record, so nothing but the hydrate cross-check ties it
    // to the report whose fingerprint was signed: without that, moving one
    // column silently changes which evaluation the product calls the latest.
    await client.$executeRawUnsafe(
      'UPDATE "multicam_longform_gates" SET "evaluatedAt" = $1 WHERE "id" = $2',
      at(9_000),
      empty.gate.id,
    )
    await assert.rejects(
      read({ workspaceId: A, projectId: PROJECT_A, gateId: empty.gate.id }),
      (error) => {
        assert.equal(error.code, 'PERSISTENCE_CONFLICT')
        return true
      },
      'a record whose evaluation instant was moved came back as if it had not been',
    )

    // -----------------------------------------------------------------------
    // The assembled runtime exposes the scanner its evaluation uses.
    // -----------------------------------------------------------------------
    // Two instances were built, and the one on `legacyAudit` was not the one
    // `evaluate` read — so a caller that configured it changed nothing, and
    // every evaluation walked the 113-module graph from disk twice. Identity
    // is the assertion: the exposed object is patched, and the evaluation has
    // to see the patch.
    const { createMulticamLongformGateRuntime } = await import(
      '../../src/v2/infrastructure/repository-factory.ts'
    )
    const runtime = createMulticamLongformGateRuntime(() => at(150))
    let scans = 0
    const realAudit = runtime.legacyAudit.audit.bind(runtime.legacyAudit)
    runtime.legacyAudit.audit = async () => {
      scans += 1
      const audit = await realAudit()
      // A scan that reached nothing: `module-graph-scanned` has to say so.
      return Object.freeze({ ...audit, entryModules: [...audit.entryModules, 'nowhere.ts'] })
    }
    const scanned = await runtime.evaluate({
      workspaceId: A,
      projectId: PROJECT_A,
      actor: actorA,
      idempotencyKey: 'f4016-key-runtime',
    })
    assert.equal(scans, 1, 'the runtime evaluated with a scanner it did not expose')
    assert.equal(
      criterionOf(scanned.gate, 'no-legacy-runtime-dependency').checks
        .every((check) => check.failureReason === 'evidence-unverified'),
      true,
      'the patched scan was not the one the evaluation read',
    )

    // -----------------------------------------------------------------------
    // The CHECK constraints, offered rows they must refuse.
    // -----------------------------------------------------------------------
    let refusals = 0
    const refused = async (constraint, write) => {
      let caught = null
      try {
        await write()
      } catch (error) {
        caught = error
      }
      assert.notEqual(caught, null, `${constraint} accepted a row it must refuse`)
      assert.match(
        String(caught?.message ?? ''),
        new RegExp(constraint),
        `the row was refused, but not by ${constraint}`,
      )
      refusals += 1
    }
    const gateRow = await client.v2MulticamLongformGate.findUnique({
      where: { id: deleted.gate.id },
    })
    const criterionRow = await client.v2MulticamLongformGateCriterion.findFirst({
      where: { workspaceId: A, gateId: deleted.gate.id },
    })
    const checkRow = await client.v2MulticamLongformGateCheck.findFirst({
      where: { workspaceId: A, gateId: deleted.gate.id },
    })

    await refused('multicam_longform_gates_result_check', () =>
      client.v2MulticamLongformGate.create({
        data: { ...gateRow, id: 'f4016-forged-approval', recordHash: sha('5'), idempotencyKey: 'f4016-forged-1', approved: true },
      }))
    await refused('multicam_longform_gates_result_check', () =>
      client.v2MulticamLongformGate.create({
        data: { ...gateRow, id: 'f4016-forged-count', recordHash: sha('6'), idempotencyKey: 'f4016-forged-2', satisfied: 11, evaluated: 11 },
      }))
    await refused('multicam_longform_gates_schema_check', () =>
      client.v2MulticamLongformGate.create({
        data: { ...gateRow, id: 'f4016-forged-schema', recordHash: sha('7'), idempotencyKey: 'f4016-forged-3', gate: 'some-other-gate/v1' },
      }))
    await refused('multicam_longform_gates_actor_check', () =>
      client.v2MulticamLongformGate.create({
        data: { ...gateRow, id: 'f4016-forged-actor', recordHash: sha('8'), idempotencyKey: 'f4016-forged-4', actorAuthenticationKind: 'ui-session' },
      }))
    await refused('multicam_longform_gate_criteria_criterion_check', () =>
      client.v2MulticamLongformGateCriterion.create({
        data: { ...criterionRow, id: 'f4016-forged-criterion', criterion: 'invented-criterion', ordinal: 9 },
      }))
    await refused('multicam_longform_gate_criteria_counts_check', () =>
      client.v2MulticamLongformGateCriterion.create({
        data: { ...criterionRow, id: 'f4016-forged-counts', ordinal: 9, passed: true, failedCheckCount: 1, missingCheckCount: 1 },
      }))
    await refused('multicam_longform_gate_criteria_counts_check', () =>
      client.v2MulticamLongformGateCriterion.create({
        data: { ...criterionRow, id: 'f4016-forged-unverified', ordinal: 9, passed: true, failedCheckCount: 0, missingCheckCount: 0, unverifiedReferenceCount: 2 },
      }))
    await refused('multicam_longform_gate_checks_code_check', () =>
      client.v2MulticamLongformGateCheck.create({
        data: { ...checkRow, id: 'f4016-forged-code', checkCode: 'invented-check', ordinal: 7 },
      }))
    await refused('multicam_longform_gate_checks_reason_check', () =>
      client.v2MulticamLongformGateCheck.create({
        data: { ...checkRow, id: 'f4016-forged-reason', ordinal: 7, passed: false, failureReason: null },
      }))
    await refused('multicam_longform_gate_checks_evidence_check', () =>
      client.v2MulticamLongformGateCheck.create({
        data: { ...checkRow, id: 'f4016-forged-pass', ordinal: 7, passed: true, failureReason: null, referenceCount: 2, unverifiedReferenceCount: 1 },
      }))
    await refused('multicam_longform_gate_checks_evidence_check', () =>
      client.v2MulticamLongformGateCheck.create({
        data: { ...checkRow, id: 'f4016-forged-blind', ordinal: 7, passed: false, failureReason: 'requirement-unmet', referenceCount: 0, unverifiedReferenceCount: 0 },
      }))
    // The two reference counts are disjoint: a row cannot claim more cited
    // references than it has.
    await refused('multicam_longform_gate_checks_evidence_check', () =>
      client.v2MulticamLongformGateCheck.create({
        data: { ...checkRow, id: 'f4016-forged-overlap', ordinal: 7, passed: false, failureReason: 'requirement-unmet', referenceCount: 1, unverifiedReferenceCount: 1, unhashedReferenceCount: 1 },
      }))
    await refused('multicam_longform_gate_evidence_hash_check', () =>
      client.v2MulticamLongformGateEvidence.create({
        data: {
          id: 'f4016-forged-evidence',
          workspaceId: A,
          checkRowId: checkRow.id,
          gateId: deleted.gate.id,
          criterion: checkRow.criterion,
          checkCode: checkRow.checkCode,
          ordinal: 15,
          resourceType: 'project',
          resourceId: PROJECT_A,
          resourceHash: null,
          verified: true,
        },
      }))
    await refused('multicam_longform_gate_evidence_resource_check', () =>
      client.v2MulticamLongformGateEvidence.create({
        data: {
          id: 'f4016-forged-resource',
          workspaceId: A,
          checkRowId: checkRow.id,
          gateId: deleted.gate.id,
          criterion: checkRow.criterion,
          checkCode: checkRow.checkCode,
          ordinal: 14,
          resourceType: 'legacy-table',
          resourceId: PROJECT_A,
          resourceHash: sha('9'),
          verified: true,
        },
      }))

    // A child pointing at a parent in another workspace is refused by the
    // composite key, not by whoever remembered to filter.
    await refused('foreign key|Foreign key|constraint', () =>
      client.v2MulticamLongformGateCriterion.create({
        data: { ...criterionRow, id: 'f4016-forged-cross', workspaceId: B, ordinal: 9 },
      }))

    // Cascade: deleting the record takes its criteria, checks and evidence.
    await client.v2MulticamLongformGate.delete({ where: { id: empty.gate.id } })
    assert.equal(
      await client.v2MulticamLongformGateCheck.count({ where: { gateId: empty.gate.id } }),
      0,
      'the checks outlived the record they belong to',
    )
    assert.equal(
      await client.v2MulticamLongformGateEvidence.count({ where: { gateId: empty.gate.id } }),
      0,
      'the evidence rows outlived the record they belong to',
    )

    console.log(`[E2E-F4.016] ${refusals} constraint refusals measured`)
    assert.equal(refusals, 15)
  },
)

test(
  'E2E-F4.016 the real reader approves a complete world, and one missing row fails one criterion',
  { skip: SKIP },
  async (t) => {
    const { PrismaMulticamLongformGateRepository } = await import(
      '../../src/v2/infrastructure/prisma/multicam-longform-gate-repository.ts'
    )
    const { ModuleGraphLegacyRuntimeAudit } = await import(
      '../../src/v2/infrastructure/audit/module-graph-legacy-runtime-audit.ts'
    )
    const {
      evaluateMulticamLongformGateService,
      readMulticamLongformGateService,
    } = await import('../../src/v2/application/multicam-longform-gate.ts')
    const { MULTICAM_LONGFORM_CRITERIA } = await import(
      '../../src/v2/domain/multicam-longform-gate.ts'
    )
    const { buildGateWorld, cleanGateWorld } = await import(
      './helpers/multicam-longform-gate-world.mjs'
    )

    const client = new PrismaClient()
    const W = 'f4016-workspace-c'
    const OTHER = 'f4016-workspace-d'
    const PROJECT = 'f4016-project-c'
    const OTHER_PROJECT = 'f4016-project-d'
    const VERSION = 'f4016-version-c'
    const CLIENT = 'f4016-client-c'
    const OTHER_CLIENT = 'f4016-client-d'

    let world = null
    t.after(async () => {
      try {
        // Through the world when it exists, because only it knows which
        // catalogue rows it published; through the bare cleaner otherwise.
        await (world
          ? world.clean()
          : cleanGateWorld({ client, workspaceIds: [W, OTHER] }))
      } catch (error) {
        console.error('cleanup failed:', error?.message ?? error)
      } finally {
        await client.$disconnect()
      }
    })

    world = await buildGateWorld({
      client,
      workspaceId: W,
      projectId: PROJECT,
      versionId: VERSION,
      clientId: CLIENT,
      otherWorkspaceId: OTHER,
      otherProjectId: OTHER_PROJECT,
      otherClientId: OTHER_CLIENT,
    })

    const repository = new PrismaMulticamLongformGateRepository(client)
    const legacyAudit = new ModuleGraphLegacyRuntimeAudit({ clock: () => at(0) })
    let issued = 0
    const evaluate = evaluateMulticamLongformGateService({
      repository,
      legacyAudit,
      // Fixed on purpose: two evaluations of one unchanged world must produce
      // the same report, and a clock that moves would hide a difference the
      // evidence caused behind one the timestamp caused.
      clock: () => at(200),
      createId: () => `f4016-world-gate-${(issued += 1)}`,
    })
    const actor = await makeActor(CLIENT, W)
    const run = (key, overrides = {}) =>
      evaluate({ workspaceId: W, projectId: PROJECT, actor, idempotencyKey: key, ...overrides })
    const criterionOf = (gate, name) =>
      gate.report.criteria.find((item) => item.criterion === name)
    const failing = (gate) =>
      gate.report.criteria.filter((item) => !item.passed).map((item) => item.criterion)

    // -----------------------------------------------------------------------
    // Every condition holds: the gate approves, on evidence it read itself.
    // -----------------------------------------------------------------------
    const approved = await run('f4016-world-key-approved')
    assert.deepEqual(
      failing(approved.gate),
      [],
      'a criterion the fixture satisfies was reported unmet',
    )
    assert.equal(approved.gate.report.approved, true)
    assert.equal(approved.gate.report.satisfied, 10)
    assert.equal(approved.gate.report.evaluated, 10)
    assert.equal(approved.gate.report.blocking.length, 0)
    assert.equal(approved.gate.projectVersionId, VERSION)
    assert.ok(
      approved.gate.sessionId &&
        (await client.v2CaptureSessionHead.count({
          where: { workspaceId: W, sessionId: approved.gate.sessionId },
        })) === 1,
      'the record names a session the reader never found',
    )
    console.log(
      `[E2E-F4.016] complete world: satisfied ${approved.gate.report.satisfied}/10 ` +
      `from the real reader, session ${approved.gate.sessionId}, ` +
      `fingerprint ${approved.gate.reportFingerprint.slice(0, 12)}`,
    )

    // Criteria 1 and 2 are two conditions, not one row seen twice. The podcast
    // criterion must cite the podcast evaluation and the teacher criterion the
    // teacher one, over two different sessions.
    const evidenceFor = async (criterion, checkCode) =>
      client.v2MulticamLongformGateEvidence.findMany({
        where: { workspaceId: W, gateId: approved.gate.id, criterion, checkCode },
        orderBy: { ordinal: 'asc' },
      })
    const podcastCitations = await evidenceFor(
      'podcast-multicam-synchronised',
      'podcast-protocol-evaluated',
    )
    const teacherCitations = await evidenceFor(
      'teacher-and-screen-synchronised',
      'teacher-protocol-evaluated',
    )
    const evaluationOf = (rows) =>
      rows.find((row) => row.resourceType === 'capture-protocol-evaluation')?.resourceId
    assert.match(evaluationOf(podcastCitations), /^f4016-session-podcast:podcast-v1:/)
    assert.match(evaluationOf(teacherCitations), /^f4016-session-teacher:teacher-and-screen-v1:/)
    assert.notEqual(
      evaluationOf(podcastCitations),
      evaluationOf(teacherCitations),
      'one protocol evaluation answered two independent conditions',
    )
    assert.match(
      criterionOf(approved.gate, 'podcast-multicam-synchronised').checks[0].detail,
      /\(podcast\)/,
    )

    // `protocol-ceiling-blocks-auto-edit` asks the domain authority rather than
    // re-deriving one of its six grounds from the evaluation row: a diagnostic
    // canAutoEdit refuses for confidence or contradictory anchors was reported
    // as "not blocked" by the copy that only looked at the ceiling.
    const ceilingDetail = criterionOf(
      approved.gate,
      'insufficient-evidence-requires-manual',
    ).checks.find((item) => item.code === 'protocol-ceiling-blocks-auto-edit').detail
    assert.match(ceilingDetail, /canAutoEdit allowed=false/)
    assert.match(
      ceilingDetail,
      /manual input is required/,
      'the check reports the ceiling but not the other grounds canAutoEdit found',
    )

    // A pass may cite a row that stores no hash — a media artifact nobody
    // downloaded, a playback piece its map already covers — and the record has
    // to be storable. Counting those as tampering is what made four criteria
    // impossible to record as satisfied.
    const artifactCitation = await client.v2MulticamLongformGateEvidence.findFirst({
      where: {
        workspaceId: W,
        gateId: approved.gate.id,
        checkCode: 'final-export-promoted',
        resourceType: 'media-artifact',
      },
    })
    assert.ok(artifactCitation, 'the promoted export cited no artifact')
    assert.equal(artifactCitation.resourceHash, null)
    assert.equal(artifactCitation.verified, false)
    const finalCheckRow = await client.v2MulticamLongformGateCheck.findFirstOrThrow({
      where: { workspaceId: W, gateId: approved.gate.id, checkCode: 'final-export-promoted' },
    })
    assert.equal(finalCheckRow.passed, true)
    assert.equal(finalCheckRow.unverifiedReferenceCount, 0)
    assert.ok(
      finalCheckRow.unhashedReferenceCount >= 1,
      'a reference with no stored hash was not counted as one',
    )

    // -----------------------------------------------------------------------
    // The caller supplies no evidence, no scope and no workspace.
    // -----------------------------------------------------------------------
    const injected = await run('f4016-world-key-injected', {
      evidence: MULTICAM_LONGFORM_CRITERIA.map((criterion) => ({
        criterion,
        checks: [],
      })),
    })
    assert.equal(
      injected.gate.reportFingerprint,
      approved.gate.reportFingerprint,
      'a request carrying evidence produced a different report',
    )
    await assert.rejects(
      evaluate({
        workspaceId: W,
        projectId: PROJECT,
        actor: await makeActor(CLIENT, W, ['projects:read']),
        idempotencyKey: 'f4016-world-key-readonly',
      }),
      (error) => {
        assert.equal(error.code, 'AUTH_SCOPE_REQUIRED')
        return true
      },
      'an actor holding only projects:read evaluated the gate',
    )
    await assert.rejects(
      evaluate({
        workspaceId: W,
        projectId: PROJECT,
        actor: await makeActor(OTHER_CLIENT, OTHER),
        idempotencyKey: 'f4016-world-key-foreign',
      }),
      (error) => {
        assert.equal(error.code, 'AUTH_INVALID')
        return true
      },
      'an actor of another workspace evaluated this one',
    )

    // -----------------------------------------------------------------------
    // Three rows edited under the product. Each reproves ONE criterion, and
    // the record is still written — a reader that throws leaves no record at
    // all, which is the failure this gate exists to prevent.
    // -----------------------------------------------------------------------
    const tamper = async ({ label, criterion, checkCode, intact, apply, restore }) => {
      await apply()
      const result = await run(`f4016-world-key-${label}`)
      assert.deepEqual(
        failing(result.gate),
        [criterion],
        `${label}: tampering moved something other than ${criterion}`,
      )
      const moved = criterionOf(result.gate, criterion)
      const check = moved.checks.find((item) => item.code === checkCode)
      assert.equal(
        check.failureReason,
        'evidence-unverified',
        `${label}: the edited row was not reported as unverified`,
      )
      // The edited row reproves the check that READ it. A criterion whose
      // every check comes back unverified is a reader that gave up on the
      // aggregate, which is a different — and weaker — answer.
      for (const code of intact ?? []) {
        assert.equal(
          moved.checks.find((item) => item.code === code)?.passed,
          true,
          `${label}: ${code} was dragged down by a row it does not read`,
        )
      }
      const stored = await client.v2MulticamLongformGate.findUnique({
        where: { id: result.gate.id },
      })
      assert.ok(stored, `${label}: no gate record was written at all`)
      await restore()
      return result
    }

    // A manifest edited underneath the product used to make the WHOLE
    // evaluation throw INVALID_ARGUMENT: `artifact-hash-matches-attempt` passed
    // while citing the manifest's hash, which the domain refuses.
    const manifestId = `manifest-${world.exportIds.outputArtifact}`
    const manifestBefore = await client.v2MediaArtifactManifest.findUniqueOrThrow({
      where: { id: manifestId },
    })
    const manifestTampered = await tamper({
      label: 'manifest',
      criterion: 'final-mp4-inspectable',
      checkCode: 'output-probe-measured',
      intact: ['final-export-promoted', 'output-codec-recorded', 'artifact-hash-matches-attempt'],
      apply: () => client.$executeRawUnsafe(
        'UPDATE "media_artifact_manifests" SET "manifestJson" = replace("manifestJson", $1, $2) WHERE "id" = $3',
        '"duration":120',
        '"duration":121',
        manifestId,
      ),
      restore: () => client.$executeRawUnsafe(
        'UPDATE "media_artifact_manifests" SET "manifestJson" = $1 WHERE "id" = $2',
        manifestBefore.manifestJson,
        manifestId,
      ),
    })
    const artifactCheck = criterionOf(manifestTampered.gate, 'final-mp4-inspectable')
      .checks.find((item) => item.code === 'artifact-hash-matches-attempt')
    assert.equal(
      artifactCheck.passed,
      true,
      'the artifact comparison was dragged down by the manifest it does not read',
    )

    // A renderable plan snapshot whose stored hash no longer recomputes. The
    // read that finds it sits outside the criterion's own try/catch, so before
    // the fix this threw out of readEvidence and no record was written.
    const snapshotRow = await client.v2RenderablePlanSnapshot.findFirstOrThrow({
      where: { workspaceId: W, origin: 'react-playback' },
    })
    await tamper({
      label: 'snapshot',
      criterion: 'react-edited-with-piecewise-map',
      checkCode: 'map-compiled-into-plan',
      // The three checks that never look at the plan still answer. Guarding
      // the whole criterion instead of the read would leave all four
      // unverified — true, but it would stop saying the map itself is fine.
      intact: ['playback-map-persisted', 'interrupted-piece-present', 'reaction-duration-differs'],
      apply: () => client.$executeRawUnsafe(
        'UPDATE "renderable_plan_snapshots" SET "planHash" = $1 WHERE "id" = $2',
        sha('b'),
        snapshotRow.id,
      ),
      restore: () => client.$executeRawUnsafe(
        'UPDATE "renderable_plan_snapshots" SET "planHash" = $1 WHERE "id" = $2',
        snapshotRow.planHash,
        snapshotRow.id,
      ),
    })

    // And the case the lane already covered, now against a world where every
    // other criterion holds: only the direction moves.
    const shot = await client.v2MulticamShotDecision.findFirstOrThrow({
      where: { workspaceId: W },
      orderBy: { ordinal: 'asc' },
    })
    await tamper({
      label: 'shot',
      criterion: 'active-speaker-and-demonstration-directed',
      checkCode: 'direction-persisted',
      apply: () => client.$executeRawUnsafe(
        'UPDATE "multicam_shot_decisions" SET "reason" = $1 WHERE "id" = $2',
        'edited underneath the product',
        shot.id,
      ),
      restore: () => client.$executeRawUnsafe(
        'UPDATE "multicam_shot_decisions" SET "reason" = $1 WHERE "id" = $2',
        shot.reason,
        shot.id,
      ),
    })

    const restored = await run('f4016-world-key-restored')
    assert.equal(
      restored.gate.report.satisfied,
      10,
      'the world did not come back after the edits were undone',
    )

    // -----------------------------------------------------------------------
    // Rows that exist and say no. A check that stopped reading its value and
    // started reporting the row's mere presence passes every test above; these
    // are the cases where the evidence is there and the answer is still no.
    // -----------------------------------------------------------------------
    const { buildMeasurement, lumaAtEv } = await import('./wave20-fixtures.mjs')
    const { evaluateColorCritic } = await import(
      '../../src/v2/domain/color-critic-report.ts'
    )
    const { PrismaColorCriticReportRepository } = await import(
      '../../src/v2/infrastructure/prisma/color-critic-report-repository.ts'
    )
    const criticStage = (suffix, assetId, digest, overrides = {}) => [
      buildMeasurement({ measurementId: `f4016-open-${suffix}-a`, cameraId: 'camera-a', sourceAssetId: assetId, sourceSha256: digest }),
      buildMeasurement({ measurementId: `f4016-open-${suffix}-b`, cameraId: 'camera-b', sourceAssetId: assetId, sourceSha256: digest, ...overrides }),
    ]
    // A newer verdict that does NOT close: the cameras still disagree by two
    // and a half stops after the output transform, so the critic asks for a
    // person. The report is there; the answer is no.
    const openVerdict = evaluateColorCritic({
      reportId: 'f4016-critic-report-open',
      workspaceId: W,
      projectId: PROJECT,
      projectVersionId: VERSION,
      subject: { kind: 'output', artifactId: 'artifact-output' },
      before: criticStage('before', 'artifact-intermediate', sha('d')),
      after: criticStage('after', 'artifact-output', sha('e'), { exposure: lumaAtEv(0.5, -2.5) }),
      creativeIntent: { declared: false },
      evaluatedAt: at(300).toISOString(),
    })
    assert.equal(openVerdict.action, 'human-review', 'the fixture stopped being the open case')
    await new PrismaColorCriticReportRepository(client).persist({
      report: openVerdict,
      createdAt: at(300).toISOString(),
    })
    const openRun = await run('f4016-world-key-open-verdict')
    const criticChecks = Object.fromEntries(
      criterionOf(openRun.gate, 'colour-critic-resolved').checks.map((item) => [item.code, item]),
    )
    assert.equal(
      criticChecks['critic-report-persisted'].passed,
      true,
      'a report that exists was reported missing',
    )
    assert.equal(
      criticChecks['verdict-resolved'].passed,
      false,
      'a verdict of human-review was recorded as closed',
    )
    assert.equal(criticChecks['verdict-resolved'].failureReason, 'requirement-unmet')
    assert.match(criticChecks['verdict-resolved'].detail, /human-review/)
    assert.equal(criticChecks['no-open-hard-issue'].passed, false)
    assert.deepEqual(failing(openRun.gate), ['colour-critic-resolved'])
    // Deleted by reportId, not by the row id: the repository hashes the
    // natural key into the primary key, so `id` is not the report's own name.
    await client.v2ColorCriticReport.deleteMany({
      where: { workspaceId: W, reportId: openVerdict.reportId },
    })

    // `output-codec-recorded` cannot be made to fail on a stored row: MEASURED
    // here, `project_final_export_profile_check` pins outputCodec, audio codec,
    // container and quality to h264/aac/mp4/final, so PostgreSQL refuses the
    // `webm` row before the gate ever sees it. The check is a belt over the
    // database's braces, and this comment is what a later reader needs instead
    // of a test that cannot be written.
    await assert.rejects(
      client.$executeRawUnsafe(
        'UPDATE "project_final_export_operations" SET "outputContainer" = $1 WHERE "operationId" = $2',
        'webm',
        world.exportIds.finalOperation,
      ),
      (error) => /project_final_export_profile_check/.test(String(error?.message)),
      'the export profile is no longer pinned by the database',
    )

    // The artifact's byte size and the attempt's disagree: the delivered file
    // is not the one the export promoted.
    await client.$executeRawUnsafe(
      'UPDATE "media_artifacts" SET "byteSize" = "byteSize" + 1 WHERE "id" = $1',
      world.exportIds.outputArtifact,
    )
    const sizeRun = await run('f4016-world-key-size')
    const sizeChecks = Object.fromEntries(
      criterionOf(sizeRun.gate, 'final-mp4-inspectable').checks.map((item) => [item.code, item]),
    )
    assert.equal(sizeChecks['artifact-hash-matches-attempt'].passed, false)
    assert.equal(sizeChecks['artifact-hash-matches-attempt'].failureReason, 'requirement-unmet')
    assert.equal(sizeChecks['output-probe-measured'].passed, true)
    assert.deepEqual(failing(sizeRun.gate), ['final-mp4-inspectable'])
    await client.$executeRawUnsafe(
      'UPDATE "media_artifacts" SET "byteSize" = "byteSize" - 1 WHERE "id" = $1',
      world.exportIds.outputArtifact,
    )

    // `renderable_plan_snapshots.sourceHash` is a plain column: the snapshot's
    // hash covers the plan document, not the binding columns beside it, so one
    // UPDATE used to promote a stale plan to evidence while the gate still
    // recorded the reference as verified. Criteria 4 and 6 now read the same
    // binding out of the document they just re-derived, so a fabricated column
    // changes nothing — and reverting to the column makes this fail.
    for (const origin of ['react-playback', 'multi-range-synthesis']) {
      const row = await client.v2RenderablePlanSnapshot.findFirstOrThrow({
        where: { workspaceId: W, origin },
      })
      await client.$executeRawUnsafe(
        'UPDATE "renderable_plan_snapshots" SET "sourceHash" = $1 WHERE "id" = $2',
        sha('e'),
        row.id,
      )
      const forged = await run(`f4016-world-key-source-${origin}`)
      assert.deepEqual(
        failing(forged.gate),
        [],
        `a fabricated ${origin} sourceHash changed what the gate concluded`,
      )
      await client.$executeRawUnsafe(
        'UPDATE "renderable_plan_snapshots" SET "sourceHash" = $1 WHERE "id" = $2',
        row.sourceHash,
        row.id,
      )
    }

    // One coverage row left where two are needed. "We derived one" and "we
    // derived two and neither carries a measured coverageBps" are different
    // jobs for the operator, and `coverage-derived` used to announce both as
    // `evidence-not-measured` — the reason came from a different predicate
    // than the one that decided the failure.
    const { PrismaCaptureSessionRepository } = await import(
      '../../src/v2/infrastructure/prisma/capture-session-repository.ts'
    )
    const sessionRepository = new PrismaCaptureSessionRepository(client)
    const keptCoverage = world.podcast.coverages[0]
    await client.v2CaptureTrackCoverage.deleteMany({
      where: {
        workspaceId: W,
        sessionId: world.ids.podcastSession,
        trackId: { not: keptCoverage.trackId },
      },
    })
    const thinRun = await run('f4016-world-key-thin-coverage')
    const coverageCheck = criterionOf(thinRun.gate, 'podcast-multicam-synchronised')
      .checks.find((item) => item.code === 'coverage-derived')
    assert.equal(coverageCheck.passed, false)
    assert.equal(
      coverageCheck.failureReason,
      'evidence-missing',
      'one derived coverage was announced as a measurement nobody took',
    )
    assert.match(coverageCheck.detail, /derived 1 track coverages/)
    assert.deepEqual(failing(thinRun.gate), ['podcast-multicam-synchronised'])
    for (const coverage of world.podcast.coverages) {
      await sessionRepository.persistCoverage({
        coverage,
        sessionId: world.ids.podcastSession,
        createdAt: new Date(at(400)).toISOString(),
      })
    }

    // A diagnostic that says the session CAN be edited unattended, over a
    // protocol evaluation whose ceiling still blocks it. The two disagree, and
    // `canAutoEdit` — the domain authority, which blocks on six grounds — is
    // the one that decides. A copy that only re-derives the ceiling clause
    // reports this as blocked, which is the state ADR-135 asks the gate to
    // catch: an automatic edit nobody is stopping.
    const { createSyncDiagnostic, deriveTrackStatus } = await import(
      '../../src/v2/domain/sync-diagnostic.ts'
    )
    const { PrismaSyncDiagnosticRepository } = await import(
      '../../src/v2/infrastructure/prisma/sync-diagnostic-repository.ts'
    )
    const diagnosticRepository = new PrismaSyncDiagnosticRepository(client)
    const headBefore = await client.v2SyncDiagnosticHead.findFirstOrThrow({
      where: { workspaceId: W, sessionId: world.ids.insufficientSession },
    })
    const editableTrack = {
      ...world.unusableTrack,
      methods: ['apollo-marker'],
      confidence: 0.9,
      offsetMs: 0,
      residualMs: 6,
      coverageBps: 9_800,
      warnings: [],
    }
    const editableDiagnostic = createSyncDiagnostic({
      workspaceId: W,
      sessionId: world.ids.insufficientSession,
      referenceTrackId: world.insufficientDiagnostic.referenceTrackId,
      version: world.insufficientDiagnostic.version + 1,
      previousVersionHash: world.insufficientDiagnostic.diagnosticHash,
      sessionVersion: world.insufficientDiagnostic.sessionVersion,
      referenceEpoch: world.insufficientDiagnostic.referenceEpoch,
      tracks: [{
        ...editableTrack,
        status: deriveTrackStatus({ ...editableTrack, hasContradictoryAnchors: false }),
      }],
      protocolCeiling: 'automatic',
      generatedAt: at(500).toISOString(),
    })
    assert.equal(editableDiagnostic.manualRequired, false, 'the fixture no longer allows the edit')
    await diagnosticRepository.appendVersion({
      diagnostic: editableDiagnostic,
      occurredAt: at(500).toISOString(),
    })
    const editableRun = await run('f4016-world-key-auto-editable')
    const ceilingChecks = Object.fromEntries(
      criterionOf(editableRun.gate, 'insufficient-evidence-requires-manual')
        .checks.map((item) => [item.code, item]),
    )
    assert.equal(ceilingChecks['sync-evidence-insufficient'].passed, true)
    assert.equal(
      ceilingChecks['protocol-ceiling-blocks-auto-edit'].passed,
      false,
      'the ceiling was reported as blocking an edit canAutoEdit would allow',
    )
    assert.match(ceilingChecks['protocol-ceiling-blocks-auto-edit'].detail, /canAutoEdit allowed=true/)
    await client.v2SyncDiagnostic.deleteMany({
      where: {
        workspaceId: W,
        sessionId: world.ids.insufficientSession,
        version: editableDiagnostic.version,
      },
    })
    await client.v2SyncDiagnosticHead.update({
      where: { id: headBefore.id },
      data: {
        version: headBefore.version,
        diagnosticHash: headBefore.diagnosticHash,
        status: headBefore.status,
        manualRequired: headBefore.manualRequired,
        updatedAt: headBefore.updatedAt,
      },
    })

    const healthy = await run('f4016-world-key-healthy-again')
    assert.equal(healthy.gate.report.satisfied, 10, 'the world did not come back')

    // -----------------------------------------------------------------------
    // Nine deletions, one row each. After the k-th, exactly the first k
    // criteria are unmet and the rest still answer for themselves.
    // -----------------------------------------------------------------------
    const deletions = [
      {
        criterion: 'podcast-multicam-synchronised',
        row: 'the podcast protocol evaluation',
        remove: () => client.v2CaptureProtocolEvaluation.deleteMany({
          where: { workspaceId: W, sessionId: world.ids.podcastSession, protocolId: 'podcast-v1' },
        }),
      },
      {
        criterion: 'teacher-and-screen-synchronised',
        row: 'the teacher protocol evaluation',
        remove: () => client.v2CaptureProtocolEvaluation.deleteMany({
          where: { workspaceId: W, sessionId: world.ids.teacherSession },
        }),
      },
      {
        criterion: 'insufficient-evidence-requires-manual',
        row: 'the sync evidence record',
        remove: () => client.v2CaptureSyncEvidence.deleteMany({
          where: { workspaceId: W, sessionId: world.ids.insufficientSession },
        }),
      },
      {
        criterion: 'react-edited-with-piecewise-map',
        row: 'the compiled react plan',
        remove: () => client.v2RenderablePlanSnapshot.deleteMany({
          where: { workspaceId: W, origin: 'react-playback' },
        }),
      },
      {
        criterion: 'active-speaker-and-demonstration-directed',
        row: 'the direction head',
        remove: () => client.v2MulticamDirectionHead.deleteMany({ where: { workspaceId: W } }),
      },
      {
        criterion: 'contextual-multi-range-synthesis',
        row: 'the compiled synthesis plan',
        remove: () => client.v2RenderablePlanSnapshot.deleteMany({
          where: { workspaceId: W, origin: 'multi-range-synthesis' },
        }),
      },
      {
        criterion: 'colour-match-precedes-creative-lut',
        row: 'the project colour plan head',
        remove: () => client.v2ProjectColorPlanHead.deleteMany({ where: { workspaceId: W } }),
      },
      {
        criterion: 'colour-critic-resolved',
        row: 'the colour critic report',
        remove: () => client.v2ColorCriticReport.deleteMany({ where: { workspaceId: W } }),
      },
      {
        criterion: 'final-mp4-inspectable',
        row: 'the promoted export attempt',
        remove: () => client.v2ProjectFinalExportAttempt.deleteMany({ where: { workspaceId: W } }),
      },
    ]
    const expected = []
    for (const [index, deletion] of deletions.entries()) {
      await deletion.remove()
      const after = await run(`f4016-world-key-deleted-${index}`)
      expected.push(deletion.criterion)
      assert.deepEqual(
        failing(after.gate).sort(),
        [...expected].sort(),
        `deleting ${deletion.row} did not fail ${deletion.criterion} alone`,
      )
      assert.equal(
        after.gate.report.satisfied,
        10 - expected.length,
        `deleting ${deletion.row} moved the satisfied count by something other than one`,
      )
    }
    console.log(
      `[E2E-F4.016] ${deletions.length} single-row deletions measured; ` +
      'each failed exactly its own criterion',
    )

    // The approved record is still readable, and still refuses to be edited.
    const read = readMulticamLongformGateService({ repository })
    const stillApproved = await read({
      workspaceId: W,
      projectId: PROJECT,
      gateId: approved.gate.id,
    })
    assert.equal(stillApproved.report.approved, true)
    assert.equal(stillApproved.recordHash, approved.gate.recordHash)
    await client.$executeRawUnsafe(
      'UPDATE "multicam_longform_gates" SET "reportJson" = replace("reportJson", $1, $2) WHERE "id" = $3',
      '"approved":true',
      '"approved":true ',
      approved.gate.id,
    )
    await assert.rejects(
      read({ workspaceId: W, projectId: PROJECT, gateId: approved.gate.id }),
      (error) => {
        assert.equal(error.code, 'PERSISTENCE_CONFLICT')
        return true
      },
      'an edited approved record was handed back as if it had been evaluated',
    )
  },
)

test('E2E-F4.016 the reader narrows the domain vocabularies rather than retyping them', async () => {
  // No database: this is about the reader's constants, and CONTRACT §2 asks
  // for it because on Wave 19 every enum written from memory in an
  // infrastructure file was wrong — and a wrong set here does not fail, it
  // makes a criterion quietly stop firing.
  const { GATE_READER_VOCABULARIES } = await import(
    '../../src/v2/infrastructure/prisma/multicam-longform-gate-repository.ts'
  )
  const { SYNC_CEILINGS } = await import('../../src/v2/domain/capture-protocol.ts')
  const { PODCAST_PARTICIPANT_ROLES, CAPTURE_TRACK_ROLES } = await import(
    '../../src/v2/domain/capture-session.ts'
  )
  const { COLOR_CRITIC_ACTIONS } = await import('../../src/v2/domain/color-critic-report.ts')
  const { PLAYBACK_MODES } = await import('../../src/v2/domain/playback-map.ts')
  const { DIAGNOSTIC_STATUSES, RECOMMENDED_ACTIONS } = await import(
    '../../src/v2/domain/sync-diagnostic.ts'
  )
  const { RENDERABLE_PLAN_ORIGINS } = await import(
    '../../src/v2/application/renderable-edit-plan.ts'
  )

  const authorities = {
    syncedStatuses: DIAGNOSTIC_STATUSES,
    manualActions: RECOMMENDED_ACTIONS,
    interruptedModes: PLAYBACK_MODES,
    blockingCeilings: SYNC_CEILINGS,
    resolvedCriticActions: COLOR_CRITIC_ACTIONS,
    participantRoles: PODCAST_PARTICIPANT_ROLES,
    renderablePlanOrigins: RENDERABLE_PLAN_ORIGINS,
  }
  assert.deepEqual(
    Object.keys(GATE_READER_VOCABULARIES).sort(),
    Object.keys(authorities).sort(),
    'the reader narrows a vocabulary this test does not know the authority for',
  )
  for (const [name, values] of Object.entries(GATE_READER_VOCABULARIES)) {
    assert.ok(values.length >= 1, `${name} narrowed its authority to nothing`)
    for (const value of values) {
      assert.ok(
        authorities[name].includes(value),
        `${name} carries ${value}, which its domain constant does not`,
      )
    }
  }
  // The participants are a subset of the track roles, and the four roles that
  // are not a person are excluded rather than forgotten.
  for (const role of PODCAST_PARTICIPANT_ROLES) {
    assert.ok(CAPTURE_TRACK_ROLES.includes(role))
  }
  assert.deepEqual(
    CAPTURE_TRACK_ROLES.filter((role) => !PODCAST_PARTICIPANT_ROLES.includes(role)).sort(),
    ['master-audio', 'reference-video', 'scratch-audio', 'screen'],
  )
  assert.deepEqual(
    [...GATE_READER_VOCABULARIES.renderablePlanOrigins],
    ['react-playback', 'multi-range-synthesis'],
    'the two plan origins are no longer the ones criteria 4 and 6 look for',
  )
  console.log(
    `[E2E-F4.016] ${Object.keys(GATE_READER_VOCABULARIES).length} reader vocabularies ` +
    'checked against their domain authorities',
  )
})
