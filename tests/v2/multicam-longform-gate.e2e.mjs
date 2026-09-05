import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

/**
 * F4.016 — the phase gate against a real PostgreSQL.
 *
 * `multicam-longform-gate.test.mjs` proves the domain refuses what it should.
 * It cannot prove any of the four things below, because a fake agrees with
 * whatever the code that wrote it believes:
 *
 * - **Tampering is caught on the way out.** A row edited underneath the
 *   product has to make the owning repository's hash re-derivation fail, and
 *   that failure has to reprove exactly one criterion rather than take the
 *   evaluation down. This edits `multicam_shot_decisions` with raw SQL — the
 *   product's own code cannot produce that state.
 * - **A deleted evidence row is a different answer from a tampered one.**
 *   `evidence-missing` and `evidence-unverified` send an operator to different
 *   work, so the two are asserted apart.
 * - **The CHECK constraints are constraints.** They were parsed for the first
 *   time when a database applied the migration; every one that encodes a
 *   domain invariant is offered a row that violates it here.
 * - **Workspace isolation is a WHERE clause the repository actually writes.**
 *
 * Declared limitation: the approved path is exercised with a complete evidence
 * set supplied by a reader double (`completeReader` below). The real reader
 * cannot produce one yet — no test world contains a synchronised podcast, a
 * teacher-and-screen session, a react playback map, a promoted final export
 * and a resolved colour critic at once, and the capture-sync worker has no
 * runtime driver (MAP §3.5 "Prerequisites"). What is proven about approval is
 * that PostgreSQL accepts and re-derives an approved record; what is not
 * proven is that the nine database-backed criteria can all be satisfied by
 * real production rows today.
 */

const RUN = process.env.APOLLO_MULTICAM_GATE_E2E === '1'

