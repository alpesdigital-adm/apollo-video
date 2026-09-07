import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import {
  closeJourneyObjectStore,
  journeyStorageDriver,
  journeyStorageLabel,
  openJourneyObjectStore,
} from './helpers/journey-object-storage.mjs'
import { PrismaClient } from '../../generated/prisma-v2/index.js'

/**
 * Journey 5 — the phase gate, driven through the published `/v1` routes.
 *
 * `multicam-longform-gate.e2e.mjs` proves the reader and the domain against a
 * real PostgreSQL by calling the application service. It never crosses the
 * public boundary, so five things it cannot say are said here, and every one
 * of them is a property of the ROUTE rather than of the service:
 *
 * 1. **The gate approves through the API, and the input cannot carry a
 *    verdict.** The request that returns `approved: true` is a `POST` whose
 *    whole body is `{}` — no evidence, no measurement, no verdict — and five
 *    bodies that try to supply one (`approved`, `satisfied`, `evidence`,
 *    `report`, `recordHash`) are refused `422 INVALID_ARGUMENT` with no row
 *    written. `report.serverEvidenceOnly` is a constant the domain writes and
 *    is asserted here as a shape, not as proof; the refusals are the proof.
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
 *    Four more conditions get the same treatment, because "approved 10/10" is
 *    an assertion about one healthy world and says nothing about whether each
 *    condition is independently visible: a desynchronised podcast diagnostic,
 *    a session left with one derived coverage, a colour plan that AUTHORS the
 *    creative LUT ahead of the match, and a reference recording made as long
 *    as the reaction. Each moves exactly its criterion and exactly the checks
 *    named, and each is put back. Before this block, the sync gate, the
 *    colour-order gate and the reaction-duration gate could each be replaced
 *    with `true` and nothing in the repository went red.
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

/**
 * The environment the clients are issued in, and the one the routes check.
 *
 * These two have to be the same value or every request is rejected before it
 * reaches the gate. They used to disagree: the clients below were pinned to
 * `sandbox` while `??=` left an environment the caller had already set alone —
 * and CI sets `APOLLO_API_ENVIRONMENT: production` for the whole job, so the
 * journey answered 401 AUTH_INVALID there and passed on a developer machine,
 * where nothing sets it. One value now feeds both.
 */
const API_ENVIRONMENT = process.env.APOLLO_API_ENVIRONMENT ?? 'sandbox'
process.env.APOLLO_API_ENVIRONMENT = API_ENVIRONMENT

/**
 * The request-anomaly floor, raised for the same reason the podcast and
 * teacher journeys raise it — and for a reason this journey looked immune to.
 *
 * The detector is not a call counter. `evaluateGovernanceAnomalies` only emits
 * `REQUEST_RATE_ANOMALY` when `usage.baselineRequests > 0`
 * (`governance-anomaly.ts:152`), and `baselineRequests` is the count of
 * admissions in `[now - 300 s, now - 60 s)` — strictly OLDER than the signal
 * window (`governance-admission-repository.ts:435-452`). A run that finishes
 * inside one 60 s window therefore has no baseline at all and cannot trip it,
 * whatever it does; a run that outlives 60 s gets a baseline made of its own
 * first minute, and the threshold collapses to the floor
 * (`max(requestMinimum, ceil(baseline * 3 / 5))`, `governance-anomaly.ts:105-115`),
 * so admission number `floor + 1` in the second window is refused.
 *
 * Measured on this branch, PostgreSQL 16 on 127.0.0.1:55744:
 * - this journey writes **30** admissions and took 10.8 s / 18.7 s / 20.7 s
 *   (N=3) — under the window, which is why it passed 3/3 unguarded here and
 *   why the guard looked unnecessary;
 * - a probe seeding 25 admissions older than 60 s and then calling one
 *   governed route was refused `429 GOVERNANCE_LIMIT_EXCEEDED` at call **21**
 *   with the shipped floor of 20, and admitted 40/40 with this floor of 400.
 *
 * So the difference from the podcast and teacher journeys is DURATION, not
 * call count: they render with FFmpeg and always outlive the window, this one
 * usually does not — until a loaded runner makes it, which is what the audit
 * measured (one 429 in N=2 on a virgin database). 30 is far below 400, so the
 * floor cannot hide a journey that genuinely burst: only the floor moves,
 * `requestsPerMinute` and the quotas keep their shipped defaults.
 */
