import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

/**
 * Journey 5 — the phase gate, driven through the published `/v1` routes.
 *
 * `multicam-longform-gate.e2e.mjs` proves the reader and the domain against a
 * real PostgreSQL by calling the application service. It never crosses the
 * public boundary, so five things it cannot say are said here, and every one
 * of them is a property of the ROUTE rather than of the service:
 *
 * 1. **The gate approves through the API.** The request that returns
 *    `approved: true` is a `POST` whose whole body is `{}` — no evidence, no
 *    measurement, no verdict. Everything in the answer was read from
 *    PostgreSQL and from the module graph by the server.
 * 2. **A replay is byte-identical.** The same `Idempotency-Key` from the same
 *    credential returns 200 with a `gate` object whose serialization equals
 *    the 201's, and writes no second row. The same key with a different body
 *    is refused as `IDEMPOTENCY_PAYLOAD_MISMATCH` rather than quietly
 *    answering about a different session.
 * 3. **Tampering is refused, by criterion.** One `UPDATE` underneath the
 *    product — the editorial synthesis' objective, so its stored hash no
 *    longer re-derives — reproves exactly `contextual-multi-range-synthesis`
 *    with `evidence-unverified`, takes the gate down with it, and leaves the
 *    other nine criteria answering for themselves. Restoring the column makes
 *    the gate approve again, which is what separates a refusal from a latch.
 * 4. **A deleted row fails exactly its own criterion.** The match-plan head is
 *    removed and re-created afterwards; while it is gone,
 *    `colour-match-precedes-creative-lut` is the only criterion that moves.
 * 5. **Another workspace cannot see any of it, and the old record survives.**
 *    Workspace B's credential gets `PROJECT_NOT_FOUND` from the evaluation and
 *    `MULTICAM_LONGFORM_GATE_NOT_FOUND` from the read of A's gate id, and the
 *    first approved evaluation still reads back — same `recordHash`, same
 *    fingerprint — after three later evaluations disagreed with it.
 *
 * The routes are imported and invoked directly rather than through a running
 * server. That is the whole published path minus the socket: capability
 * lookup by method and pathname, bearer authentication, scope, governance
 * admission, the singular-filter rule, the JSON parse, the presenter and the
 * public error envelope. It costs no `next build` and leaves no process
 * behind.
 *
 * What is NOT through the API: the evidence world itself. Nine of the ten
 * criteria read rows — coverage, clock maps, final-export operations, media
 * manifests among them — that no `/v1` route can write today, so the world is
 * built by `buildGateWorld` through the real repositories and services, the
 * same way `multicam-longform-gate.e2e.mjs` builds it. Said plainly because
 * the alternative is to imply a write surface that does not exist.
 */

const RUN = process.env.APOLLO_PHASE_GATE_E2E === '1'
const SKIP = RUN
  ? false
  : 'set APOLLO_PHASE_GATE_E2E=1 with a migrated V2_DATABASE_URL'

/**
 * The gate reads the module graph for criterion 10 and PostgreSQL for the
 * other nine, and does it four times here.
 */
const TIMEOUT = 15 * 60_000

/** Sandbox unless the caller declared otherwise: the API clients are sandbox. */
process.env.APOLLO_API_ENVIRONMENT ??= 'sandbox'

/**
 * Invoke a published route the way Next would.
 *
 * `params` is handed over as a promise because that is the shape every route
 * in `src/app/v1` destructures; passing a plain object would make the suite
 * agree with a signature the framework does not use.
 */
async function callRoute(NextRequest, module, {
  method,
  path,
  params = {},
  body,
  authorization,
  idempotencyKey,
}) {
  const headers = new Headers()
  if (authorization) headers.set('authorization', authorization)
  if (idempotencyKey) headers.set('idempotency-key', idempotencyKey)
  const init = { method, headers }
  if (body !== undefined) {
    headers.set('content-type', 'application/json')
    init.body = JSON.stringify(body)
  }
  const request = new NextRequest(new URL(`http://apollo.invalid${path}`), init)
  const handler = module[method]
  assert.ok(handler, `${method} ${path} has no handler`)
  const response = await handler(request, { params: Promise.resolve(params) })
  const text = await response.text()
  return {
    status: response.status,
    text,
    payload: text.length > 0 ? JSON.parse(text) : null,
  }
}