test(
  'E2E-F4.016 the multicam long-form gate is evaluated, recorded and re-derived from PostgreSQL',
  { skip: RUN ? false : 'set APOLLO_MULTICAM_GATE_E2E=1 with a migrated V2_DATABASE_URL' },
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
    // The shared helper is a plain `.mjs` with a static `.ts` import, which
    // this runner cannot resolve, so the actor is built from the same
    // application factory the helper uses.
    const { createExternalAuditContext } = await import(
      '../../src/v2/application/authenticate-api-client.ts'
    )

    const client = new PrismaClient()
    const A = 'f4016-workspace-a'
    const B = 'f4016-workspace-b'
    const PROJECT_A = 'f4016-project-a'
    const PROJECT_B = 'f4016-project-b'
    const SESSION = 'f4016-session'
    const CLIENT_A = 'f4016-client-a'
    const CLIENT_B = 'f4016-client-b'
    const VERSION_A = 'f4016-version-a'
    const at = (second) =>
      new Date(Date.parse('2029-06-01T10:00:00.000Z') + second * 1_000)
    const sha = (character) => character.repeat(64)
    const CHECK_TOTAL = MULTICAM_LONGFORM_CRITERIA.reduce(
      (total, criterion) =>
        total + MULTICAM_LONGFORM_CRITERION_CHECKS[criterion].length,
      0,
    )

    const clean = async () => {
      const workspaces = { in: [A, B] }
      for (const table of [
        client.v2MulticamLongformGateEvidence,
        client.v2MulticamLongformGateCheck,
        client.v2MulticamLongformGateCriterion,
        client.v2MulticamLongformGate,
        client.v2MulticamShotAlternative,
        client.v2MulticamAngleScoreComponent,
        client.v2MulticamAngleCandidate,
        client.v2MulticamShotDecision,
        client.v2MulticamDirectionHead,
        client.v2MulticamDirection,
        client.v2MulticamObservation,
        client.v2MulticamEvidenceSet,
        client.v2CaptureSessionHead,
      ]) {
        await table.deleteMany({ where: { workspaceId: workspaces } })
      }
      // The project points at its current version, so the pointer has to go
      // before the version does.
      await client.v2Project.updateMany({
        where: { workspaceId: workspaces },
        data: { currentVersionId: null },
      })
      await client.v2ProjectVersion.deleteMany({ where: { workspaceId: workspaces } })
      await client.v2ProjectSnapshot.deleteMany({ where: { workspaceId: workspaces } })
      await client.v2Project.deleteMany({ where: { workspaceId: workspaces } })
      await client.v2ApiClient.deleteMany({ where: { workspaceId: workspaces } })
      await client.v2Workspace.deleteMany({ where: { id: workspaces } })
    }

    t.after(async () => {
      // Reported, not rethrown: a cleanup failure that masks the assertion
      // turns one clear defect into two confusing ones.
      try {
        await clean()
      } catch (error) {
        console.error('cleanup failed:', error?.message ?? error)
      } finally {
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
    const actor = (clientId, workspaceId) => {
      const auditContext = createExternalAuditContext({
        clientId,
        credentialId: `${clientId}-credential`,
        workspaceId,
        environment: 'sandbox',
      })
      return Object.freeze({
        ...auditContext,
        scopes: new Set(['projects:read', 'projects:write']),
        authenticationKind: 'bearer',
        clientKillSwitchEngaged: false,
        workspaceKillSwitchEngaged: false,
        clientAccessStatus: 'active',
        workspaceAccessStatus: 'active',
        auditContext,
      })
    }
    const run = async (key, overrides = {}) =>
      evaluate({
        workspaceId: A,
        projectId: PROJECT_A,
        actor: actor(CLIENT_A, A),
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
    assert.equal(history.length, 5, 'the history lost or duplicated an evaluation')
    assert.equal(
      new Set(history.map((gate) => gate.id)).size,
      5,
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
    // The approved path, with a reader double (see the header's limitation).
    // -----------------------------------------------------------------------
    const completeReader = Object.freeze({
      findIdempotent: (input) => repository.findIdempotent(input),
      persist: (gate, audit) => repository.persist(gate, audit),
      read: (input) => repository.read(input),
      readLatest: (input) => repository.readLatest(input),
      list: (input) => repository.list(input),
      readEvidence: async () => ({
        resolvedSessionId: SESSION,
        projectVersionId: VERSION_A,
        projectVersionHash: sha('2'),
        evidence: MULTICAM_LONGFORM_CRITERIA
          .filter((criterion) => criterion !== 'no-legacy-runtime-dependency')
          .map((criterion) => ({
            criterion,
            checks: MULTICAM_LONGFORM_CRITERION_CHECKS[criterion].map((code) => ({
              code,
              passed: true,
              failureReason: null,
              detail: `${code} satisfied by a reader double`,
              references: [
                { type: 'project', id: PROJECT_A, hash: sha('4'), verified: true },
              ],
            })),
          })),
      }),
    })
    const approvedRun = evaluateMulticamLongformGateService({
      repository: completeReader,
      legacyAudit,
      clock: () => at(200),
      createId: () => 'f4016-gate-approved',
    })
    const approved = await approvedRun({
      workspaceId: A,
      projectId: PROJECT_A,
      actor: actor(CLIENT_A, A),
      idempotencyKey: 'f4016-key-approved',
    })
    assert.equal(approved.gate.report.approved, true)
    assert.equal(approved.gate.report.satisfied, 10)
    assert.equal(approved.gate.report.blocking.length, 0)
    assert.equal(approved.gate.sessionId, SESSION)
    assert.equal(approved.gate.projectVersionId, VERSION_A)
    const approvedRow = await client.v2MulticamLongformGate.findUnique({
      where: { id: approved.gate.id },
    })
    assert.equal(approvedRow.approved, true)
    assert.equal(approvedRow.satisfied, 10)
    assert.equal(approvedRow.blockingCount, 0)
    const rehydrated = await read({
      workspaceId: A,
      projectId: PROJECT_A,
      gateId: approved.gate.id,
    })
    assert.equal(rehydrated.reportFingerprint, approved.gate.reportFingerprint)
    assert.equal(rehydrated.recordHash, approved.gate.recordHash)

    // An approved record whose stored report is edited must not come back.
    await client.$executeRawUnsafe(
      'UPDATE "multicam_longform_gates" SET "reportJson" = replace("reportJson", $1, $2) WHERE "id" = $3',
      'satisfied by a reader double',
      'satisfied by nobody at all',
      approved.gate.id,
    )
    await assert.rejects(
      read({ workspaceId: A, projectId: PROJECT_A, gateId: approved.gate.id }),
      (error) => {
        assert.equal(error.code, 'PERSISTENCE_CONFLICT')
        return true
      },
      'an edited gate report was handed back as if it had been evaluated',
    )
    console.log(
      `[E2E-F4.016] approved record: satisfied ${approvedRow.satisfied}/10, ` +
      `blocking ${approvedRow.blockingCount}, fingerprint ` +
      `${approved.gate.reportFingerprint.slice(0, 12)}, edit-on-read refused`,
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
    assert.equal(refusals, 14)
  },
)
