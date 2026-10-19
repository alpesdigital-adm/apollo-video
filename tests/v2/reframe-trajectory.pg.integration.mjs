import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { NextRequest } from 'next/server'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
// Under tsx a static named import of a TypeScript module is not visible to Node (the module runs as CommonJS), so these are dynamic.
const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
const { projectProxyRenderInputHash } = await import('../../src/v2/application/project-render-sources.ts')
const { setAssetRightsService } = await import('../../src/v2/application/set-asset-rights.ts')
const { stableSerialize } = await import('../../src/v2/domain/canonical-hash.ts')
const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
const { REFRAME_POLICY_SHA256 } = await import('../../src/v2/domain/reframe-policy.ts')
const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
const { PrismaAssetRightsRepository } = await import('../../src/v2/infrastructure/prisma/asset-rights-repository.ts')
const { PrismaProjectProxyRenderRepository } = await import('../../src/v2/infrastructure/prisma/project-proxy-render-repository.ts')
const { PrismaWorkspaceRepository } = await import('../../src/v2/infrastructure/prisma/workspace-repository.ts')
const { PrismaVariantReframePlanRepository } = await import('../../src/v2/infrastructure/prisma/variant-reframe-plan-repository.ts')
const { PrismaVariantReframeOverrideRepository } = await import('../../src/v2/infrastructure/prisma/variant-reframe-override-repository.ts')
const { applyVariantReframeOverrideService } = await import('../../src/v2/application/variant-reframe-overrides.ts')
const { disconnectV2PostgresClient } = await import('../../src/v2/infrastructure/prisma-postgres/client.ts')
const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
const reframePlansRoute = await import('../../src/app/v1/projects/[projectId]/reframe-plans/route.ts')
const overridesRoute = await import('../../src/app/v1/projects/[projectId]/variant-reframe-overrides/route.ts')
import { sourceWindowHarness } from './helpers/face-source-pg.mjs'
import { seedTwoOutputIngestedProject } from './helpers/multi-output-pg-world.mjs'
import { testActor } from './helpers/pg-output-world.mjs'
import { SCENES, standInDetectorRows } from './helpers/reframe-gt-oracle.mjs'

/**
 * W66r PostgreSQL + public API proof of the reframe plan and the per-variant manual override (written for the supervised harness; not run in CI).
 *
 * Everything below goes through the product: the route handlers (bearer authentication, capability scopes, the error catalog), the application
 * services, the Prisma repositories and the database guards (the new Command type is admitted by the child-Command guard of the sealed State).
 * The ONLY stand-in is the face detector: the sealed source window is produced by the real worker over the real repository, from rows the GT
 * generator computed (see reframe-gt-oracle.mjs); no frame of any video is analysed here.
 *
 * It proves, on a project with TWO outputs (9:16 and 16:9) over one ingested recording:
 *  1. plan persistence and replay: no evidence -> no crop is decided and the windows to request are listed; with evidence the plan is persisted
 *     and a replay is the same row; a later evidence set appends the next record to the chain of that (Version, variant) without losing the first;
 *  2. a stale base, an aspect ratio used as a variant, an unknown variant and another workspace are refused with their published status;
 *     revoked rights stop planning (422) and planning works again when the rights are restored;
 *  3. an override is a Command on one variant and one range: it creates a Version whose plan for that variant differs and whose plan for the other
 *     variant is byte-identical; the observations and the server's own plan do not move; the previous Version and its plan are untouched; a replay is the
 *     same Version, the same key with another body is refused, overlaps and crops that hide a critical subject are refused; a reset returns the range to
 *     the automatic level and to the very record the automatic plan had;
 *  4. the RenderInput of a (Version, variant) is reconstructed identically every time, carries the plan of ITS variant, and moves with the plan;
 *  5. the tables refuse a broken chain and a reset without a predecessor, and a hand-edited row is refused when read.
 */
const enabled = Boolean(process.env.V2_DATABASE_URL)
const SKIP = enabled ? false : 'set V2_DATABASE_URL to a migrated disposable database (the supervised harness does)'
const CHECK_FAILURE = /check constraint|constraint failed|violates|Unique constraint/i
process.env.APOLLO_API_ENVIRONMENT = 'production'

const run = randomUUID().replaceAll('-', '').slice(0, 10)
const MOVING = SCENES['moving-subject']
const evidenceLines = []
const note = (label, value) => {
  evidenceLines.push({ label, ...value })
  console.log(`W66R-PG-EVIDENCE ${JSON.stringify({ label, ...value })}`)
}