/** The failing criteria of a report, as `criterion -> first blocking reason`. */
function failures(report) {
  return Object.fromEntries(
    report.criteria
      .filter((entry) => !entry.passed)
      .map((entry) => [
        entry.criterion,
        entry.checks.find((check) => !check.passed)?.failureReason ?? 'unknown',
      ]),
  )
}

test(
  'E2E-F4.016 the phase gate approves, refuses tampering and refuses another workspace, through /v1',
  { skip: SKIP, timeout: TIMEOUT },
  async (t) => {
    const { NextRequest } = await import('next/server')
    const { createApiClientService } = await import(
      '../../src/v2/application/create-api-client.ts'
    )
    const { PrismaApiClientRepository } = await import(
      '../../src/v2/infrastructure/prisma/api-client-repository.ts'
    )
    const { nodeApiCredentialCrypto } = await import(
      '../../src/v2/infrastructure/security/api-credential.ts'
    )
    const { MULTICAM_LONGFORM_CRITERIA, MULTICAM_LONGFORM_GATE_ID } = await import(
      '../../src/v2/domain/multicam-longform-gate.ts'
    )
    const { buildGateWorld, cleanGateWorld } = await import(
      './helpers/multicam-longform-gate-world.mjs'
    )

    const criteriaRoute = await import(
      '../../src/app/v1/multicam-longform-gate/criteria/route.ts'
    )
    const evaluationsRoute = await import(
      '../../src/app/v1/projects/[projectId]/multicam-longform-gate/evaluations/route.ts'
    )
    const evaluationRoute = await import(
      '../../src/app/v1/projects/[projectId]/multicam-longform-gate/evaluations/[gateId]/route.ts'
    )
    const artifactsRoute = await import(
      '../../src/app/v1/projects/[projectId]/multicam-longform-gate/evaluations/[gateId]/artifacts/route.ts'
    )
    const latestRoute = await import(
      '../../src/app/v1/projects/[projectId]/multicam-longform-gate/route.ts'
    )
    const outstandingRoute = await import(
      '../../src/app/v1/projects/[projectId]/multicam-longform-gate/outstanding/route.ts'
    )

    const client = new PrismaClient()
    const A = 'f4016-journey-workspace-a'
    const B = 'f4016-journey-workspace-b'
    const PROJECT_A = 'f4016-journey-project-a'
    const PROJECT_B = 'f4016-journey-project-b'
    const VERSION_A = 'f4016-journey-version-a'
    const OWNER_A = 'f4016-journey-owner-a'
    const OWNER_B = 'f4016-journey-owner-b'
    // `buildGateWorld` writes fixed fixture ids — media artifacts among them,
    // and `media_artifacts.id` is unique across the whole database rather than
    // per workspace. A crashed run of THIS suite or of
    // `multicam-longform-gate.e2e.mjs` therefore blocks the next seed, so the
    // cleanup takes back both worlds. The two never run at once: they are
    // separate, sequential CI steps.
    const WORKSPACES = [A, B, 'f4016-workspace-a', 'f4016-workspace-b']

    const clean = () => cleanGateWorld({ client, workspaceIds: WORKSPACES })

    t.after(async () => {
      // Reported, not rethrown: a cleanup failure that masks the assertion
      // turns one clear defect into two confusing ones.
      try {
        await clean()
      } catch (error) {
        console.error('cleanup failed:', error?.message ?? error)
      }
      await client.$disconnect()
    })

    await clean()
    await buildGateWorld({
      client,
      workspaceId: A,
      projectId: PROJECT_A,
      versionId: VERSION_A,
      clientId: OWNER_A,
      otherWorkspaceId: B,
      otherProjectId: PROJECT_B,
      otherClientId: OWNER_B,
    })

    // The credentials the journey actually authenticates with. They are issued
    // after the world is built because building it starts by emptying the
    // workspaces, api clients included.
    const issue = createApiClientService({
      repository: new PrismaApiClientRepository(client),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => new Date('2029-06-01T10:00:00.000Z'),
    })
    const callerA = await issue({
      id: `f4016-journey-caller-a-${randomUUID().slice(0, 8)}`,
      workspaceId: A,
      name: 'phase gate journey A',
      environment: 'sandbox',
      scopes: ['projects:read', 'projects:write'],
    })
    const callerB = await issue({
      id: `f4016-journey-caller-b-${randomUUID().slice(0, 8)}`,
      workspaceId: B,
      name: 'phase gate journey B',
      environment: 'sandbox',
      scopes: ['projects:read', 'projects:write'],
    })
    const bearerA = `Bearer ${callerA.token}`
    const bearerB = `Bearer ${callerB.token}`

    const evaluate = (authorization, key, body = {}) =>
      callRoute(NextRequest, evaluationsRoute, {
        method: 'POST',
        path: `/v1/projects/${PROJECT_A}/multicam-longform-gate/evaluations`,
        params: { projectId: PROJECT_A },
        body,
        authorization,
        idempotencyKey: key,
      })

    // ---- the catalogue, before anything was evaluated ---------------------
    const catalogue = await callRoute(NextRequest, criteriaRoute, {
      method: 'GET',
      path: '/v1/multicam-longform-gate/criteria',
      authorization: bearerA,
    })
    assert.equal(catalogue.status, 200, catalogue.text)
    assert.equal(catalogue.payload.data.gate, MULTICAM_LONGFORM_GATE_ID)
    assert.deepEqual(
      catalogue.payload.data.criteria.map((entry) => entry.criterion),
      [...MULTICAM_LONGFORM_CRITERIA],
      'the published catalogue is the domain constant, not a copy of it',
    )

    // ---- 1. the world the gate is meant to approve ------------------------
    const approvedKey = `phase-gate-journey-approved-${randomUUID()}`
    const first = await evaluate(bearerA, approvedKey)
    assert.equal(first.status, 201, first.text)
    const approved = first.payload.data.gate
    assert.equal(first.payload.data.replayed, false)
    assert.equal(
      approved.report.approved,
      true,
      `the complete world was not approved: ${JSON.stringify(failures(approved.report))}`,
    )
    assert.equal(approved.report.satisfied, 10)
    assert.equal(approved.report.total, 10)
    assert.deepEqual(approved.report.failed, [])
    assert.equal(
      approved.report.serverEvidenceOnly,
      true,
      'the report must declare that nothing in it came from the caller',
    )
    assert.equal(approved.createdBy.id, callerA.client.id)
    assert.equal(approved.workspaceId, A)

    // The evaluation cited rows, and the citations are readable as artifacts.
    const artifacts = await callRoute(NextRequest, artifactsRoute, {
      method: 'GET',
      path: `/v1/projects/${PROJECT_A}/multicam-longform-gate/evaluations/${approved.id}/artifacts?limit=100`,
      params: { projectId: PROJECT_A, gateId: approved.id },
      authorization: bearerA,
    })
    assert.equal(artifacts.status, 200, artifacts.text)
    assert.ok(
      artifacts.payload.data.artifacts.length >= 10,
      `an approved gate cited only ${artifacts.payload.data.artifacts.length} artifacts`,
    )
    assert.equal(
      artifacts.payload.data.artifacts.filter((entry) => entry.hash !== null && !entry.verified).length,
      0,
      'no approved criterion may cite a reference whose hash did not re-derive',
    )

    // ---- 2. a replay is the same bytes, and no new work -------------------
    const replay = await evaluate(bearerA, approvedKey)
    assert.equal(replay.status, 200, replay.text)
    assert.equal(replay.payload.data.replayed, true)
    assert.equal(
      JSON.stringify(replay.payload.data.gate),
      JSON.stringify(approved),
      'the replay is not byte-identical to the record it replays',
    )
    assert.equal(
      await client.v2MulticamLongformGate.count({ where: { workspaceId: A, projectId: PROJECT_A } }),
      1,
      'the replay wrote a second row',
    )

    const mismatch = await evaluate(bearerA, approvedKey, { sessionId: 'f4016-session-podcast' })
    assert.equal(mismatch.status, 409, mismatch.text)
    assert.equal(mismatch.payload.error.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH')

    // ---- 3. another workspace sees nothing --------------------------------
    const foreignRead = await callRoute(NextRequest, evaluationRoute, {
      method: 'GET',
      path: `/v1/projects/${PROJECT_A}/multicam-longform-gate/evaluations/${approved.id}`,
      params: { projectId: PROJECT_A, gateId: approved.id },
      authorization: bearerB,
    })
    assert.equal(foreignRead.status, 404, foreignRead.text)
    assert.equal(foreignRead.payload.error.code, 'MULTICAM_LONGFORM_GATE_NOT_FOUND')

    const foreignLatest = await callRoute(NextRequest, latestRoute, {
      method: 'GET',
      path: `/v1/projects/${PROJECT_A}/multicam-longform-gate`,
      params: { projectId: PROJECT_A },
      authorization: bearerB,
    })
    assert.equal(foreignLatest.status, 404, foreignLatest.text)

    const foreignEvaluate = await evaluate(bearerB, `phase-gate-journey-foreign-${randomUUID()}`)
    assert.equal(foreignEvaluate.status, 404, foreignEvaluate.text)
    assert.equal(foreignEvaluate.payload.error.code, 'PROJECT_NOT_FOUND')
    assert.equal(
      await client.v2MulticamLongformGate.count({ where: { workspaceId: B } }),
      0,
      'workspace B wrote a gate row for a project it cannot see',
    )

    // ---- 4. one deleted row fails exactly its own criterion ---------------
    const matchHead = await client.v2MulticamMatchPlanHead.findFirst({
      where: { workspaceId: A, projectId: PROJECT_A },
    })
    assert.ok(matchHead, 'the world did not persist a match plan head to delete')
    await client.v2MulticamMatchPlanHead.delete({ where: { id: matchHead.id } })

    const afterDelete = await evaluate(bearerA, `phase-gate-journey-deleted-${randomUUID()}`)
    assert.equal(afterDelete.status, 201, afterDelete.text)
    const deletedReport = afterDelete.payload.data.gate.report
    assert.equal(deletedReport.approved, false, 'a gate with a missing row must not approve')
    assert.deepEqual(
      Object.keys(failures(deletedReport)),
      ['colour-match-precedes-creative-lut'],
      'the deletion moved a criterion other than its own',
    )
    assert.equal(deletedReport.satisfied, 9)
    assert.equal(
      failures(deletedReport)['colour-match-precedes-creative-lut'],
      'evidence-missing',
      'a row nobody wrote is missing evidence, not unverified evidence',
    )

    await client.v2MulticamMatchPlanHead.create({ data: matchHead })
    const restoredMatch = await evaluate(bearerA, `phase-gate-journey-restored-match-${randomUUID()}`)
    assert.equal(
      restoredMatch.payload.data.gate.report.approved,
      true,
      `restoring the row did not restore approval: ${JSON.stringify(failures(restoredMatch.payload.data.gate.report))}`,
    )

    // ---- 5. one tampered hash fails exactly its own criterion -------------
    const synthesis = await client.v2EditorialSynthesis.findFirst({
      where: { workspaceId: A, projectId: PROJECT_A },
    })
    assert.ok(synthesis, 'the world did not persist an editorial synthesis to tamper with')
    await client.v2EditorialSynthesis.update({
      where: { id: synthesis.id },
      // Underneath the product on purpose: the row still parses, still has a
      // hash column, and the hash simply is not this body's any more.
      data: { objective: 'a sentence nobody agreed to' },
    })

    const afterTamper = await evaluate(bearerA, `phase-gate-journey-tampered-${randomUUID()}`)
    assert.equal(afterTamper.status, 201, afterTamper.text)
    const tamperedReport = afterTamper.payload.data.gate.report
    assert.equal(tamperedReport.approved, false, 'a tampered row must not approve')
    assert.deepEqual(
      Object.keys(failures(tamperedReport)),
      ['contextual-multi-range-synthesis'],
      'the tamper moved a criterion other than its own',
    )
    assert.equal(
      failures(tamperedReport)['contextual-multi-range-synthesis'],
      'evidence-unverified',
      'a row that was checked and disagreed is unverified, not missing',
    )
    assert.equal(tamperedReport.satisfied, 9)
    // What the report can say about the tamper, measured rather than assumed.
    // The reader learns of the mismatch by the repository REFUSING to hydrate
    // (`PERSISTENCE_CONFLICT`), so at that point it holds no synthesis to name
    // and blames the project instead. That is honest, and it is also as far as
    // the operator gets: a project with twenty syntheses is told one of them
    // disagreed, not which. Recorded here as the behaviour that exists.
    const blockingSynthesis = tamperedReport.blocking.filter(
      (entry) => entry.criterion === 'contextual-multi-range-synthesis',
    )
    assert.equal(blockingSynthesis.length, 5, 'every check of the criterion must report the refusal')
    assert.ok(
      blockingSynthesis.every((entry) => entry.detail.includes(PROJECT_A)),
      `the report does not name what disagreed: ${JSON.stringify(blockingSynthesis[0])}`,
    )
    assert.deepEqual(
      tamperedReport.criteria
        .find((entry) => entry.criterion === 'contextual-multi-range-synthesis')
        .checks.map((check) => check.references.map((reference) => reference.type)),
      Array.from({ length: 5 }, () => ['project']),
      'a refused hydration must not cite the row it could not read as evidence',
    )

    await client.v2EditorialSynthesis.update({
      where: { id: synthesis.id },
      data: { objective: synthesis.objective },
    })
    const restoredSynthesis = await evaluate(
      bearerA,
      `phase-gate-journey-restored-synthesis-${randomUUID()}`,
    )
    assert.equal(
      restoredSynthesis.payload.data.gate.report.approved,
      true,
      'restoring the tampered column did not restore approval',
    )

    // ---- 6. the older version is preserved --------------------------------
    const reread = await callRoute(NextRequest, evaluationRoute, {
      method: 'GET',
      path: `/v1/projects/${PROJECT_A}/multicam-longform-gate/evaluations/${approved.id}`,
      params: { projectId: PROJECT_A, gateId: approved.id },
      authorization: bearerA,
    })
    assert.equal(reread.status, 200, reread.text)
    assert.equal(
      JSON.stringify(reread.payload.data.gate),
      JSON.stringify(approved),
      'the first approved evaluation changed after four later ones',
    )

    const history = await callRoute(NextRequest, evaluationsRoute, {
      method: 'GET',
      path: `/v1/projects/${PROJECT_A}/multicam-longform-gate/evaluations?limit=20`,
      params: { projectId: PROJECT_A },
      authorization: bearerA,
    })
    assert.equal(history.status, 200, history.text)
    const gates = history.payload.data.gates
    assert.equal(gates.length, 5, 'the history lost or invented an evaluation')
    assert.deepEqual(
      gates.map((gate) => gate.report.approved),
      [true, false, true, false, true].reverse(),
      'the history is not newest-first, or an evaluation changed its verdict',
    )
    assert.equal(
      new Set(gates.map((gate) => gate.recordHash)).size,
      5,
      'two evaluations share a record hash',
    )

    // Latest is the last one, and it approves again.
    const latest = await callRoute(NextRequest, latestRoute, {
      method: 'GET',
      path: `/v1/projects/${PROJECT_A}/multicam-longform-gate`,
      params: { projectId: PROJECT_A },
      authorization: bearerA,
    })
    assert.equal(latest.status, 200, latest.text)
    assert.equal(latest.payload.data.gate.id, restoredSynthesis.payload.data.gate.id)

    const outstanding = await callRoute(NextRequest, outstandingRoute, {
      method: 'GET',
      path: `/v1/projects/${PROJECT_A}/multicam-longform-gate/outstanding`,
      params: { projectId: PROJECT_A },
      authorization: bearerA,
    })
    assert.equal(outstanding.status, 200, outstanding.text)
    assert.equal(outstanding.payload.data.approved, true)
    assert.deepEqual(outstanding.payload.data.outstanding, [])

    console.log(
      `E2E-F4.016 phase gate journey: 5 evaluations through /v1 — approved ${approved.report.satisfied}/10 ` +
      `(fingerprint ${approved.report.fingerprint.slice(0, 12)}, ${artifacts.payload.data.artifacts.length} artifacts cited), ` +
      `replay byte-identical ${JSON.stringify(replay.payload.data.gate).length} chars, ` +
      `deleted match head -> ${deletedReport.satisfied}/10 evidence-missing, ` +
      `tampered synthesis -> ${tamperedReport.satisfied}/10 evidence-unverified, ` +
      `restored -> ${restoredSynthesis.payload.data.gate.report.satisfied}/10`,
    )
  },
)
