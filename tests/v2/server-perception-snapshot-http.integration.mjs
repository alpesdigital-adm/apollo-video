import assert from 'node:assert/strict'
import test from 'node:test'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { sha } from './helpers/perception-snapshot-fixtures.mjs'
import { coverageOf, seedSnapshotWorld } from './helpers/server-perception-pg-world.mjs'
import { seedPerceptionProducerContext } from './helpers/perception-producer-pg-world.mjs'

// Under tsx a static named import of a TypeScript module is not visible to Node (the module runs as CommonJS), so these are dynamic.
const { stableSerialize } = await import('../../src/v2/domain/canonical-hash.ts')
const { PERCEPTION_KINDS } = await import('../../src/v2/domain/perception-timeline.ts')
const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
const { getPublicSchema } = await import('../../src/v2/public-api/schema-registry.ts')
const { publicSchemaDocument } = await import('../../src/v2/public-api/schema-examples.ts')

/**
 * W63a HTTP proof of GET /v1/projects/{projectId}/perception/snapshot, through the real route handler and the real authentication,
 * over a PostgreSQL world with sealed OCR, temporal and face evidence written by the products' writers (written for the supervised
 * disposable cluster; not run in hosted CI).
 *
 * The handler is called the way Next calls it (a NextRequest and a promise of params); the response is validated against the schema
 * the API publishes. It must establish: 200 with kinds, per-kind coverage and server provenance; range clipping; the isolation of
 * workspaces (404, never 403); 401 without a credential; 403 without the scope; 422 for what is not a valid query; 428 for a
 * Version that plays nothing; and that a caller's manual timeline never becomes detector evidence.
 */
process.env.APOLLO_API_ENVIRONMENT = 'production'
process.env.APOLLO_GOVERNANCE_ANOMALY_REQUEST_MINIMUM = '2000000000'
process.env.APOLLO_GOVERNANCE_ANOMALY_SPEND_MINIMUM_MINOR_UNITS = '2000000000'

async function callRoute(NextRequest, module, { method = 'GET', path, params, token, body, idempotencyKey }) {
  const headers = new Headers()
  if (token) headers.set('authorization', `Bearer ${token}`)
  if (idempotencyKey) headers.set('idempotency-key', idempotencyKey)
  const init = { method, headers }
  if (body !== undefined) { headers.set('content-type', 'application/json'); init.body = JSON.stringify(body) }
  const response = await module[method](new NextRequest(new URL(`http://apollo.invalid${path}`), init), { params: Promise.resolve(params) })
  const text = await response.text()
  return { status: response.status, text, payload: text ? JSON.parse(text) : null }
}