process.env.APOLLO_GOVERNANCE_ANOMALY_REQUEST_MINIMUM = '400'

/**
 * Local disk or versioned MinIO, read from the runtime env.
 *
 * This journey used to name no driver at all, which meant the default: it ran
 * against a local disk and the briefing's "PostgreSQL 16 and versioned object
 * storage" was true of neither half here. It now runs under whichever driver
 * the workflow selects, and CI runs it under `s3` on the Compose MinIO.
 *
 * What that proves is stated rather than implied. The gate reads ROWS and the
 * module graph: ten criteria over coverage, clock maps, diagnostics, colour
 * plans, final-export operations and media MANIFESTS — the manifest, never the
 * file. `buildGateWorld` writes no bytes anywhere, in either mode
 * (`multicam-longform-gate-world.mjs:1017-1075` creates `v2MediaArtifact` and
 * `v2MediaArtifactManifest` rows and stops), and the artifacts the report cites
 * carry synthetic digests no real file could have.
 *
 * So what the s3 run proves is narrower than "the gate read its evidence out of
 * MinIO", and narrower than "the gate ran on the object-storage composition
 * root" too: no route this journey imports ever constructs artifact storage at
 * all. Measured — `createArtifact|Materializer|ContentStorage|VerifiedMedia|
 * RenderInput` has zero hits across the six route modules imported below, and
 * this suite sets neither `APOLLO_V2_ARTIFACT_ROOT` nor
 * `APOLLO_V2_RENDER_WORK_ROOT`, one of which the composition root demands the
 * moment anything asks it for storage in either mode
 * (`local-artifact-content-storage.ts:87`, `repository-factory.ts:1252-1257`).
 * The whole S3 conversation in an s3 run is this suite's own CreateBucket,
 * PutBucketVersioning, GetBucketVersioning, ListObjectVersions and DeleteBucket.
 *
 * Stated plainly, then: the gate reaches the same verdict whichever driver the
 * environment names — it is indifferent to it — and the bucket it was handed is
 * EMPTY at the end.
 *
 * That emptiness is the falsifiable half, and what it falsifies is a WRITE. The
 * day a criterion starts putting bytes anywhere — an export promoted, a probe
 * cached — the assertion at the end of this journey fails. A criterion that
 * starts READING a file never reaches that assertion: under s3 it dies first
 * with PERSISTENCE_NOT_CONFIGURED, "Render work root is required for S3
 * artifact materialization", because neither this suite nor the CI step that
 * runs it configures one. Two different failures, one decision behind them —
 * whether the gate should be touching bytes at all — and this is what each of
 * them looks like, instead of it happening silently on a developer's disk.
 */
const storageDriver = journeyStorageDriver()
process.env.APOLLO_V2_ARTIFACT_STORAGE_DRIVER = storageDriver

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

/** The failing checks of one criterion, as `[code, reason]` in catalogue order. */
function failedChecks(report, criterion) {
  const entry = report.criteria.find((item) => item.criterion === criterion)
  assert.ok(entry, `the report carries no criterion named ${criterion}`)
  return entry.checks
    .filter((check) => !check.passed)
    .map((check) => [check.code, check.failureReason])
}