async function callRoute(handler, path, { method = 'GET', token, body, key, params, search = '' }) {
  const request = new NextRequest(`http://localhost${path}${search}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const response = await handler(request, { params: Promise.resolve(params) })
  return { status: response.status, payload: await response.json() }
}

/** A workspace with an API client that holds `projects:read` and `projects:write`, and its bearer token. */
async function tenant(db, label) {
  const workspaceId = `w66r-${run}-${label}-ws`
  const clientId = `w66r-${run}-${label}-client`
  await new PrismaWorkspaceRepository(db).create(createWorkspace({ id: workspaceId, slug: workspaceId, name: `W66r ${label}`, status: 'active', createdAt: new Date().toISOString() }))
  const issued = await createApiClientService({ repository: new PrismaApiClientRepository(db), credentialCrypto: nodeApiCredentialCrypto, clock: () => new Date() })({
    id: clientId, workspaceId, name: `W66r ${label}`, environment: 'production', scopes: ['projects:read', 'projects:write', 'media:write'],
  })
  const actor = testActor({ workspaceId, clientId, credentialId: `${clientId}-seed`, environment: 'production', scopes: ['projects:read', 'projects:write', 'media:write'] })
  return { workspaceId, clientId, token: issued.token, actor }
}

/** Two outputs over one ingested recording of 150 frames, and the face harness over the same project. */
async function world(db, owner, label) {
  const seeded = await seedTwoOutputIngestedProject(db, {
    workspaceId: owner.workspaceId, actor: owner.actor, prefix: `w66r-${label}`, ids: { project: `w66r-${run}-${label}-project` },
    recording: { slug: 'source', durationFrames: 150 },
  })
  const faces = sourceWindowHarness(db, { suffix: `${run}${label}`, workspaceId: owner.workspaceId, clientId: owner.clientId, projectId: seeded.projectId,
    sourceId: seeded.recording.names.sourceArtifactId, actor: owner.actor })
  const publish = (name, window) => faces.publish(`${label}-${name}`, window, (frame) => standInDetectorRows(MOVING, frame))
  return { ...seeded, faces, publish, owner, path: (suffix) => `/v1/projects/${seeded.projectId}/${suffix}`, params: { projectId: seeded.projectId } }
}

const planCall = (w, body, token = w.owner.token) =>
  callRoute(reframePlansRoute.POST, w.path('reframe-plans'), { method: 'POST', token, body, params: w.params })
const planRead = (w, variantId, extra = {}, token = w.owner.token) =>
  callRoute(reframePlansRoute.GET, w.path('reframe-plans'), { token, params: w.params, search: `?variantId=${encodeURIComponent(variantId)}${extra.projectVersionId ? `&projectVersionId=${extra.projectVersionId}` : ''}` })
const overrideCall = (w, body, key, token = w.owner.token) =>
  callRoute(overridesRoute.POST, w.path('variant-reframe-overrides'), { method: 'POST', token, body, key, params: w.params })
const overridesRead = (w, variantId, token = w.owner.token) =>
  callRoute(overridesRoute.GET, w.path('variant-reframe-overrides'), { token, params: w.params, search: `?variantId=${encodeURIComponent(variantId)}` })

/** The application service over the real repository: the refusal reasons the public error presenter keeps internal are read from here. */
const overrideService = (db) => applyVariantReframeOverrideService({
  repository: new PrismaVariantReframeOverrideRepository(db), createId: (kind) => `w66r-${run}-svc-${kind}-${randomUUID()}`,
})
const refusedWith = (code, reason) => (error) => error.code === code && error.details?.reason === reason

/**
 * The rights of the recording's source are revoked (audited, by the production service) while `work` runs, and restored after it, whatever it
 * does: the render source then has no approved current rights, and nothing may be planned or framed over it.
 */
async function whileRightsRevoked(db, owner, w, work) {
  const rights = new PrismaAssetRightsRepository(db)
  const setRights = setAssetRightsService({ repository: rights, clock: () => new Date(), createId: () => randomUUID() })
  const sourceArtifactId = w.recording.names.sourceArtifactId
  const current = await rights.findCurrent(owner.workspaceId, sourceArtifactId)
  const clone = (value) => JSON.parse(JSON.stringify(value))
  const keys = ['owner', 'license', 'status', 'allowedUses', 'prohibitedUses', 'allowedMarkets', 'allowedLocales', 'allowedSyntheticOperations', 'expiresAt', 'sourceNote']
  const consentKeys = ['status', 'allowedUses', 'allowedMarkets', 'allowedLocales', 'allowedSyntheticOperations', 'expiresAt', 'documentArtifactId']
  const original = { ...Object.fromEntries(keys.filter((key) => current.snapshot[key] !== undefined).map((key) => [key, clone(current.snapshot[key])])),
    consent: Object.fromEntries(consentKeys.filter((key) => current.snapshot.consent[key] !== undefined).map((key) => [key, clone(current.snapshot.consent[key])])) }
  const actor = { type: 'system', id: 'controlled-fixture' }
  await setRights({ workspaceId: owner.workspaceId, artifactId: sourceArtifactId, baseRevision: current.revision, draft: { ...original, status: 'revoked' }, actor })
  try {
    assert.equal((await rights.findCurrent(owner.workspaceId, sourceArtifactId)).snapshot.status, 'revoked')
    return await work()
  } finally {
    const revoked = await rights.findCurrent(owner.workspaceId, sourceArtifactId)
    await setRights({ workspaceId: owner.workspaceId, artifactId: sourceArtifactId, baseRevision: revoked.revision, draft: original, actor })
    assert.equal((await rights.findCurrent(owner.workspaceId, sourceArtifactId)).snapshot.status, original.status, 'the rights are the approved ones again')
  }
}

const headOf = async (db, projectId) => {
  const row = await db.v2Project.findUniqueOrThrow({ where: { id: projectId }, include: { currentVersion: true } })
  return { id: row.currentVersion.id, baseHash: row.currentVersion.baseHash, sequence: row.currentVersion.sequence, editPlanSnapshotId: row.currentVersion.editPlanSnapshotId }
}
const planRows = (db, w, where = {}) => db.v2VariantReframePlan.findMany({ where: { workspaceId: w.owner.workspaceId, projectId: w.projectId, ...where }, orderBy: [{ variantId: 'asc' }, { projectVersionId: 'asc' }, { sequence: 'asc' }] })
const versionSnapshot = async (db, versionId) => JSON.stringify(await db.v2ProjectVersion.findUniqueOrThrow({ where: { id: versionId } }), (_key, value) => (typeof value === 'bigint' ? value.toString() : value))

test('W66r PG reframe plan: no evidence decides no crop; evidence persists and replays; new evidence appends to the chain; stale base, unknown variant, other workspace and revoked rights are refused',
  { skip: SKIP, timeout: 20 * 60_000 }, async () => {
    const db = new PrismaClient()
    try {
      const owner = await tenant(db, 'p')
      const other = await tenant(db, 'po')
      const w = await world(db, owner, 'plan')
      const head = w.head.version
      const base = { baseVersionId: head.id }

      // --- before any plan an override has nothing to sit on: the public answer is 428, the reason is read from the service
      const clipId = `clip-${w.recording.slug}`
      const early = { baseVersionId: head.id, baseHash: head.baseHash, variantId: w.verticalVariantId, clipId, startFrame: 100, endFrame: 130, crop: { x: 0.4, y: 0, width: 0.31640625, height: 1 } }
      const earlyCall = await overrideCall(w, early, `w66r-${run}-early`)
      assert.deepEqual([earlyCall.status, earlyCall.payload.error.code], [428, 'PRECONDITION_REQUIRED'], JSON.stringify(earlyCall.payload))
      await assert.rejects(overrideService(db)({ ...early, workspaceId: owner.workspaceId, projectId: w.projectId, actor: owner.actor, idempotencyKey: `w66r-${run}-early-svc` }),
        refusedWith('PRECONDITION_REQUIRED', 'reframe-plan-required'))
      assert.equal((await headOf(db, w.projectId)).id, head.id)

      // --- no evidence: the vertical crop is not decided, the windows that would let it be are listed; nothing is persisted
      const none = await planCall(w, { ...base, variantId: w.verticalVariantId })
      assert.equal(none.status, 200, JSON.stringify(none.payload))
      assert.deepEqual([none.payload.data.status, none.payload.data.plan, none.payload.data.reasonCode], ['review-required', null, 'FACE_PERCEPTION_UNAVAILABLE'])
      assert.ok(none.payload.data.requiredFaceWindows[0].windows.length > 0, 'the windows that would let it be planned are named')
      assert.equal((await planRows(db, w)).length, 0)
      // the 16:9 output shows the whole 16:9 source: it needs no evidence and is planned (and persisted) at once
      const wide = await planCall(w, { ...base, variantId: w.wideVariantId })
      assert.deepEqual([wide.status, wide.payload.data.status, wide.payload.data.replayed], [200, 'ready', false], JSON.stringify(wide.payload))
      const wideReplay = await planCall(w, { ...base, variantId: w.wideVariantId })
      assert.deepEqual([wideReplay.payload.data.replayed, wideReplay.payload.data.plan.recordHash, wideReplay.payload.data.plan.planRecordId], [true, wide.payload.data.plan.recordHash, wide.payload.data.plan.planRecordId])
      assert.equal((await planRows(db, w)).length, 1)

      // --- first half of the evidence: the second half is a gap, so it is reported and never guessed
      await w.publish('first-half', { startSourceFrame: 0, endSourceFrame: 75 })
      const partial = await planCall(w, { ...base, variantId: w.verticalVariantId })
      assert.equal(partial.status, 200, JSON.stringify(partial.payload))
      const partialPlan = partial.payload.data.plan
      assert.deepEqual([partial.payload.data.status, partial.payload.data.replayed, partialPlan.sequence], ['review-required', false, 1])
      assert.ok(partialPlan.issues.some((issue) => issue.code === 'PERCEPTION_UNCERTAIN' && issue.startFrame >= 75), JSON.stringify(partialPlan.issues))
      assert.equal(partialPlan.policy.hash, REFRAME_POLICY_SHA256, 'the policy hash is sealed into the persisted record')

      // --- the rest of the evidence: the next record of the same (Version, variant), chained to the first; the first is still there
      await w.publish('second-half', { startSourceFrame: 75, endSourceFrame: 150 })
      const full = await planCall(w, { ...base, variantId: w.verticalVariantId })
      const fullPlan = full.payload.data.plan
      assert.deepEqual([full.status, full.payload.data.status, full.payload.data.replayed, fullPlan.sequence], [200, 'ready', false, 2], JSON.stringify(full.payload))
      assert.notEqual(fullPlan.recordHash, partialPlan.recordHash)
      assert.deepEqual(fullPlan.issues, [])
      const verticalRows = await planRows(db, w, { variantId: w.verticalVariantId })
      assert.deepEqual(verticalRows.map((row) => [row.sequence, row.recordHash, row.previousPlanId]),
        [[1, partialPlan.recordHash, null], [2, fullPlan.recordHash, verticalRows[0].id]], 'a chain of two, the first kept')
      const replay = await planCall(w, { ...base, variantId: w.verticalVariantId })
      assert.deepEqual([replay.payload.data.replayed, replay.payload.data.plan.recordHash, replay.payload.data.plan.sequence], [true, fullPlan.recordHash, 2])
      assert.equal((await planRows(db, w, { variantId: w.verticalVariantId })).length, 2, 'a replay writes nothing')
      const read = await planRead(w, w.verticalVariantId)
      assert.deepEqual([read.status, read.payload.data.plan.recordHash, read.payload.data.projectVersionId], [200, fullPlan.recordHash, head.id])
      // the two outputs have their own plans, bound to their own stable variant
      const wideRead = await planRead(w, w.wideVariantId)
      assert.notEqual(wideRead.payload.data.plan.recordHash, fullPlan.recordHash)
      assert.equal(fullPlan.renderPlan.variantId, w.verticalVariantId)
      assert.equal(wideRead.payload.data.plan.renderPlan.variantId, w.wideVariantId)
      assert.equal(fullPlan.renderPlan.format, '9:16')
      note('plan-chain', { variantId: w.verticalVariantId, records: verticalRows.map((row) => [row.sequence, row.recordHash.slice(0, 16), row.disposition]), wideRecord: wideRead.payload.data.plan.recordHash.slice(0, 16) })

      // --- refusals, each with its published status and nothing written
      const rowsBefore = (await planRows(db, w)).length
      const parent = (await db.v2ProjectVersion.findUniqueOrThrow({ where: { id: head.id } })).parentVersionId
      const stale = await planCall(w, { baseVersionId: parent, variantId: w.verticalVariantId })
      assert.deepEqual([stale.status, stale.payload.error.code], [409, 'VERSION_CONFLICT'], JSON.stringify(stale.payload))
      const aspect = await planCall(w, { ...base, variantId: '9:16' })
      assert.deepEqual([aspect.status, aspect.payload.error.code, aspect.payload.error.details?.reason], [428, 'PRECONDITION_REQUIRED', 'output-variant-unknown'], JSON.stringify(aspect.payload))
      const unknown = await planCall(w, { ...base, variantId: 'variant-does-not-exist' })
      assert.deepEqual([unknown.status, unknown.payload.error.details?.reason], [428, 'output-variant-unknown'])
      const closed = await planCall(w, { ...base, variantId: w.verticalVariantId, observations: [] })
      assert.deepEqual([closed.status, closed.payload.error.code], [422, 'INVALID_ARGUMENT'], 'the body is closed: a caller cannot bring observations')
      const foreign = await planCall(w, { ...base, variantId: w.verticalVariantId }, other.token)
      assert.deepEqual([foreign.status, foreign.payload.error.code], [404, 'PROJECT_NOT_FOUND'], JSON.stringify(foreign.payload))
      const foreignRead = await planRead(w, w.verticalVariantId, {}, other.token)
      assert.equal(foreignRead.status, 404)
      // reading a plan checks the project, the workspace and the variant WHICHEVER Version is named: another workspace is not found (it does not
      // have an empty plan), a project that does not exist is not found, and an aspect ratio is not a variant with or without a Version
      const foreignNamed = await planRead(w, w.verticalVariantId, { projectVersionId: head.id }, other.token)
      assert.deepEqual([foreignNamed.status, foreignNamed.payload.error?.code], [404, 'PROJECT_NOT_FOUND'], JSON.stringify(foreignNamed.payload))
      const noProject = await callRoute(reframePlansRoute.GET, '/v1/projects/w66r-no-such-project/reframe-plans', { token: owner.token, params: { projectId: 'w66r-no-such-project' },
        search: `?variantId=${encodeURIComponent(w.verticalVariantId)}&projectVersionId=${head.id}` })
      assert.deepEqual([noProject.status, noProject.payload.error?.code], [404, 'PROJECT_NOT_FOUND'])
      const aspectNamed = await planRead(w, '9:16', { projectVersionId: head.id })
      assert.deepEqual([aspectNamed.status, aspectNamed.payload.error?.details?.reason], [428, 'output-variant-unknown'], JSON.stringify(aspectNamed.payload))
      const aspectHead = await planRead(w, '9:16')
      assert.deepEqual([aspectHead.status, aspectHead.payload.error?.details?.reason], [428, 'output-variant-unknown'])
      const unknownNamed = await planRead(w, 'variant-does-not-exist', { projectVersionId: head.id })
      assert.deepEqual([unknownNamed.status, unknownNamed.payload.error?.details?.reason], [428, 'output-variant-unknown'])
      assert.equal((await planRows(db, w)).length, rowsBefore)

      // --- revoked rights stop planning: the render source no longer has approved current rights; restored rights plan again
      await whileRightsRevoked(db, owner, w, async () => {
        const blocked = await planCall(w, { ...base, variantId: w.verticalVariantId })
        assert.deepEqual([blocked.status, blocked.payload.error.code], [422, 'ASSET_RIGHTS_BLOCKED'], JSON.stringify(blocked.payload))
        const blockedWide = await planCall(w, { ...base, variantId: w.wideVariantId })
        assert.equal(blockedWide.payload.error?.code, 'ASSET_RIGHTS_BLOCKED')
        assert.equal((await planRows(db, w)).length, rowsBefore, 'a blocked source writes no plan')
      })
      const restored = await planCall(w, { ...base, variantId: w.verticalVariantId })
      assert.deepEqual([restored.status, restored.payload.data.replayed, restored.payload.data.plan.recordHash], [200, true, fullPlan.recordHash])

      // --- the tables: a broken chain and a reset with no predecessor are refused by the database, and a hand-edited row is refused when read
      const row = verticalRows[1]
      // a probe row whose only fault is the one named: the first record has a successor already, so a row after it is a second successor
      const probe = (data) => db.v2VariantReframePlan.create({ data: { id: `w66r-${run}-probe-${randomUUID()}`, workspaceId: owner.workspaceId, projectId: w.projectId, projectVersionId: head.id,
        variantId: w.verticalVariantId, sequence: 9, recordHash: 'e'.repeat(64), disposition: 'ready', recordJson: '{}', previousPlanId: verticalRows[0].id, createdAt: new Date(), ...data } })
      await assert.rejects(probe({ sequence: 1 }), (error) => CHECK_FAILURE.test(String(error?.message)) && /chain_check|variant_reframe_plans/.test(String(error?.message)), 'sequence 1 with a predecessor')
      await assert.rejects(probe({ disposition: 'maybe' }), (error) => CHECK_FAILURE.test(String(error?.message)), 'a disposition the policy does not have')
      await assert.rejects(probe({}), (error) => /Unique constraint|previousPlanId/.test(String(error?.message)), 'a second successor of the same record: the chain is a compare-and-swap')
      assert.equal((await planRows(db, w, { variantId: w.verticalVariantId })).length, 2, 'no probe was stored')
      // a hand-edited row does not survive the read: a column that contradicts the record, then a record that contradicts its own seal
      const readHead = () => new PrismaVariantReframePlanRepository(db).readHead({ workspaceId: owner.workspaceId, projectId: w.projectId, projectVersionId: head.id, variantId: w.verticalVariantId })
      await db.v2VariantReframePlan.update({ where: { id: row.id }, data: { disposition: 'blocked' } })
      await assert.rejects(readHead, (error) => error.code === 'PERSISTENCE_CONFLICT')
      await db.v2VariantReframePlan.update({ where: { id: row.id }, data: { disposition: row.disposition } })
      await db.v2VariantReframePlan.update({ where: { id: row.id }, data: { recordJson: row.recordJson.replace('"disposition":"ready"', '"disposition":"blocked"') } })
      await assert.rejects(readHead, (error) => ['PERSISTENCE_CONFLICT', 'INVALID_RENDER_INPUT'].includes(error.code))
      await db.v2VariantReframePlan.update({ where: { id: row.id }, data: { recordJson: row.recordJson } })
      assert.equal((await planRead(w, w.verticalVariantId)).payload.data.plan.recordHash, fullPlan.recordHash, 'restored')
    } finally {
      await db.$disconnect()
      await disconnectV2PostgresClient().catch(() => undefined)
    }
  })

test('W66r PG variant override: a Command on one variant and one range; the other variant, the observations and the previous Version do not move; replay, mismatch, overlap, hidden subject and reset',
  { skip: SKIP, timeout: 20 * 60_000 }, async () => {
    const db = new PrismaClient()
    try {
      const owner = await tenant(db, 'o')
      const other = await tenant(db, 'oo')
      const w = await world(db, owner, 'override')
      await w.publish('all', { startSourceFrame: 0, endSourceFrame: 150 })
      const baseHead = await headOf(db, w.projectId)
      const baseBody = { baseVersionId: baseHead.id }
      const vertical = await planCall(w, { ...baseBody, variantId: w.verticalVariantId })
      const wide = await planCall(w, { ...baseBody, variantId: w.wideVariantId })
      assert.deepEqual([vertical.payload.data.status, wide.payload.data.status], ['ready', 'ready'], JSON.stringify([vertical.payload, wide.payload]))
      const autoPlan = vertical.payload.data.plan
      const widePlan = wide.payload.data.plan
      const clipId = autoPlan.renderPlan.ranges[0].clipId
      const subject = { x: 0.4, y: 0, width: 0.31640625, height: 1 }
      const baseVersionRowBefore = await versionSnapshot(db, baseHead.id)
      const rowsBeforeOverride = await planRows(db, w)

      // --- an override that would hide the subject the server is sure of is refused; so is a range outside the clip, an overlap is checked below
      const hiding = await overrideCall(w, { ...baseBody, baseHash: baseHead.baseHash, variantId: w.verticalVariantId, clipId, startFrame: 100, endFrame: 130, crop: { x: 0, y: 0, width: 0.31640625, height: 1 } }, `w66r-${run}-hiding`)
      assert.deepEqual([hiding.status, hiding.payload.error.code], [422, 'INVALID_ARGUMENT'], JSON.stringify(hiding.payload))
      await assert.rejects(overrideService(db)({ ...baseBody, baseHash: baseHead.baseHash, workspaceId: owner.workspaceId, projectId: w.projectId, actor: owner.actor, idempotencyKey: `w66r-${run}-hiding-svc`,
        variantId: w.verticalVariantId, clipId, startFrame: 100, endFrame: 130, crop: { x: 0, y: 0, width: 0.31640625, height: 1 } }), refusedWith('INVALID_ARGUMENT', 'HIDES_CRITICAL_SUBJECT'))
      const outside = await overrideCall(w, { ...baseBody, baseHash: baseHead.baseHash, variantId: w.verticalVariantId, clipId, startFrame: 140, endFrame: 200, crop: subject }, `w66r-${run}-outside`)
      assert.equal(outside.status, 422, JSON.stringify(outside.payload))
      const noClip = await overrideCall(w, { ...baseBody, baseHash: baseHead.baseHash, variantId: w.verticalVariantId, clipId: 'clip-not-played', startFrame: 100, endFrame: 130, crop: subject }, `w66r-${run}-noclip`)
      assert.equal(noClip.status, 422)
      assert.equal((await headOf(db, w.projectId)).id, baseHead.id, 'a refused Command writes nothing')

      // --- set: one range of one clip of the vertical variant
      const set = await overrideCall(w, { ...baseBody, baseHash: baseHead.baseHash, variantId: w.verticalVariantId, clipId, startFrame: 100, endFrame: 130, crop: subject, reason: 'frame the speaker' }, `w66r-${run}-set`)
      assert.equal(set.status, 201, JSON.stringify(set.payload))
      const data = set.payload.data
      assert.deepEqual([data.command.type, data.command.baseVersionId, data.version.parentVersionId, data.replayed], ['apply-variant-reframe-override', baseHead.id, baseHead.id, false])
      const afterSet = await headOf(db, w.projectId)
      assert.deepEqual([afterSet.id, afterSet.sequence], [data.version.id, baseHead.sequence + 1], 'the Version is the new head')
      // the plan for THIS variant moved, over the very same observations and the very same server plan
      assert.notEqual(data.plan.recordHash, autoPlan.recordHash)
      assert.equal(data.plan.observationSetHash, autoPlan.observationSetHash, 'the raw observation does not change')
      assert.equal(data.plan.serverPlanHash, autoPlan.serverPlanHash, 'the server plan does not change')
      assert.notEqual(data.plan.finalPlanHash, autoPlan.finalPlanHash)
      assert.deepEqual(data.plan.overrides.applied.map((entry) => [entry.clipId, entry.startFrame, entry.endFrame]), [[clipId, 100, 130]])
      assert.deepEqual(data.reframeOverride.crop, subject)
      assert.equal(data.reframeOverride.variantId, w.verticalVariantId)
      assert.equal(data.reframeOverride.action, 'set')
      // the impact is honest: a render made from a plan is always a full render, so the stale region and the render asked for are the WHOLE
      // timeline of the target variant (never the framed range), and only of that variant
      assert.deepEqual(data.impact.affectedRanges, [{ startFrame: 0, endFrame: 150 }])
      assert.deepEqual(data.impact.minimalRenders.map((render) => [render.variantId, render.ranges]), [[w.verticalVariantId, [{ startFrame: 0, endFrame: 150 }]]])
      assert.deepEqual(data.impact.affectedVariantIds, [w.verticalVariantId])
      // the plan of the OTHER variant is carried unchanged to the new Version: the same record
      const wideAfter = await planRead(w, w.wideVariantId, { projectVersionId: data.version.id })
      assert.equal(wideAfter.payload.data.plan.recordHash, widePlan.recordHash)
      assert.equal(wideAfter.payload.data.plan.finalPlanHash, widePlan.finalPlanHash)
      // the previous Version, its plans and its row are exactly what they were
      assert.equal(await versionSnapshot(db, baseHead.id), baseVersionRowBefore, 'the previous ProjectVersion is unchanged')
      const rowsAfter = await planRows(db, w)
      for (const before of rowsBeforeOverride) {
        const kept = rowsAfter.find((row) => row.id === before.id)
        assert.deepEqual([kept.recordHash, kept.recordJson, kept.sequence], [before.recordHash, before.recordJson, before.sequence], 'a plan of the previous Version is untouched')
      }
      assert.deepEqual((await planRead(w, w.verticalVariantId, { projectVersionId: baseHead.id })).payload.data.plan.recordHash, autoPlan.recordHash)
      // the EditPlan is the parent's under the new identity: nothing in it moved
      const [parentSnapshot, childSnapshot] = await Promise.all([baseHead.editPlanSnapshotId, afterSet.editPlanSnapshotId].map((id) => db.v2ProjectSnapshot.findUniqueOrThrow({ where: { id } })))
      // what a re-identification may change: the plan's own id, the Version it belongs to and the instant it was born
      const strip = ({ id: _id, projectVersionId: _version, createdAt: _created, ...rest }) => stableSerialize(rest)
      assert.equal(strip(JSON.parse(childSnapshot.contentJson)), strip(JSON.parse(parentSnapshot.contentJson)), 'the EditPlan is re-identified, not recompiled')
      note('override-set', { variant: w.verticalVariantId, range: [100, 130], autoRecord: autoPlan.recordHash.slice(0, 16), overriddenRecord: data.plan.recordHash.slice(0, 16),
        observationSetHash: data.plan.observationSetHash.slice(0, 16), serverPlanHash: data.plan.serverPlanHash.slice(0, 16), wideRecordKept: widePlan.recordHash.slice(0, 16) })

      // --- replay, mismatch, stale base, other workspace, unknown variant
      const versionsBefore = await db.v2ProjectVersion.count({ where: { projectId: w.projectId } })
      const sameSet = { ...baseBody, baseHash: baseHead.baseHash, variantId: w.verticalVariantId, clipId, startFrame: 100, endFrame: 130, crop: subject, reason: 'frame the speaker' }
      const replayed = await overrideCall(w, sameSet, `w66r-${run}-set`)
      assert.deepEqual([replayed.status, replayed.payload.data.replayed, replayed.payload.data.version.id, replayed.payload.data.plan.recordHash], [200, true, data.version.id, data.plan.recordHash])
      assert.equal(await db.v2ProjectVersion.count({ where: { projectId: w.projectId } }), versionsBefore, 'a replay writes nothing')
      const mismatch = await overrideCall(w, { ...sameSet, crop: { ...subject, x: 0.45 } }, `w66r-${run}-set`)
      assert.deepEqual([mismatch.status, mismatch.payload.error.code], [409, 'IDEMPOTENCY_PAYLOAD_MISMATCH'], JSON.stringify(mismatch.payload))
      const stale = await overrideCall(w, { ...sameSet, startFrame: 30, endFrame: 45, crop: { x: 0.1, y: 0, width: 0.31640625, height: 1 } }, `w66r-${run}-stale`)
      assert.deepEqual([stale.status, stale.payload.error.code], [409, 'VERSION_CONFLICT'], 'the base is the previous head: stale')
      const foreign = await overrideCall(w, sameSet, `w66r-${run}-foreign`, other.token)
      assert.deepEqual([foreign.status, foreign.payload.error.code], [404, 'PROJECT_NOT_FOUND'], JSON.stringify(foreign.payload))
      assert.equal((await overridesRead(w, w.verticalVariantId, other.token)).status, 404, 'another workspace finds no project, not an empty list')
      const unknownList = await overridesRead(w, '9:16')
      assert.deepEqual([unknownList.status, unknownList.payload.error.details?.reason], [428, 'output-variant-unknown'], 'an aspect ratio is not a variant here either')
      const head1 = await headOf(db, w.projectId)
      const current = { baseVersionId: head1.id, baseHash: head1.baseHash }
      const aspect = await overrideCall(w, { ...current, variantId: '9:16', clipId, startFrame: 30, endFrame: 45, crop: subject }, `w66r-${run}-aspect`)
      assert.deepEqual([aspect.status, aspect.payload.error.details?.reason], [428, 'output-variant-unknown'], 'an aspect ratio is not a variant')
      const unknown = await overrideCall(w, { ...current, variantId: 'variant-does-not-exist', clipId, startFrame: 30, endFrame: 45, crop: subject }, `w66r-${run}-unknownvariant`)
      assert.deepEqual([unknown.status, unknown.payload.error.details?.reason], [428, 'output-variant-unknown'])
      const overlap = await overrideCall(w, { ...current, variantId: w.verticalVariantId, clipId, startFrame: 110, endFrame: 140, crop: subject }, `w66r-${run}-overlap`)
      assert.equal(overlap.status, 422, 'a different range that overlaps an existing manual range is refused')
      const nothingToReset = await overrideCall(w, { ...current, variantId: w.verticalVariantId, clipId, startFrame: 30, endFrame: 45, action: 'reset' }, `w66r-${run}-noreset`)
      assert.equal(nothingToReset.status, 422, 'there is no manual reframe on that range to reset')
      assert.equal(await db.v2ProjectVersion.count({ where: { projectId: w.projectId } }), versionsBefore, 'every refusal wrote nothing')
      const heads = await overridesRead(w, w.verticalVariantId)
      assert.deepEqual(heads.payload.data.overrides.map((entry) => [entry.clipId, entry.startFrame, entry.endFrame, entry.action]), [[clipId, 100, 130, 'set']])
      assert.deepEqual((await overridesRead(w, w.wideVariantId)).payload.data.overrides, [], 'the other variant has no override')

      // --- a second range on the SAME variant is a second Command: both overrides are in the plan, the wide variant still the same record
      const second = await overrideCall(w, { ...current, variantId: w.verticalVariantId, clipId, startFrame: 70, endFrame: 90, crop: { x: 0.38, y: 0, width: 0.31640625, height: 1 } }, `w66r-${run}-second`)
      assert.equal(second.status, 201, JSON.stringify(second.payload))
      assert.deepEqual(second.payload.data.plan.overrides.applied.map((entry) => [entry.startFrame, entry.endFrame]).sort((a, b) => a[0] - b[0]), [[70, 90], [100, 130]])
      assert.equal(second.payload.data.plan.observationSetHash, autoPlan.observationSetHash)

      // --- reset of the first range: the range returns to the automatic level (the second override stays)
      const head2 = await headOf(db, w.projectId)
      const reset = await overrideCall(w, { baseVersionId: head2.id, baseHash: head2.baseHash, variantId: w.verticalVariantId, clipId, startFrame: 100, endFrame: 130, action: 'reset' }, `w66r-${run}-reset`)
      assert.equal(reset.status, 201, JSON.stringify(reset.payload))
      assert.deepEqual([reset.payload.data.reframeOverride.action, reset.payload.data.reframeOverride.previousOverrideId], ['reset', data.reframeOverride.id])
      assert.deepEqual(reset.payload.data.plan.overrides.applied.map((entry) => [entry.startFrame, entry.endFrame]), [[70, 90]], 'only the second override still applies')
      assert.equal(reset.payload.data.plan.observationSetHash, autoPlan.observationSetHash)
      assert.equal(reset.payload.data.plan.serverPlanHash, autoPlan.serverPlanHash)
      const head3 = await headOf(db, w.projectId)
      const resetSecond = await overrideCall(w, { baseVersionId: head3.id, baseHash: head3.baseHash, variantId: w.verticalVariantId, clipId, startFrame: 70, endFrame: 90, action: 'reset' }, `w66r-${run}-reset-second`)
      assert.equal(resetSecond.status, 201, JSON.stringify(resetSecond.payload))
      // with no manual range left the plan is, byte for byte, the automatic record of the first Version
      assert.equal(resetSecond.payload.data.plan.recordHash, autoPlan.recordHash, 'a full reset returns to the automatic record')
      assert.deepEqual(resetSecond.payload.data.plan.overrides.applied, [])
      assert.equal(resetSecond.payload.data.plan.finalPlanHash, resetSecond.payload.data.plan.serverPlanHash)
      assert.deepEqual((await overridesRead(w, w.verticalVariantId)).payload.data.overrides.map((entry) => entry.action), ['reset', 'reset'], 'the heads are the last word of each range: both reset')
      // the whole history is kept: four Commands, chained by the override they follow
      const chain = await db.v2VariantReframeOverride.findMany({ where: { workspaceId: owner.workspaceId, projectId: w.projectId }, orderBy: { createdAt: 'asc' } })
      assert.deepEqual(chain.map((row) => [row.action, row.startFrame, row.endFrame, row.previousOverrideId === null ? null : chain.findIndex((candidate) => candidate.id === row.previousOverrideId)]),
        [['set', 100, 130, null], ['set', 70, 90, null], ['reset', 100, 130, 0], ['reset', 70, 90, 1]])
      assert.equal(await db.v2VariantReframeOverrideHead.count({ where: { workspaceId: owner.workspaceId, projectId: w.projectId } }), 2)
      note('override-reset', { commands: chain.map((row) => row.action), finalRecordEqualsAutomatic: true })

      // --- the tables refuse a reset with no predecessor
      const lastOverride = chain.at(-1)
      await assert.rejects(db.v2VariantReframeOverride.create({ data: { ...lastOverride, id: `w66r-${run}-probe`, commandId: `w66r-${run}-probe-command`, resultVersionId: `w66r-${run}-probe-version`,
        previousOverrideId: null, action: 'reset' } }), (error) => /variant_reframe_overrides_reset_check/.test(String(error?.message)) || CHECK_FAILURE.test(String(error?.message)))

      // --- the RenderInput of a (Version, variant): reconstructed identically, carrying the plan of ITS variant, and moving with the plan
      const renders = new PrismaProjectProxyRenderRepository(db)
      const sourceOf = async (versionId, variantId) => {
        const version = await db.v2ProjectVersion.findUniqueOrThrow({ where: { id: versionId } })
        return renders.readImmutableSource({ workspaceId: owner.workspaceId, projectId: w.projectId, projectVersionId: versionId, editPlanSnapshotId: version.editPlanSnapshotId,
          sourceArtifactId: w.recording.names.sourceArtifactId, sourceManifestId: w.recording.names.sourceManifestId, variantId })
      }
      const hashOf = (source) => projectProxyRenderInputHash({ source, colorPipelineBindings: [] })
      const setVersionId = data.version.id
      const first = await sourceOf(setVersionId, w.verticalVariantId)
      const again = await sourceOf(setVersionId, w.verticalVariantId)
      const head = await renders.readCurrentSource({ workspaceId: owner.workspaceId, projectId: w.projectId, variantId: w.verticalVariantId })
      assert.equal(hashOf(first), hashOf(again), 'the same Version and variant give the same RenderInput hash')
      assert.equal(first.reframeRecordHash, data.plan.recordHash)
      assert.deepEqual(JSON.parse(stableSerialize(first.reframePlan)), JSON.parse(stableSerialize(data.plan.renderPlan)), 'the render receives the persisted plan of the exact Version')
      assert.equal(first.reframePlan.variantId, w.verticalVariantId, 'and by the stable variant, never by the aspect ratio')
      assert.ok(first.reframePlan.ranges.some((range) => range.manualSpans?.length > 0), 'the manual span is in the RenderInput')
      assert.equal(head.reframeRecordHash, resetSecond.payload.data.plan.recordHash)
      assert.notEqual(hashOf(first), hashOf(await sourceOf(baseHead.id, w.verticalVariantId)), 'another plan is another input')
      const wideFirst = await sourceOf(setVersionId, w.wideVariantId)
      assert.equal(wideFirst.reframeRecordHash, widePlan.recordHash, 'the other output renders with ITS plan, untouched by the override')
      assert.equal(wideFirst.reframePlan.variantId, w.wideVariantId)
      assert.notEqual(hashOf(wideFirst), hashOf(first))
      // --- revoked rights refuse an override: the Command is a write over a render source the workspace may no longer use
      const head4 = await headOf(db, w.projectId)
      const versionsBeforeRights = await db.v2ProjectVersion.count({ where: { projectId: w.projectId } })
      const rightsBody = { baseVersionId: head4.id, baseHash: head4.baseHash, variantId: w.verticalVariantId, clipId, startFrame: 100, endFrame: 130, crop: subject }
      await whileRightsRevoked(db, owner, w, async () => {
        const refused = await overrideCall(w, rightsBody, `w66r-${run}-revoked`)
        assert.deepEqual([refused.status, refused.payload.error?.code], [422, 'ASSET_RIGHTS_BLOCKED'], JSON.stringify(refused.payload))
        await assert.rejects(overrideService(db)({ ...rightsBody, workspaceId: owner.workspaceId, projectId: w.projectId, actor: owner.actor, idempotencyKey: `w66r-${run}-revoked-svc` }),
          (error) => error.code === 'ASSET_RIGHTS_BLOCKED')
        assert.equal(await db.v2ProjectVersion.count({ where: { projectId: w.projectId } }), versionsBeforeRights, 'a refused Command writes no Version')
        assert.equal((await headOf(db, w.projectId)).id, head4.id)
      })
      // with the rights back, the very same request is admitted
      const admitted = await overrideCall(w, rightsBody, `w66r-${run}-rights-back`)
      assert.equal(admitted.status, 201, JSON.stringify(admitted.payload))
      note('render-input', { version: setVersionId, vertical: hashOf(first).slice(0, 16), verticalAgain: hashOf(again).slice(0, 16), wide: hashOf(wideFirst).slice(0, 16), reframeRecordHash: first.reframeRecordHash.slice(0, 16) })
    } finally {
      await db.$disconnect()
      await disconnectV2PostgresClient().catch(() => undefined)
      console.log(`W66R-PG-SUMMARY ${JSON.stringify({ steps: evidenceLines.length, policySha256: REFRAME_POLICY_SHA256 })}`)
    }
  })