test('W63a HTTP server perception snapshot: scoped, isolated, honest about coverage, and never fed by a caller',
  { skip: !process.env.V2_DATABASE_URL, timeout: 480_000 }, async () => {
    const db = new PrismaClient()
    let primaryError
    try {
      const { NextRequest } = await import('next/server')
      const snapshotRoute = await import('../../src/app/v1/projects/[projectId]/perception/snapshot/route.ts')
      const manualRoute = await import('../../src/app/v1/projects/[projectId]/perception/route.ts')
      const built = await seedSnapshotWorld(db)
      const { world } = built
      const other = await seedPerceptionProducerContext(db, { durationFrames: 120 })
      const issue = createApiClientService({ repository: new PrismaApiClientRepository(db), credentialCrypto: nodeApiCredentialCrypto, clock: () => new Date() })
      const token = async (id, workspaceId, scopes) => (await issue({ id: `w63a-http-${id}-${world.suffix}`,
        credentialId: `w63a-http-${id}-credential-${world.suffix}`, workspaceId, name: `W63a HTTP ${id}`, environment: 'production', scopes })).token
      const reader = await token('reader', world.workspaceId, ['projects:read'])
      const writer = await token('writer', world.workspaceId, ['projects:read', 'projects:write'])
      const noScope = await token('noscope', world.workspaceId, ['artifacts:read'])
      const stranger = await token('stranger', other.workspaceId, ['projects:read'])
      const ajv = addFormats(new Ajv2020({ allErrors: true, strict: true }))
      const validate = ajv.compile(publicSchemaDocument(getPublicSchema('apollo://schemas/server-perception-snapshot-response/v1')))
      const get = (query = '', who = reader, projectId = world.projectId) => callRoute(NextRequest, snapshotRoute, {
        path: `/v1/projects/${projectId}/perception/snapshot${query}`, params: { projectId }, token: who })

      // 200: all nine kinds' coverage, server provenance, and exactly the schema the API publishes
      const full = await get()
      assert.equal(full.status, 200, full.text)
      assert.equal(validate(full.payload), true, ajv.errorsText(validate.errors))
      const data = full.payload.data
      assert.equal(full.payload.meta.apiVersion, 'v1')
      assert.equal(data.projectVersionId, world.versionId)
      assert.deepEqual(data.result.kinds, PERCEPTION_KINDS)
      assert.deepEqual(data.origin, { kind: 'server-assembled', manualTimelinesIncluded: false })
      assert.deepEqual(Object.fromEntries(data.result.coverage.map((entry) => [entry.kind, entry.state])), {
        'transcript-word': 'partial', speaker: 'absent', silence: 'absent', face: 'partial', object: 'absent',
        shot: 'partial', motion: 'partial', ocr: 'partial', 'image-insert': 'absent' })
      assert.ok(data.result.coverage.every((entry) => entry.state === 'complete' || entry.unexaminedRanges.length > 0),
        'a kind that is not complete says what it did not examine')
      assert.ok(data.result.coverage.filter((entry) => entry.state === 'absent').every((entry) => /^[A-Z][A-Z0-9_]{2,63}$/.test(entry.reasonCode)))
      assert.ok(data.result.observations.length > 0 && data.result.observations.every((item) => item.provenance.origin === 'server' &&
        /^[a-f0-9]{64}$/.test(item.provenance.envelopeHash)))
      assert.equal(data.result.inventedValues, 0)

      // range clipping, and the kinds asked for
      const clipped = await get('?fromMs=1000&toMs=2000&kinds=ocr,object,shot')
      assert.equal(clipped.status, 200, clipped.text)
      assert.equal(validate(clipped.payload), true, ajv.errorsText(validate.errors))
      assert.deepEqual(clipped.payload.data.result.range, { startMs: 1_000, endMs: 2_000 })
      assert.deepEqual(clipped.payload.data.result.kinds, ['ocr', 'object', 'shot'])
      assert.ok(clipped.payload.data.result.observations.every((item) => item.startMs < 2_000 && item.endMs > 1_000))
      assert.deepEqual(coverageOf(clipped.payload.data, 'ocr').ranges, [[1_000, 1_033]])
      assert.deepEqual(coverageOf(clipped.payload.data, 'ocr').unexaminedRanges, [[1_033, 2_000]])
      assert.equal(coverageOf(clipped.payload.data, 'object').state, 'absent')
      assert.equal(coverageOf(clipped.payload.data, 'object').reasonCode, 'NO_VERIFIED_DETECTOR')
      assert.equal(coverageOf(clipped.payload.data, 'shot').state, 'complete')
      // a range nobody examined is absent in that range, with the reason, even though the kind was examined elsewhere
      const dark = await get('?fromMs=3500&toMs=4000&kinds=ocr')
      assert.equal(coverageOf(dark.payload.data, 'ocr').state, 'absent')
      assert.equal(coverageOf(dark.payload.data, 'ocr').reasonCode, 'RANGE_NOT_EXAMINED')
      assert.equal(dark.payload.data.result.observations.length, 0)
      // the same Version named explicitly is the same snapshot, and a replay is byte for byte the same
      const named = await get(`?versionId=${world.versionId}`)
      assert.equal(named.payload.data.snapshot.snapshotHash, data.snapshot.snapshotHash)
      assert.equal(stableSerialize(named.payload.data), stableSerialize(data))
      assert.equal(await db.v2ServerPerceptionSnapshot.count({ where: { workspaceId: world.workspaceId } }), 1)

      // isolation: another workspace sees a project that does not exist (404, never 403), a missing version is the same answer
      const foreign = await get('', stranger)
      assert.equal(foreign.status, 404)
      assert.equal(foreign.payload.error.code, 'PROJECT_NOT_FOUND')
      assert.equal(foreign.text.includes(data.snapshot.snapshotHash), false)
      assert.equal((await get(`?versionId=${other.versionId}`)).status, 404)
      assert.equal((await get('?versionId=version-does-not-exist')).status, 404)
      assert.equal((await get('', reader, 'project-does-not-exist')).status, 404)
      // ... and the stranger's own project is a snapshot without this workspace's evidence
      const own = await get('', stranger, other.projectId)
      assert.equal(own.status, 200, own.text)
      assert.deepEqual(own.payload.data.snapshot.inputs.map((input) => input.kind), ['transcript'], 'only the words of its own EditPlan')
      assert.ok(own.payload.data.result.coverage.filter((entry) => entry.kind !== 'transcript-word').every((entry) => entry.state === 'absent'))

      // authentication and scope
      assert.equal((await get('', null)).status, 401)
      assert.equal((await get('', 'not-a-token')).status, 401)
      const forbidden = await get('', noScope)
      assert.equal(forbidden.status, 403)
      assert.equal(forbidden.payload.error.code, 'AUTH_SCOPE_REQUIRED')

      // what is not a valid question is refused, and a Version that plays nothing has no snapshot
      for (const query of ['?unknown=1', '?fromMs=1&fromMs=2', '?kinds=ocr,ocr', '?kinds=lighting', '?fromMs=3000&toMs=3000', '?fromMs=-1',
        '?fromMs=abc', '?toMs=4001', '?toMs=999999999', '?versionId=']) {
        const refused = await get(query)
        assert.equal(refused.status, 422, `${query}: ${refused.text}`)
        assert.equal(refused.payload.error.code, 'INVALID_ARGUMENT', query)
      }
      const versions = await db.v2ProjectVersion.findMany({ where: { projectId: world.projectId, workspaceId: world.workspaceId }, orderBy: { sequence: 'asc' } })
      const empty = versions.find((version) => version.id !== world.versionId)
      const noTimeline = await get(`?versionId=${empty.id}`)
      assert.equal(noTimeline.status, 428, noTimeline.text)
      assert.equal(noTimeline.payload.error.code, 'PRECONDITION_REQUIRED')

      // a caller's manual timeline never becomes detector evidence: it is a different record, with its own label, and the snapshot ignores it
      const manualBody = (provenance) => ({ projectVersionId: world.versionId, baseRevision: null, durationMs: 4_000,
        observations: [{ id: 'manual-object-1', kind: 'object', startMs: 0, endMs: 4_000, value: { label: 'product' }, provenance }],
        coverage: PERCEPTION_KINDS.map((kind) => ({ kind, ranges: kind === 'object' ? [[0, 4_000]] : [] })) })
      const put = await callRoute(NextRequest, manualRoute, { method: 'PUT', path: `/v1/projects/${world.projectId}/perception`,
        params: { projectId: world.projectId }, token: writer, idempotencyKey: `w63a-manual-${world.suffix}`,
        body: manualBody({ source: 'server', model: 'detector', version: 'v9', confidence: 0.99 }) })
      assert.equal(put.status, 201, put.text)
      assert.deepEqual(put.payload.data.origin, { kind: 'manual-controlled', trust: 'unverified', suppliedByClientId: put.payload.data.origin.suppliedByClientId })
      const elevated = await callRoute(NextRequest, manualRoute, { method: 'PUT', path: `/v1/projects/${world.projectId}/perception`,
        params: { projectId: world.projectId }, token: writer, idempotencyKey: `w63a-manual-elevated-${world.suffix}`,
        body: manualBody({ source: 'envelope-1', model: 'detector', version: 'v9', confidence: 0.99, origin: 'server', producer: 'detector',
          envelopeId: 'envelope-1', envelopeHash: sha('1'), confidenceBasis: 'producer-reported' }) })
      assert.equal(elevated.status, 422, elevated.text)
      const afterManual = await get()
      assert.equal(afterManual.payload.data.snapshot.snapshotHash, data.snapshot.snapshotHash, 'a manual timeline does not change the snapshot')
      assert.equal(afterManual.payload.data.result.observations.some((item) => item.id === 'manual-object-1'), false)
      assert.equal(coverageOf(afterManual.payload.data, 'object').state, 'absent')
      const manual = await callRoute(NextRequest, manualRoute, { path: `/v1/projects/${world.projectId}/perception`, params: { projectId: world.projectId }, token: reader })
      assert.equal(manual.status, 200, manual.text)
      assert.equal(manual.payload.data.origin.kind, 'manual-controlled')
      assert.equal(manual.payload.data.result.observations[0].id, 'manual-object-1')
      assert.equal(await db.v2ServerPerceptionSnapshot.count({ where: { workspaceId: world.workspaceId } }), 1)
    } catch (error) {
      primaryError = error
    } finally {
      try { await db.$disconnect() } catch (error) { primaryError ??= error }
      if (primaryError) throw primaryError
    }
  })