/** The detail line of one check, so an assertion can read what was measured. */
function detailOf(report, criterion, code) {
  const entry = report.criteria.find((item) => item.criterion === criterion)
  assert.ok(entry, `the report carries no criterion named ${criterion}`)
  const check = entry.checks.find((item) => item.code === code)
  assert.ok(check, `${criterion} carries no check named ${code}`)
  return check.detail
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
    const { acquireGateFixtureLease } = await import('./helpers/gate-fixture-lease.mjs')
    // The four breakages below write real aggregates: no hash is invented, so
    // every hash the gate re-derives afterwards is the hash the product
    // computes over the doctored body. Three go through their domain factory.
    // The colour one cannot — `assertMatchStagePosition` refuses the very row
    // it has to store — so it is assembled from the stored record and sealed
    // with `calculateCanonicalHash`, the function those factories call, over
    // the same content they hash. See the block itself.
    const { createSyncDiagnostic, deriveTrackStatus } = await import(
      '../../src/v2/domain/sync-diagnostic.ts'
    )
    const { createPlaybackMap } = await import('../../src/v2/domain/playback-map.ts')
    const { calculateCanonicalHash } = await import('../../src/v2/domain/canonical-hash.ts')
    const { PrismaCaptureSessionRepository } = await import(
      '../../src/v2/infrastructure/prisma/capture-session-repository.ts'
    )
    const { PrismaPlaybackMapRepository } = await import(
      '../../src/v2/infrastructure/prisma/playback-map-repository.ts'
    )
    const { PrismaSyncDiagnosticRepository } = await import(
      '../../src/v2/infrastructure/prisma/sync-diagnostic-repository.ts'
    )
    const { fixtureInstant } = await import('./wave20-fixtures.mjs')

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
    // cleanup takes back both worlds. Today the two are separate, sequential
    // CI steps — but nothing in the workflow enforces that, and a suite that
    // empties another suite's live fixture mid-flight fails as a domain bug.
    // The lease below makes the second runner WAIT instead, so the sentence
    // "they never run at once" is now true because something makes it true.
    const WORKSPACES = [A, B, 'f4016-workspace-a', 'f4016-workspace-b']

    const clean = () => cleanGateWorld({ client, workspaceIds: WORKSPACES })
    const lease = await acquireGateFixtureLease()
    const objectStore = await openJourneyObjectStore()

    t.after(async () => {
      // Reported, not rethrown: a cleanup failure that masks the assertion
      // turns one clear defect into two confusing ones.
      try {
        await clean()
      } catch (error) {
        console.error('cleanup failed:', error?.message ?? error)
      }
      await closeJourneyObjectStore(objectStore).catch((error) => {
        console.error('object storage cleanup failed:', error?.message ?? error)
      })
      await client.$disconnect()
      await lease.release()
    })

    await clean()
    const world = await buildGateWorld({
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
      environment: API_ENVIRONMENT,
      scopes: ['projects:read', 'projects:write'],
    })
    const callerB = await issue({
      id: `f4016-journey-caller-b-${randomUUID().slice(0, 8)}`,
      workspaceId: B,
      name: 'phase gate journey B',
      environment: API_ENVIRONMENT,
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
    // A shape check, and nothing more: `serverEvidenceOnly` is `true as const`
    // in the domain and `{ const: true }` in the published schema, so it would
    // still read `true` if the caller HAD influenced the report. What the flag
    // claims is measured further down, against the input surface itself.
    assert.equal(
      approved.report.serverEvidenceOnly,
      true,
      'the published shape lost the serverEvidenceOnly flag',
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

    // ---- 6. the input surface refuses to carry a verdict -------------------
    // `serverEvidenceOnly` above is a constant the server writes; on its own it
    // says nothing about the caller. The property it CLAIMS is this one: the
    // evaluate body accepts `sessionId` and nothing else, so there is no field
    // on this input a client could use to hand the gate a result or the
    // evidence to reach one. The public envelope deliberately does not echo the
    // offending key — a domain error's details stay internal — so what is
    // pinned here is the refusal and the fact that nothing was written.
    const gatesBeforeSmuggling = await client.v2MulticamLongformGate.count({
      where: { workspaceId: A, projectId: PROJECT_A },
    })
    for (const smuggled of [
      { approved: true },
      { satisfied: 10 },
      { evidence: [{ criterion: 'colour-critic-resolved', passed: true }] },
      { report: { approved: true, criteria: [] } },
      { recordHash: '0'.repeat(64) },
    ]) {
      const refused = await evaluate(
        bearerA,
        `phase-gate-journey-smuggled-${randomUUID()}`,
        smuggled,
      )
      // 422, not 400: the published catalogue maps INVALID_ARGUMENT to
      // "unprocessable", and the status is read off the answer rather than
      // typed in from memory.
      assert.equal(
        refused.status,
        422,
        `${JSON.stringify(smuggled)} was not refused: ${refused.text}`,
      )
      assert.equal(refused.payload.error.code, 'INVALID_ARGUMENT', refused.text)
    }
    assert.equal(
      await client.v2MulticamLongformGate.count({ where: { workspaceId: A, projectId: PROJECT_A } }),
      gatesBeforeSmuggling,
      'a body the contract refused still wrote a gate row',
    )

    // ---- 7. four more conditions, each made to fail on its own -------------
    // "Approved 10/10" is an assertion about one healthy world; it says nothing
    // about whether each condition is independently visible. Sections 4 and 5
    // prove two of them. These four prove the rest of the ones a row can move:
    // the sync gate, the coverage gate, the colour-order gate and the
    // reaction-vs-reference duration gate. Every one of them could be replaced
    // with `true` before this block existed and the suite stayed green.
    const sessions = new PrismaCaptureSessionRepository(client)
    const diagnostics = new PrismaSyncDiagnosticRepository(client)
    const playbackMaps = new PrismaPlaybackMapRepository(client)

    /**
     * One condition, broken through its own rows and then put back.
     *
     * `apply` writes the world into a state the criterion has to refuse;
     * exactly `criterion` must move, and inside it exactly `checks` — code and
     * failure reason — must be the ones that failed. `restore` puts the rows
     * back and the gate has to approve again, which is what separates a
     * refusal from a latch.
     */
    const conditions = []
    const breakAndRestore = async ({ name, criterion, checks, apply, restore, expect }) => {
      await apply()
      const broken = await evaluate(bearerA, `phase-gate-journey-${name}-${randomUUID()}`)
      assert.equal(broken.status, 201, broken.text)
      const report = broken.payload.data.gate.report
      assert.equal(report.approved, false, `${name} left the gate approving`)
      assert.deepEqual(
        Object.keys(failures(report)),
        [criterion],
        `${name} moved a criterion other than ${criterion}`,
      )
      assert.equal(report.satisfied, 9, `${name} moved more than one criterion`)
      assert.deepEqual(
        failedChecks(report, criterion),
        checks,
        `${name} did not fail the checks it was aimed at`,
      )
      if (expect) expect(report)
      conditions.push(`${name} -> ${checks.map(([code]) => code).join('+')}`)
      await restore()
      const back = await evaluate(bearerA, `phase-gate-journey-${name}-restored-${randomUUID()}`)
      assert.equal(broken.payload.data.gate.id === back.payload.data.gate.id, false)
      assert.equal(
        back.payload.data.gate.report.approved,
        true,
        `restoring ${name} did not restore approval: ${JSON.stringify(failures(back.payload.data.gate.report))}`,
      )
    }

    // (a) the sync gate. A new diagnostic version whose tracks are still
    // measured — the coverage stays derived, so the criterion moves on the
    // synchronisation alone — but whose residual walks past the ceiling that
    // separates `synced-medium` from `partial`.
    const podcastDiagnostic = world.podcast.diagnostic
    const diagnosticHeadBefore = await client.v2SyncDiagnosticHead.findFirstOrThrow({
      where: { workspaceId: A, sessionId: world.ids.podcastSession },
    })
    const desynced = createSyncDiagnostic({
      workspaceId: A,
      sessionId: podcastDiagnostic.sessionId,
      referenceTrackId: podcastDiagnostic.referenceTrackId,
      version: podcastDiagnostic.version + 1,
      previousVersionHash: podcastDiagnostic.diagnosticHash,
      sessionVersion: podcastDiagnostic.sessionVersion,
      referenceEpoch: podcastDiagnostic.referenceEpoch,
      tracks: podcastDiagnostic.tracks.map((track) => {
        const drifted = { ...track, residualMs: 900 }
        return {
          ...drifted,
          status: deriveTrackStatus({ ...drifted, hasContradictoryAnchors: false }),
        }
      }),
      protocolCeiling: podcastDiagnostic.protocolCeiling,
      generatedAt: fixtureInstant(500),
    })
    assert.equal(
      ['synced-high', 'synced-medium'].includes(desynced.status),
      false,
      `the doctored diagnostic still reads as synchronised: ${desynced.status}`,
    )
    assert.equal(
      desynced.tracks.every((track) => track.coverageBps !== null),
      true,
      'the doctored diagnostic stopped measuring coverage, which is a different failure',
    )

    await breakAndRestore({
      name: 'desynchronised-podcast',
      criterion: 'podcast-multicam-synchronised',
      checks: [['diagnostic-synchronised', 'requirement-unmet']],
      apply: () => diagnostics.appendVersion({
        diagnostic: desynced,
        occurredAt: fixtureInstant(501),
      }),
      expect: (report) => assert.match(
        detailOf(report, 'podcast-multicam-synchronised', 'diagnostic-synchronised'),
        new RegExp(`is ${desynced.status} over ${desynced.tracks.length} tracks`),
        'the report does not say what the diagnostic actually read',
      ),
      restore: async () => {
        await client.v2SyncDiagnostic.deleteMany({
          where: {
            workspaceId: A,
            sessionId: world.ids.podcastSession,
            version: desynced.version,
          },
        })
        await client.v2SyncDiagnosticHead.update({
          where: { id: diagnosticHeadBefore.id },
          data: {
            version: diagnosticHeadBefore.version,
            diagnosticHash: diagnosticHeadBefore.diagnosticHash,
            status: diagnosticHeadBefore.status,
            manualRequired: diagnosticHeadBefore.manualRequired,
            updatedAt: diagnosticHeadBefore.updatedAt,
          },
        })
      },
    })

    // (b) the coverage gate. Two coverages are what makes them comparable; one
    // is a row nobody derived, and the reason has to say so rather than
    // announcing a measurement that was never taken.
    const keptCoverage = world.podcast.coverages[0].trackId
    await breakAndRestore({
      name: 'single-coverage',
      criterion: 'podcast-multicam-synchronised',
      checks: [['coverage-derived', 'evidence-missing']],
      apply: () => client.v2CaptureTrackCoverage.deleteMany({
        where: {
          workspaceId: A,
          sessionId: world.ids.podcastSession,
          trackId: { not: keptCoverage },
        },
      }),
      expect: (report) => assert.match(
        detailOf(report, 'podcast-multicam-synchronised', 'coverage-derived'),
        /derived 1 track coverages/,
        'one derived coverage was announced as something other than a missing row',
      ),
      restore: async () => {
        for (const coverage of world.podcast.coverages) {
          await sessions.persistCoverage({
            coverage,
            sessionId: world.ids.podcastSession,
            createdAt: fixtureInstant(502),
          })
        }
      },
    })

    // (c) the colour-order gate. `resolveColorPlan` emits the stages in
    // COLOR_TRANSFORM_ORDER, so reading the RESOLVED order back can only catch
    // a rewrite of that constant. The plan AS STORED is what a person authors,
    // and a plan that declares the creative LUT ahead of the match resolves to
    // the right order only because the resolver sorted it. Every hash on the
    // row is the hash of the misordered body, so the row re-derives to its own
    // hash: this is a plan the gate has to refuse on its content, not on
    // arithmetic that stopped adding up.
    const colourPlanRow = await client.v2ProjectColorPlan.findFirstOrThrow({
      where: { workspaceId: A, projectId: PROJECT_A },
    })
    const storedColourPlan = world.colourPlan
    const swapStages = (layer) => {
      const kinds = layer.map((transform) => transform.kind)
      const matchIndex = kinds.indexOf('match')
      const lutIndex = kinds.indexOf('creative-lut')
      assert.ok(matchIndex >= 0 && lutIndex >= 0 && matchIndex < lutIndex, 'the fixture plan is already misordered')
      const swapped = [...layer]
      swapped[matchIndex] = layer[lutIndex]
      swapped[lutIndex] = layer[matchIndex]
      return swapped
    }
    // The tamper cannot be built by `createProjectColorPlan`. `normalizeLayer`
    // calls `assertMatchStagePosition`, which refuses a layer whose match sits
    // after the creative LUT with `COLOR_STAGE_VIOLATION` — that guard is the
    // point of the domain and the misordered plan is exactly what it refuses,
    // so the factory can no longer produce the row this block has to store.
    // Nothing exported lets a caller skip it, so the record is assembled here
    // and re-hashed with the domain's own `calculateCanonicalHash`, over the
    // same content each factory hashes: `createColorPlan` hashes the plan
    // without `planHash`, `compileColorPlanTargets` hashes `{schemaVersion,
    // colorPlanHash, targets}` without `manifestHash`, and
    // `createProjectColorPlan` hashes the record without `recordHash`. The row
    // is therefore internally consistent — every hash is the hash of the
    // misordered content — and the gate has to refuse it on the ORDER, not on
    // a hash that stopped matching its body.
    //
    // The compiled targets are carried over untouched on purpose:
    // `resolveColorPlan` keys stages by kind and emits them in
    // COLOR_TRANSFORM_ORDER, so swapping two declarations leaves every
    // resolved pipeline byte-identical. Only `colorPlanHash` moves, which is
    // the same reason the resolved order cannot catch this and the AUTHORED
    // order has to.
    const contentOf = (record, hashField) => Object.fromEntries(
      Object.entries(record).filter(([key]) => key !== hashField),
    )
    const sealed = (content, hashField) => ({
      ...content,
      [hashField]: calculateCanonicalHash(content),
    })
    const misorderedPlan = sealed({
      ...contentOf(storedColourPlan.plan, 'planHash'),
      global: swapStages(storedColourPlan.plan.global),
    }, 'planHash')
    const misorderedCompiled = sealed({
      ...contentOf(storedColourPlan.compiled, 'manifestHash'),
      colorPlanHash: misorderedPlan.planHash,
    }, 'manifestHash')
    const misorderedColourPlan = sealed({
      ...contentOf(storedColourPlan, 'recordHash'),
      plan: misorderedPlan,
      compiled: misorderedCompiled,
    }, 'recordHash')
    const colourPlanColumns = (record) => ({
      schemaVersion: record.schemaVersion,
      planJson: JSON.stringify(record.plan),
      planHash: record.plan.planHash,
      compiledManifestJson: JSON.stringify(record.compiled),
      compiledManifestHash: record.compiled.manifestHash,
      recordJson: JSON.stringify(record),
      recordHash: record.recordHash,
    })
    assert.notEqual(
      misorderedColourPlan.recordHash,
      storedColourPlan.recordHash,
      'swapping two stages left the record byte-identical',
    )
    await breakAndRestore({
      name: 'creative-lut-authored-before-match',
      criterion: 'colour-match-precedes-creative-lut',
      checks: [['match-precedes-creative-lut', 'requirement-unmet']],
      apply: () => client.v2ProjectColorPlan.update({
        where: { id: colourPlanRow.id },
        data: colourPlanColumns(misorderedColourPlan),
      }),
      expect: (report) => assert.match(
        detailOf(report, 'colour-match-precedes-creative-lut', 'match-precedes-creative-lut'),
        /declares creative-lut before match in \[global\]/,
        'the report does not name the layer that put the stages the wrong way round',
      ),
      restore: () => client.v2ProjectColorPlan.update({
        where: { id: colourPlanRow.id },
        data: colourPlanColumns(storedColourPlan),
      }),
    })

    // (d) the reaction-vs-reference duration gate. A new map version whose
    // reference recording is as long as the reaction: every piece still fits,
    // the map is still resolved, and the one thing that changed is the fact
    // criterion 4 stands for. The appended version carries a new map hash, so
    // the plan compiled from the previous one goes stale with it — both moves
    // are the same edit and both are pinned rather than one being waved past.
    const mapHeadBefore = await client.v2PlaybackMapHead.findFirstOrThrow({
      where: { workspaceId: A, sessionId: world.ids.reactSession },
    })
    const headMap = await playbackMaps.readHead({
      workspaceId: A,
      sessionId: world.ids.reactSession,
      reactionTrackId: mapHeadBefore.reactionTrackId,
    })
    assert.ok(headMap, 'the world persisted no playback map head to lengthen')
    assert.notEqual(
      headMap.referenceMedia.durationTicks,
      headMap.reactionMedia.durationTicks,
      'the fixture reaction and reference are already the same length',
    )
    const equalDurations = createPlaybackMap({
      mapId: headMap.mapId,
      workspaceId: A,
      sessionId: headMap.sessionId,
      sessionVersion: headMap.sessionVersion,
      referenceEpoch: headMap.referenceEpoch,
      reactionTrackId: headMap.reactionTrackId,
      referenceTrackId: headMap.referenceTrackId,
      referenceMedia: {
        ...headMap.referenceMedia,
        durationTicks: headMap.reactionMedia.durationTicks,
      },
      reactionMedia: headMap.reactionMedia,
      version: headMap.version + 1,
      previousVersionHash: headMap.mapHash,
      pieces: headMap.pieces,
      uncovered: headMap.uncovered,
      anchors: headMap.anchors,
      supersedesMapId: headMap.supersedesMapId ?? null,
    })
    assert.equal(equalDurations.status, headMap.status, 'lengthening the reference changed the map status')
    await breakAndRestore({
      name: 'reaction-as-long-as-reference',
      criterion: 'react-edited-with-piecewise-map',
      checks: [
        ['reaction-duration-differs', 'requirement-unmet'],
        ['map-compiled-into-plan', 'evidence-stale'],
      ],
      apply: () => playbackMaps.appendVersion({
        map: equalDurations,
        occurredAt: fixtureInstant(503),
      }),
      expect: (report) => {
        assert.match(
          detailOf(report, 'react-edited-with-piecewise-map', 'reaction-duration-differs'),
          /^reaction (\d+\.\d+)s vs reference \1s$/,
          'the report does not show the two durations it compared',
        )
        // The interruptions ADR-135 names are still all three, so the criterion
        // moved on the duration and not on a piece that went missing.
        assert.match(
          detailOf(report, 'react-edited-with-piecewise-map', 'interrupted-piece-present'),
          /paused/,
        )
      },
      restore: async () => {
        await client.v2PlaybackMap.deleteMany({
          where: { workspaceId: A, mapId: headMap.mapId, version: equalDurations.version },
        })
        await client.v2PlaybackMapHead.update({
          where: { id: mapHeadBefore.id },
          data: {
            mapId: mapHeadBefore.mapId,
            version: mapHeadBefore.version,
            mapHash: mapHeadBefore.mapHash,
            status: mapHeadBefore.status,
            updatedAt: mapHeadBefore.updatedAt,
          },
        })
      },
    })

    // The approved world says all three interruptions are present by name, so
    // a production change that linearises the rewind is visible from here too.
    const restoredReport = (await callRoute(NextRequest, latestRoute, {
      method: 'GET',
      path: `/v1/projects/${PROJECT_A}/multicam-longform-gate`,
      params: { projectId: PROJECT_A },
      authorization: bearerA,
    })).payload.data.gate.report
    const interruptions = detailOf(
      restoredReport,
      'react-edited-with-piecewise-map',
      'interrupted-piece-present',
    )
    for (const mode of ['paused', 'replay', 'seek']) {
      assert.match(
        interruptions,
        new RegExp(`\\b${mode}\\b`),
        `the approved map no longer carries a ${mode} piece: ${interruptions}`,
      )
    }

    // ---- 8. the older version is preserved --------------------------------
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
      'the first approved evaluation changed after twelve later ones',
    )

    const history = await callRoute(NextRequest, evaluationsRoute, {
      method: 'GET',
      path: `/v1/projects/${PROJECT_A}/multicam-longform-gate/evaluations?limit=20`,
      params: { projectId: PROJECT_A },
      authorization: bearerA,
    })
    assert.equal(history.status, 200, history.text)
    const gates = history.payload.data.gates
    // Thirteen rows: the first approval, then six break/restore pairs. The
    // five refused bodies and the foreign-workspace attempt wrote nothing.
    const VERDICTS = [
      true,
      false, true, // the deleted match-plan head
      false, true, // the tampered synthesis objective
      false, true, // the desynchronised podcast diagnostic
      false, true, // the single coverage row
      false, true, // the creative LUT authored before the match
      false, true, // the reference recording as long as the reaction
    ]
    assert.equal(gates.length, VERDICTS.length, 'the history lost or invented an evaluation')
    assert.deepEqual(
      gates.map((gate) => gate.report.approved),
      [...VERDICTS].reverse(),
      'the history is not newest-first, or an evaluation changed its verdict',
    )
    assert.equal(
      new Set(gates.map((gate) => gate.recordHash)).size,
      VERDICTS.length,
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
    assert.equal(latest.payload.data.gate.id, gates[0].id)
    assert.equal(latest.payload.data.gate.report.approved, true)

    const outstanding = await callRoute(NextRequest, outstandingRoute, {
      method: 'GET',
      path: `/v1/projects/${PROJECT_A}/multicam-longform-gate/outstanding`,
      params: { projectId: PROJECT_A },
      authorization: bearerA,
    })
    assert.equal(outstanding.status, 200, outstanding.text)
    assert.equal(outstanding.payload.data.approved, true)
    assert.deepEqual(outstanding.payload.data.outstanding, [])

    // What object storage saw: nothing. See the note on `storageDriver` — no
    // route here constructs artifact storage at all, so this is the assertion
    // that notices the day a criterion starts WRITING bytes. One that starts
    // READING them fails earlier and louder, on the work root nobody configured.
    if (objectStore) {
      assert.deepEqual(
        await objectStore.keys(),
        [],
        'the phase gate reads rows and manifests, never bytes, so its bucket must stay empty',
      )
    }

    console.log(
      `E2E-F4.016 phase gate journey: ${gates.length} evaluations through /v1 — approved ${approved.report.satisfied}/10 ` +
      `(fingerprint ${approved.report.fingerprint.slice(0, 12)}, ${artifacts.payload.data.artifacts.length} artifacts cited), ` +
      `replay byte-identical ${JSON.stringify(replay.payload.data.gate).length} chars, ` +
      `deleted match head -> ${deletedReport.satisfied}/10 evidence-missing, ` +
      `tampered synthesis -> ${tamperedReport.satisfied}/10 evidence-unverified, ` +
      `restored -> ${restoredSynthesis.payload.data.gate.report.satisfied}/10; ` +
      '5 bodies carrying a verdict refused 422 INVALID_ARGUMENT with 0 rows written; ' +
      `4 more conditions broken one at a time: ${conditions.join(', ')}; ` +
      `${journeyStorageLabel(storageDriver)}, bucket keys ${objectStore ? (await objectStore.keys()).length : 'n/a'}`,
    )
  },
)
